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
    pageIndex: number,
    pagePt: { x: number; y: number },
    clientPt: { x: number; y: number }
  ) => void
  /** Ctrl/Cmd + click — remove a selected mark under the point, if any. */
  onCtrlClick: (pageIndex: number, pagePt: { x: number; y: number }) => void
  /** A text-mode drag selection — page-space rect + screen pt for menu placement. */
  onTextSelect: (
    pageIndex: number,
    sel: { x0: number; y0: number; x1: number; y1: number },
    clientPt: { x: number; y: number }
  ) => void
  /** Ctrl + wheel zoom: receives the desired new zoom (clamping done by parent). */
  onZoomChange: (zoom: number) => void
  /** Bump to force a re-fetch of the rendered page (e.g. after redaction). */
  refreshKey: number
  /**
   * One-shot "copy a region" mode: while true, a drag draws a rectangle and,
   * on release, hands it to `onRegionCopy` instead of selecting for redaction.
   */
  regionCopyMode?: boolean
  onRegionCopy?: (
    pageIndex: number,
    rect: { x0: number; y0: number; x1: number; y1: number }
  ) => void
  /**
   * 文字入れモード: a click opens an inline draft editor at that spot; on commit
   * the text is burned into the page as real embedded text.
   */
  textMode?: boolean
  /** Fallback font size (pt) when no nearby text is detected to copy. */
  defaultFontSize?: number
  onInsertText?: (
    pageIndex: number,
    pagePt: { x: number; y: number },
    text: string,
    fontSize: number
  ) => void
}

interface DragState {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** In-progress text box: position in canvas px (top-left), size in points. */
interface TextDraft {
  x: number
  y: number
  text: string
  size: number
}

export default function PageCanvas({
  pageIndex,
  zoom,
  pendingRects,
  selectMode,
  onAddRects,
  onWordClick,
  onCtrlClick,
  onTextSelect,
  onZoomChange,
  refreshKey,
  regionCopyMode = false,
  onRegionCopy,
  textMode = false,
  defaultFontSize = 10.5,
  onInsertText
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
  // 文字入れ: the draft text box currently being composed (null = none).
  const [draft, setDraft] = useState<TextDraft | null>(null)
  const draftRef = useRef<TextDraft | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

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

    // Selected (not-yet-processed) ranges use a neutral blue — they can become
    // either a redaction (墨) or a highlight (黄) from the toolbar.
    ctx.fillStyle = 'rgba(37, 99, 235, 0.30)'
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.90)'
    ctx.lineWidth = 1
    for (const r of pendingRects) fillRectPt(ctx, r)

    // Live text selection preview while dragging.
    for (const r of textPreview) fillRectPt(ctx, r)

    // Freehand rectangle preview (rect mode or region-copy mode) — blue.
    if (drag && (regionCopyMode || selectMode === 'rect')) {
      const x = Math.min(drag.x0, drag.x1)
      const y = Math.min(drag.y0, drag.y1)
      const w = Math.abs(drag.x1 - drag.x0)
      const h = Math.abs(drag.y1 - drag.y0)
      ctx.fillStyle = 'rgba(37, 99, 235, 0.35)'
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.95)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    }
  }, [pendingRects, textPreview, drag, selectMode, regionCopyMode, fillRectPt])

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

    if (selectMode === 'text' && !regionCopyMode && !textMode) {
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

  // Burn the current draft (if any non-empty text) and clear it.
  const commitDraft = useCallback(() => {
    const dr = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (dr && dr.text.trim() && onInsertText) {
      onInsertText(pageIndex, { x: dr.x / zoom, y: dr.y / zoom }, dr.text, dr.size)
    }
  }, [pageIndex, zoom, onInsertText])

  // Open a fresh draft at a canvas point, seeding its size from nearby text.
  const openDraft = useCallback(
    async (canvasX: number, canvasY: number) => {
      let s = defaultFontSize
      try {
        const ctx = await pdfApi.fontContextAt(pageIndex, canvasX / zoom, canvasY / zoom)
        if (ctx.fontSize) s = ctx.fontSize
      } catch {
        // no context available — keep the fallback size
      }
      setDraft({ x: canvasX, y: canvasY, text: '', size: s })
    },
    [pageIndex, zoom, defaultFontSize]
  )

  // Focus the textarea whenever a new draft appears.
  useEffect(() => {
    if (draft) taRef.current?.focus()
  }, [draft?.x, draft?.y])

  // Leaving 文字入れ mode commits whatever is being typed.
  useEffect(() => {
    if (!textMode && draftRef.current) commitDraft()
  }, [textMode, commitDraft])

  const onPointerUp = async (e: React.PointerEvent): Promise<void> => {
    if (!drag) return
    const dx = Math.abs(drag.x1 - drag.x0)
    const dy = Math.abs(drag.y1 - drag.y0)
    const isClick = dx <= 4 && dy <= 4

    // 文字入れ: a click places a new text box (committing any current draft).
    if (textMode) {
      setDrag(null)
      setTextPreview([])
      if (isClick) {
        if (draftRef.current) commitDraft()
        void openDraft(drag.x0, drag.y0)
      }
      return
    }

    // Region-copy mode: a real drag copies that rectangle; a click does nothing.
    if (regionCopyMode) {
      if (!isClick && onRegionCopy) {
        onRegionCopy(pageIndex, {
          x0: Math.min(drag.x0, drag.x1) / zoom,
          y0: Math.min(drag.y0, drag.y1) / zoom,
          x1: Math.max(drag.x0, drag.x1) / zoom,
          y1: Math.max(drag.y0, drag.y1) / zoom
        })
      }
      setDrag(null)
      setTextPreview([])
      return
    }

    if (isClick) {
      const pt = { x: drag.x0 / zoom, y: drag.y0 / zoom }
      if (e.ctrlKey || e.metaKey) {
        onCtrlClick(pageIndex, pt)
      } else {
        onWordClick(pageIndex, pt, { x: e.clientX, y: e.clientY })
      }
    } else if (selectMode === 'text') {
      // Hand the dragged text selection to the menu (redact / search / highlight).
      onTextSelect(
        pageIndex,
        {
          x0: drag.x0 / zoom,
          y0: drag.y0 / zoom,
          x1: drag.x1 / zoom,
          y1: drag.y1 / zoom
        },
        { x: e.clientX, y: e.clientY }
      )
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

  const nudge = (dx: number, dy: number): void =>
    setDraft((d) => (d ? { ...d, x: d.x + dx * zoom, y: d.y + dy * zoom } : d))

  const setDraftSize = (delta: number): void => {
    setDraft((d) =>
      d ? { ...d, size: Math.max(4, Math.round((d.size + delta) * 2) / 2) } : d
    )
    taRef.current?.focus()
  }

  const onDraftKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      draftRef.current = null
      setDraft(null)
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commitDraft()
      return
    }
    if (e.altKey && e.key.startsWith('Arrow')) {
      // Nudge the box: 1pt, or 0.25pt with Shift, for pixel-precise placement.
      e.preventDefault()
      const s = e.shiftKey ? 0.25 : 1
      if (e.key === 'ArrowLeft') nudge(-s, 0)
      else if (e.key === 'ArrowRight') nudge(s, 0)
      else if (e.key === 'ArrowUp') nudge(0, -s)
      else if (e.key === 'ArrowDown') nudge(0, s)
    }
  }

  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      {loading && <div className="canvas-loading">描画中…</div>}
      <canvas
        ref={canvasRef}
        width={size.w}
        height={size.h}
        className={
          'page-canvas' +
          (regionCopyMode
            ? ' mode-region'
            : textMode
              ? ' mode-text-insert'
              : selectMode === 'text'
                ? ' mode-text'
                : '')
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {draft && (
        <div
          className="text-draft"
          style={{ left: draft.x, top: draft.y }}
        >
          <div className="text-draft-tools" onMouseDown={keepFocus}>
            <button type="button" title="小さく" onClick={() => setDraftSize(-0.5)}>
              A−
            </button>
            <span className="text-draft-size">{draft.size}pt</span>
            <button type="button" title="大きく" onClick={() => setDraftSize(0.5)}>
              A＋
            </button>
            <span className="text-draft-sep" />
            <button
              type="button"
              className="text-draft-ok"
              title="確定（Ctrl+Enter）"
              onClick={commitDraft}
            >
              ✓
            </button>
            <button
              type="button"
              className="text-draft-cancel"
              title="取消（Esc）"
              onClick={() => {
                draftRef.current = null
                setDraft(null)
              }}
            >
              ✕
            </button>
          </div>
          <textarea
            ref={taRef}
            className="text-draft-input"
            value={draft.text}
            spellCheck={false}
            rows={1}
            style={{
              fontSize: draft.size * zoom,
              lineHeight: 1.35
            }}
            onChange={(e) => {
              const text = e.target.value
              setDraft((d) => (d ? { ...d, text } : d))
              // Auto-grow height to fit the content.
              const el = e.target
              el.style.height = 'auto'
              el.style.height = `${el.scrollHeight}px`
            }}
            onKeyDown={onDraftKeyDown}
            onBlur={commitDraft}
          />
        </div>
      )}
    </div>
  )
}
