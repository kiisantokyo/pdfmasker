import type { LicenseState } from '@shared/types'

interface Props {
  state: LicenseState | null
  onOpenDialog: () => void
}

/**
 * Slim bar above the toolbar. Hidden while licensed; shows remaining trial days
 * during the trial, and an "expired" prompt once the save gate has closed.
 */
export default function TrialBanner({
  state,
  onOpenDialog
}: Props): React.JSX.Element | null {
  if (!state || state.kind === 'active' || state.kind === 'grace') return null

  const expired = state.kind === 'trial_expired' || state.kind === 'revoked'

  return (
    <div className={'trial-banner' + (expired ? ' expired' : '')}>
      <span className="trial-banner-msg">
        {expired ? '⚠ ' : ''}
        {state.message ??
          (expired ? '試用期間が終了しました' : '試用版')}
        {expired && '（保存・書き出しにはライセンスが必要です）'}
      </span>
      <button className="trial-banner-btn" onClick={onOpenDialog}>
        {expired ? '購入 / キーを入力' : 'ライセンスキーを入力'}
      </button>
    </div>
  )
}
