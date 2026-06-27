// Convert a Word document (.docx/.doc) to PDF via Microsoft Word COM
// automation (PowerShell). Tracked changes are accepted and comments removed so
// the output is a clean "no revision history" final version. Windows + an
// installed Microsoft Word are required.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

const execFileP = promisify(execFile)

const WORD_EXTS = new Set(['.docx', '.doc', '.docm', '.rtf'])

/** True if the path looks like a Word-openable document. */
export function isWordPath(p: string): boolean {
  return WORD_EXTS.has(extname(p).toLowerCase())
}

// Opens the file in an invisible Word instance, accepts all tracked changes,
// deletes comments, then exports a PDF without document properties or markup.
// The original file is never saved back (Close $false).
const PS_SCRIPT = `param([string]$In,[string]$Out)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($In, $false, $false)
  try { $doc.TrackRevisions = $false } catch {}
  try { $doc.AcceptAllRevisions() } catch {}
  try { while ($doc.Comments.Count -gt 0) { $doc.Comments.Item(1).Delete() } } catch {}
  # ExportAsFixedFormat: PDF(17), no open after, optimize-for-print(0),
  # all document(0), from/to ignored, content only(0), IncludeDocProps=$false
  $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 1, 1, 0, $false)
  $doc.Close($false)
} finally {
  $word.Quit()
}
`

/**
 * Convert a Word document at `inputPath` to PDF bytes. Throws a Japanese error
 * if Word is unavailable or the conversion fails. Temp files are cleaned up.
 */
export async function wordToPdf(inputPath: string): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'pdfmasker-word-'))
  const scriptPath = join(dir, 'convert.ps1')
  const outPath = join(dir, 'out.pdf')
  await writeFile(scriptPath, PS_SCRIPT, 'utf8')
  try {
    await execFileP(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-In',
        inputPath,
        '-Out',
        outPath
      ],
      { windowsHide: true, timeout: 180000 }
    )
    const bytes = await readFile(outPath)
    return new Uint8Array(bytes)
  } catch (err) {
    throw new Error(
      `Word→PDF変換に失敗しました（Microsoft Word が必要です）: ${
        (err as Error).message
      }`
    )
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
