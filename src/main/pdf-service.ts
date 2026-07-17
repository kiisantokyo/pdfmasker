// Core PDF engine. Pure mupdf — no Electron imports — so it can be unit-tested
// in plain Node. Holds a single open document as module state (MVP: one doc).

import * as mupdf from 'mupdf'
import Tesseract from 'tesseract.js'
import type {
  ApplyScope,
  BindingMarginOptions,
  CleanReport,
  DiscrepancyReport,
  DocumentInfo,
  HiddenTextReport,
  MetadataEntry,
  PageInfo,
  PageNumberFormat,
  PageNumberOptions,
  RedactionRect,
  SaveProfile,
  RotateDelta,
  ScopedTerm,
  StampOptions,
  TermCount,
  TextBoxOptions,
  TextColor,
  FontContext,
  TextGuides,
  WordHit
} from '../shared/types'
import { STAMP_PNG_BASE64 } from './stamp-assets'
import { filterContentStream } from './content-filter'

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

/**
 * Reject OCR "words" whose bounding box is implausibly large for a text token.
 * Tesseract occasionally boxes a decorative element (speech bubble, avatar, icon)
 * as a single word spanning much of the page. Such a box has no text meaning, but
 * without this guard it flows straight into a redaction rect — and because
 * {@link ocrSelectionRects} merges vertically-overlapping words, a normal drag that
 * happens to touch it gets merged into one giant rectangle, wiping the whole image
 * (a full-page-image PDF then renders blank). The native-text path already guards
 * this via {@link plausibleQuad}; this is the OCR-side equivalent. Thresholds sit
 * far above real text tokens (which top out near ~11% of page height / ~4% area on
 * dense chat screenshots) yet well below anything that would visually blank a page.
 */
function plausibleOcrWord(
  w: OcrWord,
  pageW: number,
  pageH: number
): boolean {
  const bw = w.x1 - w.x0
  const bh = w.y1 - w.y0
  if (bw <= 0 || bh <= 0) return false
  if (bh > pageH * 0.25) return false
  if (bw > pageW * 0.9) return false
  if (bw * bh > pageW * pageH * 0.15) return false
  return true
}
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
 * Render a single page to PNG bytes at a given DPI, for image export / clipboard
 * copy. Redactions are already destructive in the document, so the rasterised
 * image never carries removed data. showExtras=true so yellow highlights render.
 */
export function renderPageImage(index: number, dpi = 200): Uint8Array {
  const d = requireDoc()
  const page = d.loadPage(index)
  const zoom = dpi / 72
  const matrix = mupdf.Matrix.scale(zoom, zoom)
  const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  try {
    return pix.asPNG()
  } finally {
    pix.destroy?.()
  }
}

/**
 * Render just a rectangular region of a page to PNG bytes, for "copy region to
 * clipboard". `rect` is in page space (PDF points, top-left origin — the same
 * space the renderer produces from canvas px ÷ zoom). The full page is rendered
 * at `dpi`, then cropped to the rect with `warp` (axis-aligned → no distortion).
 */
export function renderRegionImage(
  index: number,
  rect: { x0: number; y0: number; x1: number; y1: number },
  dpi = 200
): Uint8Array {
  const d = requireDoc()
  const page = d.loadPage(index)
  const zoom = dpi / 72
  const matrix = mupdf.Matrix.scale(zoom, zoom)
  const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true)
  const extra: mupdf.Pixmap[] = []
  try {
    const pw = pix.getWidth()
    const ph = pix.getHeight()
    // page-pt rect → device px, clamped to the rendered pixmap.
    const rx0 = Math.max(0, Math.min(rect.x0, rect.x1) * zoom)
    const ry0 = Math.max(0, Math.min(rect.y0, rect.y1) * zoom)
    const rx1 = Math.min(pw, Math.max(rect.x0, rect.x1) * zoom)
    const ry1 = Math.min(ph, Math.max(rect.y0, rect.y1) * zoom)
    const wPx = Math.max(1, Math.round(rx1 - rx0))
    const hPx = Math.max(1, Math.round(ry1 - ry0))
    // Whole-page (or degenerate) selection → just return the full render.
    const isWhole =
      rx0 <= 0.5 && ry0 <= 0.5 && rx1 >= pw - 0.5 && ry1 >= ph - 0.5
    if (isWhole || rx1 - rx0 < 1 || ry1 - ry0 < 1) return pix.asPNG()
    const crop = pix.warp(
      [
        [rx0, ry0],
        [rx1, ry0],
        [rx1, ry1],
        [rx0, ry1]
      ],
      wPx,
      hPx
    )
    extra.push(crop)
    return crop.asPNG()
  } finally {
    for (const p of extra) p.destroy?.()
    pix.destroy?.()
  }
}

/**
 * Apply TRUE redaction: removes the underlying text/image content under each
 * rect, not just a cosmetic box. This is the security-critical operation.
 *
 * `fill` only changes the *colour painted over the removed area* — both 'black'
 * and 'white' delete the underlying data. White is a whiteout that still leaves
 * nothing recoverable underneath.
 */
export function applyRedactions(
  rects: RedactionRect[],
  color?: TextColor
): void {
  const d = requireDoc()
  if (rects.length === 0) return

  const byPage = new Map<number, RedactionRect[]>()
  for (const r of rects) {
    const list = byPage.get(r.pageIndex) ?? []
    list.push(r)
    byPage.set(r.pageIndex, list)
  }

  operation(color ? '墨消しの適用' : '白塗りの適用', () => {
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
      // Always whiteout (black_boxes=false): the covered content is truly removed
      // (verified: extractable text → 0), leaving the area blank. We then paint a
      // solid rectangle in the chosen colour on top — this is what lets the fill
      // be any colour (mupdf's own redaction fill is limited to black/whiteout).
      // REDACT_IMAGE_PIXELS clears only the covered pixels of an image, so a
      // scanned/full-page-image PDF keeps the rest of the page intact.
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS)
      // color === undefined ⇒ whiteout (leave the blank area showing).
      if (color) paintFilledRects(d, page, pageRects, color)
    }
  })
}

/** Paint solid filled rectangles (page space, top-left origin) onto a page in a
 *  given colour, via a content-stream append. Rotation-aware (pageVisualMatrix).
 *  Used to colour redaction boxes after the content beneath is removed. */
function paintFilledRects(
  d: mupdf.PDFDocument,
  page: mupdf.PDFPage,
  rects: RedactionRect[],
  color: TextColor
): void {
  const pageObj = page.getObject()
  const [llx, lly, urx, ury] = mediaBox(page)
  const w = urx - llx
  const h = ury - lly
  if (w <= 0 || h <= 0) return
  const { cm, visH } = pageVisualMatrix(readRotation(page), llx, lly, w, h)
  let inner = `${fmt(color.r)} ${fmt(color.g)} ${fmt(color.b)} rg\n`
  for (const r of rects) {
    const x0 = Math.min(r.x0, r.x1)
    const x1 = Math.max(r.x0, r.x1)
    const y0 = Math.min(r.y0, r.y1)
    const y1 = Math.max(r.y0, r.y1)
    // top-left (y down) → visual bottom-left (y up)
    inner += `${fmt(x0)} ${fmt(visH - y1)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re f\n`
  }
  const ops = 'q\n' + `${cm.map(fmt).join(' ')} cm\n` + inner + 'Q\n'
  const enc = new TextEncoder()
  const wrapped = concatBytes([
    enc.encode('q\n'),
    readPageContents(pageObj),
    enc.encode('\nQ\n'),
    enc.encode(ops)
  ])
  pageObj.put('Contents', d.addStream(wrapped, {}))
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
export function highlightRects(
  rects: RedactionRect[],
  color: TextColor = { r: 1, g: 1, b: 0 }
): DocumentInfo {
  const d = requireDoc()
  if (rects.length === 0) return getInfo()
  const byPage = new Map<number, RedactionRect[]>()
  for (const r of rects) {
    const list = byPage.get(r.pageIndex) ?? []
    list.push(r)
    byPage.set(r.pageIndex, list)
  }
  const rgb: [number, number, number] = [color.r, color.g, color.b]
  operation('マーカー', () => {
    for (const [pageIndex, prs] of byPage) {
      const page = d.loadPage(pageIndex)
      for (const r of prs) {
        const x0 = Math.min(r.x0, r.x1)
        const y0 = Math.min(r.y0, r.y1)
        const x1 = Math.max(r.x0, r.x1)
        const y1 = Math.max(r.y0, r.y1)
        // A 'Square' annotation with a coloured interior fill gives a clean
        // rectangle; 'Highlight' would render with rounded ends (oval-looking).
        const annot = page.createAnnotation('Square')
        annot.setRect([x0, y0, x1, y1])
        annot.setInteriorColor(rgb)
        annot.setColor(rgb)
        annot.setBorderWidth(0)
        annot.setOpacity(0.4)
        annot.update()
      }
    }
  })
  return getInfo()
}

// ─── Mosaic (pixelate) redaction ──────────────────────────────────────────────
// Like applyRedactions, the underlying text/image data under each rect is truly
// removed. But instead of a flat black/white box, a pixelated (mosaic) rendering
// of the ORIGINAL region — captured before removal and downsampled to a coarse
// grid — is painted back on top. The mosaic is only a low-resolution average, so
// no original detail survives; the destructive removal is what makes it
// unrecoverable (the product's whole point). Uses the same image-XObject
// placement as addStamp and the /Rotate-aware pageVisualMatrix.
const MOSAIC_DPI = 150
/** Target size (PDF points) of one mosaic block; smaller = finer mosaic. */
const MOSAIC_CELL_PT = 4

export function applyMosaic(rects: RedactionRect[]): DocumentInfo {
  const d = requireDoc()
  if (rects.length === 0) return getInfo()
  const byPage = new Map<number, RedactionRect[]>()
  for (const r of rects) {
    const list = byPage.get(r.pageIndex) ?? []
    list.push(r)
    byPage.set(r.pageIndex, list)
  }
  const enc = new TextEncoder()
  const zoom = MOSAIC_DPI / 72

  operation('モザイクの適用', () => {
    for (const [pageIndex, pageRects] of byPage) {
      const page = d.loadPage(pageIndex)
      const pageObj = page.getObject()
      const [llx, lly, urx, ury] = mediaBox(page)
      const w = urx - llx
      const h = ury - lly
      if (w <= 0 || h <= 0) continue
      const { cm, visW, visH } = pageVisualMatrix(readRotation(page), llx, lly, w, h)

      // 1) Capture a pixelated image of each region from the ORIGINAL content,
      //    before any removal. The page pixmap is upright (toPixmap bakes /Rotate),
      //    so region rects (visual, top-left origin) map straight to device px.
      const pix = page.toPixmap(
        mupdf.Matrix.scale(zoom, zoom),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
      )
      const pw = pix.getWidth()
      const ph = pix.getHeight()
      const placements: {
        imgRef: mupdf.PDFObject
        name: string
        sW: number
        sH: number
        vx: number
        vy: number
      }[] = []
      try {
        pageRects.forEach((r, k) => {
          // Region in visual (upright, top-left origin) points, clamped to page.
          const bx0 = Math.max(0, Math.min(r.x0, r.x1))
          const by0 = Math.max(0, Math.min(r.y0, r.y1))
          const bx1 = Math.min(visW, Math.max(r.x0, r.x1))
          const by1 = Math.min(visH, Math.max(r.y0, r.y1))
          const wPt = bx1 - bx0
          const hPt = by1 - by0
          if (wPt < 1 || hPt < 1) return
          // Region in device pixels of the upright pixmap.
          const dx0 = Math.max(0, Math.min(bx0 * zoom, pw))
          const dy0 = Math.max(0, Math.min(by0 * zoom, ph))
          const dx1 = Math.max(0, Math.min(bx1 * zoom, pw))
          const dy1 = Math.max(0, Math.min(by1 * zoom, ph))
          if (dx1 - dx0 < 1 || dy1 - dy0 < 1) return
          // Downsample the region to a coarse grid → mosaic blocks. The PDF
          // renderer upsamples this tiny image with nearest-neighbour (images are
          // not interpolated by default), giving crisp mosaic squares.
          const gridW = Math.max(2, Math.min(64, Math.round(wPt / MOSAIC_CELL_PT)))
          const gridH = Math.max(2, Math.min(64, Math.round(hPt / MOSAIC_CELL_PT)))
          const small = pix.warp(
            [
              [dx0, dy0],
              [dx1, dy0],
              [dx1, dy1],
              [dx0, dy1]
            ],
            gridW,
            gridH
          )
          let imgRef: mupdf.PDFObject
          try {
            imgRef = d.addImage(new mupdf.Image(Uint8Array.from(small.asPNG())))
          } finally {
            small.destroy?.()
          }
          placements.push({
            imgRef,
            name: `PMMOSAIC${k}`,
            sW: wPt,
            sH: hPt,
            vx: bx0,
            vy: visH - by1 // flip top-left origin → content-stream bottom-left
          })
        })
      } finally {
        pix.destroy?.()
      }
      if (placements.length === 0) continue

      // 2) TRUE redaction: remove the underlying text/image data. The fill colour
      //    is irrelevant — the opaque mosaic is painted over it — so keep black.
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
      page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS)

      // 3) Paint the mosaic images over the (now-removed) regions.
      const res = ownResources(d, pageObj)
      const xobj = ownSubDict(d, res, 'XObject')
      let ops = 'q\n' + cm.map(fmt).join(' ') + ' cm\n'
      for (const p of placements) {
        xobj.put(p.name, p.imgRef)
        ops +=
          `q ${fmt(p.sW)} 0 0 ${fmt(p.sH)} ${fmt(p.vx)} ${fmt(p.vy)} cm\n` +
          `/${p.name} Do\nQ\n`
      }
      ops += 'Q\n'
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

/**
 * NFKC-normalise and drop ALL whitespace, so matching ignores line wraps and
 * spacing differences — e.g. an address split across two lines in a table cell
 * ("東京都千代田区丸の内" + newline + "1-2-3 …") still matches the joined term
 * an AI returns.
 */
function stripWhitespace(s: string): string {
  return s.normalize('NFKC').replace(/\s+/gu, '')
}

/**
 * Whitespace-insensitive native-text search on one page. mupdf's `page.search`
 * treats a line break as a single space, so a term with no separator at the wrap
 * point won't match across lines. This concatenates the page's characters with
 * all whitespace removed and maps each match back to per-line boxes.
 */
function wsInsensitiveFind(
  page: mupdf.PDFPage,
  pageIndex: number,
  needle: string
): RedactionRect[] {
  const target = stripWhitespace(needle)
  if (!target) return []
  const quads: mupdf.Quad[] = []
  const lineOf: number[] = []
  let norm = ''
  const owner: number[] = []
  let lineIdx = -1
  page.toStructuredText().walk({
    beginLine() {
      lineIdx++
    },
    onChar(c, _origin, _font, _size, quad) {
      const ci = quads.length
      quads.push(quad)
      lineOf.push(lineIdx)
      for (const nc of stripWhitespace(c)) {
        norm += nc
        owner.push(ci)
      }
    }
  })
  const out: RedactionRect[] = []
  for (
    let idx = norm.indexOf(target);
    idx >= 0;
    idx = norm.indexOf(target, idx + target.length)
  ) {
    const first = owner[idx]
    const last = owner[idx + target.length - 1]
    // One box per visual line (split at line boundaries, not by y-overlap, so a
    // wrapped term doesn't paint one giant rectangle over the whitespace between).
    let cur: { x0: number; y0: number; x1: number; y1: number } | null = null
    let curLine = -1
    for (let k = first; k <= last; k++) {
      const b = quadToBox(quads[k])
      if (cur && lineOf[k] === curLine) {
        cur.x0 = Math.min(cur.x0, b.x0)
        cur.y0 = Math.min(cur.y0, b.y0)
        cur.x1 = Math.max(cur.x1, b.x1)
        cur.y1 = Math.max(cur.y1, b.y1)
      } else {
        if (cur) out.push({ pageIndex, ...cur })
        cur = { ...b }
        curLine = lineOf[k]
      }
    }
    if (cur) out.push({ pageIndex, ...cur })
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
    if (matches.length > 0) {
      for (const match of matches) {
        // Each match is one or more quads (one per visual line); redact each.
        for (const quad of match) {
          rects.push({ pageIndex: i, ...quadToBox(quad) })
        }
      }
    } else {
      // Native search missed on this page — retry ignoring whitespace so a term
      // that wraps across lines (with no separator) is still found.
      rects.push(...wsInsensitiveFind(page, i, trimmed))
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

// ─── Hidden (invisible) text: detect / visible-only extract / remove ──────────
// Invisible text (render mode 3/7) is not shown on screen but IS extracted by
// search/copy/AI — an adversary can hide instructions or false data there. These
// use the content-stream filter to isolate or strip it.

/**
 * Serialize the open doc and reopen an isolated throwaway copy for read-only
 * inspection. Uses NO garbage collection on purpose: mupdf's `garbage` compaction
 * renumbers objects and invalidates the live document's undo journal, so a plain
 * save keeps the journal intact while still producing a fully independent copy.
 */
function reopenCopy(): mupdf.PDFDocument {
  const d = requireDoc()
  const bytes = Uint8Array.from(d.saveToBuffer('').asUint8Array())
  const copy = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()
  if (!copy) throw new Error('内部コピーの生成に失敗しました')
  return copy
}

/**
 * Map each ExtGState resource name on the page to its fill alpha (`/ca`), so the
 * content filter can flag text drawn transparently (ca ≈ 0). Missing ⇒ opaque.
 */
function pageGsAlpha(pageObj: mupdf.PDFObject): Record<string, number> {
  const out: Record<string, number> = {}
  const res = pageObj.getInheritable('Resources')
  const egs = res && res.isDictionary() ? res.get('ExtGState') : null
  if (egs && egs.isDictionary()) {
    egs.forEach((val, key) => {
      const ca = val.get('ca')
      if (ca && ca.isNumber()) out[String(key)] = ca.asNumber()
    })
  }
  return out
}

/** Replace a page's content with a single uncompressed stream of `bytes`. */
function writePageContents(
  d: mupdf.PDFDocument,
  pageObj: mupdf.PDFObject,
  bytes: Uint8Array
): void {
  pageObj.put('Contents', d.addStream(bytes, {}))
}

/**
 * Detect invisible text (a hidden / poisoned OCR layer). Returns the run count
 * and a per-page readable preview. Does not modify the open document.
 */
export function detectHiddenText(): HiddenTextReport {
  const copy = reopenCopy()
  try {
    const count = copy.countPages()
    const items: { page: number; text: string }[] = []
    for (let i = 0; i < count; i++) {
      const pageObj = copy.loadPage(i).getObject()
      const bytes = readPageContents(pageObj)
      if (bytes.length === 0) continue
      const alpha = pageGsAlpha(pageObj)
      const invis = filterContentStream(bytes, 'invisible', alpha)
      if (invis.removed === 0) continue
      // Isolate the hidden text: strip the VISIBLE glyphs, then collect each
      // remaining text BLOCK (≈ paragraph) separately. Counting blocks — not the
      // low-level draw operators — makes "N 箇所" match what a human perceives
      // (a Word white-text paragraph is one passage, not dozens of operators).
      writePageContents(copy, pageObj, filterContentStream(bytes, 'visible', alpha).output)
      let block = ''
      copy.loadPage(i).toStructuredText().walk({
        beginTextBlock() {
          block = ''
        },
        onChar(c) {
          block += c
        },
        endLine() {
          block += ' '
        },
        endTextBlock() {
          const t = block.replace(/\s+/g, ' ').trim()
          if (t) items.push({ page: i, text: t })
        }
      })
    }
    return { runs: items.length, items }
  } finally {
    copy.destroy?.()
  }
}

/**
 * Whole-document plain text with invisible text removed — "what is visually
 * present". Bundle THIS to an external AI so hidden text can't reach it.
 */
export function visibleOnlyText(): string {
  const copy = reopenCopy()
  try {
    const count = copy.countPages()
    const parts: string[] = []
    for (let i = 0; i < count; i++) {
      const pageObj = copy.loadPage(i).getObject()
      const bytes = readPageContents(pageObj)
      if (bytes.length > 0) {
        const r = filterContentStream(bytes, 'invisible', pageGsAlpha(pageObj))
        if (r.removed > 0) writePageContents(copy, pageObj, r.output)
      }
      parts.push(copy.loadPage(i).toStructuredText().asText())
    }
    return parts.join('\n')
  } finally {
    copy.destroy?.()
  }
}

/**
 * Permanently remove invisible text from the open document (one undoable op).
 * Returns the refreshed info and how many hidden text runs were removed.
 */
export function removeHiddenText(): { info: DocumentInfo; removed: number } {
  const d = requireDoc()
  const count = d.countPages()
  let removed = 0
  operation('隠し文字の削除', () => {
    for (let i = 0; i < count; i++) {
      const pageObj = d.loadPage(i).getObject()
      const bytes = readPageContents(pageObj)
      if (bytes.length === 0) continue
      const r = filterContentStream(bytes, 'invisible', pageGsAlpha(pageObj))
      if (r.removed > 0) {
        writePageContents(d, pageObj, r.output)
        removed += r.removed
      }
    }
  })
  return { info: getInfo(), removed }
}

// ─── Render × embedded-text comparison (thorough hidden-text audit) ───────────
// The heuristic detector above recognises specific hiding methods. This instead
// compares what is actually VISIBLE (OCR of the rendered page) with what is
// EMBEDDED (extractable text). Any embedded line that is not visibly present —
// no matter HOW it was hidden (behind an image, microscopic, off-tint, …) — is
// flagged. Heavy (OCR per page); exposed as a separate, opt-in action.

/** Fraction of an embedded line (as 4-gram windows) that appears in the OCR text. */
function visibleRatio(s: string, hay: string): number {
  if (s.length < 4) return hay.includes(s) ? 1 : 0
  let total = 0
  let found = 0
  for (let i = 0; i + 4 <= s.length; i += 2) {
    total++
    if (hay.includes(s.slice(i, i + 4))) found++
  }
  return total ? found / total : hay.includes(s) ? 1 : 0
}

/**
 * Pure comparator: which embedded lines are NOT visibly present in `ocrText`?
 * Whitespace/case-insensitive with OCR-error tolerance (partial n-gram match).
 * Exported for testing.
 */
export function discrepantLines(embeddedLines: string[], ocrText: string): string[] {
  const hay = stripWhitespace(ocrText)
  const out: string[] = []
  for (const l of embeddedLines) {
    const norm = stripWhitespace(l)
    if (norm.length < 3) continue // too short to judge reliably
    // Only flag lines that are almost entirely ABSENT from the rendered page.
    // A visible line survives OCR errors (some n-grams still match); a hidden
    // line matches almost nothing → low ratio.
    if (visibleRatio(norm, hay) < 0.3) out.push(l.replace(/\s+/g, ' ').trim())
  }
  return out
}

/**
 * Audit every page by OCR'ing its rendered image and comparing to the embedded
 * text. Returns, for each embedded line NOT visibly present, both the embedded
 * text and what is actually visible at that position (so the user can see the
 * discrepancy). `cachePath` is the Tesseract model cache. Slow — opt-in.
 */
export async function findDiscrepantText(
  cachePath: string,
  onProgress?: (page: number, total: number) => void
): Promise<DiscrepancyReport> {
  const d = requireDoc()
  const count = d.countPages()
  const zoom = OCR_DPI / 72
  const worker = await Tesseract.createWorker('jpn+eng', Tesseract.OEM.LSTM_ONLY, {
    cachePath
  })
  try {
    const items: { page: number; embedded: string; visible: string }[] = []
    for (let i = 0; i < count; i++) {
      const page = d.loadPage(i)
      // Embedded lines with their vertical band.
      const emb: { text: string; y0: number; y1: number }[] = []
      let text = ''
      let ly0 = 0
      let ly1 = 0
      page.toStructuredText().walk({
        beginLine(bbox) {
          text = ''
          ly0 = bbox[1]
          ly1 = bbox[3]
        },
        onChar(c) {
          text += c
        },
        endLine() {
          if (text.trim()) emb.push({ text, y0: ly0, y1: ly1 })
        }
      })
      if (emb.length === 0) {
        onProgress?.(i + 1, count)
        continue
      }
      const pix = page.toPixmap(
        mupdf.Matrix.scale(zoom, zoom),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
      )
      const png = pix.asPNG()
      pix.destroy?.()
      const { data } = await worker.recognize(Buffer.from(png), {}, { blocks: true })
      // OCR words with page-pt positions (for pairing) and the whole visible text.
      const words: { text: string; x0: number; yt: number; yb: number }[] = []
      for (const b of data.blocks ?? []) {
        for (const p of b.paragraphs) {
          for (const ln of p.lines) {
            for (const w of ln.words) {
              const t = w.text?.trim()
              if (t)
                words.push({
                  text: t,
                  x0: w.bbox.x0 / zoom,
                  yt: w.bbox.y0 / zoom,
                  yb: w.bbox.y1 / zoom
                })
            }
          }
        }
      }
      // Merge consecutive discrepant lines (a wrapped paragraph) into one item.
      let pend: { y1: number; embedded: string; visible: string } | null = null
      const flush = (): void => {
        if (pend) {
          items.push({ page: i, embedded: pend.embedded, visible: pend.visible })
          pend = null
        }
      }
      for (const el of emb) {
        const norm = stripWhitespace(el.text)
        // What is actually VISIBLE at this line's position (same vertical band)?
        // Compare against THIS position — not the whole page — so text that only
        // differs subtly from a visible line elsewhere (e.g. a white "9,000,000"
        // vs a visible "1,000,000") is still caught.
        const visible = words
          .filter((w) => w.yb >= el.y0 && w.yt <= el.y1)
          .sort((a, b) => a.x0 - b.x0)
          .map((w) => w.text)
          .join(' ')
          .trim()
        const discrepant =
          norm.length >= 3 && visibleRatio(norm, stripWhitespace(visible)) < 0.3
        if (!discrepant) {
          flush()
          continue
        }
        const clean = el.text.replace(/\s+/g, ' ').trim()
        if (pend) {
          // Consecutive hidden lines (a wrapped paragraph) → one item.
          pend.embedded += clean
          pend.y1 = el.y1
        } else {
          pend = {
            y1: el.y1,
            embedded: clean,
            visible: visible || '（この位置に見える文字はありません）'
          }
        }
      }
      flush()
      onProgress?.(i + 1, count)
    }
    return { runs: items.length, items }
  } finally {
    await worker.terminate()
  }
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
      const [px0, py0, px1, py1] = page.getBounds()
      const pageW = px1 - px0
      const pageH = py1 - py0
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
              const word: OcrWord = {
                text,
                x0: w.bbox.x0 / zoom,
                y0: w.bbox.y0 / zoom,
                x1: w.bbox.x1 / zoom,
                y1: w.bbox.y1 / zoom
              }
              // Drop recognition artifacts (a decoration boxed as one giant
              // "word") so they can't become a whole-image redaction rect.
              if (!plausibleOcrWord(word, pageW, pageH)) continue
              words.push(word)
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
    // Credit card: 16 digits in four groups (space/hyphen optional), not inside a
    // longer digit run. Checked before マイナンバー so a spaced 16-digit number is
    // not mistaken for a 12-digit one.
    {
      kind: 'カード番号',
      re: /(?<![\d-])(?:\d{4}[-\s]?){3}\d{4}(?![\d-])/g
    },
    // My Number: 12 digits, optionally grouped in 4s.
    {
      kind: 'マイナンバー・ID',
      re: /(?<![\d-])\d{4}[-\s]?\d{4}[-\s]?\d{4}(?![\d-])/g
    },
    // Bank account: a 6–8 digit number carrying an explicit account label.
    {
      kind: '口座番号',
      re: /(?:口座番号|普通|当座|口座)[\s:：]*\d{6,8}/g
    },
    // Full dates — Japanese era (令和6年1月2日) or Western (2024年1月2日 / 2024/1/2 /
    // 2024-01-02). Likely 生年月日・日付; the user reviews before redacting.
    {
      kind: '日付・生年月日',
      re: /(?:明治|大正|昭和|平成|令和)\s?\d{1,2}\s?年\s?\d{1,2}\s?月\s?\d{1,2}\s?日/g
    },
    {
      kind: '日付・生年月日',
      re: /\d{4}\s?[年./-]\s?\d{1,2}\s?[月./-]\s?\d{1,2}\s?日?/g
    },
    // Address: a 都道府県 followed by 市区郡町村 and the run up to the first number.
    {
      kind: '住所',
      re: /(?:東京都|北海道|(?:大阪|京都)府|[一-龥]{2,3}県)[一-龥ぁ-んァ-ヶA-Za-z0-9０-９]{1,10}?[市区郡町村][一-龥ぁ-んァ-ヶ0-9０-９ー\-丁目番地号]{0,24}/g
    },
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
  // Whitespace-insensitive so terms that wrap across lines in the source (the
  // extracted text joins lines with '\n') are still counted — matches findWord.
  const text = stripWhitespace(documentText())
  const seen = new Set<string>()
  const out: TermCount[] = []
  for (const raw of terms) {
    const term = raw.trim()
    if (!term || seen.has(term)) continue
    seen.add(term)
    const count = countOccurrences(text, stripWhitespace(term))
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
/** A PDF content-stream matrix [a b c d e f] (maps (x,y)→(ax+cy+e, bx+dy+f)). */
type Mat6 = [number, number, number, number, number, number]

/** Overwrite a page box with a plain [0,0,w,h] rectangle. Written as a raw
 *  array on purpose: page.setPageBox() applies hidden rotation/repositioning
 *  transforms (it swapped/offset the box on /Rotate pages), which is exactly
 *  what broke 回転＋用紙サイズ変更. */
function putBox(
  d: mupdf.PDFDocument,
  obj: mupdf.PDFObject,
  name: string,
  w: number,
  h: number
): void {
  const arr = d.newArray()
  arr.push(0)
  arr.push(0)
  arr.push(w)
  arr.push(h)
  obj.put(name, arr)
}

function transformAnnotations(page: mupdf.PDFPage, m: Mat6): void {
  const [a, b, c, d, e, f] = m
  const mapX = (x: number, y: number): number => a * x + c * y + e
  const mapY = (x: number, y: number): number => b * x + d * y + f
  for (const annot of page.getAnnotations()) {
    const obj = annot.getObject()
    const rect = obj.get('Rect')
    if (rect && rect.isArray() && rect.length === 4) {
      const x0 = rect.get(0).asNumber()
      const y0 = rect.get(1).asNumber()
      const x1 = rect.get(2).asNumber()
      const y1 = rect.get(3).asNumber()
      // Map both corners then re-normalise: a 90/270° transform swaps which
      // corner is the minimum.
      const px0 = mapX(x0, y0)
      const py0 = mapY(x0, y0)
      const px1 = mapX(x1, y1)
      const py1 = mapY(x1, y1)
      rect.put(0, Math.min(px0, px1))
      rect.put(1, Math.min(py0, py1))
      rect.put(2, Math.max(px0, px1))
      rect.put(3, Math.max(py0, py1))
    }
    const qp = obj.get('QuadPoints')
    if (qp && qp.isArray()) {
      const n = qp.length
      for (let k = 0; k + 1 < n; k += 2) {
        const x = qp.get(k).asNumber()
        const y = qp.get(k + 1).asNumber()
        qp.put(k, mapX(x, y))
        qp.put(k + 1, mapY(x, y))
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
      const rot = readRotation(page)
      const [llx, lly, urx, ury] = mediaBox(page)
      const W = urx - llx
      const H = ury - lly
      if (W <= 0 || H <= 0) continue

      // Work in *visual* space. A /Rotate=90/270 page's on-screen orientation is
      // the media box swapped; deciding the paper orientation and the fit from
      // the raw box (ignoring rotation) is what clipped/mis-placed rotated
      // pages. We fit+centre in visual space, bake the rotation into the content
      // matrix, and reset /Rotate to 0 so the box and content always agree.
      const turned = rot === 90 || rot === 270
      const visW = turned ? H : W
      const visH = turned ? W : H
      const landscape = visW > visH
      const tW = (landscape ? longMm : shortMm) * MM_TO_PT
      const tH = (landscape ? shortMm : longMm) * MM_TO_PT

      const s = Math.min(tW / visW, tH / visH)
      const ox = (tW - visW * s) / 2
      const oy = (tH - visH * s) / 2

      // Affine mapping raw media coords → new upright page coords: undo the page
      // /Rotate, scale by s, then centre by (ox,oy).
      let m: Mat6
      switch (rot) {
        case 90:
          m = [0, -s, s, 0, ox - s * lly, s * (W + llx) + oy]
          break
        case 180:
          m = [-s, 0, 0, -s, s * (W + llx) + ox, s * (H + lly) + oy]
          break
        case 270:
          m = [0, s, -s, 0, s * (H + lly) + ox, oy - s * llx]
          break
        default:
          m = [s, 0, 0, s, ox - s * llx, oy - s * lly]
      }

      const obj = page.getObject()
      // Remember the very first (pre-resize) *visual* size so the UI can show
      // "B4→A4" correctly regardless of rotation.
      const had = obj.get('PMOrigW')
      if (!(had && had.isNumber())) {
        obj.put('PMOrigW', visW)
        obj.put('PMOrigH', visH)
      }
      const enc = new TextEncoder()
      const wrapped = concatBytes([
        enc.encode(`q ${m[0]} ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]} cm\n`),
        readPageContents(obj),
        enc.encode('\nQ\n')
      ])
      obj.put('Contents', d.addStream(wrapped, {}))
      // Rotation is baked into the content — the page is upright now.
      obj.put('Rotate', 0)
      putBox(d, obj, 'MediaBox', tW, tH)
      putBox(d, obj, 'CropBox', tW, tH)
      transformAnnotations(page, m)
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

/**
 * Move a set of pages so they land at insertion gap `to` (0..count, an index in
 * the ORIGINAL order; `count` = end). The moved pages keep their relative order.
 * One journal operation = one undo. Used by drag-and-drop reordering.
 */
export function movePages(indices: number[], to: number): DocumentInfo {
  const d = requireDoc()
  const count = d.countPages()
  const sel = [...new Set(indices)]
    .filter((i) => i >= 0 && i < count)
    .sort((a, b) => a - b)
  if (sel.length === 0) return getInfo()
  const selSet = new Set(sel)
  const order = Array.from({ length: count }, (_, i) => i)
  const remaining = order.filter((i) => !selSet.has(i))
  const clampedTo = Math.max(0, Math.min(to, count))
  const insertAt = remaining.filter((i) => i < clampedTo).length
  const newOrder = [
    ...remaining.slice(0, insertAt),
    ...sel,
    ...remaining.slice(insertAt)
  ]
  // No-op if the order is unchanged.
  if (newOrder.every((v, i) => v === i)) return getInfo()
  operation('ページ移動', () => d.rearrangePages(newOrder))
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
      transformAnnotations(page, [s, 0, 0, s, tx, ty])
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

// --- Text insertion ---------------------------------------------------------

/**
 * Bundled Japanese font bytes, injected once from the main process (kept out of
 * this Electron-free core: main reads the file and calls setJpFont). The parsed
 * mupdf.Font is cached because parsing a full CJK font is not free; it is
 * document-independent, so we reuse it and only re-`addFont` per document.
 */
let jpFontData: Uint8Array | null = null
let jpFont: mupdf.Font | null = null
let jpFontBoldData: Uint8Array | null = null
let jpFontBold: mupdf.Font | null = null

/** Supply the regular Japanese font used for inserted text (font bytes). */
export function setJpFont(data: Uint8Array): void {
  jpFontData = data
  jpFont = null
}

/** Supply the bold Japanese font (optional; enables the 太字 toggle). */
export function setJpFontBold(data: Uint8Array): void {
  jpFontBoldData = data
  jpFontBold = null
}

/** Return the regular or bold mupdf.Font (bold falls back to regular if the bold
 *  face was not bundled). Fonts are parsed once and reused across documents. */
function requireJpFont(bold = false): mupdf.Font {
  if (bold && jpFontBoldData) {
    if (!jpFontBold) jpFontBold = new mupdf.Font('PMTextB', jpFontBoldData, 0)
    return jpFontBold
  }
  if (!jpFontData) {
    throw new Error('日本語フォントが読み込まれていません（文字入れ機能は未初期化）')
  }
  if (!jpFont) jpFont = new mupdf.Font('PMText', jpFontData, 0)
  return jpFont
}

/** Encode a line as a 2-byte hex CID string for an Identity CIDFont (addFont).
 *  Each Unicode scalar maps to a glyph id via encodeCharacter. */
function hexCids(font: mupdf.Font, line: string): string {
  let out = ''
  for (const ch of line) {
    const gid = font.encodeCharacter(ch.codePointAt(0) as number)
    out += (gid & 0xffff).toString(16).padStart(4, '0')
  }
  return out
}

/**
 * Sample the size of the existing text nearest a click point, so the inline
 * editor can default a new box to the surrounding document's size. Works in the
 * same top-left-origin point space the renderer sends (as wordAt/selectText do).
 * Returns null when no text is near (e.g. a blank margin).
 */
export function fontContextAt(
  pageIndex: number,
  x: number,
  y: number
): FontContext {
  const d = requireDoc()
  const stext = d.loadPage(pageIndex).toStructuredText()
  let bestSize: number | null = null
  let bestDist = Infinity
  stext.walk({
    onChar(_c, _origin, _font, size, quad) {
      const b = quadToBox(quad)
      const cx = (b.x0 + b.x1) / 2
      const cy = (b.y0 + b.y1) / 2
      const dd = (cx - x) ** 2 + (cy - y) ** 2
      if (dd < bestDist) {
        bestDist = dd
        bestSize = size
      }
    }
  })
  // Ignore matches that are far away (> ~2cm): a lone label across the page is
  // not useful context; fall back to the editor's own default instead.
  if (bestSize != null && bestDist <= 56 * 56) {
    return { fontSize: Math.round(bestSize * 10) / 10 }
  }
  return { fontSize: null }
}

/** Build the `BT … ET` text-drawing body for one text box, in the page's visual
 *  bottom-left space (caller wraps it with the pageVisualMatrix `cm`). */
function textItemBody(
  font: mupdf.Font,
  opts: TextBoxOptions,
  visH: number,
  fontName: string
): string {
  const size = Math.max(1, opts.fontSize)
  const col = opts.color ?? { r: 0.1, g: 0.1, b: 0.1 }
  const lines = (opts.text ?? '').replace(/\r\n?/g, '\n').split('\n')
  // ascent = top→baseline; leading = baseline→baseline. Both come from the
  // renderer's editor metrics (see TextBoxOptions) so the burn matches the
  // on-page overlay exactly; fall back to reasonable ratios when absent.
  const ascent = opts.ascentPt ?? size * 0.8
  const leading = opts.lineHeightPt ?? size * 1.35
  const bx = opts.x
  const byTop = visH - (opts.y + ascent)

  let body = 'BT\n' + `/${fontName} ${fmt(size)} Tf\n`
  body += `${fmt(col.r)} ${fmt(col.g)} ${fmt(col.b)} rg\n`
  body += `${fmt(-leading)} TL\n`
  body += `${fmt(bx)} ${fmt(byTop)} Td\n`
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) body += 'T*\n'
    body += `<${hexCids(font, lines[i])}> Tj\n`
  }
  body += 'ET\n'
  return body
}

/**
 * Collect alignment guides for a page: the baseline y and left edge x of each
 * existing text line (page points, top-left origin). The renderer snaps a new/
 * moved text box to these so 文字入れ lines up with the document. Baseline comes
 * from glyph origins; left edge from the line bbox / glyph quads. Empty for
 * pages without native text (e.g. un-OCR'd scans).
 */
export function pageTextGuides(pageIndex: number): TextGuides {
  const d = requireDoc()
  const stext = d.loadPage(pageIndex).toStructuredText()
  const baseSet = new Set<number>()
  const leftSet = new Set<number>()
  const round1 = (v: number): number => Math.round(v * 10) / 10
  let sum = 0
  let n = 0
  let left = Infinity
  stext.walk({
    beginLine(bbox) {
      sum = 0
      n = 0
      left = bbox && bbox.length >= 1 ? bbox[0] : Infinity
    },
    onChar(_c, origin, _font, _size, quad) {
      sum += origin[1] // origin sits on the baseline
      n++
      const x0 = Math.min(quad[0], quad[2], quad[4], quad[6])
      if (x0 < left) left = x0
    },
    endLine() {
      if (n > 0) {
        baseSet.add(round1(sum / n))
        if (Number.isFinite(left)) leftSet.add(round1(left))
      }
    }
  })
  return {
    baselines: [...baseSet].sort((a, b) => a - b),
    lefts: [...leftSet].sort((a, b) => a - b)
  }
}

/**
 * Burn one or more text boxes into their pages as real, selectable/searchable
 * text: the Japanese font is embedded as an Identity CIDFont (subset on save),
 * so glyphs render and round-trip through extraction. No border/background is
 * drawn (a deliberate default — the common "form fill" case wants clean text).
 * All boxes are applied in ONE journal operation (= one undo). Placed via
 * pageVisualMatrix so text stays upright on /Rotate pages.
 */
export function insertTextBoxes(items: TextBoxOptions[]): DocumentInfo {
  const d = requireDoc()
  const valid = items.filter((it) => (it.text ?? '').trim())
  if (valid.length === 0) return getInfo()
  const font = requireJpFont(false)
  const enc = new TextEncoder()

  // Group by page so each page's content stream is rewritten once.
  const byPage = new Map<number, TextBoxOptions[]>()
  for (const it of valid) {
    const arr = byPage.get(it.pageIndex)
    if (arr) arr.push(it)
    else byPage.set(it.pageIndex, [it])
  }

  operation('文字の挿入', () => {
    for (const [pageIndex, its] of byPage) {
      const page = d.loadPage(pageIndex)
      const pageObj = page.getObject()
      const [llx, lly, urx, ury] = mediaBox(page)
      const w = urx - llx
      const h = ury - lly
      if (w <= 0 || h <= 0) continue
      const { cm, visH } = pageVisualMatrix(readRotation(page), llx, lly, w, h)

      const usesBold = its.some((it) => it.bold)
      const boldFont = usesBold ? requireJpFont(true) : font
      const fontDict = ownSubDict(d, ownResources(d, pageObj), 'Font')
      fontDict.put('PMTEXT', d.addFont(font))
      if (usesBold) fontDict.put('PMTEXTB', d.addFont(boldFont))

      let inner = ''
      for (const it of its) {
        const bold = !!it.bold
        inner += textItemBody(
          bold ? boldFont : font,
          it,
          visH,
          bold ? 'PMTEXTB' : 'PMTEXT'
        )
      }
      const ops = 'q\n' + `${cm.map(fmt).join(' ')} cm\n` + inner + 'Q\n'

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

/** Convenience: burn a single text box (one undo). */
export function insertTextBox(opts: TextBoxOptions): DocumentInfo {
  return insertTextBoxes([opts])
}

/**
 * mupdf save-option fragment that turns on AES-256 encryption for `password`
 * (empty when no password). Composed onto any save so encryption combines with
 * a size profile or image-flattening. The password must not contain a comma —
 * mupdf's options are a comma-separated string. (Verified: letters/digits/
 * symbols/日本語 all round-trip; only ',' breaks it.)
 */
function encryptSuffix(password?: string): string {
  if (!password) return ''
  if (password.includes(',')) {
    throw new Error('パスワードにカンマ「,」は使用できません')
  }
  return `,encrypt=aes-256,user-password=${password},owner-password=${password}`
}

/**
 * Serialize the current document to PDF bytes (garbage-collected & compacted).
 * When `password` is given the output is AES-256 encrypted.
 */
export function saveToBuffer(password?: string): Uint8Array {
  const d = requireDoc()
  // mupdf's `garbage` compaction renumbers objects and invalidates the undo
  // journal — running it on the live document would silently break Ctrl+Z after
  // every save. So serialize the live doc WITHOUT garbage first (journal-safe),
  // then compact on a reopened, fully independent copy. The live document keeps
  // its full undo history.
  const plain = Uint8Array.from(d.saveToBuffer('').asUint8Array())
  const tmp = mupdf.Document.openDocument(plain, 'application/pdf').asPDF()
  if (!tmp) return plain
  try {
    // Subset embedded fonts on the throwaway copy: 文字入れ embeds a full CJK
    // font (~5MB) that would otherwise bloat every save. Runs here (not on the
    // live doc) so it never invalidates the undo journal. No-op when there is
    // nothing to subset.
    tmp.subsetFonts?.()
    const buf = tmp.saveToBuffer('garbage=compact,sanitize=yes' + encryptSuffix(password))
    // Copy out of the WASM heap *before* freeing the buffer. asUint8Array() is a
    // view into the heap; destroying the buffer frees that memory (the allocator
    // then writes free-list pointers into the first bytes), so the copy must run
    // while the buffer is still alive — otherwise the PDF header gets corrupted.
    const out = Uint8Array.from(buf.asUint8Array())
    buf.destroy?.()
    return out
  } finally {
    tmp.destroy?.()
  }
}

// ─── Save with a size profile (image recompression) ──────────────────────────
// 'original' keeps images untouched (lossless). 'standard'/'light' downsample &
// re-encode raster images to shrink scans/photos. Runs on a throwaway copy so the
// live document keeps full quality and its undo history.

const PROFILE_SETTINGS: Record<'standard' | 'light', { maxDpi: number; quality: number }> = {
  standard: { maxDpi: 200, quality: 80 },
  light: { maxDpi: 150, quality: 55 }
}

function longEdgePt(pageObj: mupdf.PDFObject): number {
  const mb = pageObj.getInheritable('MediaBox')
  if (mb && mb.isArray() && mb.length >= 4) {
    const w = Math.abs(mb.get(2).asNumber() - mb.get(0).asNumber())
    const h = Math.abs(mb.get(3).asNumber() - mb.get(1).asNumber())
    if (w > 0 && h > 0) return Math.max(w, h)
  }
  return 842 // A4 long edge fallback
}

/**
 * Re-encode a single image XObject as JPEG, downsampled so its long edge fits
 * `capPx`. Returns a new image reference, or null when it should be left as-is
 * (bilevel scan, transparency, or re-encoding wouldn't shrink it).
 */
function recompressImage(
  d: mupdf.PDFDocument,
  obj: mupdf.PDFObject,
  capPx: number,
  quality: number
): mupdf.PDFObject | null {
  let img: mupdf.Image
  try {
    img = d.loadImage(obj)
  } catch {
    return null
  }
  // Leave stencil masks, bilevel (fax) scans, and masked/transparent images.
  if (img.getImageMask() || img.getBitsPerComponent() === 1 || img.getMask()) {
    return null
  }
  const sm = obj.get('SMask')
  if (sm && !sm.isNull()) return null

  let pm: mupdf.Pixmap
  try {
    pm = img.toPixmap()
  } catch {
    return null
  }
  const extra: mupdf.Pixmap[] = []
  try {
    if (pm.getAlpha()) return null
    let work = pm
    const comps = work.getNumberOfComponents()
    if (comps !== 1 && comps !== 3) {
      work = work.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false)
      extra.push(work)
    }
    const w = work.getWidth()
    const h = work.getHeight()
    const longEdge = Math.max(w, h)
    let enc = work
    if (capPx > 0 && longEdge > capPx) {
      const scale = capPx / longEdge
      const tw = Math.max(1, Math.round(w * scale))
      const th = Math.max(1, Math.round(h * scale))
      enc = work.warp(
        [
          [0, 0],
          [w, 0],
          [w, h],
          [0, h]
        ],
        tw,
        th
      )
      extra.push(enc)
    }
    let jpeg: Uint8Array
    try {
      jpeg = enc.asJPEG(quality, false)
    } catch {
      return null
    }
    // Only apply if it actually shrinks the stored image.
    let origLen = Infinity
    try {
      origLen = obj.readRawStream().asUint8Array().length
    } catch {
      /* keep Infinity */
    }
    if (jpeg.length >= origLen) return null
    return d.addImage(new mupdf.Image(Uint8Array.from(jpeg)))
  } finally {
    for (const p of extra) p.destroy?.()
    pm.destroy?.()
    img.destroy?.()
  }
}

/** Downsample & re-encode raster images throughout `d` (in place). */
function optimizeImages(d: mupdf.PDFDocument, maxDpi: number, quality: number): void {
  const images = new Map<number, { obj: mupdf.PDFObject; capPx: number }>()
  const refs: { dict: mupdf.PDFObject; name: string; num: number }[] = []
  const count = d.countPages()
  for (let i = 0; i < count; i++) {
    const pageObj = d.loadPage(i).getObject()
    const res = pageObj.getInheritable('Resources')
    if (!res || !res.isDictionary()) continue
    const xobj = res.get('XObject')
    if (!xobj || !xobj.isDictionary()) continue
    const capPx = Math.round((maxDpi * longEdgePt(pageObj)) / 72)
    xobj.forEach((val, key) => {
      const sub = val.get('Subtype')
      if (!(sub && sub.isName() && sub.asName() === 'Image')) return
      const num = val.isIndirect() ? val.asIndirect() : -1
      refs.push({ dict: xobj, name: String(key), num })
      if (num >= 0) {
        const prev = images.get(num)
        if (prev) {
          if (capPx > prev.capPx) prev.capPx = capPx
        } else {
          images.set(num, { obj: val, capPx })
        }
      }
    })
  }
  const replacements = new Map<number, mupdf.PDFObject>()
  for (const [num, { obj, capPx }] of images) {
    const nr = recompressImage(d, obj, capPx, quality)
    if (nr) replacements.set(num, nr)
  }
  for (const r of refs) {
    const nr = replacements.get(r.num)
    if (nr) r.dict.put(r.name, nr)
  }
}

/**
 * Serialize with a size profile. 'original' == saveToBuffer(). When `password`
 * is given the output is AES-256 encrypted (encryption composes with the profile).
 */
export function saveToBufferProfiled(
  profile: SaveProfile,
  password?: string
): Uint8Array {
  if (profile === 'original') return saveToBuffer(password)
  const { maxDpi, quality } = PROFILE_SETTINGS[profile]
  const d = requireDoc()
  // Optimize on an independent, journal-safe copy; never touch the live doc.
  const plain = Uint8Array.from(d.saveToBuffer('').asUint8Array())
  const tmp = mupdf.Document.openDocument(plain, 'application/pdf').asPDF()
  if (!tmp) return saveToBuffer(password)
  try {
    optimizeImages(tmp, maxDpi, quality)
    tmp.subsetFonts?.() // shrink the embedded 文字入れ CJK font to used glyphs
    const buf = tmp.saveToBuffer(
      'garbage=compact,sanitize=yes,compress-images,compress-fonts,compress' +
        encryptSuffix(password)
    )
    const out = Uint8Array.from(buf.asUint8Array())
    buf.destroy?.()
    return out
  } finally {
    tmp.destroy?.()
  }
}

// ─── Extract / trim pages ─────────────────────────────────────────────────────

/** Build a new PDF containing only the given pages (grafted in sorted order). */
export function extractPagesToBuffer(indices: number[]): Uint8Array {
  const d = requireDoc()
  const count = d.countPages()
  const sorted = [...new Set(indices)]
    .filter((i) => i >= 0 && i < count)
    .sort((a, b) => a - b)
  if (sorted.length === 0) throw new Error('抽出するページがありません')
  const out = new mupdf.PDFDocument()
  try {
    for (const i of sorted) out.graftPage(out.countPages(), d, i)
    const buf = out.saveToBuffer('garbage=compact,sanitize=yes,compress')
    const bytes = Uint8Array.from(buf.asUint8Array())
    buf.destroy?.()
    return bytes
  } finally {
    out.destroy?.()
  }
}

/**
 * Trim a uniform margin (mm) off every edge of the given pages. The content is
 * translated so the trimmed region maps to a fresh [0,0,W',H'] MediaBox/CropBox
 * (origin stays at 0 — the renderer maps canvas px → pt without an origin offset,
 * so a shifted box would break click/selection alignment). A symmetric inset is
 * rotation-invariant. Content outside the new box is clipped but still present
 * in the file — to remove it entirely, save as an image PDF. One undoable op.
 */
export function trimPages(indices: number[], marginMm: number): DocumentInfo {
  const d = requireDoc()
  const m = Math.max(0, marginMm) * MM_TO_PT
  const targets = [...new Set(indices)].filter(
    (i) => i >= 0 && i < d.countPages()
  )
  if (m <= 0 || targets.length === 0) return getInfo()
  const enc = new TextEncoder()
  operation('余白のトリミング', () => {
    for (const i of targets) {
      const page = d.loadPage(i)
      const obj = page.getObject()
      const [llx, lly, urx, ury] = mediaBox(page)
      const W = urx - llx
      const H = ury - lly
      // Refuse to trim so much that almost nothing (< ~7mm) would remain.
      if (W - 2 * m <= 20 || H - 2 * m <= 20) continue
      const tx = -(llx + m)
      const ty = -(lly + m)
      const prefix = enc.encode(`q 1 0 0 1 ${fmt(tx)} ${fmt(ty)} cm\n`)
      const suffix = enc.encode('\nQ\n')
      const original = readPageContents(obj)
      obj.put('Contents', d.addStream(concatBytes([prefix, original, suffix]), {}))
      putBox(d, obj, 'MediaBox', W - 2 * m, H - 2 * m)
      putBox(d, obj, 'CropBox', W - 2 * m, H - 2 * m)
      transformAnnotations(page, [1, 0, 0, 1, tx, ty])
    }
  })
  return getInfo()
}

// ─── Flatten to images (柱2): rasterize every page ───────────────────────────
// Renders each page to a JPEG and rebuilds an image-only PDF. Because the output
// contains only pixels, ALL hidden data — invisible/white text, metadata, hidden
// layers, annotations, attachments, JavaScript — is structurally gone. Use it to
// hand an adversary's document to an AI without leaking (or being deceived by)
// anything not visually present.
const FLATTEN_DPI = 200
const FLATTEN_QUALITY = 80

/**
 * Serialize the current document as an image-only PDF (one JPEG per page). When
 * `password` is given the output is AES-256 encrypted.
 */
export function flattenToImages(password?: string): Uint8Array {
  const d = requireDoc()
  const zoom = FLATTEN_DPI / 72
  const out = new mupdf.PDFDocument()
  try {
    const count = d.countPages()
    for (let i = 0; i < count; i++) {
      const page = d.loadPage(i)
      // showExtras=true bakes in visible annotations (highlights, etc.). The
      // pixmap size already reflects the page's /Rotate, so derive the new page
      // dimensions from it.
      const pm = page.toPixmap(
        mupdf.Matrix.scale(zoom, zoom),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true
      )
      const jpeg = Uint8Array.from(pm.asJPEG(FLATTEN_QUALITY, false))
      const wpt = pm.getWidth() / zoom
      const hpt = pm.getHeight() / zoom
      pm.destroy?.()
      const imgRef = out.addImage(new mupdf.Image(jpeg))
      const res = out.addObject({ XObject: { Im0: imgRef } })
      const content = `q ${wpt} 0 0 ${hpt} 0 0 cm /Im0 Do Q`
      const pageObj = out.addPage([0, 0, wpt, hpt], 0, res, content)
      out.insertPage(out.countPages(), pageObj)
    }
    const buf = out.saveToBuffer(
      'garbage=compact,sanitize=yes,compress-images' + encryptSuffix(password)
    )
    const bytes = Uint8Array.from(buf.asUint8Array())
    buf.destroy?.()
    return bytes
  } finally {
    out.destroy?.()
  }
}

// ─── 提出前クリーニング ───────────────────────────────────────────────────────
// One undoable step that scrubs everything not visually present: hidden text,
// document properties (Info + XMP), embedded attachments, and JavaScript. Unlike
// flattenToImages it keeps the visible text layer (still searchable/selectable).

export function cleanForSubmission(): CleanReport {
  const d = requireDoc()
  let hiddenRuns = 0
  const metaRemoved: string[] = []
  let attachments = false
  let javascript = false

  operation('提出前クリーニング', () => {
    // 1) Hidden (invisible / white) text.
    const count = d.countPages()
    for (let i = 0; i < count; i++) {
      const pageObj = d.loadPage(i).getObject()
      const bytes = readPageContents(pageObj)
      if (bytes.length === 0) continue
      const r = filterContentStream(bytes, 'invisible', pageGsAlpha(pageObj))
      if (r.removed > 0) {
        writePageContents(d, pageObj, r.output)
        hiddenRuns += r.removed
      }
    }

    const trailer = d.getTrailer()
    // 2) Document properties (Info dict + XMP stream).
    const info = trailer.get('Info')
    if (info && info.isDictionary()) {
      for (const [key, label] of INFO_LABELS) {
        const v = info.get(key)
        if (v && !v.isNull() && (!v.isString() || v.asString().trim() !== '')) {
          metaRemoved.push(label)
          info.delete(key)
        }
      }
    }
    const root = trailer.get('Root')
    if (root && root.isDictionary()) {
      const md = root.get('Metadata')
      if (md && !md.isNull()) {
        metaRemoved.push('XMPメタデータ')
        root.delete('Metadata')
      }
      // 3) Embedded files and JavaScript live under the catalog /Names.
      const names = root.get('Names')
      if (names && names.isDictionary()) {
        const ef = names.get('EmbeddedFiles')
        if (ef && !ef.isNull()) {
          attachments = true
          names.delete('EmbeddedFiles')
        }
        const js = names.get('JavaScript')
        if (js && !js.isNull()) {
          javascript = true
          names.delete('JavaScript')
        }
      }
      // Document-open JavaScript action.
      const oa = root.get('OpenAction')
      if (oa && oa.isDictionary()) {
        const s = oa.get('S')
        if (s && s.isName() && s.asName() === 'JavaScript') {
          javascript = true
          root.delete('OpenAction')
        }
      }
      // Document-level additional actions (/AA) can also carry JavaScript.
      const aa = root.get('AA')
      if (aa && !aa.isNull()) {
        javascript = true
        root.delete('AA')
      }
    }
  })

  return { info: getInfo(), hiddenRuns, metaRemoved, attachments, javascript }
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
