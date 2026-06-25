import { useState } from 'react'
import type { RedactionRect, TermCount } from '@shared/types'
import { pdfApi } from '../lib/api'

interface Props {
  onClose: () => void
  onAddRects: (rects: RedactionRect[], summary: string) => void
}

/** Pull candidate redaction terms out of pasted markdown instructions. */
function parseMarkdown(md: string): string[] {
  const terms = new Set<string>()
  const spanRes = [
    /`([^`]+)`/g,
    /\*\*([^*]+)\*\*/g,
    /"([^"]+)"/g,
    /「([^」]+)」/g,
    /『([^』]+)』/g
  ]
  for (const rawLine of md.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line) continue
    line = line.replace(/^([#>\-*+]|\d+[.)])\s*/, '').trim()
    for (const re of spanRes) {
      for (const m of line.matchAll(re)) terms.add(m[1].trim())
    }
    const plain = line.replace(/[`*_]/g, '').trim()
    if (plain && plain.length <= 40) {
      for (const part of plain.split(/[、,，]/)) {
        const p = part.trim()
        if (p) terms.add(p)
      }
    }
  }
  return [...terms].filter((t) => t.length >= 1)
}

export default function RedactByTermsModal({
  onClose,
  onAddRects
}: Props): React.JSX.Element {
  const [terms, setTerms] = useState<TermCount[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(false)
  const [note, setNote] = useState('「自動抽出」するか、外部AIの指示をMarkdownで貼り付けてください。')

  const autoExtract = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await pdfApi.extractCandidates()
      setTerms(result)
      setChecked(new Set()) // user decides which to redact
      setNote(
        result.length
          ? `${result.length} 件の候補を抽出しました。墨消しする語にチェックしてください。`
          : '候補が見つかりませんでした（画像化PDFの可能性）。'
      )
    } finally {
      setLoading(false)
    }
  }

  const loadMarkdown = async (): Promise<void> => {
    const parsed = parseMarkdown(markdown)
    if (parsed.length === 0) {
      setNote('指示から用語を抽出できませんでした。')
      return
    }
    setLoading(true)
    try {
      const result = await pdfApi.countTerms(parsed)
      setTerms(result)
      setChecked(new Set(result.map((t) => t.term))) // explicit list → all on
      setNote(
        result.length
          ? `${parsed.length} 語のうち ${result.length} 語が文書内で見つかりました。`
          : '指定された語は文書内に見つかりませんでした。'
      )
    } finally {
      setLoading(false)
    }
  }

  const toggle = (term: string): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(term)) next.delete(term)
      else next.add(term)
      return next
    })
  }

  const apply = async (): Promise<void> => {
    const selected = [...checked]
    if (selected.length === 0) return
    setLoading(true)
    try {
      const rects = await pdfApi.findTerms(selected)
      onAddRects(
        rects,
        `${selected.length} 語・${rects.length} 箇所をマークしました。`
      )
      onClose()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>固有名詞・指示から墨消し</h2>
        <p className="modal-desc">{note}</p>

        <div className="terms-tools">
          <button onClick={autoExtract} disabled={loading}>
            文書から自動抽出
          </button>
          <span className="terms-sub">または外部AIの指示を貼り付け：</span>
        </div>

        <textarea
          className="md-input"
          placeholder={
            '例:\n- 山田太郎\n- 株式会社サンプル\n- yamada@example.com'
          }
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
        />
        <div className="terms-tools">
          <button onClick={loadMarkdown} disabled={loading || !markdown.trim()}>
            指示を読み込む
          </button>
        </div>

        {terms.length > 0 && (
          <>
            <div className="terms-head">
              <span>
                候補 {terms.length} 件 / 選択 {checked.size} 件
              </span>
              <span className="terms-selectors">
                <button onClick={() => setChecked(new Set(terms.map((t) => t.term)))}>
                  全選択
                </button>
                <button onClick={() => setChecked(new Set())}>解除</button>
              </span>
            </div>
            <ul className="terms-list">
              {terms.map((t) => (
                <li key={t.term}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked.has(t.term)}
                      onChange={() => toggle(t.term)}
                    />
                    <span className="term-text">{t.term}</span>
                    {t.kind && <span className="term-kind">{t.kind}</span>}
                    <span className="term-count">{t.count}件</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="modal-primary"
            onClick={apply}
            disabled={loading || checked.size === 0}
          >
            選択した語を墨消し対象に追加
          </button>
        </div>
      </div>
    </div>
  )
}
