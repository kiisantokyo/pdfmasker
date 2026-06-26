import { useState } from 'react'
import type { RedactionRect } from '@shared/types'
import { pdfApi } from '../lib/api'

interface Props {
  onClose: () => void
  onAddRects: (rects: RedactionRect[], summary: string) => void
}

type Scope = 'all' | 'first'

interface Candidate {
  text: string
  count: number
  kind?: string
  reason?: string
  scope: Scope
}

const CATEGORIES = [
  '個人名',
  '住所',
  '電話番号',
  'メールアドレス',
  '会社・組織名',
  '金額',
  '日付・期間',
  '生年月日',
  'マイナンバー・ID・口座番号',
  'URL'
]

/** Pull candidate terms out of pasted markdown / bullet lists. */
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

/** Extract a JSON object from text that may be fenced or wrapped in prose. */
function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : text
  const s = body.indexOf('{')
  const e = body.lastIndexOf('}')
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(body.slice(s, e + 1))
    } catch {
      return null
    }
  }
  return null
}

interface ParsedItem {
  text: string
  reason?: string
  scope: Scope
}

function parsePlan(text: string): { items: ParsedItem[]; usedJson: boolean } {
  const json = extractJson(text) as { redactions?: unknown } | null
  if (json && Array.isArray(json.redactions)) {
    const items: ParsedItem[] = []
    for (const r of json.redactions as Record<string, unknown>[]) {
      if (r && typeof r.text === 'string' && r.text.trim()) {
        items.push({
          text: r.text.trim(),
          reason: typeof r.reason === 'string' ? r.reason : undefined,
          scope: r.scope === 'first' ? 'first' : 'all'
        })
      }
    }
    return { items, usedJson: true }
  }
  return {
    items: parseMarkdown(text).map((t) => ({ text: t, scope: 'all' as Scope })),
    usedJson: false
  }
}

function buildPrompt(cats: string[], freeText: string, docText?: string): string {
  const L: string[] = []
  L.push('あなたはPDF文書の墨消し（黒塗り）を支援するアシスタントです。')
  L.push(
    `添付したPDF${docText ? '（または末尾の本文）' : ''}を読み、墨消しすべき箇所を抽出してください。`
  )
  L.push('')
  L.push('# 墨消しの対象')
  if (cats.length) for (const c of cats) L.push(`- ${c}`)
  else L.push('- 個人情報・機密情報と判断されるもの全般')
  L.push('')
  L.push('# 追加の指示')
  L.push(freeText.trim() || '（特になし）')
  L.push('')
  L.push('# 出力形式（厳守）')
  L.push('- 下記スキーマの JSON だけを出力してください。前後に説明文を付けないでください。')
  L.push('- "text" は文書中に現れる正確な文字列にしてください（アプリ側で文字列検索して一致させます）。')
  L.push('- 同一の文字列は1回だけ。短すぎる一般的な語（「会社」「住所」等）は避けてください。')
  L.push('- "scope" は "all"（すべての出現を墨消し）か "first"（最初の1件のみ）。')
  L.push('- "reason" には分類（例: 個人名）を簡潔に。')
  L.push('')
  L.push('```json')
  L.push('{')
  L.push('  "redactions": [')
  L.push('    { "text": "山田太郎", "reason": "個人名", "scope": "all" }')
  L.push('  ]')
  L.push('}')
  L.push('```')
  if (docText) {
    L.push('')
    L.push('# 文書本文')
    L.push(docText)
  }
  return L.join('\n')
}

export default function RedactByTermsModal({
  onClose,
  onAddRects
}: Props): React.JSX.Element {
  const [tab, setTab] = useState<'ask' | 'apply'>('ask')

  // --- Ask tab ---
  const [cats, setCats] = useState<Set<string>>(
    new Set(['個人名', '住所', '電話番号', 'メールアドレス'])
  )
  const [freeText, setFreeText] = useState('')
  const [embedText, setEmbedText] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [copied, setCopied] = useState(false)

  // --- Apply tab ---
  const [paste, setPaste] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)

  const toggleCat = (c: string): void =>
    setCats((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const generate = async (): Promise<void> => {
    setLoading(true)
    try {
      const docText = embedText ? await pdfApi.documentText() : undefined
      setPrompt(buildPrompt([...cats], freeText, docText))
      setCopied(false)
    } finally {
      setLoading(false)
    }
  }

  const copyPrompt = (): void => {
    if (!prompt) return
    pdfApi.writeClipboard(prompt)
    setCopied(true)
  }

  const autoExtract = async (): Promise<void> => {
    setLoading(true)
    try {
      const result = await pdfApi.extractCandidates()
      setCandidates(
        result.map((t) => ({
          text: t.term,
          count: t.count,
          kind: t.kind,
          scope: 'all' as Scope
        }))
      )
      setChecked(new Set())
      setNote(
        result.length
          ? `${result.length} 件の候補を抽出しました。墨消しする語にチェックしてください。`
          : '候補が見つかりませんでした（画像化PDFの可能性）。'
      )
    } finally {
      setLoading(false)
    }
  }

  const loadPlan = async (): Promise<void> => {
    const { items, usedJson } = parsePlan(paste)
    if (items.length === 0) {
      setNote('貼り付けた内容から用語を抽出できませんでした。')
      return
    }
    setLoading(true)
    try {
      const counts = await pdfApi.countTerms(items.map((i) => i.text))
      const countMap = new Map(counts.map((c) => [c.term, c.count]))
      const cands: Candidate[] = items.map((i) => ({
        text: i.text,
        reason: i.reason,
        scope: i.scope,
        count: countMap.get(i.text) ?? 0
      }))
      setCandidates(cands)
      setChecked(new Set(cands.filter((c) => c.count > 0).map((c) => c.text)))
      const found = cands.filter((c) => c.count > 0).length
      const miss = cands.length - found
      setNote(
        `${cands.length} 件中 ${found} 件が文書内で見つかりました` +
          (miss ? `（${miss} 件は不一致＝チェック不可）` : '') +
          (usedJson ? '' : '（Markdownとして解析）')
      )
    } finally {
      setLoading(false)
    }
  }

  const toggle = (text: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(text)) next.delete(text)
      else next.add(text)
      return next
    })

  const apply = async (): Promise<void> => {
    const selected = candidates.filter((c) => checked.has(c.text) && c.count > 0)
    if (selected.length === 0) return
    setLoading(true)
    try {
      const rects = await pdfApi.findTermsScoped(
        selected.map((c) => ({ text: c.text, scope: c.scope }))
      )
      onAddRects(
        rects,
        `${selected.length} 語・${rects.length} 箇所をマークしました。`
      )
      onClose()
    } finally {
      setLoading(false)
    }
  }

  const docCharsWarning = embedText ? '（本文を含めるとプロンプトが長くなります）' : ''

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>AI連携で墨消し</h2>

        <div className="tabs">
          <button
            className={'tab' + (tab === 'ask' ? ' active' : '')}
            onClick={() => setTab('ask')}
          >
            ① AIに依頼するプロンプト
          </button>
          <button
            className={'tab' + (tab === 'apply' ? ' active' : '')}
            onClick={() => setTab('apply')}
          >
            ② 結果を貼り戻す / 自動抽出
          </button>
        </div>

        {tab === 'ask' && (
          <div className="tab-body">
            <p className="modal-desc">
              墨消し方針を選んでプロンプトを生成し、コピーして ChatGPT / Gemini
              に貼り付け、PDFを添付して送信してください。返ってきた結果は②タブで貼り戻します。
            </p>
            <div className="field">
              <span className="field-label">墨消ししたいカテゴリ</span>
              <div className="cat-grid">
                {CATEGORIES.map((c) => (
                  <label key={c} className="cat">
                    <input
                      type="checkbox"
                      checked={cats.has(c)}
                      onChange={() => toggleCat(c)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">追加の指示（任意）</span>
              <input
                className="text-input"
                placeholder="例: 役職名は残す / 自社名「サンプル社」は墨消ししない"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
              />
            </div>
            <label className="radio">
              <input
                type="checkbox"
                checked={embedText}
                onChange={(e) => setEmbedText(e.target.checked)}
              />
              文書本文もプロンプトに含める（ファイル添付できないAI向け）{docCharsWarning}
            </label>

            <div className="terms-tools">
              <button onClick={generate} disabled={loading}>
                プロンプトを生成
              </button>
              <button onClick={copyPrompt} disabled={!prompt}>
                {copied ? 'コピーしました ✓' : 'クリップボードにコピー'}
              </button>
            </div>
            <textarea
              className="md-input prompt-area"
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value)
                setCopied(false)
              }}
              placeholder="「プロンプトを生成」を押すとここに表示されます（編集可）。"
            />
            <p className="warn">
              ⚠ この手順では PDF / 本文を外部AIに送信します（あなたの操作）。機密性にご注意ください。
            </p>
          </div>
        )}

        {tab === 'apply' && (
          <div className="tab-body">
            <p className="modal-desc">
              AIが返した結果（JSON / 箇条書き）を貼り付けて読み込むか、文書から自動抽出します。
              {note && <> <b>{note}</b></>}
            </p>
            <textarea
              className="md-input"
              placeholder={'AIの出力（JSON推奨）をここに貼り付け'}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
            />
            <div className="terms-tools">
              <button onClick={loadPlan} disabled={loading || !paste.trim()}>
                貼り付けた結果を読み込む
              </button>
              <span className="terms-sub">または</span>
              <button onClick={autoExtract} disabled={loading}>
                文書から自動抽出（オフライン）
              </button>
            </div>

            {candidates.length > 0 && (
              <>
                <div className="terms-head">
                  <span>
                    候補 {candidates.length} 件 / 選択 {checked.size} 件
                  </span>
                  <span className="terms-selectors">
                    <button
                      onClick={() =>
                        setChecked(
                          new Set(
                            candidates.filter((c) => c.count > 0).map((c) => c.text)
                          )
                        )
                      }
                    >
                      全選択
                    </button>
                    <button onClick={() => setChecked(new Set())}>解除</button>
                  </span>
                </div>
                <ul className="terms-list">
                  {candidates.map((c) => (
                    <li key={c.text}>
                      <label className={c.count === 0 ? 'term-missing' : ''}>
                        <input
                          type="checkbox"
                          disabled={c.count === 0}
                          checked={checked.has(c.text)}
                          onChange={() => toggle(c.text)}
                        />
                        <span className="term-text">{c.text}</span>
                        {(c.reason || c.kind) && (
                          <span className="term-kind">{c.reason || c.kind}</span>
                        )}
                        {c.scope === 'first' && (
                          <span className="term-scope">最初のみ</span>
                        )}
                        <span className="term-count">
                          {c.count === 0 ? '不一致' : `${c.count}件`}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={onClose}>
            閉じる
          </button>
          {tab === 'apply' && (
            <button
              className="modal-primary"
              onClick={apply}
              disabled={loading || checked.size === 0}
            >
              選択した語を墨消し対象に追加
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
