// Convert dropped image files (PNG/JPEG/…) into a single PDF, fully offline
// with mupdf. Each image gets a 20mm margin on all sides; orientation is
// auto-corrected in 90° steps using Tesseract OSD when it is confident.
// No Electron imports here — keep this testable in plain Node.

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import * as mupdf from 'mupdf'
import Tesseract from 'tesseract.js'

const MM_TO_PT = 72 / 25.4
const MARGIN_PT = 20 * MM_TO_PT
/** Fallback DPI when an image carries no resolution metadata. */
const DEFAULT_DPI = 96
/** OSD orientation confidence below this is treated as unreliable (no rotation). */
const OSD_MIN_CONFIDENCE = 1.0

const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.bmp',
  '.gif',
  '.webp',
  '.tif',
  '.tiff'
])

/** True if the path looks like a supported raster image. */
export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase())
}

/** Sort by file name, ascending, with natural number ordering (2 < 10). */
function naturalSort(a: string, b: string): number {
  return basename(a).localeCompare(basename(b), 'ja', {
    numeric: true,
    sensitivity: 'base'
  })
}

/**
 * Ask Tesseract OSD which way the page is rotated. Returns the clockwise
 * correction (a PDF /Rotate value) to apply, or 0 when unknown/low-confidence.
 */
async function detectRotation(
  worker: Tesseract.Worker,
  pngBytes: Uint8Array
): Promise<mupdf.Rotate> {
  try {
    const { data } = await worker.detect(Buffer.from(pngBytes))
    const deg = data.orientation_degrees
    const conf = data.orientation_confidence
    if (deg != null && conf != null && conf >= OSD_MIN_CONFIDENCE) {
      const n = (((deg % 360) + 360) % 360) as mupdf.Rotate
      if (n === 90 || n === 180 || n === 270) return n
    }
  } catch {
    // OSD model missing / detection failed → leave the page unrotated.
  }
  return 0
}

/**
 * Build a single PDF from the given image paths (sorted by name). `osdCachePath`
 * is where the `osd` language model is cached (first use needs network). OSD is
 * best-effort: if it can't load, images are embedded without rotation.
 */
export async function imagesToPdf(
  paths: string[],
  osdCachePath: string
): Promise<Uint8Array> {
  const sorted = [...paths].sort(naturalSort)
  const pdf = new mupdf.PDFDocument()

  let worker: Tesseract.Worker | null = null
  try {
    worker = await Tesseract.createWorker('osd', Tesseract.OEM.TESSERACT_ONLY, {
      cachePath: osdCachePath
    })
  } catch {
    worker = null
  }

  try {
    for (const p of sorted) {
      const bytes = await readFile(p)
      const img = new mupdf.Image(new Uint8Array(bytes))
      const wpx = img.getWidth()
      const hpx = img.getHeight()
      const xres = img.getXResolution()
      const yres = img.getYResolution()
      const dpiX = xres > 0 ? xres : DEFAULT_DPI
      const dpiY = yres > 0 ? yres : DEFAULT_DPI
      const wpt = (wpx / dpiX) * 72
      const hpt = (hpx / dpiY) * 72

      let rotate: mupdf.Rotate = 0
      if (worker) {
        const pix = img.toPixmap()
        const png = pix.asPNG()
        pix.destroy?.()
        rotate = await detectRotation(worker, png)
      }

      const imgRef = pdf.addImage(img)
      const resources = pdf.addObject({ XObject: { Img: imgRef } })
      // Draw the image into a margin-inset box of its own size; the page's
      // /Rotate (set via addPage) turns the whole margined page upright.
      const content = `q ${wpt} 0 0 ${hpt} ${MARGIN_PT} ${MARGIN_PT} cm /Img Do Q`
      const mediabox: mupdf.Rect = [
        0,
        0,
        wpt + MARGIN_PT * 2,
        hpt + MARGIN_PT * 2
      ]
      const page = pdf.addPage(mediabox, rotate, resources, content)
      pdf.insertPage(pdf.countPages(), page)
    }

    const buf = pdf.saveToBuffer('garbage=compact')
    const out = Uint8Array.from(buf.asUint8Array())
    buf.destroy?.()
    return out
  } finally {
    if (worker) await worker.terminate()
    pdf.destroy?.()
  }
}
