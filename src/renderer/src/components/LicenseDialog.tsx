import { useState } from 'react'
import type { LicenseState } from '@shared/types'
import { licenseApi } from '../lib/api'

// Lemon Squeezy store/checkout. TODO: point at the actual product checkout URL
// once the paid product is published (currently the store root).
const STORE_URL = 'https://cosmolaw.lemonsqueezy.com'

interface Props {
  state: LicenseState | null
  onClose: () => void
  /** Called with the fresh state after activate / deactivate. */
  onChange: (state: LicenseState) => void
}

export default function LicenseDialog({
  state,
  onClose,
  onChange
}: Props): React.JSX.Element {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const licensed = state?.kind === 'active'

  const activate = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const res = await licenseApi.activate(key)
      if (res.ok) {
        setDone(true)
        onChange(res.state)
      } else {
        setError(res.error ?? 'ライセンスキーを有効化できませんでした。')
      }
    } finally {
      setBusy(false)
    }
  }

  const deactivate = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const next = await licenseApi.deactivate()
      onChange(next)
      setDone(false)
      setKey('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>ライセンス</h2>

        {licensed ? (
          <>
            <p className="modal-desc">
              このPCはライセンス認証済みです。別のPCへ移すときは、いったん
              認証を解除してください。
            </p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={onClose}>
                閉じる
              </button>
              <button
                className="modal-primary danger"
                onClick={deactivate}
                disabled={busy}
              >
                このPCの認証を解除
              </button>
            </div>
          </>
        ) : done ? (
          <>
            <p className="meta-empty">
              ✓ ライセンスを認証しました。すべての機能が使えます。
            </p>
            <div className="modal-actions">
              <button className="modal-primary" onClick={onClose}>
                閉じる
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-desc">
              購入時にメールで届いた<b>ライセンスキー</b>を貼り付けて有効化してください。
              {state?.kind === 'trial_expired' &&
                '試用期間は終了しました。引き続き保存・書き出しを行うにはライセンスが必要です。'}
            </p>

            <div className="field">
              <span className="field-label">ライセンスキー</span>
              <input
                className="text-input"
                type="text"
                placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                spellCheck={false}
                autoFocus
              />
            </div>

            {error && <p className="warn">⚠ {error}</p>}

            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => window.open(STORE_URL, '_blank')}
              >
                購入ページを開く
              </button>
              <button
                className="modal-primary"
                onClick={activate}
                disabled={busy || key.trim().length === 0}
              >
                {busy ? '確認中…' : '有効化する'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
