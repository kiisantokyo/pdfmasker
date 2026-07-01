// Pure license logic — NO Electron / Node imports, so it stays unit-testable
// in plain JS. Persistence (files, HMAC) lives in license-store.ts and the
// network/Electron wiring in license-service.ts; both inject what this needs.
//
// Decision space matches 配布収益化レポート §8: a key may be a perpetual
// (buy-once) product key, or a 30-day-expiring 試用 key issued by a ¥0 Lemon
// Squeezy product. Either way the app only asks Lemon Squeezy "is this key
// valid?" — this file decides what that means for the save gate (案1).

import type { LicenseState } from '../shared/types'

export const TRIAL_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** License record as persisted locally (without its HMAC signature). */
export interface StoredLicense {
  licenseKey: string
  instanceId: string
  /** Lemon Squeezy license_key.status: 'active' | 'expired' | 'disabled' | ... */
  status: string
  /** ISO expiry, or null for a perpetual key. */
  expiresAt: string | null
  activationLimit: number | null
  /** ISO timestamp of the last successful online check. */
  lastValidatedAt: string
}

/** Trial record as persisted locally (without its HMAC signature). */
export interface StoredTrial {
  /** ISO timestamp of first launch — the trial clock's origin. */
  firstRunAt: string
  /** ISO timestamp last seen running, for clock-rollback detection. */
  lastSeenAt: string
}

export interface ComputeInput {
  license: StoredLicense | null
  trial: StoredTrial | null
  /** false when the trial file failed its HMAC check (tampered). */
  trialValid: boolean
  nowMs: number
}

/** A stored key is usable when it is active and not past its expiry. */
function isLicenseUsable(license: StoredLicense, nowMs: number): boolean {
  if (license.status !== 'active') return false
  if (license.expiresAt) {
    const exp = Date.parse(license.expiresAt)
    if (Number.isFinite(exp) && exp <= nowMs) return false
  }
  return true
}

/**
 * Compute the single source of truth for the UI and the save gate.
 *
 * Save gate (案1): canSave is true during the trial and while a key is usable;
 * it flips to false only once the trial is over with no usable key.
 */
export function computeState(input: ComputeInput): LicenseState {
  const { license, trial, trialValid, nowMs } = input

  if (license && isLicenseUsable(license, nowMs)) {
    return {
      kind: 'active',
      expiresAt: license.expiresAt,
      canSave: true,
      message: 'ライセンス認証済み'
    }
  }

  // No usable key → fall back to the trial clock.
  const licensePresent = license !== null

  // Tampered or missing trial record → safest assumption is "expired".
  if (!trial || !trialValid) {
    return {
      kind: licensePresent ? 'revoked' : 'trial_expired',
      canSave: false,
      message: licensePresent
        ? 'ライセンスが無効です。キーを再入力してください。'
        : '試用期間が終了しました'
    }
  }

  const firstMs = Date.parse(trial.firstRunAt)
  // Future-dated origin (clock rollback / hand-edit) → treat as expired.
  if (!Number.isFinite(firstMs) || firstMs > nowMs + DAY_MS) {
    return {
      kind: licensePresent ? 'revoked' : 'trial_expired',
      canSave: false,
      message: '試用期間の確認に失敗しました'
    }
  }

  const used = Math.floor((nowMs - firstMs) / DAY_MS)
  const left = TRIAL_DAYS - used
  if (left > 0) {
    return {
      kind: 'trial',
      trialDaysLeft: left,
      canSave: true,
      message: `試用版 — 残り ${left} 日`
    }
  }

  return {
    kind: licensePresent ? 'revoked' : 'trial_expired',
    canSave: false,
    message: licensePresent
      ? 'ライセンスが無効です。キーを再入力してください。'
      : '試用期間が終了しました'
  }
}

// --- Lemon Squeezy License API ------------------------------------------
// Public endpoints keyed by the license itself: no secret API token is
// embedded in the app. See 配布収益化レポート §3-1.

const LS_BASE = 'https://api.lemonsqueezy.com/v1/licenses'

/** Minimal fetch shape so this file needs no DOM/Node lib types. */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ json(): Promise<unknown> }>

interface LsLicenseKey {
  status?: string
  expires_at?: string | null
  activation_limit?: number | null
}
interface LsInstance {
  id?: string
}
interface LsResponse {
  activated?: boolean
  deactivated?: boolean
  valid?: boolean
  error?: string | null
  license_key?: LsLicenseKey
  instance?: LsInstance
}

export interface ActivateOutcome {
  ok: boolean
  error?: string
  instanceId?: string
  status?: string
  expiresAt?: string | null
  activationLimit?: number | null
}

function form(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

async function post(
  fetchFn: FetchFn,
  path: string,
  params: Record<string, string>
): Promise<LsResponse | null> {
  try {
    const res = await fetchFn(`${LS_BASE}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form(params)
    })
    return (await res.json()) as LsResponse
  } catch {
    return null
  }
}

/** Activate a key on this device, registering one Lemon Squeezy instance. */
export async function lsActivate(
  fetchFn: FetchFn,
  key: string,
  instanceName: string
): Promise<ActivateOutcome> {
  const json = await post(fetchFn, '/activate', {
    license_key: key,
    instance_name: instanceName
  })
  if (!json) {
    return { ok: false, error: 'インターネットに接続できませんでした。' }
  }
  if (json.activated && json.instance?.id) {
    return {
      ok: true,
      instanceId: json.instance.id,
      status: json.license_key?.status ?? 'active',
      expiresAt: json.license_key?.expires_at ?? null,
      activationLimit: json.license_key?.activation_limit ?? null
    }
  }
  return {
    ok: false,
    error: json.error ?? 'ライセンスキーを有効化できませんでした。'
  }
}

/** Release this device's activation (for moving to another PC / refunds). */
export async function lsDeactivate(
  fetchFn: FetchFn,
  key: string,
  instanceId: string
): Promise<boolean> {
  const json = await post(fetchFn, '/deactivate', {
    license_key: key,
    instance_id: instanceId
  })
  return json?.deactivated === true
}
