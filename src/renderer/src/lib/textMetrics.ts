// Shared metrics for 文字入れ so the on-page editor overlay and the burned PDF
// text use IDENTICAL geometry (font, line spacing, baseline). Keeping these in
// one place is what makes the feature WYSIWYG — the overlay is exactly where the
// text will land.

/**
 * Font stack for the editable overlay. A Japanese Gothic that exists on the
 * target OS; its metrics (via measureText below) also drive where the burned
 * baseline is placed, so overlay and burn stay aligned even though the embedded
 * PDF font may differ slightly in glyph shape.
 */
export const JP_FONT_STACK =
  '"BIZ UDGothic", "Yu Gothic", "Meiryo", "Hiragino Kaku Gothic ProN", sans-serif'

/** Line-to-line spacing as a multiple of font size (overlay CSS + burn leading). */
export const TEXT_LINE_HEIGHT = 1.3

/** Snap distance in screen pixels: a box snaps to a guide within this range. */
export const SNAP_PX = 10

/**
 * Nearest candidate to `value` within `threshold`, or null if none is close.
 * Used to snap a text box's baseline/left edge to the document's text guides.
 */
export function snapValue(
  value: number,
  candidates: number[],
  threshold: number
): number | null {
  let best: number | null = null
  let bestD = threshold
  for (const c of candidates) {
    const dd = Math.abs(c - value)
    if (dd <= bestD) {
      bestD = dd
      best = c
    }
  }
  return best
}

// Cache one measuring context; measureText font metrics are text-independent.
let measureCtx: CanvasRenderingContext2D | null | undefined

/** Font ascent/descent for JP_FONT_STACK, as fractions of the em (font size). */
function jpFontMetrics(bold: boolean): { ascent: number; descent: number } {
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) return { ascent: 0.88, descent: 0.21 }
  measureCtx.font = `${bold ? 'bold ' : ''}100px ${JP_FONT_STACK}`
  const m = measureCtx.measureText('あ')
  const a = m.fontBoundingBoxAscent
  const d = m.fontBoundingBoxDescent
  return {
    ascent: a && Number.isFinite(a) ? a / 100 : 0.88,
    descent: d && Number.isFinite(d) ? d / 100 : 0.21
  }
}

/**
 * Distance (pt) from a text box's top to the first-line baseline, matching how
 * the CSS overlay lays the first line out: half-leading + ascent, where the
 * line box adds half-leading = (lineHeight − (ascent+descent))/2 above the line.
 * Simplifies to lineHeight/2 + (ascent−descent)/2. This is what makes the burned
 * text land exactly on the overlay's baseline.
 */
export function textAscentPt(fontSize: number, bold = false): number {
  const { ascent, descent } = jpFontMetrics(bold)
  const lineHeightPt = TEXT_LINE_HEIGHT * fontSize
  return lineHeightPt / 2 + ((ascent - descent) / 2) * fontSize
}
