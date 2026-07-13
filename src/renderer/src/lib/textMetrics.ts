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

// Cache one measuring context; measureText font metrics are text-independent.
let measureCtx: CanvasRenderingContext2D | null | undefined

/** Font ascent/descent for JP_FONT_STACK, as fractions of the em (font size). */
function jpFontMetrics(): { ascent: number; descent: number } {
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) return { ascent: 0.88, descent: 0.21 }
  measureCtx.font = `100px ${JP_FONT_STACK}`
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
export function textAscentPt(fontSize: number): number {
  const { ascent, descent } = jpFontMetrics()
  const lineHeightPt = TEXT_LINE_HEIGHT * fontSize
  return lineHeightPt / 2 + ((ascent - descent) / 2) * fontSize
}
