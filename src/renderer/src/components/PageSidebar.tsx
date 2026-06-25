import type { DocumentInfo } from '@shared/types'

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
                  {Math.round(p.width)}×{Math.round(p.height)}
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
