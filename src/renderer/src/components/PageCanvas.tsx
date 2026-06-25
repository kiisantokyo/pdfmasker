import { useCallback, useEffect, useRef, useState } from 'react'
import type { RedactionRect, SelectMode } from '@shared/types'
import { pdfApi } from '../lib/api'

interface Props {
  pageIndex: number
  zoom: number
  /** Pending (not-yet-applied) redactions for THIS page, in page points. */
  pendingRects: RedactionRect[]
  /** 'text' = drag over words (snap to text); 'rect' = freehand rectangle. */
  selectMode: SelectMode
  onAddRects: (rects: RedactionRect[]) => void
  /** A click (not a drag) at a point — page-space pt + screen pt for menu placement. */
  onWordClick: (
    pagePt: { x: number; y: number },
    clientPt: { x: number; y: number }
  ) => void
  /** Ctrl + wheel zoom: receives the desired new zoom (clamping done by parent). */
  onZoomChange: (zoom: number) => void
  /** Bump to force a re-fetch of the rendered page (e.g. after redaction). */
  refreshKey: number
}

interface DragState {
  x0: number
  y0: number
  x1: number
  y1: number
}

export default function PageCanvas({
  pageIndex,
  zoom,
  pendingRects,
  selectMode,
  onAddRects,
  onWordClick,
  onZoomChange,
  refreshKey
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const lastQuery = useRef(0)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<DragState | null>(null)
  // Live preview of the text selection (page-space rects) while dragging.
  const [textPreview, setTextPreview] = useState<RedactionRect[]>([])
  const [loading, setLoading] = useState(true)

  // Fetch + decode the page render whenever page/zoom/refresh changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    pdfApi.renderPage(pageIndex, zoom).then(async (res) => {
      if (cancelled) return
      // .slice() yields a fresh ArrayBuffer-backed view (Blob-compatible type).
      const blob = new Blob([res.png.slice()], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      if (cancelled) {
        bmp.close()
        return
      }
      bitmapRef.current?.close()
      bitmapRef.current = bmp
      setSize({ w: res.pixelWidth, h: res.pixelHeight })
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [pageIndex, zoom, refreshKey])

  const fillRectPt = useCallback(
    (ctx: CanvasRenderingContext2D, r: RedactionRect) => {
      const x = Math.min(r.x0, r.x1) * zoom
      const y = Math.min(r.y0, r.y1) * zoom
      const w = Math.abs(r.x1 - r.x0) * zoom
      const h = Math.abs(r.y1 - r.y0) * zoom
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    },
    [zoom]
  )

  // Redraw: page image + committed pending rects + live selection.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const bmp = bitmapRef.current
    if (!canvas || !bmp) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bmp, 0, 0)

    ctx.fillStyle = 'rgba(220, 38, 38, 0.45)'
    ctx.strokeStyle = 'rgba(220, 38, 38, 0.95)'
    ctx.lineWidth = 1
    for (const r of pendingRects) fillRectPt(ctx, r)

    // Live text selection preview (red, matches committed look).
    for (const r of textPreview) fillRectPt(ctx, r)

    // Freehand rectangle preview (rect mode only) — blue.
    if (drag && selectMode === 'rect') {
      const x = Math.min(drag.x0, drag.x1)
      const y = Math.min(drag.y0, drag.y1)
      const w = Math.abs(drag.x1 - drag.x0)
      const h = Math.abs(drag.y1 - drag.y0)
      ctx.fillStyle = 'rgba(37, 99, 235, 0.35)'
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    }
  }, [pendingRects, textPreview, drag, selectMode, fillRectPt])

  useEffect(() => {
    redraw()
  }, [redraw, size, loading])

  // Ctrl + wheel to zoom (non-passive so we can prevent page scroll).
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const handler = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      onZoomChange(zoom * factor)
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [zoom, onZoomChange])

  const toCanvasXY = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    const { x, y } = toCanvasXY(e)
    canvasRef.current?.setPointerCapture(e.pointerId)
    setDrag({ x0: x, y0: y, x1: x, y1: y })
    setTextPreview([])
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const { x, y } = toCanvasXY(e)
    setDrag({ ...drag, x1: x, y1: y })

    if (selectMode === 'text') {
      const moved = Math.hypot(x - drag.x0, y - drag.y0)
      const now = performance.now()
      if (moved > 4 && now - lastQuery.current > 40) {
        lastQuery.current = now
        pdfApi
          .selectText(pageIndex, drag.x0 / zoom, drag.y0 / zoom, x / zoom, y / zoom)
          .then(setTextPreview)
      }
    }
  }

  const onPointerUp = async (e: React.PointerEvent): Promise<void> => {
    if (!drag) return
    const dx = Math.abs(drag.x1 - drag.x0)
    const dy = Math.abs(drag.y1 - drag.y0)
    const isClick = dx <= 4 && dy <= 4

    if (isClick) {
      onWordClick(
        { x: drag.x0 / zoom, y: drag.y0 / zoom },
        { x: e.clientX, y: e.clientY }
      )
    } else if (selectMode === 'text') {
      // Authoritative final selection.
      const rects = await pdfApi.selectText(
        pageIndex,
        drag.x0 / zoom,
        drag.y0 / zoom,
        drag.x1 / zoom,
        drag.y1 / zoom
      )
      if (rects.length) onAddRects(rects)
    } else {
      onAddRects([
        {
          pageIndex,
          x0: Math.min(drag.x0, drag.x1) / zoom,
          y0: Math.min(drag.y0, drag.y1) / zoom,
          x1: Math.max(drag.x0, drag.x1) / zoom,
          y1: Math.max(drag.y0, drag.y1) / zoom
        }
      ])
    }
    setDrag(null)
    setTextPreview([])
  }

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      {loading && <div className="canvas-loading">描画中…</div>}
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        className={'page-canvas' + (selectMode === 'text' ? ' mode-text' : '')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  )
}
