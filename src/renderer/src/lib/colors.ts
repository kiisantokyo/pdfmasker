// Colour palettes for 墨消し (redaction fill) and マーカー (highlight).
import type { TextColor } from '@shared/types'

export interface ColorChoice {
  key: string
  label: string
  /** Fill colour (0..1 RGB). undefined = whiteout: remove content, no fill. */
  rgb?: TextColor
}

/** Redaction fill colours. 白 is a true whiteout (no paint over the blank area).
 *  Colours are kept soft/pale (目に優しい) — black stays solid as the default. */
export const REDACT_COLORS: ColorChoice[] = [
  { key: 'black', label: '黒', rgb: { r: 0, g: 0, b: 0 } },
  { key: 'white', label: '白' },
  { key: 'gray', label: 'グレー', rgb: { r: 0.8, g: 0.8, b: 0.8 } },
  { key: 'red', label: '赤', rgb: { r: 0.92, g: 0.66, b: 0.64 } },
  { key: 'blue', label: '青', rgb: { r: 0.66, g: 0.76, b: 0.92 } },
  { key: 'green', label: '緑', rgb: { r: 0.68, g: 0.85, b: 0.7 } }
]

/** Highlight (marker) colours. All translucent when applied (opacity handled in
 *  the engine); the swatch shows the solid tone. */
export const HIGHLIGHT_COLORS: ColorChoice[] = [
  { key: 'yellow', label: '黄', rgb: { r: 1, g: 1, b: 0 } },
  { key: 'green', label: '緑', rgb: { r: 0.5, g: 1, b: 0.4 } },
  { key: 'pink', label: 'ピンク', rgb: { r: 1, g: 0.5, b: 0.8 } },
  { key: 'blue', label: '青', rgb: { r: 0.5, g: 0.8, b: 1 } },
  { key: 'orange', label: 'オレンジ', rgb: { r: 1, g: 0.7, b: 0.2 } }
]

/** CSS colour string for a swatch (whiteout shows as white). */
export function cssColor(rgb?: TextColor): string {
  if (!rgb) return '#ffffff'
  const to = (v: number): number => Math.round(v * 255)
  return `rgb(${to(rgb.r)}, ${to(rgb.g)}, ${to(rgb.b)})`
}
