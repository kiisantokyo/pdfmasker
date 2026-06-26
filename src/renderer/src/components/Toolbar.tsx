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
  onApplyRedactions: () => void
  onClearPending: () => void
  onRedactByTerms: () => void
  onRotateLeft: () => void
  onRotateRight: () => void
  onBindingMargin: () => void
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
        className="danger"
        onClick={props.onApplyRedactions}
        disabled={d || pendingCount === 0}
        title="マークした領域の下にある文字・画像を完全に削除します"
      >
        墨消しを適用 ({pendingCount})
      </button>
      <button onClick={props.onClearPending} disabled={d || pendingCount === 0}>
        マークを消去
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
        ↺ 左回転
      </button>
      <button onClick={props.onRotateRight} disabled={d} title="現在のページを右に90°回転">
        ↻ 右回転
      </button>
      <button onClick={props.onMoveUp} disabled={d}>
        ◀ 前へ
      </button>
      <button onClick={props.onMoveDown} disabled={d}>
        後へ ▶
      </button>
      <button className="danger" onClick={props.onDeletePage} disabled={d}>
        ページ削除
      </button>

      <span className="sep" />

      <button
        onClick={props.onBindingMargin}
        disabled={d}
        title="ホチキスなどの閉じ代を確保するため、中身を縮小して余白を作ります"
      >
        閉じ代
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
