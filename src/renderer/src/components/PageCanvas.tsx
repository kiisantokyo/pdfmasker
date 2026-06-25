import { useCallback, useEffect, useRef, useState } from 'react'
import type { RedactionRect } from '@shared/types'
import { pdfApi } from '../lib/api'

interface Props {
  pageIndex: number
  zoom: number
  /** Pending (not-yet-applied) redactions for THIS page, in page points. */
  pendingRects: RedactionRect[]
  onAddRect: (rect: RedactionRect) => void
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
  onAddRect,
  refreshKey
}: Props): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<ImageBitmap | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<DragState | null>(null)
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

  // Redraw: page image + committed pending rects + in-progress drag rect.
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
    for (const r of pendingRects) {
      const x = Math.min(r.x0, r.x1) * zoom
      const y = Math.min(r.y0, r.y1) * zoom
      const w = Math.abs(r.x1 - r.x0) * zoom
      const h = Math.abs(r.y1 - r.y0) * zoom
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    }

    if (drag) {
      const x = Math.min(drag.x0, drag.x1)
      const y = Math.min(drag.y0, drag.y1)
      const w = Math.abs(drag.x1 - drag.x0)
      const h = Math.abs(drag.y1 - drag.y0)
      ctx.fillStyle = 'rgba(37, 99, 235, 0.35)'
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    }
  }, [pendingRects, drag, zoom])

  useEffect(() => {
    redraw()
  }, [redraw, size, loading])

  const toCanvasXY = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    const { x, y } = toCanvasXY(e)
    canvasRef.current?.setPointerCapture(e.pointerId)
    setDrag({ x0: x, y0: y, x1: x, y1: y })
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const { x, y } = toCanvasXY(e)
    setDrag({ ...drag, x1: x, y1: y })
  }

  const onPointerUp = (): void => {
    if (!drag) return
    const w = Math.abs(drag.x1 - drag.x0)
    const h = Math.abs(drag.y1 - drag.y0)
    // Ignore accidental tiny drags.
    if (w > 4 && h > 4) {
      onAddRect({
        pageIndex,
        x0: Math.min(drag.x0, drag.x1) / zoom,
        y0: Math.min(drag.y0, drag.y1) / zoom,
        x1: Math.max(drag.x0, drag.x1) / zoom,
        y1: Math.max(drag.y0, drag.y1) / zoom
      })
    }
    setDrag(null)
  }

  return (
    <div className="canvas-wrap">
      {loading && <div className="canvas-loading">描画中…</div>}
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        className="page-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  )
}
