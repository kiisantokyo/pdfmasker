import { useEffect, useRef, useState } from 'react'
import type { DocumentInfo, RotateDelta } from '@shared/types'
import { pdfApi } from '../lib/api'

const PT_PER_MM = 72 / 25.4

const PAPERS: { name: string; w: number; h: number }[] = [
  { name: 'A3', w: 297, h: 420 },
  { name: 'A4', w: 210, h: 297 },
  { name: 'A5', w: 148, h: 210 },
  { name: 'A6', w: 105, h: 148 },
  { name: 'B4', w: 257, h: 364 },
  { name: 'B5', w: 182, h: 257 },
  { name: 'レター', w: 216, h: 279 },
  { name: 'リーガル', w: 216, h: 356 }
]

/** Paper name only (orientation-agnostic), e.g. "A4" or "210×297mm". */
function paperName(widthPt: number, heightPt: number): string {
  const wmm = widthPt / PT_PER_MM
  const hmm = heightPt / PT_PER_MM
  const longSide = Math.max(wmm, hmm)
  const shortSide = Math.min(wmm, hmm)
  const tol = 4
  for (const p of PAPERS) {
    if (Math.abs(longSide - p.h) <= tol && Math.abs(shortSide - p.w) <= tol) {
      return p.name
    }
  }
  return `${Math.round(wmm)}×${Math.round(hmm)}mm`
}

function sizeLabel(widthPt: number, heightPt: number): string {
  const portrait = heightPt >= widthPt
  const name = paperName(widthPt, heightPt)
  return name.includes('×') ? name : `${name}・${portrait ? '縦' : '横'}`
}

interface ThumbProps {
  index: number
  widthPt: number
  heightPt: number
  refreshKey: number
}

/** Lazily renders a small page image when scrolled into view. */
function Thumb({ index, widthPt, heightPt, refreshKey }: ThumbProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const urlRef = useRef<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const el = ref.current
    if (!el) return

    const render = async (): Promise<void> => {
      const zoom = Math.min(1.5, 150 / widthPt)
      const res = await pdfApi.renderPage(index, zoom)
      if (cancelled) return
      const blob = new Blob([res.png.slice()], { type: 'image/png' })
      const next = URL.createObjectURL(blob)
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = next
      setUrl(next)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          observer.disconnect()
          void render()
        }
      },
      { rootMargin: '300px' }
    )
    observer.observe(el)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [index, widthPt, refreshKey])

  // Revoke the blob URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    },
    []
  )

  const aspect = heightPt > 0 ? widthPt / heightPt : 0.707
  return (
    <div className="thumb-img" ref={ref} style={{ aspectRatio: String(aspect) }}>
      {url ? <img src={url} alt={`page ${index + 1}`} /> : null}
    </div>
  )
}

interface Props {
  doc: DocumentInfo
  width: number
  currentPage: number
  pendingCountByPage: Record<number, number>
  refreshKey: number
  onSelect: (index: number) => void
  onBulkDelete: (indices: number[]) => void
  onBulkRotate: (indices: number[], delta: RotateDelta) => void
}

export default function PageSidebar({
  doc,
  width,
  currentPage,
  pendingCountByPage,
  refreshKey,
  onSelect,
  onBulkDelete,
  onBulkRotate
}: Props): React.JSX.Element {
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const activeRef = useRef<HTMLDivElement>(null)

  // Selection is position-based, so reset it whenever the page set changes.
  useEffect(() => {
    setChecked(new Set())
    anchor.current = null
  }, [doc.pageCount, refreshKey])

  // Follow the main view: scroll the current page's thumbnail into view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentPage])

  const toggle = (index: number): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })

  const checkRange = (from: number, to: number): void => {
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    setChecked((prev) => {
      const next = new Set(prev)
      for (let i = lo; i <= hi; i++) next.add(i)
      return next
    })
  }

  const onItemClick = (index: number, e: React.MouseEvent): void => {
    // Modifier-clicks select without navigating, so multi-selection doesn't
    // make the main view jump around.
    if (e.shiftKey && anchor.current !== null) {
      checkRange(anchor.current, index)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      toggle(index)
      anchor.current = index
      return
    }
    anchor.current = index
    onSelect(index)
  }

  const selectedList = (): number[] => [...checked].sort((a, b) => a - b)
  const clear = (): void => {
    setChecked(new Set())
    anchor.current = null
  }

  const allChecked = checked.size === doc.pageCount && doc.pageCount > 0

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-title">
        <span>ページ ({doc.pageCount})</span>
        <button
          className="link-btn"
          onClick={() =>
            allChecked
              ? clear()
              : setChecked(new Set(doc.pages.map((p) => p.index)))
          }
        >
          {allChecked ? '全解除' : '全選択'}
        </button>
      </div>

      {checked.size > 0 && (
        <div className="bulk-bar">
          <span>{checked.size} ページ選択</span>
          <div className="bulk-actions">
            <button title="左に90°回転" onClick={() => onBulkRotate(selectedList(), -90)}>
              ↺
            </button>
            <button title="右に90°回転" onClick={() => onBulkRotate(selectedList(), 90)}>
              ↻
            </button>
            <button className="danger" title="選択ページを削除" onClick={() => onBulkDelete(selectedList())}>
              削除
            </button>
            <button title="選択を解除" onClick={clear}>
              解除
            </button>
          </div>
        </div>
      )}

      <ul className="page-list">
        {doc.pages.map((p) => {
          const pending = pendingCountByPage[p.index] ?? 0
          const isChecked = checked.has(p.index)
          return (
            <li key={p.index}>
              <div
                ref={p.index === currentPage ? activeRef : undefined}
                className={
                  'page-item' +
                  (p.index === currentPage ? ' active' : '') +
                  (isChecked ? ' checked' : '')
                }
                title="クリック: 表示 / Ctrl+クリック: 複数選択 / Shift+クリック: 範囲選択"
                onClick={(e) => onItemClick(p.index, e)}
              >
                <div className="thumb-top">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => {
                      toggle(p.index)
                      anchor.current = p.index
                    }}
                  />
                  <span className="page-num">{p.index + 1}</span>
                  {p.rotation ? <span className="page-rot">{p.rotation}°</span> : null}
                  {p.origWidth &&
                  p.origHeight &&
                  paperName(p.origWidth, p.origHeight) !==
                    paperName(p.width, p.height) ? (
                    <span className="page-resize">
                      {paperName(p.origWidth, p.origHeight)}→
                      {paperName(p.width, p.height)}
                    </span>
                  ) : null}
                  {pending > 0 && <span className="page-badge">{pending}</span>}
                </div>
                <Thumb
                  index={p.index}
                  widthPt={p.width}
                  heightPt={p.height}
                  refreshKey={refreshKey}
                />
                <span className="page-dims">{sizeLabel(p.width, p.height)}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
