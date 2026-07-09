// Concatenate several dropped files (images / Word / PDF, mixed) into ONE PDF,
// in natural file-name order (2 < 10). Each file is first turned into PDF bytes
// with the existing per-type converters, then all parts are grafted into a fresh
// document. No Electron imports here — keep this testable in plain Node.

import { readFile } from 'node:fs/promises'
import * as mupdf from 'mupdf'
import { imagesToPdf, isImagePath, naturalSortPaths } from './convert-image'
import { isWordPath, wordToPdf } from './convert-word'

/** One converted part: its PDF bytes plus the source path(s) it came from. */
interface Part {
  bytes: Uint8Array
  sources: string[]
}

export interface ConcatResult {
  bytes: Uint8Array
  /** Paths that could not be converted/opened and were left out. */
  skipped: string[]
}

/**
 * Build a single PDF from the given file paths, concatenated in natural name
 * order. Images are batched into runs (one OSD worker per run); Word docs go
 * through Word COM; everything else is read as PDF bytes. Files that fail to
 * convert or open are skipped and reported, never aborting the whole drop.
 */
export async function buildConcatenatedPdf(
  paths: string[],
  osdCachePath: string
): Promise<ConcatResult> {
  const sorted = naturalSortPaths(paths)
  const skipped: string[] = []
  const parts: Part[] = []

  // 1) Convert each file (or consecutive image run) to PDF bytes, preserving order.
  let i = 0
  while (i < sorted.length) {
    if (isImagePath(sorted[i])) {
      const run: string[] = []
      while (i < sorted.length && isImagePath(sorted[i])) run.push(sorted[i++])
      try {
        parts.push({ bytes: await imagesToPdf(run, osdCachePath), sources: run })
      } catch {
        skipped.push(...run)
      }
    } else {
      const p = sorted[i++]
      try {
        const bytes = isWordPath(p)
          ? await wordToPdf(p)
          : new Uint8Array(await readFile(p))
        parts.push({ bytes, sources: [p] })
      } catch {
        skipped.push(p)
      }
    }
  }

  // 2) Graft every part's pages into one fresh document, in order.
  const out = new mupdf.PDFDocument()
  try {
    for (const part of parts) {
      // openDocument throws on non-PDF/corrupt bytes — keep it inside the try so
      // one bad file is skipped, never aborting the whole drop.
      try {
        const opened = mupdf.Document.openDocument(part.bytes, 'application/pdf')
        const src = opened.asPDF()
        if (!src) {
          opened.destroy?.()
          skipped.push(...part.sources)
          continue
        }
        try {
          const n = src.countPages()
          for (let k = 0; k < n; k++) out.graftPage(out.countPages(), src, k)
        } finally {
          src.destroy?.()
        }
      } catch {
        skipped.push(...part.sources)
      }
    }
    const buf = out.saveToBuffer('garbage=compact')
    const bytes = Uint8Array.from(buf.asUint8Array())
    buf.destroy?.()
    return { bytes, skipped }
  } finally {
    out.destroy?.()
  }
}
