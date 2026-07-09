import type { HiddenTextReport } from '@shared/types'

interface Props {
  report: HiddenTextReport
  busy: boolean
  onClose: () => void
  onRemove: () => void
}

/**
 * Shows invisible/hidden text found in the document (e.g. a poisoned OCR layer
 * an adversary embedded) and lets the user delete it. The preview lets a human
 * confirm what would be removed before doing so.
 */
export default function HiddenTextModal(props: Props): React.JSX.Element {
  const { report, busy } = props
  const has = report.runs > 0

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>隠し文字（透明テキスト）の確認</h2>
        <p className="modal-desc">
          画面には表示されないのに埋め込まれている文字（OCRの読み取り結果や、
          透明で重ねられたテキストなど）です。検索・コピー・AI分析では読み取られてしまい、
          相手方へ渡すと「見えている以上の情報」を渡すことになります。
        </p>

        {has ? (
          <>
            <p className="hidden-count">
              <b>{report.runs} 箇所</b>の隠し文字が見つかりました。
            </p>
            <div className="hidden-preview">
              {report.items.map((it) => (
                <div key={it.page} className="hidden-item">
                  <span className="hidden-page">P.{it.page + 1}</span>
                  <span className="hidden-text">{it.text}</span>
                </div>
              ))}
            </div>
            <p className="modal-warn">
              ⚠ 削除すると、これらは検索・コピー・抽出できなくなります（見た目は変わりません）。
              このPDF内の文字検索・コピーもできなくなる場合があります。相手方へ渡す最終版に対して
              実行することをおすすめします。元に戻す（Ctrl+Z）で復元できます。
            </p>
          </>
        ) : (
          <p className="meta-empty">
            ✓ このファイルに、画面に表示されない隠し文字は見つかりませんでした。
          </p>
        )}

        <div className="modal-actions">
          <button className="modal-cancel" onClick={props.onClose}>
            閉じる
          </button>
          {has && (
            <button
              className="modal-primary danger"
              onClick={props.onRemove}
              disabled={busy}
            >
              隠し文字を削除する
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
