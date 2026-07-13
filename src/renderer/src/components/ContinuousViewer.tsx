import { useEffect, useRef, useState } from 'react'
import type { PageInfo, RedactionRect, SelectMode, TextItem } from '@shared/types'
import PageCanvas from './PageCanvas'

interface Props {
  pages: PageInfo[]
  zoom: number
  pending: RedactionRect[]
  selectMode: SelectMode
  refreshKey: number
  /** Bump `.n` to request a programmatic scroll to `.page`. */
  scrollTarget: { page: number; n: number }
  onVisiblePage: (index: number) => void
  onAddRects: (rs: RedactionRect[]) => void
  onWordClick: (
    pageIndex: number,
    pagePt: { x: number; y: number },
    clientPt: { x: number; y: number }
  ) => void
  onCtrlClick: (pageIndex: number, pagePt: { x: number; y: number }) => void
  onTextSelect: (
    pageIndex: number,
    sel: { x0: number; y0: number; x1: number; y1: number },
    clientPt: { x: number; y: number }
  ) => void
  onZoomChange: (z: number) => void
  /** One-shot region-copy mode (drag a rectangle to copy it to the clipboard). */
  regionCopyMode?: boolean
  onRegionCopy?: (
    pageIndex: number,
    rect: { x0: number; y0: number; x1: number; y1: number }
  ) => void
  /** 文字入れモード（クリックで編集可能なテキストを追加）。 */
  textMode?: boolean
  textItems?: TextItem[]
  editingTextId?: number | null
  onCreateText?: (pageIndex: number, pagePt: { x: number; y: number }) => void
  onUpdateText?: (id: number, patch: Partial<TextItem>) => void
  onDeleteText?: (id: number) => void
  onEditText?: (id: number | null) => void
}

export default function ContinuousViewer({
  pages,
  zoom,
  pending,
  selectMode,
  refreshKey,
  scrollTarget,
  onVisiblePage,
  onAddRects,
  onWordClick,
  onCtrlClick,
  onTextSelect,
  onZoomChange,
  regionCopyMode = false,
  onRegionCopy,
  textMode = false,
  textItems = [],
  editingTextId = null,
  onCreateText,
  onUpdateText,
  onDeleteText,
  onEditText
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const wrapRefs = useRef<Array<HTMLDivElement | null>>([])
  const ratios = useRef<Map<number, number>>(new Map())
  const [mounted, setMounted] = useState<Set<number>>(() => new Set([0, 1, 2]))

  // Lazy-mount pages near the viewport and track the most-visible page.
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const io = new IntersectionObserver(
      (entries) => {
        const toMount: number[] = []
        for (const e of entries) {
          const idx = Number((e.target as HTMLElement).dataset.page)
          ratios.current.set(idx, e.isIntersecting ? e.intersectionRatio : 0)
          if (e.isIntersecting) toMount.push(idx)
        }
        if (toMount.length) {
          setMounted((prev) => {
            const next = new Set(prev)
            for (const i of toMount) next.add(i)
            return next
          })
        }
        let best = -1
        let bestRatio = -1
        for (const [idx, r] of ratios.current) {
          if (r > bestRatio) {
            bestRatio = r
            best = idx
          }
        }
        if (best >= 0 && bestRatio > 0) onVisiblePage(best)
      },
      { root, rootMargin: '500px 0px', threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
    )
    wrapRefs.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [pages.length, refreshKey, onVisiblePage])

  // Programmatic scroll when navigation is requested from outside.
  useEffect(() => {
    const el = wrapRefs.current[scrollTarget.page]
    if (el) el.scrollIntoView({ block: 'start' })
  }, [scrollTarget])

  return (
    <div className="viewer continuous" ref={scrollRef}>
      {pages.map((p) => {
        const h = Math.max(40, Math.round(p.height * zoom))
        return (
          <div
            key={p.index}
            data-page={p.index}
            ref={(el) => {
              wrapRefs.current[p.index] = el
            }}
            className="cv-page"
          >
            <div className="cv-pagenum">ページ {p.index + 1}</div>
            {mounted.has(p.index) ? (
              <PageCanvas
                pageIndex={p.index}
                zoom={zoom}
                pendingRects={pending.filter((r) => r.pageIndex === p.index)}
                selectMode={selectMode}
                refreshKey={refreshKey}
                onAddRects={onAddRects}
                onWordClick={onWordClick}
                onCtrlClick={onCtrlClick}
                onTextSelect={onTextSelect}
                onZoomChange={onZoomChange}
                regionCopyMode={regionCopyMode}
                onRegionCopy={onRegionCopy}
                textMode={textMode}
                textItems={textItems.filter((t) => t.pageIndex === p.index)}
                editingTextId={editingTextId}
                onCreateText={onCreateText}
                onUpdateText={onUpdateText}
                onDeleteText={onDeleteText}
                onEditText={onEditText}
              />
            ) : (
              <div className="cv-placeholder" style={{ height: h }} />
            )}
          </div>
        )
      })}
    </div>
  )
}
