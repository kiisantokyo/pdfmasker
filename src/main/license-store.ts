// Local persistence for license + trial records, under the app's userData
// folder. Each file carries an HMAC signature so a hand-edit is detected
// (tampered → ignored / treated as expired, see license-core.computeState).
//
// Honest scope (配布収益化レポート §8-2): this is casual-grade protection.
// Under MSIX the userData folder is virtualised and wiped on uninstall, so a
// determined reset is possible; the robust answer is §8-1 (a ¥0 Lemon Squeezy
// 試用 key whose expiry lives server-side), which this same code activates
// through license-core with no changes.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import type { StoredLicense, StoredTrial } from './license-core'

// Obfuscation key for the integrity HMAC. Not a real secret (a leak only lets
// someone reset their own trial), so an embedded constant is acceptable.
const SIGN_KEY = 'pmsk_v1_3b9f1c7a2e8d40516a7c9f0b4d2e6810'

const LICENSE_FILE = 'license.json'
const TRIAL_FILE = 'trial.json'

function filePath(name: string): string {
  return join(app.getPath('userData'), name)
}

function sign(payload: string): string {
  return createHmac('sha256', SIGN_KEY).update(payload).digest('hex')
}

/** Read a signed record; returns the data only when the signature verifies. */
function readSigned<T>(name: string): { data: T | null; valid: boolean } {
  const path = filePath(name)
  if (!existsSync(path)) return { data: null, valid: false }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      data: T
      sig: string
    }
    if (!raw || typeof raw.sig !== 'string') return { data: null, valid: false }
    const expected = sign(JSON.stringify(raw.data))
    if (expected !== raw.sig) return { data: null, valid: false }
    return { data: raw.data, valid: true }
  } catch {
    return { data: null, valid: false }
  }
}

function writeSigned<T>(name: string, data: T): void {
  const payload = { data, sig: sign(JSON.stringify(data)) }
  writeFileSync(filePath(name), JSON.stringify(payload), 'utf8')
}

// --- License -------------------------------------------------------------

/** The stored license, or null when absent or tampered with. */
export function readLicense(): StoredLicense | null {
  return readSigned<StoredLicense>(LICENSE_FILE).data
}

export function writeLicense(data: StoredLicense): void {
  writeSigned(LICENSE_FILE, data)
}

export function clearLicense(): void {
  // Overwrite with an empty, signed marker rather than deleting, so a stale
  // unsigned file can't be dropped in to fake a license.
  writeFileSync(filePath(LICENSE_FILE), JSON.stringify({ data: null, sig: '' }))
}

// --- Trial ---------------------------------------------------------------

/** The stored trial record plus whether its signature verified. */
export function readTrial(): { data: StoredTrial | null; valid: boolean } {
  return readSigned<StoredTrial>(TRIAL_FILE)
}

export function writeTrial(data: StoredTrial): void {
  writeSigned(TRIAL_FILE, data)
}
