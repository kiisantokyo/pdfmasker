import type { DocumentInfo } from '@shared/types'

const PT_PER_MM = 72 / 25.4

// Standard paper sizes in mm (portrait). Matched in either orientation.
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

/** Human-friendly size label: paper name + orientation, or mm fallback. */
function sizeLabel(widthPt: number, heightPt: number): string {
  const wmm = widthPt / PT_PER_MM
  const hmm = heightPt / PT_PER_MM
  const portrait = hmm >= wmm
  const longSide = Math.max(wmm, hmm)
  const shortSide = Math.min(wmm, hmm)
  const tol = 4 // mm
  for (const p of PAPERS) {
    if (Math.abs(longSide - p.h) <= tol && Math.abs(shortSide - p.w) <= tol) {
      return `${p.name}・${portrait ? '縦' : '横'}`
    }
  }
  return `${Math.round(wmm)}×${Math.round(hmm)} mm`
}

interface Props {
  doc: DocumentInfo
  currentPage: number
  pendingCountByPage: Record<number, number>
  onSelect: (index: number) => void
}

export default function PageSidebar({
  doc,
  currentPage,
  pendingCountByPage,
  onSelect
}: Props): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar-title">ページ ({doc.pageCount})</div>
      <ul className="page-list">
        {doc.pages.map((p) => {
          const pending = pendingCountByPage[p.index] ?? 0
          return (
            <li key={p.index}>
              <button
                className={
                  'page-item' + (p.index === currentPage ? ' active' : '')
                }
                onClick={() => onSelect(p.index)}
              >
                <span className="page-num">{p.index + 1}</span>
                <span className="page-dims">
                  {sizeLabel(p.width, p.height)}
                  {p.rotation ? ` · ${p.rotation}°` : ''}
                </span>
                {pending > 0 && <span className="page-badge">{pending}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
