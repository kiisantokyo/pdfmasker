// Core PDF engine. Pure mupdf — no Electron imports — so it can be unit-tested
// in plain Node. Holds a single open document as module state (MVP: one doc).

import * as mupdf from 'mupdf'
import type {
  BindingMarginOptions,
  DocumentInfo,
  PageInfo,
  RedactionRect,
  RotateDelta,
  TermCount,
  WordHit
} from '../shared/types'

let doc: mupdf.PDFDocument | null = null
let currentPath: string | null = null
let currentName = 'untitled.pdf'

function requireDoc(): mupdf.PDFDocument {
  if (!doc) throw new Error('No PDF document is open')
  return doc
}

function readRotation(page: mupdf.PDFPage): number {
  const obj = page.getObject()
  const rot = obj.getInheritable('Rotate')
  const n = rot && rot.isNumber() ? rot.asNumber() : 0
  return ((n % 360) + 360) % 360
}

function buildPageInfo(): PageInfo[] {
  const d = requireDoc()
  const pages: PageInfo[] = []
  const count = d.countPages()
  for (let i = 0; i < count; i++) {
    const page = d.loadPage(i)
    const [x0, y0, x1, y1] = page.getBounds()
    pages.push({
      index: i,
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      rotation: readRotation(page)
    })
  }
  return pages
}

export function getInfo(): DocumentInfo {
  const d = requireDoc()
  return {
    path: currentPath,
    name: currentName,
    pageCount: d.countPages(),
    pages: buildPageInfo()
  }
}

export function isOpen(): boolean {
  return doc !== null
}

/** Load a PDF from raw bytes. `name`/`path` are metadata for the UI. */
export function loadDocument(
  bytes: Uint8Array,
  name: string,
  path: string | null
): DocumentInfo {
  const opened = mupdf.Document.openDocument(bytes, 'application/pdf')
  const pdf = opened.asPDF()
  if (!pdf) {
    opened.destroy?.()
    throw new Error('File is not a valid PDF')
  }
  if (pdf.needsPassword()) {
    throw new Error('Password-protected PDFs are not supported yet')
  }
  doc?.destroy?.()
  doc = pdf
  currentName = name
  currentPath = path
  return getInfo()
}

/**
 * Render a single page to PNG.
 * @param zoom pixels-per-point (1.0 = 72dpi, 2.0 = 144dpi, ...)
 */
export function renderPage(
  index: number,
  zoom: number
): { png: Uint8Array; pixelWidth: number; pixelHeight: number } {
  const d = requireDoc()
  const page = d.loadPage(index)
  const matrix = mupdf.Matrix.scale(zoom, zoom)
  const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)
  try {
    return {
      png: pix.asPNG(),
      pixelWidth: pix.getWidth(),
      pixelHeight: pix.getHeight()
    }
  } finally {
    pix.destroy?.()
  }
}

/**
 * Apply TRUE redaction: removes the underlying text/image content under each
 * rect, not just a cosmetic black box. This is the security-critical operation.
 */
export function applyRedactions(rects: RedactionRect[]): void {
  const d = requireDoc()
  if (rects.length === 0) return

  const byPage = new Map<number, RedactionRect[]>()
  for (const r of rects) {
    const list = byPage.get(r.pageIndex) ?? []
    list.push(r)
    byPage.set(r.pageIndex, list)
  }

  for (const [pageIndex, pageRects] of byPage) {
    const page = d.loadPage(pageIndex)
    for (const r of pageRects) {
      const annot = page.createAnnotation('Redact')
      annot.setRect([
        Math.min(r.x0, r.x1),
        Math.min(r.y0, r.y1),
        Math.max(r.x0, r.x1),
        Math.max(r.y0, r.y1)
      ])
      annot.update()
    }
    // black_boxes=true draws a black fill where content was removed;
    // REDACT_IMAGE_REMOVE strips covered images entirely.
    page.applyRedactions(
      true,
      mupdf.PDFPage.REDACT_IMAGE_REMOVE
    )
  }
}

/** Convert a mupdf Quad ([ulx,uly, urx,ury, llx,lly, lrx,lry]) to a bbox. */
function quadToBox(q: mupdf.Quad): { x0: number; y0: number; x1: number; y1: number } {
  const xs = [q[0], q[2], q[4], q[6]]
  const ys = [q[1], q[3], q[5], q[7]]
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys)
  }
}

/** Find the word at a point (page-space points). Returns null if none. */
export function wordAt(pageIndex: number, x: number, y: number): WordHit | null {
  const d = requireDoc()
  const page = d.loadPage(pageIndex)
  const stext = page.toStructuredText()
  const pt: mupdf.Point = [x, y]
  const quad = stext.snap(pt, pt, 'words')
  const box = quadToBox(quad)
  // Degenerate quad => no word under the cursor.
  if (box.x1 - box.x0 < 0.5 || box.y1 - box.y0 < 0.5) return null
  // copy() selects in reading order, so a ul->lr selection grabs the whole
  // line. Sweep horizontally through the word's mid-line to get just the word.
  const cy = (box.y0 + box.y1) / 2
  const word = stext
    .copy([box.x0 + 0.5, cy], [box.x1 - 0.5, cy])
    .replace(/\s+/g, ' ')
    .trim()
  if (!word) return null
  return { word, rect: { pageIndex, ...box } }
}

/**
 * Text-selection sweep: returns the quads tracing the text between two points
 * (page-space), so the user can "drag over" words instead of boxing them.
 */
export function selectText(
  pageIndex: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): RedactionRect[] {
  const d = requireDoc()
  const stext = d.loadPage(pageIndex).toStructuredText()
  const quads = stext.highlight([x0, y0], [x1, y1], 500)
  return quads.map((q) => ({ pageIndex, ...quadToBox(q) }))
}

/** Find every occurrence of `needle` across all pages (case-insensitive). */
export function findWord(needle: string): RedactionRect[] {
  const d = requireDoc()
  const trimmed = needle.trim()
  if (!trimmed) return []
  const rects: RedactionRect[] = []
  const count = d.countPages()
  for (let i = 0; i < count; i++) {
    const page = d.loadPage(i)
    const matches = page.search(trimmed, 500)
    for (const match of matches) {
      // Each match is one or more quads (one per visual line); redact each.
      for (const quad of match) {
        rects.push({ pageIndex: i, ...quadToBox(quad) })
      }
    }
  }
  return rects
}

/** Concatenated plain text of the whole document. */
function documentText(): string {
  const d = requireDoc()
  const parts: string[] = []
  const count = d.countPages()
  for (let i = 0; i < count; i++) {
    parts.push(d.loadPage(i).toStructuredText().asText())
  }
  return parts.join('\n')
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0
  return text.split(term).length - 1
}

/**
 * Heuristically extract likely proper nouns / personal data as redaction
 * candidates. Fully offline — no NLP model, just patterns. Noisy by design:
 * the user reviews and picks which to redact.
 */
export function extractCandidates(): TermCount[] {
  const text = documentText()
  const found = new Map<string, string>() // term -> kind

  const add = (term: string, kind: string): void => {
    const t = term.trim()
    if (t.length >= 2 && !found.has(t)) found.set(t, kind)
  }

  const patterns: { kind: string; re: RegExp }[] = [
    { kind: 'メール', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { kind: '電話', re: /0\d{1,4}-\d{1,4}-\d{3,4}/g },
    { kind: '電話', re: /0[789]0\d{8}/g },
    // Explicit 〒 form, or a NNN-NNNN not embedded inside a longer digit run
    // (so phone numbers like 090-1234-5678 don't masquerade as postal codes).
    { kind: '郵便番号', re: /〒\s?\d{3}-\d{4}|(?<![\d-])\d{3}-\d{4}(?![\d-])/g },
    { kind: 'URL', re: /https?:\/\/[^\s「」、。]+/g },
    {
      kind: '組織',
      re: /[一-龯ぁ-んァ-ヶA-Za-z0-9０-９]{1,12}(?:株式会社|有限会社|合同会社|大学|高校|中学校|小学校|銀行|信用金庫|病院|医院|クリニック|事務所|役所|区役所|市役所)/g
    },
    {
      kind: '組織',
      re: /(?:株式会社|有限会社)[一-龯ぁ-んァ-ヶA-Za-z0-9０-９]{1,12}/g
    },
    { kind: '人名候補', re: /[一-龯]{1,4}(?=さん|様|氏|君|先生|殿)/g },
    { kind: 'カタカナ語', re: /[ァ-ヶ][ァ-ヶー・]{2,}/g }
  ]

  for (const { kind, re } of patterns) {
    for (const match of text.matchAll(re)) {
      add(match[0], kind)
    }
  }

  const out: TermCount[] = []
  for (const [term, kind] of found) {
    out.push({ term, kind, count: countOccurrences(text, term) })
  }
  // Most frequent first, then longer terms; cap to keep the list manageable.
  out.sort((a, b) => b.count - a.count || b.term.length - a.term.length)
  return out.slice(0, 200)
}

/** Count document occurrences for a set of terms (drops zero-count terms). */
export function countTerms(terms: string[]): TermCount[] {
  const text = documentText()
  const seen = new Set<string>()
  const out: TermCount[] = []
  for (const raw of terms) {
    const term = raw.trim()
    if (!term || seen.has(term)) continue
    seen.add(term)
    const count = countOccurrences(text, term)
    if (count > 0) out.push({ term, count })
  }
  return out
}

/** Collect redaction rects for every occurrence of each given term. */
export function findTerms(terms: string[]): RedactionRect[] {
  const rects: RedactionRect[] = []
  const seen = new Set<string>()
  for (const raw of terms) {
    const term = raw.trim()
    if (!term || seen.has(term)) continue
    seen.add(term)
    rects.push(...findWord(term))
  }
  return rects
}

export function deletePage(index: number): DocumentInfo {
  const d = requireDoc()
  if (d.countPages() <= 1) {
    throw new Error('Cannot delete the only page')
  }
  d.deletePage(index)
  return getInfo()
}

/** Move a page from one position to another, preserving the rest of the order. */
export function movePage(from: number, to: number): DocumentInfo {
  const d = requireDoc()
  const count = d.countPages()
  if (from < 0 || from >= count || to < 0 || to >= count) {
    throw new Error('Page index out of range')
  }
  const order = Array.from({ length: count }, (_, i) => i)
  const [moved] = order.splice(from, 1)
  order.splice(to, 0, moved)
  d.rearrangePages(order)
  return getInfo()
}

export function rotatePage(index: number, delta: RotateDelta): DocumentInfo {
  const d = requireDoc()
  const page = d.loadPage(index)
  const obj = page.getObject()
  const current = readRotation(page)
  const next = (((current + delta) % 360) + 360) % 360
  obj.put('Rotate', next)
  return getInfo()
}

const MM_TO_PT = 72 / 25.4

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function readPageContents(pageObj: mupdf.PDFObject): Uint8Array {
  const c = pageObj.get('Contents')
  if (c.isStream()) return Uint8Array.from(c.readStream().asUint8Array())
  if (c.isArray()) {
    const parts: Uint8Array[] = []
    const len = c.length
    for (let i = 0; i < len; i++) {
      parts.push(Uint8Array.from(c.get(i).readStream().asUint8Array()))
      parts.push(new TextEncoder().encode('\n'))
    }
    return concatBytes(parts)
  }
  return new Uint8Array()
}

function mediaBox(page: mupdf.PDFPage): [number, number, number, number] {
  const mb = page.getObject().getInheritable('MediaBox')
  if (mb && mb.isArray() && mb.length === 4) {
    return [
      mb.get(0).asNumber(),
      mb.get(1).asNumber(),
      mb.get(2).asNumber(),
      mb.get(3).asNumber()
    ]
  }
  const [x0, y0, x1, y1] = page.getBounds()
  return [x0, y0, x1, y1]
}

/**
 * Shrink page content and add a blank binding (staple) margin on one edge.
 * Page size is preserved; the content is uniformly scaled and shifted so the
 * binding edge gets `marginMm` of empty space.
 */
export function addBindingMargin(opts: BindingMarginOptions): DocumentInfo {
  const d = requireDoc()
  const m = Math.max(0, opts.marginMm) * MM_TO_PT
  const targets = opts.allPages
    ? Array.from({ length: d.countPages() }, (_, i) => i)
    : [opts.pageIndex]

  for (const i of targets) {
    const page = d.loadPage(i)
    const [llx, lly, urx, ury] = mediaBox(page)
    const W = urx - llx
    const H = ury - lly
    if (W <= 0 || H <= 0) continue

    const horizontal = opts.side === 'left' || opts.side === 'right'
    const s = horizontal ? (W - m) / W : (H - m) / H
    if (s <= 0 || s >= 1) continue

    let tx = llx * (1 - s)
    let ty = lly * (1 - s)
    if (horizontal) {
      // Centre vertically; push away from the binding edge horizontally.
      ty += (H - H * s) / 2
      tx += opts.side === 'left' ? m : 0
    } else {
      // Centre horizontally; push away from the binding edge vertically.
      tx += (W - W * s) / 2
      ty += opts.side === 'bottom' ? m : 0
    }

    const enc = new TextEncoder()
    const prefix = enc.encode(`q ${s} 0 0 ${s} ${tx} ${ty} cm\n`)
    const suffix = enc.encode('\nQ\n')
    const original = readPageContents(page.getObject())
    const wrapped = concatBytes([prefix, original, suffix])

    const stream = d.addStream(wrapped, {})
    page.getObject().put('Contents', stream)
  }

  return getInfo()
}

/** Serialize the current document to PDF bytes (garbage-collected & compacted). */
export function saveToBuffer(): Uint8Array {
  const d = requireDoc()
  const buf = d.saveToBuffer('garbage=compact,sanitize=yes')
  const bytes = buf.asUint8Array()
  buf.destroy?.()
  // Copy out of the WASM heap so the bytes stay valid after buffer is freed.
  return Uint8Array.from(bytes)
}

export function markSavedAt(path: string): void {
  currentPath = path
  currentName = path.replace(/^.*[\\/]/, '')
}

export function getPath(): string | null {
  return currentPath
}

export function hasUnsavedChanges(): boolean {
  return doc ? doc.hasUnsavedChanges() : false
}
