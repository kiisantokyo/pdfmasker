import type { SelectMode } from '@shared/types'

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
  onRedact: () => void
  onHighlight: () => void
  onExpandSameWord: () => void
  canExpand: boolean
  onClearPending: () => void
  onRedactByTerms: () => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onBindingMargin: () => void
  onResizePage: () => void
  onDeletePage: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onZoom: (z: number) => void
  onSave: () => void
  onSaveAs: () => void
}

export default function Toolbar(props: Props): React.JSX.Element {
  const { hasDoc, pendingCount, zoom, busy } = props
  const d = !hasDoc || busy
  return (
    <div className="toolbar">
      <button onClick={props.onOpen} disabled={busy}>
        開く…
      </button>

      <span className="sep" />

      <button
        onClick={props.onUndo}
        disabled={!props.canUndo || busy}
        title="元に戻す (Ctrl+Z)"
      >
        ↶ 元に戻す
      </button>
      <button
        onClick={props.onRedo}
        disabled={!props.canRedo || busy}
        title="やり直す (Ctrl+Y)"
      >
        ↷ やり直す
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

      <button
        className="act act-redact"
        onClick={props.onRedact}
        disabled={d || pendingCount === 0}
        title="選択した範囲の下にある文字・画像を完全に削除します"
      >
        <span className="act-icon">■</span>墨
        <span className="act-count">{pendingCount}</span>
      </button>
      <button
        className="act act-highlight"
        onClick={props.onHighlight}
        disabled={d || pendingCount === 0}
        title="選択した範囲に薄い黄色のマーカーを引きます（非破壊）"
      >
        <span className="act-icon">▥</span>黄
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
        onClick={props.onRedactByTerms}
        disabled={d}
        title="AIに依頼するプロンプト生成、結果の貼り戻し、または固有名詞の自動抽出"
      >
        AI連携/固有名詞…
      </button>

      <span className="sep" />

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
        🗑
      </button>

      <span className="sep" />

      <button
        onClick={props.onBindingMargin}
        disabled={d}
        title="ホチキスなどの閉じ代を確保するため、中身を縮小して余白を作ります"
      >
        閉じ代
      </button>

      <button
        onClick={props.onResizePage}
        disabled={d}
        title="ページの用紙サイズを変更します（B5→A4 など）"
      >
        用紙サイズ
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

      <button onClick={props.onSave} disabled={d}>
        保存{props.dirty ? ' *' : ''}
      </button>
      <button onClick={props.onSaveAs} disabled={d}>
        名前を付けて保存…
      </button>
    </div>
  )
}
