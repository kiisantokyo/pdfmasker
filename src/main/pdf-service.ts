// Core PDF engine. Pure mupdf — no Electron imports — so it can be unit-tested
// in plain Node. Holds a single open document as module state (MVP: one doc).

import * as mupdf from 'mupdf'
import Tesseract from 'tesseract.js'
import type {
  ApplyScope,
  BindingMarginOptions,
  DocumentInfo,
  MetadataEntry,
  PageInfo,
  PageNumberFormat,
  PageNumberOptions,
  RedactionRect,
  RotateDelta,
  ScopedTerm,
  StampOptions,
  TermCount,
  WordHit
} from '../shared/types'
import { STAMP_PNG_BASE64 } from './stamp-assets'

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
    const obj = page.getObject()
    const ow = obj.get('PMOrigW')
    const oh = obj.get('PMOrigH')
    pages.push({
      index: i,
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
      rotation: readRotation(page),
      origWidth: ow && ow.isNumber() ? ow.asNumber() : undefined,
      origHeight: oh && oh.isNumber() ? oh.asNumber() : undefined
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
    pages: buildPageInfo(),
    hasMetadata: documentHasMetadata()
  }
}

/**
 * True if the document still has distribution-unsafe properties: a non-empty
 * Document Info field, or an XMP metadata stream on the catalog. Mirrors what
 * clearMetadata() removes, so the 「配布情報なし」 badge tracks the real state.
 */
function documentHasMetadata(): boolean {
  if (!doc) return false
  const trailer = doc.getTrailer()
  const info = trailer.get('Info')
  if (info && info.isDictionary()) {
    for (const [key] of INFO_LABELS) {
      const v = info.get(key)
      if (v && !v.isNull() && (!v.isString() || v.asString().trim() !== '')) {
        return true
      }
    }
  }
  const root = trailer.get('Root')
  if (root && root.isDictionary()) {
    const md = root.get('Metadata')
    if (md && !md.isNull()) return true
  }
  return false
}

export function isOpen(): boolean {
  return doc !== null
}

/** Close the current document and release its resources (back to no-doc state). */
export function closeDocument(): void {
  doc?.destroy?.()
  doc = null
  ocr = null
  currentPath = null
  currentName = 'untitled.pdf'
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
 * Merge an external PDF (given as bytes) into the open document, either before
 * the first page or after the last. Used when the user drops a file while a
 * document is already open and chooses "前に追加" / "後に追加". A single journal
 * operation so the whole merge undoes/redoes atomically.
 */
export function insertExternalPdf(
  bytes: Uint8Array,
  position: 'before' | 'after'
): DocumentInfo {
  const d = requireDoc()
  const opened = mupdf.Document.openDocument(bytes, 'application/pdf')
  const src = opened.asPDF()
  if (!src) {
    opened.destroy?.()
    throw new Error('取り込むファイルが有効なPDFではありません')
  }
  try {
    const srcCount = src.countPages()
    operation('ファイルの取り込み', () => {
      if (position === 'after') {
        for (let i = 0; i < srcCount; i++) d.graftPage(d.countPages(), src, i)
      } else {
        // Insert at the front, keeping the source order: 0,1,2,...
        for (let i = 0; i < srcCount; i++) d.graftPage(i, src, i)
      }
    })
  } finally {
    src.destroy?.()
  }
  // Page indices shifted; any cached OCR is now misaligned. Drop it so callers
  // can re-run OCR over the merged document if needed.
  ocr = null
  return getInfo()
}

const INFO_LABELS: [string, string][] = [
  ['Title', 'タイトル'],
  ['Author', '作成者'],
  ['Subject', 'サブタイトル'],
  ['Keywords', 'キーワード'],
  ['Creator', '作成アプリ'],
  ['Producer', 'PDF変換ソフト'],
  ['CreationDate', '作成日時'],
  ['ModDate', '更新日時']
]

/**
 * Remove the selected document properties. `keys` holds Info-dict field names
 * (Author, Title, …) and/or the sentinel 'XMP' for the metadata stream; only
 * those are deleted, so the user can keep some and drop others. Undoable.
 * Returns the labels of the properties that were actually present and removed.
 */
export function clearMetadata(keys: string[]): {
  info: DocumentInfo
  removed: string[]
} {
  const d = requireDoc()
  const removed: string[] = []
  const want = new Set(keys)
  operation('プロパティ消去', () => {
    const trailer = d.getTrailer()
    const info = trailer.get('Info')
    if (info && info.isDictionary()) {
      for (const [key, label] of INFO_LABELS) {
        if (!want.has(key)) continue
        const v = info.get(key)
        const present =
          v && !v.isNull() && (!v.isString() || v.asString().trim() !== '')
        if (present) {
          removed.push(label)
          info.delete(key)
        }
      }
    }
    if (want.has('XMP')) {
      const root = trailer.get('Root')
      if (root && root.isDictionary()) {
        const md = root.get('Metadata')
        if (md && !md.isNull()) removed.push('XMPメタデータ')
        root.delete('Metadata')
      }
    }
  })
  return { info: getInfo(), removed }
}

/** Format a PDF date string (D:YYYYMMDDHHmmSS...) as "YYYY-MM-DD HH:mm". */
function formatPdfDate(s: string): string {
  const m = /(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(s)
  if (!m) return s
  const [, y, mo, d, h, mi] = m
  return h ? `${y}-${mo}-${d} ${h}:${mi ?? '00'}` : `${y}-${mo}-${d}`
}

/**
 * List the document properties currently embedded (Info-dict fields + whether
 * an XMP stream is present), with human-readable values. Mirrors what
 * clearMetadata() removes so the viewer shows exactly what can be cleared.
 */
export function readMetadata(): MetadataEntry[] {
  if (!doc) return []
  const out: MetadataEntry[] = []
  const trailer = doc.getTrailer()
  const info = trailer.get('Info')
  if (info && info.isDictionary()) {
    for (const [key, label] of INFO_LABELS) {
      const v = info.get(key)
      if (!v || !v.isString()) continue
      const raw = v.asString().trim()
      if (!raw) continue
      const value =
        key === 'CreationDate' || key === 'ModDate' ? formatPdfDate(raw) : raw
      out.push({ key, label, value })
    }
  }
  const root = trailer.get('Root')
  if (root && root.isDictionary()) {
    const md = root.get('Metadata')
    if (md && !md.isNull()) {
      out.push({
        key: 'XMP',
        label: 'XMPメタデータ',
        value: 'あり（作成情報などの詳細データ）'
      })
    }
  }
  return out
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

/**
 * Reject quads from snap()/highlight() that are rotated (e.g. a diagonal "社外秘"
 * watermark) or implausibly tall — these would add a giant box to the selection
 * when the user clicks/drags near non-body text. Normal body text is upright
 * (top edge horizontal, left edge vertical) and within a sane line height.
 */
function plausibleQuad(q: mupdf.Quad): boolean {
  const tol = 2
  if (Math.abs(q[1] - q[3]) > tol || Math.abs(q[0] - q[4]) > tol) return false
  const h = Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7])
  return h <= 80
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
  // Degenerate quad, or a rotated/oversized one (watermark etc.) => no usable
  // native word under the cursor; try OCR instead.
  if (box.x1 - box.x0 < 0.5 || box.y1 - box.y0 < 0.5 || !plausibleQuad(quad)) {
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
  const quads = stext.highlight([x0, y0], [x1, y1], 500).filter(plausibleQuad)
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
  const quads = stext.highlight([x0, y0], [x1, y1], 500).filter(plausibleQuad)
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

// Small→large kana, so OCR variants like "シュン" / "シユン" fold together.
const SMALL_KANA = 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮ'
const LARGE_KANA = 'あいうえおつやゆよわアイウエオツヤユヨワ'

/**
 * Normalise a token for fuzzy OCR matching: unify full/half width (NFKC),
 * lowercase, drop everything that isn't a letter or number (so decorations a
 * mention picks up — '@', emoji like ⭐, spaces, punctuation — are removed), and
 * fold small kana to large. Lets "@シュン⭐" match plain "シユン" occurrences.
 */
function normalizeForMatch(s: string): string {
  const stripped = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
  let out = ''
  for (const ch of stripped) {
    const i = SMALL_KANA.indexOf(ch)
    out += i >= 0 ? LARGE_KANA[i] : ch
  }
  return out
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
    rects.push(...ocrFindRects(normalizeForMatch(trimmed)))
  }
  return rects
}

/**
 * Search the OCR layer for `target` (already normalised). CJK OCR splits words
 * into per-character tokens ("山田由美" → 山 / 田 / 由美), so we concatenate each
 * line's tokens into one normalised string, search within it, and map every
 * match back to the bounding box spanning the tokens it covers. This is what
 * makes multi-character terms findable across the whole document.
 */
function ocrFindRects(target: string): RedactionRect[] {
  const out: RedactionRect[] = []
  if (!ocr || !target) return out
  for (const [pageIndex, words] of ocr) {
    // Group words into lines (vertically-overlapping bands), reading order.
    const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    const lines: OcrWord[][] = []
    for (const w of sorted) {
      const line = lines[lines.length - 1]
      if (line && w.y0 < line[line.length - 1].y1) line.push(w)
      else lines.push([w])
    }
    for (const line of lines) {
      line.sort((a, b) => a.x0 - b.x0)
      // Build the line's normalised text plus, per character, which token it came from.
      let norm = ''
      const owner: number[] = []
      line.forEach((w, wi) => {
        for (const ch of normalizeForMatch(w.text)) {
          norm += ch
          owner.push(wi)
        }
      })
      // Emit a merged box over the tokens covering each occurrence.
      for (let idx = norm.indexOf(target); idx >= 0; idx = norm.indexOf(target, idx + 1)) {
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (let k = idx; k < idx + target.length; k++) {
          const w = line[owner[k]]
          x0 = Math.min(x0, w.x0)
          y0 = Math.min(y0, w.y0)
          x1 = Math.max(x1, w.x1)
          y1 = Math.max(y1, w.y1)
        }
        out.push({ pageIndex, x0, y0, x1, y1 })
      }
    }
  }
  return out
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
/**
 * Apply the same scale+shift used on a page's content stream to its
 * annotations. Annotation /Rect and /QuadPoints live in the page's user space
 * (the same space the content `cm` operates in), so the transform is applied
 * directly — no top-left/bottom-left flip needed. This keeps yellow highlights
 * aligned when 閉じ代 / 用紙サイズ変更 scale and move the page content.
 */
function transformAnnotations(
  page: mupdf.PDFPage,
  s: number,
  tx: number,
  ty: number
): void {
  const mapX = (x: number): number => s * x + tx
  const mapY = (y: number): number => s * y + ty
  for (const annot of page.getAnnotations()) {
    const obj = annot.getObject()
    const rect = obj.get('Rect')
    if (rect && rect.isArray() && rect.length === 4) {
      rect.put(0, mapX(rect.get(0).asNumber()))
      rect.put(1, mapY(rect.get(1).asNumber()))
      rect.put(2, mapX(rect.get(2).asNumber()))
      rect.put(3, mapY(rect.get(3).asNumber()))
    }
    const qp = obj.get('QuadPoints')
    if (qp && qp.isArray()) {
      const n = qp.length
      for (let k = 0; k + 1 < n; k += 2) {
        qp.put(k, mapX(qp.get(k).asNumber()))
        qp.put(k + 1, mapY(qp.get(k + 1).asNumber()))
      }
    }
    annot.update()
  }
}

export function resizePages(
  indices: number[],
  widthMm: number,
  heightMm: number
): DocumentInfo {
  const d = requireDoc()
  if (indices.length === 0) return getInfo()
  // The chosen paper as long/short edges; orientation is kept per page (rotation
  // is a separate operation), so changing size never flips the layout.
  const longMm = Math.max(widthMm, heightMm)
  const shortMm = Math.min(widthMm, heightMm)
  if (longMm <= 0) return getInfo()

  operation('用紙サイズ変更', () => {
    for (const i of indices) {
      const page = d.loadPage(i)
      const [llx, lly, urx, ury] = mediaBox(page)
      const W = urx - llx
      const H = ury - lly
      if (W <= 0 || H <= 0) continue

      // Match the page's current orientation.
      const landscape = W > H
      const tW = (landscape ? longMm : shortMm) * MM_TO_PT
      const tH = (landscape ? shortMm : longMm) * MM_TO_PT

      const s = Math.min(tW / W, tH / H)
      const tx = (tW - W * s) / 2 - llx * s
      const ty = (tH - H * s) / 2 - lly * s

      const obj = page.getObject()
      // Remember the very first (pre-resize) size so the UI can show "B4→A4".
      const had = obj.get('PMOrigW')
      if (!(had && had.isNumber())) {
        obj.put('PMOrigW', W)
        obj.put('PMOrigH', H)
      }
      const enc = new TextEncoder()
      const wrapped = concatBytes([
        enc.encode(`q ${s} 0 0 ${s} ${tx} ${ty} cm\n`),
        readPageContents(obj),
        enc.encode('\nQ\n')
      ])
      obj.put('Contents', d.addStream(wrapped, {}))
      page.setPageBox('MediaBox', [0, 0, tW, tH])
      page.setPageBox('CropBox', [0, 0, tW, tH])
      transformAnnotations(page, s, tx, ty)
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
      transformAnnotations(page, s, tx, ty)
    }
  })

  return getInfo()
}

// --- Page numbers & stamps --------------------------------------------------

/** Resolve which 0-based page indices an ApplyScope targets (range is 1-based,
 *  inclusive; values are clamped to the document). */
function resolveTargets(
  scope: ApplyScope,
  pageIndex: number,
  rangeFrom: number,
  rangeTo: number,
  count: number
): number[] {
  if (scope === 'current') return [Math.max(0, Math.min(pageIndex, count - 1))]
  if (scope === 'range') {
    const lo = Math.max(1, Math.min(rangeFrom, rangeTo))
    const hi = Math.min(count, Math.max(rangeFrom, rangeTo))
    const out: number[] = []
    for (let p = lo; p <= hi; p++) out.push(p - 1)
    return out
  }
  return Array.from({ length: count }, (_, i) => i)
}

/**
 * Matrix mapping "visual" coordinates (origin at the visually-upright page's
 * bottom-left, y up) into the page's media space, so content drawn through it
 * lands at the intended on-screen spot and stays upright on /Rotate pages.
 * Also returns the visual page size.
 */
function pageVisualMatrix(
  rot: number,
  llx: number,
  lly: number,
  w: number,
  h: number
): {
  cm: [number, number, number, number, number, number]
  visW: number
  visH: number
} {
  let cm: [number, number, number, number, number, number]
  let visW: number
  let visH: number
  switch (rot) {
    case 90:
      cm = [0, 1, -1, 0, w, 0]
      visW = h
      visH = w
      break
    case 180:
      cm = [-1, 0, 0, -1, w, h]
      visW = w
      visH = h
      break
    case 270:
      cm = [0, -1, 1, 0, 0, h]
      visW = h
      visH = w
      break
    default:
      cm = [1, 0, 0, 1, 0, 0]
      visW = w
      visH = h
  }
  cm[4] += llx
  cm[5] += lly
  return { cm, visW, visH }
}

/** Ensure the page owns its /Resources dict (copying inherited entries so the
 *  parent Pages node is never mutated), and return it. */
function ownResources(
  d: mupdf.PDFDocument,
  pageObj: mupdf.PDFObject
): mupdf.PDFObject {
  const existing = pageObj.get('Resources')
  if (existing && existing.isDictionary()) return existing
  const res = d.newDictionary()
  const inherited = pageObj.getInheritable('Resources')
  if (inherited && inherited.isDictionary()) {
    inherited.forEach((val, key) => res.put(key as string, val))
  }
  pageObj.put('Resources', res)
  return res
}

/** Return a private named sub-dict of /Resources (e.g. /Font, /XObject),
 *  cloning any inherited/shared one so our additions never touch it. */
function ownSubDict(
  d: mupdf.PDFDocument,
  res: mupdf.PDFObject,
  name: string
): mupdf.PDFObject {
  const sub = d.newDictionary()
  const existing = res.get(name)
  if (existing && existing.isDictionary()) {
    existing.forEach((val, key) => sub.put(key as string, val))
  }
  res.put(name, sub)
  return sub
}

/** Format a PDF number compactly (no trailing zeros). */
const fmt = (n: number): string =>
  Number.isInteger(n) ? String(n) : Number(n.toFixed(3)).toString()

/** Escape a string for a PDF literal-string operand. */
const pdfEscape = (s: string): string => s.replace(/[\\()]/g, (c) => '\\' + c)

/** Helvetica advance widths (1000-unit em) for the glyphs page numbers use. */
const HELV_WIDTH: Record<string, number> = {
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556,
  '6': 556, '7': 556, '8': 556, '9': 556, ' ': 278, '/': 278,
  '-': 333, P: 667, '.': 278
}

function helvWidth(text: string, size: number): number {
  let w = 0
  for (const ch of text) w += (HELV_WIDTH[ch] ?? 556) / 1000
  return w * size
}

function formatPageNumber(
  format: PageNumberFormat,
  n: number,
  total: number
): string {
  switch (format) {
    case 'slash':
      return `${n} / ${total}`
    case 'dash':
      return `- ${n} -`
    case 'p-dot':
      return `P.${n}`
    default:
      return `${n}`
  }
}

/**
 * Append page-number text (ASCII, base-14 Helvetica) at the bottom-centre of
 * each targeted page. Numbers run startNumber, +1, … across the sorted targets;
 * the "{n} / {total}" format uses the count of numbered pages as the total.
 */
export function addPageNumbers(opts: PageNumberOptions): DocumentInfo {
  const d = requireDoc()
  const count = d.countPages()
  const targets = resolveTargets(
    opts.scope,
    opts.pageIndex,
    opts.rangeFrom,
    opts.rangeTo,
    count
  )
  if (targets.length === 0) return getInfo()

  const fontSize = 10.5
  // 8mm from the bottom edge (was 13mm) so the number clears page content.
  const marginBottom = 8 * MM_TO_PT
  const sideMargin = 18 * MM_TO_PT
  const total = opts.startNumber + targets.length - 1
  const enc = new TextEncoder()

  operation('ページ番号の付与', () => {
    const fontRef = d.addSimpleFont(new mupdf.Font('Helvetica'))
    for (let k = 0; k < targets.length; k++) {
      const page = d.loadPage(targets[k])
      const pageObj = page.getObject()
      const [llx, lly, urx, ury] = mediaBox(page)
      const w = urx - llx
      const h = ury - lly
      if (w <= 0 || h <= 0) continue
      const { cm, visW } = pageVisualMatrix(readRotation(page), llx, lly, w, h)

      const text = formatPageNumber(opts.format, opts.startNumber + k, total)
      const tw = helvWidth(text, fontSize)
      const tx =
        opts.position === 'bottom-left'
          ? sideMargin
          : opts.position === 'bottom-right'
            ? visW - sideMargin - tw
            : (visW - tw) / 2
      const ops =
        'q\n' +
        `${cm.map(fmt).join(' ')} cm\n` +
        'BT\n' +
        `/PMHELV ${fmt(fontSize)} Tf\n` +
        '0.25 0.25 0.25 rg\n' +
        `${fmt(tx)} ${fmt(marginBottom)} Td\n` +
        `(${pdfEscape(text)}) Tj\n` +
        'ET\nQ\n'

      ownSubDict(d, ownResources(d, pageObj), 'Font').put('PMHELV', fontRef)
      const wrapped = concatBytes([
        enc.encode('q\n'),
        readPageContents(pageObj),
        enc.encode('\nQ\n'),
        enc.encode(ops)
      ])
      pageObj.put('Contents', d.addStream(wrapped, {}))
    }
  })
  return getInfo()
}

/** All stamps are translucent so underlying text stays readable; the center
 *  watermark is the lightest. */
const STAMP_OPACITY: Record<StampOptions['position'], number> = {
  center: 0.25,
  'top-right': 0.55,
  'bottom-right': 0.55
}

/**
 * Stamp a predefined red 朱印 (image asset) onto each targeted page. Corner
 * stamps are small and opaque; the center stamp is large and translucent so it
 * reads as a watermark without hiding content.
 */
export function addStamp(opts: StampOptions): DocumentInfo {
  const d = requireDoc()
  const count = d.countPages()
  const targets = resolveTargets(
    opts.scope,
    opts.pageIndex,
    opts.rangeFrom,
    opts.rangeTo,
    count
  )
  if (targets.length === 0) return getInfo()
  const b64 = STAMP_PNG_BASE64[opts.kind]
  if (!b64) throw new Error(`Unknown stamp kind: ${opts.kind}`)

  const png = Uint8Array.from(Buffer.from(b64, 'base64'))
  const opacity = STAMP_OPACITY[opts.position] ?? 1
  const margin = 22
  const enc = new TextEncoder()

  operation('スタンプの付与', () => {
    const imgRef = d.addImage(new mupdf.Image(png))
    const gs = d.newDictionary()
    gs.put('Type', d.newName('ExtGState'))
    gs.put('ca', opacity)
    gs.put('CA', opacity)
    const gsRef = d.addObject(gs)

    for (const i of targets) {
      const page = d.loadPage(i)
      const pageObj = page.getObject()
      const [llx, lly, urx, ury] = mediaBox(page)
      const w = urx - llx
      const h = ury - lly
      if (w <= 0 || h <= 0) continue
      const { cm, visW, visH } = pageVisualMatrix(
        readRotation(page),
        llx,
        lly,
        w,
        h
      )

      // Square asset → uniform scale. Place in visual space.
      let s: number
      let x: number
      let y: number
      if (opts.position === 'center') {
        s = Math.min(visW, visH) * 0.46
        x = (visW - s) / 2
        y = (visH - s) / 2
      } else {
        s = Math.min(Math.min(visW, visH) * 0.22, 96)
        x = visW - margin - s
        y = opts.position === 'top-right' ? visH - margin - s : margin
      }

      const ops =
        'q\n' +
        `${cm.map(fmt).join(' ')} cm\n` +
        '/PMGS gs\n' +
        `${fmt(s)} 0 0 ${fmt(s)} ${fmt(x)} ${fmt(y)} cm\n` +
        '/PMSTAMP Do\nQ\n'

      const res = ownResources(d, pageObj)
      ownSubDict(d, res, 'XObject').put('PMSTAMP', imgRef)
      ownSubDict(d, res, 'ExtGState').put('PMGS', gsRef)
      const wrapped = concatBytes([
        enc.encode('q\n'),
        readPageContents(pageObj),
        enc.encode('\nQ\n'),
        enc.encode(ops)
      ])
      pageObj.put('Contents', d.addStream(wrapped, {}))
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
