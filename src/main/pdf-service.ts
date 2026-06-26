// Core PDF engine. Pure mupdf — no Electron imports — so it can be unit-tested
// in plain Node. Holds a single open document as module state (MVP: one doc).

import * as mupdf from 'mupdf'
import Tesseract from 'tesseract.js'
import type {
  BindingMarginOptions,
  DocumentInfo,
  PageInfo,
  RedactionRect,
  RotateDelta,
  ScopedTerm,
  TermCount,
  WordHit
} from '../shared/types'

let doc: mupdf.PDFDocument | null = null
let currentPath: string | null = null
let currentName = 'untitled.pdf'

/** A word recognised by OCR, in page-space points (top-left origin). */
interface OcrWord {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
}
/** Per-page OCR results; null until OCR has been run on a text-less PDF. */
let ocr: Map<number, OcrWord[]> | null = null
const OCR_DPI = 200

function requireDoc(): mupdf.PDFDocument {
  if (!doc) throw new Error('No PDF document is open')
  return doc
}

/** Wrap a mutation as a single journal operation so it undoes/redoes atomically. */
function operation<T>(name: string, fn: () => T): T {
  const d = requireDoc()
  d.beginOperation(name)
  try {
    const result = fn()
    d.endOperation()
    return result
  } catch (err) {
    d.abandonOperation()
    throw err
  }
}

export function undo(): DocumentInfo {
  const d = requireDoc()
  if (d.canUndo()) d.undo()
  return getInfo()
}

export function redo(): DocumentInfo {
  const d = requireDoc()
  if (d.canRedo()) d.redo()
  return getInfo()
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
  ocr = null
  // Enable the journal so every mutation can be undone/redone.
  pdf.enableJournal()
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
  // showExtras=true so annotations (e.g. yellow highlights) are rendered.
  const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
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

  operation('墨消しの適用', () => {
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
      // black_boxes=true draws a black fill where content was removed.
      // REDACT_IMAGE_PIXELS clears only the covered pixels of an image — so a
      // scanned/full-page-image PDF keeps the rest of the page intact (REMOVE
      // would delete the whole intersecting image, wiping the page).
      page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS)
    }
  })
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
  // Degenerate quad => no native word under the cursor; try OCR.
  if (box.x1 - box.x0 < 0.5 || box.y1 - box.y0 < 0.5) {
    return ocrWordAt(pageIndex, x, y)
  }
  // copy() selects in reading order, so a ul->lr selection grabs the whole
  // line. Sweep horizontally through the word's mid-line to get just the word.
  const cy = (box.y0 + box.y1) / 2
  const word = stext
    .copy([box.x0 + 0.5, cy], [box.x1 - 0.5, cy])
    .replace(/\s+/g, ' ')
    .trim()
  if (word) return { word, rect: { pageIndex, ...box } }
  return ocrWordAt(pageIndex, x, y)
}

/** Word lookup against OCR results (used for scanned PDFs). */
function ocrWordAt(pageIndex: number, x: number, y: number): WordHit | null {
  const words = ocr?.get(pageIndex)
  if (!words) return null
  const hit = words.find(
    (w) => x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1
  )
  if (!hit) return null
  return {
    word: hit.text,
    rect: { pageIndex, x0: hit.x0, y0: hit.y0, x1: hit.x1, y1: hit.y1 }
  }
}

/**
 * OCR selection: take the words intersecting a region and merge them into ONE
 * rectangle per text line (so a drag becomes a clean bar instead of a row of
 * disconnected per-word boxes — the "tofu" problem).
 */
function ocrSelectionRects(
  pageIndex: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { text: string; rects: RedactionRect[] } {
  const words = ocr?.get(pageIndex)
  if (!words) return { text: '', rects: [] }
  const lx = Math.min(x0, x1)
  const ly = Math.min(y0, y1)
  const hx = Math.max(x0, x1)
  const hy = Math.max(y0, y1)
  const sel = words
    .filter((w) => w.x0 < hx && w.x1 > lx && w.y0 < hy && w.y1 > ly)
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const lines: { x0: number; y0: number; x1: number; y1: number; text: string }[] = []
  for (const w of sel) {
    const last = lines[lines.length - 1]
    // Same line if this word vertically overlaps the current line band.
    if (last && w.y0 < last.y1) {
      last.x0 = Math.min(last.x0, w.x0)
      last.y0 = Math.min(last.y0, w.y0)
      last.x1 = Math.max(last.x1, w.x1)
      last.y1 = Math.max(last.y1, w.y1)
      last.text += w.text
    } else {
      lines.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, text: w.text })
    }
  }
  return {
    text: lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim(),
    rects: lines.map((l) => ({ pageIndex, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 }))
  }
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
  if (quads.length) return quads.map((q) => ({ pageIndex, ...quadToBox(q) }))
  // Fallback: OCR words intersecting the dragged region (scanned PDFs),
  // merged into one rectangle per line.
  return ocrSelectionRects(pageIndex, x0, y0, x1, y1).rects
}

/**
 * Text + rects for a drag selection. The returned `text` is meant to be used
 * verbatim as a search term ("redact all occurrences of what I dragged").
 */
export function selectionString(
  pageIndex: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): { text: string; rects: RedactionRect[] } {
  const d = requireDoc()
  const stext = d.loadPage(pageIndex).toStructuredText()
  const quads = stext.highlight([x0, y0], [x1, y1], 500)
  if (quads.length) {
    const text = stext.copy([x0, y0], [x1, y1]).replace(/\s+/g, ' ').trim()
    return { text, rects: quads.map((q) => ({ pageIndex, ...quadToBox(q) })) }
  }
  return ocrSelectionRects(pageIndex, x0, y0, x1, y1)
}

/** Apply a light, rectangular yellow highlight over each rect. */
export function highlightRects(rects: RedactionRect[]): DocumentInfo {
  const d = requireDoc()
  if (rects.length === 0) return getInfo()
  const byPage = new Map<number, RedactionRect[]>()
  for (const r of rects) {
    const list = byPage.get(r.pageIndex) ?? []
    list.push(r)
    byPage.set(r.pageIndex, list)
  }
  operation('黄色マーカー', () => {
    for (const [pageIndex, prs] of byPage) {
      const page = d.loadPage(pageIndex)
      for (const r of prs) {
        const x0 = Math.min(r.x0, r.x1)
        const y0 = Math.min(r.y0, r.y1)
        const x1 = Math.max(r.x0, r.x1)
        const y1 = Math.max(r.y0, r.y1)
        // A 'Square' annotation with a yellow interior fill gives a clean
        // rectangle; 'Highlight' would render with rounded ends (oval-looking).
        const annot = page.createAnnotation('Square')
        annot.setRect([x0, y0, x1, y1])
        annot.setInteriorColor([1, 1, 0])
        annot.setColor([1, 1, 0])
        annot.setBorderWidth(0)
        annot.setOpacity(0.4)
        annot.update()
      }
    }
  })
  return getInfo()
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
  // Fallback: search OCR words when the PDF has no native text.
  if (rects.length === 0 && ocr) {
    const low = trimmed.toLowerCase()
    for (const [i, words] of ocr) {
      for (const w of words) {
        if (w.text.toLowerCase().includes(low)) {
          rects.push({ pageIndex: i, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })
        }
      }
    }
  }
  return rects
}

/** Concatenated plain text of the whole document (OCR fallback if no native text). */
function documentText(): string {
  const d = requireDoc()
  const parts: string[] = []
  const count = d.countPages()
  let hasNative = false
  for (let i = 0; i < count; i++) {
    const t = d.loadPage(i).toStructuredText().asText()
    if (t.trim()) hasNative = true
    parts.push(t)
  }
  if (hasNative || !ocr) return parts.join('\n')
  const op: string[] = []
  for (let i = 0; i < count; i++) {
    op.push((ocr.get(i) ?? []).map((w) => w.text).join(' '))
  }
  return op.join('\n')
}

/** True when the document has no extractable text (a scan that needs OCR). */
export function needsOcr(): boolean {
  if (!doc || ocr) return false
  const count = doc.countPages()
  for (let i = 0; i < count; i++) {
    if (doc.loadPage(i).toStructuredText().asText().trim()) return false
  }
  return true
}

export function isOcrApplied(): boolean {
  return ocr !== null
}

/**
 * Run offline OCR (jpn+eng) on every page and keep the words in memory so the
 * search / click / extract features work on scanned PDFs. `cachePath` is where
 * Tesseract stores the downloaded language model (first run needs network).
 */
export async function runOcr(
  cachePath: string,
  onProgress?: (page: number, total: number) => void
): Promise<number> {
  const d = requireDoc()
  const count = d.countPages()
  const zoom = OCR_DPI / 72
  const worker = await Tesseract.createWorker('jpn+eng', Tesseract.OEM.LSTM_ONLY, {
    cachePath
  })
  try {
    const map = new Map<number, OcrWord[]>()
    let total = 0
    for (let i = 0; i < count; i++) {
      const page = d.loadPage(i)
      const pix = page.toPixmap(
        mupdf.Matrix.scale(zoom, zoom),
        mupdf.ColorSpace.DeviceRGB,
        false
      )
      const png = pix.asPNG()
      pix.destroy?.()
      const { data } = await worker.recognize(
        Buffer.from(png),
        {},
        { blocks: true }
      )
      const words: OcrWord[] = []
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const w of line.words) {
              const text = w.text?.trim()
              if (!text) continue
              words.push({
                text,
                x0: w.bbox.x0 / zoom,
                y0: w.bbox.y0 / zoom,
                x1: w.bbox.x1 / zoom,
                y1: w.bbox.y1 / zoom
              })
            }
          }
        }
      }
      map.set(i, words)
      total += words.length
      onProgress?.(i + 1, count)
    }
    ocr = map
    return total
  } finally {
    await worker.terminate()
  }
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
  // Drop short fragments that are substrings of a longer candidate which
  // accounts for most of their occurrences (e.g. "サンプルソ" ⊂ "サンプルソフト").
  const deNoised = out.filter(
    (x) =>
      !out.some(
        (y) =>
          y.term.length > x.term.length &&
          y.term.includes(x.term) &&
          y.count >= x.count * 0.7
      )
  )
  // Most frequent first, then longer terms; cap to keep the list manageable.
  deNoised.sort((a, b) => b.count - a.count || b.term.length - a.term.length)
  return deNoised.slice(0, 200)
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

/** Like findTerms, but honours each term's scope ('all' | 'first'). */
export function findTermsScoped(items: ScopedTerm[]): RedactionRect[] {
  const rects: RedactionRect[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const term = it.text.trim()
    if (!term || seen.has(term)) continue
    seen.add(term)
    const hits = findWord(term)
    rects.push(...(it.scope === 'first' ? hits.slice(0, 1) : hits))
  }
  return rects
}

/** Full plain text of the document (for building an AI prompt). */
export function getDocumentText(): string {
  requireDoc()
  return documentText()
}

export function deletePage(index: number): DocumentInfo {
  const d = requireDoc()
  if (d.countPages() <= 1) {
    throw new Error('Cannot delete the only page')
  }
  operation('ページ削除', () => d.deletePage(index))
  return getInfo()
}

/** Delete multiple pages at once (single undoable operation). */
export function deletePages(indices: number[]): DocumentInfo {
  const d = requireDoc()
  const drop = new Set(indices)
  const keep = Array.from({ length: d.countPages() }, (_, i) => i).filter(
    (i) => !drop.has(i)
  )
  if (keep.length === 0) throw new Error('全てのページは削除できません')
  if (keep.length === d.countPages()) return getInfo()
  operation('ページ削除', () => d.rearrangePages(keep))
  return getInfo()
}

/** Rotate multiple pages at once (single undoable operation). */
export function rotatePages(indices: number[], delta: RotateDelta): DocumentInfo {
  const d = requireDoc()
  if (indices.length === 0) return getInfo()
  operation('ページ回転', () => {
    for (const i of indices) {
      const page = d.loadPage(i)
      const obj = page.getObject()
      const current = readRotation(page)
      obj.put('Rotate', (((current + delta) % 360) + 360) % 360)
    }
  })
  return getInfo()
}

/**
 * Change the paper size of the given pages (e.g. B5 → A4). Content is uniformly
 * scaled to fit the new box and centred; the MediaBox/CropBox are updated.
 */
export function resizePages(
  indices: number[],
  widthMm: number,
  heightMm: number
): DocumentInfo {
  const d = requireDoc()
  if (indices.length === 0) return getInfo()
  const tW = widthMm * MM_TO_PT
  const tH = heightMm * MM_TO_PT
  if (tW <= 0 || tH <= 0) return getInfo()

  operation('用紙サイズ変更', () => {
    for (const i of indices) {
      const page = d.loadPage(i)
      const [llx, lly, urx, ury] = mediaBox(page)
      const W = urx - llx
      const H = ury - lly
      if (W <= 0 || H <= 0) continue

      const s = Math.min(tW / W, tH / H)
      const tx = (tW - W * s) / 2 - llx * s
      const ty = (tH - H * s) / 2 - lly * s

      const obj = page.getObject()
      const enc = new TextEncoder()
      const wrapped = concatBytes([
        enc.encode(`q ${s} 0 0 ${s} ${tx} ${ty} cm\n`),
        readPageContents(obj),
        enc.encode('\nQ\n')
      ])
      obj.put('Contents', d.addStream(wrapped, {}))
      page.setPageBox('MediaBox', [0, 0, tW, tH])
      page.setPageBox('CropBox', [0, 0, tW, tH])
    }
  })
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
  operation('ページ移動', () => d.rearrangePages(order))
  return getInfo()
}

export function rotatePage(index: number, delta: RotateDelta): DocumentInfo {
  const d = requireDoc()
  const page = d.loadPage(index)
  const obj = page.getObject()
  const current = readRotation(page)
  const next = (((current + delta) % 360) + 360) % 360
  operation('ページ回転', () => obj.put('Rotate', next))
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

  operation('閉じ代の確保', () => {
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
  })

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
