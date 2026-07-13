import { useCallback, useEffect, useRef, useState } from 'react'
import type { RedactionRect, SelectMode, TextGuides, TextItem } from '@shared/types'
import { pdfApi } from '../lib/api'
import {
  JP_FONT_STACK,
  SNAP_PX,
  TEXT_LINE_HEIGHT,
  snapValue,
  textAscentPt
} from '../lib/textMetrics'

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
   * 文字入れモード: a click on empty space creates a new editable text box; the
   * boxes stay editable/movable overlays (WYSIWYG) until the user applies them.
   */
  textMode?: boolean
  /** Editable (not-yet-burned) text boxes belonging to THIS page. */
  textItems?: TextItem[]
  /** Which text box is currently being edited (focuses its textarea). */
  editingTextId?: number | null
  /** Fallback size (pt) for a new box when no nearby text is detected. */
  defaultFontSize?: number
  /**
   * Create a new text box. PageCanvas already resolved its size (nearby text or
   * the fallback) and snapped its position to the document, so the parent just
   * stores it and starts editing.
   */
  onCreateText?: (
    pageIndex: number,
    box: { x: number; y: number; fontSize: number }
  ) => void
  onUpdateText?: (id: number, patch: Partial<TextItem>) => void
  onDeleteText?: (id: number) => void
  /** Report which box is being edited (id) or that editing ended (null). */
  onEditText?: (id: number | null) => void
}

interface DragState {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** While dragging a text box: which box + pointer→box offset (px). `fromBody`
 *  drags start on the box itself, so a click (no real drag) opens it for editing;
 *  handle drags (`fromBody:false`) always move. */
interface MoveState {
  id: number
  offX: number
  offY: number
  fromBody: boolean
  startX: number
  startY: number
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
  textItems = [],
  editingTextId = null,
  defaultFontSize = 10.5,
  onCreateText,
  onUpdateText,
  onDeleteText,
  onEditText
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
  // 文字入れ: pointer-drag state while moving a text box.
  const [move, setMove] = useState<MoveState | null>(null)
  const movedRef = useRef(false)
  // Snap guide line to show while dragging (canvas px; x=vertical, y=horizontal).
  const [snapLine, setSnapLine] = useState<{ x?: number; y?: number } | null>(null)
  const editRef = useRef<HTMLTextAreaElement | null>(null)
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Alignment guides for THIS page. Cached per render; `data` is the resolved
  // value (read synchronously while dragging), `p` the in-flight/cached promise.
  const guidesRef = useRef<{
    key: number
    p: Promise<TextGuides> | null
    data: TextGuides | null
  }>({ key: -1, p: null, data: null })
  const getGuides = useCallback((): Promise<TextGuides> => {
    const gr = guidesRef.current
    if (gr.key !== refreshKey) {
      gr.key = refreshKey
      gr.p = null
      gr.data = null
    }
    if (!gr.p) {
      gr.p = pdfApi
        .textGuides(pageIndex)
        .catch(() => ({ baselines: [], lefts: [] }) as TextGuides)
      gr.p.then((d) => {
        if (guidesRef.current.key === refreshKey) guidesRef.current.data = d
      })
    }
    return gr.p
  }, [pageIndex, refreshKey])

  // Prefetch guides when 文字入れ turns on, so the first drag/click snaps at once.
  useEffect(() => {
    if (textMode) void getGuides()
  }, [textMode, getGuides])

  // Clear any pending snap-line timer on unmount.
  useEffect(() => {
    return () => {
      if (snapTimer.current) clearTimeout(snapTimer.current)
    }
  }, [])

  // Show the snap guide line(s) briefly (canvas px), then fade.
  const flashSnap = useCallback((line: { x?: number; y?: number } | null) => {
    if (snapTimer.current) clearTimeout(snapTimer.current)
    setSnapLine(line)
    if (line) snapTimer.current = setTimeout(() => setSnapLine(null), 900)
  }, [])

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

  // Focus the textarea of whichever box is being edited.
  useEffect(() => {
    if (editingTextId != null) editRef.current?.focus()
  }, [editingTextId])

  const onPointerUp = async (e: React.PointerEvent): Promise<void> => {
    if (!drag) return
    const dx = Math.abs(drag.x1 - drag.x0)
    const dy = Math.abs(drag.y1 - drag.y0)
    const isClick = dx <= 4 && dy <= 4

    // 文字入れ: a click on empty page space creates a new text box, sized from
    // nearby text and snapped (baseline/left) to the document. A guide line
    // flashes so the alignment is visible.
    if (textMode) {
      const cx = drag.x0
      const cy = drag.y0
      setDrag(null)
      setTextPreview([])
      if (isClick && onCreateText) {
        const px = cx / zoom
        const py = cy / zoom
        let fontSize = defaultFontSize
        try {
          const ctx = await pdfApi.fontContextAt(pageIndex, px, py)
          if (ctx.fontSize) fontSize = ctx.fontSize
        } catch {
          // keep the fallback size
        }
        const guides = await getGuides()
        const thr = SNAP_PX / zoom
        const asc = textAscentPt(fontSize)
        let x = px
        let y = Math.max(0, py - (TEXT_LINE_HEIGHT * fontSize) / 2)
        let gx: number | undefined
        let gy: number | undefined
        const sb = snapValue(y + asc, guides.baselines, thr)
        if (sb != null) {
          y = Math.max(0, sb - asc)
          gy = sb * zoom
        }
        const sl = snapValue(x, guides.lefts, thr)
        if (sl != null) {
          x = sl
          gx = sl * zoom
        }
        flashSnap(gx != null || gy != null ? { x: gx, y: gy } : null)
        onCreateText(pageIndex, { x, y, fontSize })
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

  // Size a text box's <textarea> to exactly fit its content (no wrapping, so the
  // overlay matches the non-wrapping burned text). Collapse to 0 first: with
  // width:auto a textarea reports its default multi-column width, so it would
  // never shrink to the typed text — measuring from 0 gives the true content size.
  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.width = '0px'
    el.style.width = `${el.scrollWidth + 2}px`
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }

  // Drag a text box (by its ✥ handle, or by its body when not editing): track the
  // pointer globally until release. Snaps the box's baseline/left edge to nearby
  // document text (hold Alt to bypass) and shows the guide line. A body drag with
  // no real movement is a click → open the box for editing.
  useEffect(() => {
    if (!move) return
    const el = canvasRef.current
    const item = textItems.find((t) => t.id === move.id)
    const onMove = (e: PointerEvent): void => {
      if (!el) return
      if (!movedRef.current) {
        // Body drags wait for a small threshold so a click doesn't nudge the box.
        if (Math.hypot(e.clientX - move.startX, e.clientY - move.startY) < 4) return
        movedRef.current = true
      }
      const r = el.getBoundingClientRect()
      let nx = Math.max(0, (e.clientX - r.left - move.offX) / zoom)
      let ny = Math.max(0, (e.clientY - r.top - move.offY) / zoom)
      let gx: number | undefined
      let gy: number | undefined
      const guides = guidesRef.current.data
      if (guides && item && !e.altKey) {
        const thr = SNAP_PX / zoom
        const asc = textAscentPt(item.fontSize)
        const sb = snapValue(ny + asc, guides.baselines, thr)
        if (sb != null) {
          ny = Math.max(0, sb - asc)
          gy = sb * zoom
        }
        const sl = snapValue(nx, guides.lefts, thr)
        if (sl != null) {
          nx = sl
          gx = sl * zoom
        }
      }
      setSnapLine(gx != null || gy != null ? { x: gx, y: gy } : null)
      onUpdateText?.(move.id, { x: nx, y: ny })
    }
    const onUp = (): void => {
      // A body press that never moved = a click to start editing that box.
      if (move.fromBody && !movedRef.current) onEditText?.(move.id)
      setMove(null)
      setSnapLine(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [move, zoom, onUpdateText, onEditText, textItems])

  const beginDrag = (
    e: React.PointerEvent,
    item: TextItem,
    fromBody: boolean
  ): void => {
    e.preventDefault()
    e.stopPropagation()
    void getGuides()
    movedRef.current = !fromBody // handle drags move immediately
    const r = canvasRef.current!.getBoundingClientRect()
    setMove({
      id: item.id,
      offX: e.clientX - r.left - item.x * zoom,
      offY: e.clientY - r.top - item.y * zoom,
      fromBody,
      startX: e.clientX,
      startY: e.clientY
    })
  }

  const changeSize = (item: TextItem, delta: number): void => {
    const next = Math.max(4, Math.round((item.fontSize + delta) * 2) / 2)
    onUpdateText?.(item.id, { fontSize: next })
    editRef.current?.focus()
  }

  const onItemKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    item: TextItem
  ): void => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.blur()
      return
    }
    if (e.altKey && e.key.startsWith('Arrow')) {
      // Nudge the box: 1pt, or 0.25pt with Shift, for precise placement.
      e.preventDefault()
      const s = e.shiftKey ? 0.25 : 1
      const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0
      const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0
      const nx = Math.max(0, item.x + dx)
      const ny = Math.max(0, item.y + dy)
      onUpdateText?.(item.id, { x: nx, y: ny })
      // Flash the guide line when the nudge lands on a document line (feedback
      // only — nudging stays free, it does not force a snap).
      const guides = guidesRef.current.data
      if (guides) {
        const thr = SNAP_PX / zoom
        const asc = textAscentPt(item.fontSize)
        const sb = snapValue(ny + asc, guides.baselines, thr)
        const sl = snapValue(nx, guides.lefts, thr)
        flashSnap(
          sb != null || sl != null
            ? { x: sl != null ? sl * zoom : undefined, y: sb != null ? sb * zoom : undefined }
            : null
        )
      }
    }
  }

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

      {/* Alignment guide lines shown while a box snaps to document text. */}
      {snapLine?.y != null && (
        <div className="snap-guide snap-h" style={{ top: snapLine.y }} />
      )}
      {snapLine?.x != null && (
        <div className="snap-guide snap-v" style={{ left: snapLine.x }} />
      )}

      {/* 文字入れ: editable WYSIWYG text boxes (shown always; interactive only in
          文字入れ mode). Each box's overlay defines exactly where it will burn. */}
      {textItems.map((item) => {
        const editing = textMode && editingTextId === item.id
        return (
          <div
            key={item.id}
            className={
              'text-item' +
              (textMode ? ' interactive' : '') +
              (editing ? ' editing' : '')
            }
            style={{ left: item.x * zoom, top: item.y * zoom }}
          >
            {editing && (
              <div
                className="text-item-tools"
                onMouseDown={(e) => e.preventDefault()}
              >
                <button type="button" title="小さく" onClick={() => changeSize(item, -0.5)}>
                  A−
                </button>
                <span className="text-item-size">{item.fontSize}pt</span>
                <button type="button" title="大きく" onClick={() => changeSize(item, 0.5)}>
                  A＋
                </button>
              </div>
            )}
            {textMode && (
              <span
                className="text-item-handle"
                title="ドラッグで移動"
                onPointerDown={(e) => beginDrag(e, item, false)}
              >
                ✥
              </span>
            )}
            {textMode && item.text.trim() !== '' && (
              <button
                type="button"
                className="text-item-close"
                title="このテキストを削除"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onDeleteText?.(item.id)}
              >
                ×
              </button>
            )}
            <textarea
              ref={(el) => {
                if (editing) editRef.current = el
                if (el) autoGrow(el) // keep every box sized to its content
              }}
              className={'text-item-input' + (textMode && !editing ? ' movable' : '')}
              value={item.text}
              spellCheck={false}
              rows={1}
              readOnly={!editing}
              placeholder={editing ? '文字を入力' : ''}
              style={{
                fontSize: item.fontSize * zoom,
                lineHeight: TEXT_LINE_HEIGHT,
                fontFamily: JP_FONT_STACK
              }}
              onPointerDown={(e) => {
                // Not the box being edited: drag to move, or click to edit it.
                if (textMode && !editing) beginDrag(e, item, true)
              }}
              onFocus={(e) => {
                onEditText?.(item.id)
                autoGrow(e.currentTarget)
              }}
              onChange={(e) => {
                onUpdateText?.(item.id, { text: e.target.value })
                autoGrow(e.target)
              }}
              onKeyDown={(e) => onItemKeyDown(e, item)}
              onBlur={(e) => {
                if (!e.currentTarget.value.trim()) onDeleteText?.(item.id)
                onEditText?.(null)
              }}
            />
            {editing && (
              <span className="text-item-hint">
                Ctrl+Enter で入力完了 ／ 仕上げにツールバー「文字」でPDFに反映
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
