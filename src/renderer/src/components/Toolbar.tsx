import { useEffect, useRef, useState } from 'react'
import type { SelectMode } from '@shared/types'
import ColorApplyButton from './ColorApplyButton'
import type { ColorChoice } from '../lib/colors'
import { HIGHLIGHT_COLORS, REDACT_COLORS } from '../lib/colors'

interface Props {
  hasDoc: boolean
  pendingCount: number
  zoom: number
  busy: boolean
  dirty: boolean
  selectMode: SelectMode
  canUndo: boolean
  canRedo: boolean
  onToggleSelectMode: () => void
  onUndo: () => void
  onRedo: () => void
  onOpen: () => void
  onClose: () => void
  onRedact: () => void
  onHighlight: () => void
  onMosaic: () => void
  /** Selected 墨消し / マーカー colours and their setters (split-button palette). */
  redactColor: ColorChoice
  onRedactColor: (c: ColorChoice) => void
  highlightColor: ColorChoice
  onHighlightColor: (c: ColorChoice) => void
  onExpandSameWord: () => void
  canExpand: boolean
  onSearchAdd: (keyword: string) => void
  onClearPending: () => void
  onRedactByTerms: () => void
  onHiddenText: () => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onBindingMargin: () => void
  onPageNumbers: () => void
  onStamp: () => void
  textMode: boolean
  onToggleTextMode: () => void
  /** Count of not-yet-applied text boxes; enables the 「文字(N)」 apply button. */
  textCount: number
  onApplyText: () => void
  onResizePage: () => void
  onClearMetadata: () => void
  onDeletePage: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onZoom: (z: number) => void
  onSave: () => void
  onSaveSized: () => void
  onCopyImage: () => void
  onCopyRegion: () => void
  onCleanForSubmission: () => void
  onCompareText: () => void
  onCheckResidual: () => void
  onReview: () => void
}

export default function Toolbar(props: Props): React.JSX.Element {
  const { hasDoc, pendingCount, zoom, busy } = props
  const d = !hasDoc || busy
  const [kw, setKw] = useState('')
  const [saveMenu, setSaveMenu] = useState(false)
  const saveRef = useRef<HTMLDivElement>(null)
  const submitSearch = (): void => {
    if (kw.trim()) props.onSearchAdd(kw)
  }
  // Close the save dropdown when clicking elsewhere.
  useEffect(() => {
    if (!saveMenu) return
    const onDown = (e: MouseEvent): void => {
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) {
        setSaveMenu(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [saveMenu])
  return (
    <div className="toolbar">
      {/* Row 1 — 選択・墨消しの主作業 */}
      <div className="toolbar-row">
        <span className="toolbar-group-label">墨消し：</span>
        <button onClick={props.onOpen} disabled={busy}>
          開く…
        </button>
        <button onClick={props.onClose} disabled={d} title="ファイルを閉じて最初の画面に戻ります">
          閉じる
        </button>

        <span className="sep" />

        <button
          onClick={props.onToggleSelectMode}
          disabled={d}
          title="ドラッグの選択方法を切り替えます（文字をなぞる／四角で囲む）"
        >
          {props.selectMode === 'text' ? '選択：文字なぞり' : '選択：四角'}
        </button>

        <span className="sep" />

        <ColorApplyButton
          label="墨消し"
          count={pendingCount}
          disabled={d}
          colors={REDACT_COLORS}
          selected={props.redactColor}
          onSelect={props.onRedactColor}
          onApply={props.onRedact}
          applyClass="act act-redact"
          title="選択した範囲の下にある文字・画像を完全に削除し、選んだ色で覆います（白＝塗らずに削除のみ）"
        />
        <ColorApplyButton
          label="マーカー"
          count={pendingCount}
          disabled={d}
          colors={HIGHLIGHT_COLORS}
          selected={props.highlightColor}
          onSelect={props.onHighlightColor}
          onApply={props.onHighlight}
          applyClass="act act-highlight"
          title="選択した範囲に選んだ色の薄いマーカーを引きます（非破壊）"
        />
        <button
          className="act act-mosaic"
          onClick={props.onMosaic}
          disabled={d || pendingCount === 0}
          title="選択した範囲の下にある文字・画像を完全に削除し、モザイク（ぼかし）で覆います"
        >
          <span className="act-icon">▦</span>モザイク
          <span className="act-count">{pendingCount}</span>
        </button>
        <button
          onClick={props.onExpandSameWord}
          disabled={d || !props.canExpand}
          title="直前に選んだ文字列と同じ語を文書内から探して選択に追加します"
        >
          同語＋
        </button>
        <button
          onClick={props.onClearPending}
          disabled={d || pendingCount === 0}
          title="選択をクリア"
        >
          ✕
        </button>
        <button
          onClick={props.onReview}
          disabled={d || pendingCount === 0}
          title="選択中（未適用）の一覧を開き、個別に削除したり理由メモを付けられます"
        >
          一覧 {pendingCount}
        </button>

        <span className="search-box">
          <input
            type="text"
            className="search-input"
            placeholder="キーワードで検索"
            value={kw}
            disabled={d}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch()
            }}
          />
          <button
            onClick={submitSearch}
            disabled={d || !kw.trim()}
            title="入力した語を文書内から検索し、選択に追加します"
          >
            🔍 追加
          </button>
        </span>
        <button
          onClick={props.onRedactByTerms}
          disabled={d}
          title="AIに依頼するプロンプト生成、結果の貼り戻し、または固有名詞の自動抽出"
        >
          AI連携/固有名詞…
        </button>

        <span className="sep" />

        <button
          onClick={props.onUndo}
          disabled={!props.canUndo || busy}
          title="元に戻す (Ctrl+Z)"
        >
          ↶
        </button>
        <button
          onClick={props.onRedo}
          disabled={!props.canRedo || busy}
          title="やり直す (Ctrl+Y)"
        >
          ↷
        </button>
      </div>

      {/* Row 2 — ページ・文書の編集と保存 */}
      <div className="toolbar-row">
        <span className="toolbar-group-label">編集：</span>
        <button onClick={props.onRotateLeft} disabled={d} title="現在のページを左に90°回転">
          ↺ 左
        </button>
        <button onClick={props.onRotateRight} disabled={d} title="現在のページを右に90°回転">
          ↻ 右
        </button>
        <button onClick={props.onMoveUp} disabled={d} title="現在のページを前へ移動">
          ◀ 前
        </button>
        <button onClick={props.onMoveDown} disabled={d} title="現在のページを後へ移動">
          後 ▶
        </button>
        <button
          className="danger"
          onClick={props.onDeletePage}
          disabled={d}
          title="現在のページを削除"
        >
          🗑 ページ削除
        </button>

        <span className="sep" />

        <button
          onClick={props.onBindingMargin}
          disabled={d}
          title="ホチキスなどの閉じ代を確保するため、中身を縮小して余白を作ります"
        >
          <BindingIcon />
          閉じ代
        </button>

        <button
          onClick={props.onResizePage}
          disabled={d}
          title="ページの用紙サイズを変更します（B5→A4 など）"
        >
          用紙サイズ
        </button>

        <button
          onClick={props.onPageNumbers}
          disabled={d}
          title="ページ番号（ノンブル）を下中央に付けます"
        >
          № ページ番号
        </button>

        <button
          onClick={props.onStamp}
          disabled={d}
          title="「秘」「社外秘」などの赤いスタンプを押します"
        >
          🔴 スタンプ
        </button>

        <button
          className={props.textMode ? 'active' : ''}
          onClick={props.onToggleTextMode}
          disabled={d}
          title="クリックした位置に文字を書き込みます（フォームの記入・注記など）。適用するまで自由に編集・移動できます"
        >
          ✏️ 文字入れ
        </button>

        <button
          className="act act-text"
          onClick={props.onApplyText}
          disabled={d || props.textCount === 0}
          title="書き込んだ文字を本物の文字としてPDFに反映します（画像化ではありません。元に戻すで取消可）"
        >
          文字<span className="act-count">{props.textCount}</span>
        </button>

        <span className="sep" />

        <label className="zoom">
          拡大
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.25}
            value={zoom}
            disabled={d}
            onChange={(e) => props.onZoom(Number(e.target.value))}
          />
          <span className="zoom-val">{Math.round(zoom * 100)}%</span>
        </label>

        <span className="spacer" />

        <div className="split-btn" ref={saveRef}>
          <button
            className="split-main"
            onClick={props.onSave}
            disabled={d}
            title="現在のファイルに保存します"
          >
            保存{props.dirty ? ' *' : ''}
          </button>
          <button
            className="split-caret"
            onClick={() => setSaveMenu((v) => !v)}
            disabled={d}
            title="保存メニュー"
            aria-haspopup="menu"
            aria-expanded={saveMenu}
          >
            ▼
          </button>
          {saveMenu && (
            <div className="split-menu" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setSaveMenu(false)
                  props.onSave()
                }}
              >
                保存（上書き）
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setSaveMenu(false)
                  props.onSaveSized()
                }}
                title="通常PDF／パスワード付きPDF／画像化PDF／PNG画像から選んで保存します"
              >
                名前を付けて保存…
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setSaveMenu(false)
                  props.onCopyImage()
                }}
                title="現在のページを画像としてクリップボードにコピーします（Ctrl+C）"
              >
                クリップボードにコピー（Ctrl + C）
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setSaveMenu(false)
                  props.onCopyRegion()
                }}
                title="ドラッグした矩形の範囲だけを画像としてクリップボードにコピーします"
              >
                クリップボードにコピー（矩形選択）…
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Row 3 — 提出前の安全処理（隠し情報の確認・除去） */}
      <div className="toolbar-row toolbar-row-security">
        <span className="toolbar-group-label">提出前チェック：</span>
        <button
          onClick={props.onClearMetadata}
          disabled={d}
          title="作成者・作成日時・作成アプリ名などの文書プロパティ（XMP含む）を確認し、消去します"
        >
          プロパティ確認・消去
        </button>
        <button
          onClick={props.onHiddenText}
          disabled={d}
          title="画面に表示されない隠し文字（透明テキスト）を確認し、削除します"
        >
          隠し文字を確認・削除
        </button>
        <button
          onClick={props.onCompareText}
          disabled={d}
          title="各ページをOCRして「見えている文字」と「埋め込み文字」を照合し、あらゆる隠し方の文字を洗い出します（時間がかかります）"
        >
          隠し文字の徹底照合（OCR）
        </button>
        <button
          onClick={props.onCleanForSubmission}
          disabled={d}
          title="提出前に、隠し文字・文書プロパティ・添付ファイル・JavaScriptをまとめて除去します（元に戻す可）"
        >
          提出前クリーニング
        </button>
        <button
          onClick={props.onCheckResidual}
          disabled={d}
          title="この作業中に単語クリック・検索・AIで選んだ語が、文書内にまだ残っていないか（墨消し漏れがないか）を確認します"
        >
          墨消し漏れチェック
        </button>
      </div>
    </div>
  )
}

/** A document with two staples on its left edge — icon for 閉じ代. */
function BindingIcon(): React.JSX.Element {
  return (
    <svg
      className="ico-binding"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <rect
        x="5"
        y="2"
        width="9"
        height="12"
        rx="1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect x="1.8" y="3.6" width="3.8" height="1.6" rx="0.6" fill="currentColor" />
      <rect x="1.8" y="8.6" width="3.8" height="1.6" rx="0.6" fill="currentColor" />
    </svg>
  )
}
