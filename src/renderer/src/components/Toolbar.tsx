interface Props {
  hasDoc: boolean
  pendingCount: number
  zoom: number
  busy: boolean
  dirty: boolean
  onOpen: () => void
  onApplyRedactions: () => void
  onClearPending: () => void
  onRotate: () => void
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

      <span className="sep" />

      <button onClick={props.onRotate} disabled={d}>
        回転 ⟳
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
