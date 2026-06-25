// Core PDF engine. Pure mupdf — no Electron imports — so it can be unit-tested
// in plain Node. Holds a single open document as module state (MVP: one doc).

import * as mupdf from 'mupdf'
import type {
  DocumentInfo,
  PageInfo,
  RedactionRect,
  RotateDelta
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
