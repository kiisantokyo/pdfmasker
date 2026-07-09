// Orchestrator the IPC layer calls. Glues the pure logic (license-core) to
// persistence (license-store) and the network (global fetch). Keeps getState()
// synchronous so the save gate can consult it inline.

import { hostname } from 'node:os'
import type { ActivateResult, LicenseState } from '../shared/types'
import { lsActivate, lsDeactivate, type FetchFn } from './license-core'
import { clearLicense, readLicense, writeLicense } from './license-store'

// Electron's main process runs on Node, which exposes a global fetch.
const fetchFn = globalThis.fetch as unknown as FetchFn

/** A human-friendly label for this device's Lemon Squeezy activation. */
function instanceName(): string {
  try {
    return `究極の墨消し @ ${hostname()}`
  } catch {
    return '究極の墨消し'
  }
}

/** The current license state — single source of truth for UI + save gate. */
export function getState(): LicenseState {
  // The app is now free: no trial clock, no license key, saving always allowed.
  return { kind: 'free', canSave: true, expiresAt: null }
}

/** Activate a key on this device via Lemon Squeezy, then persist it. */
export async function activate(key: string): Promise<ActivateResult> {
  const trimmed = key.trim()
  if (!trimmed) {
    return { ok: false, state: getState(), error: 'キーを入力してください。' }
  }
  const outcome = await lsActivate(fetchFn, trimmed, instanceName())
  if (!outcome.ok || !outcome.instanceId) {
    return { ok: false, state: getState(), error: outcome.error }
  }
  writeLicense({
    licenseKey: trimmed,
    instanceId: outcome.instanceId,
    status: outcome.status ?? 'active',
    expiresAt: outcome.expiresAt ?? null,
    activationLimit: outcome.activationLimit ?? null,
    lastValidatedAt: new Date().toISOString()
  })
  return { ok: true, state: getState() }
}

/** Release this device's activation and drop the local license. */
export async function deactivate(): Promise<LicenseState> {
  const license = readLicense()
  if (license) {
    // Best-effort: even if the network call fails, free the local slot so the
    // user isn't stuck. The Lemon Squeezy dashboard can revoke server-side.
    await lsDeactivate(fetchFn, license.licenseKey, license.instanceId)
    clearLicense()
  }
  return getState()
}
