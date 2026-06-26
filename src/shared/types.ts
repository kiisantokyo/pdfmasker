// Shared types used across main / preload / renderer.

/** Per-page geometry, in PDF points (1pt = 1/72 inch). */
export interface PageInfo {
  index: number
  /** Page width in PDF points, after rotation is accounted for by mupdf bounds. */
  width: number
  height: number
  /** Page /Rotate value: 0 | 90 | 180 | 270. */
  rotation: number
}

export interface DocumentInfo {
  /** Absolute path on disk, or null for an unsaved/in-memory document. */
  path: string | null
  name: string
  pageCount: number
  pages: PageInfo[]
}

/**
 * A redaction region, expressed in *page space* (PDF points, top-left origin,
 * y increasing downward — the same space mupdf uses for annotation rects).
 */
export interface RedactionRect {
  pageIndex: number
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface RenderedPage {
  index: number
  /** PNG bytes of the rendered page. */
  png: Uint8Array
  /** Pixel dimensions of the PNG. */
  pixelWidth: number
  pixelHeight: number
  /** zoom = pixels-per-point used for rendering. */
  zoom: number
}

/** Rotate a page by this many degrees (clockwise). */
export type RotateDelta = 90 | 180 | 270 | -90

/** Redaction selection mode: trace over text, or draw a freehand rectangle. */
export type SelectMode = 'text' | 'rect'

/** A word found at a click point, with its bounding box as a redaction rect. */
export interface WordHit {
  word: string
  rect: RedactionRect
}

/** A candidate term and how many times it occurs in the document. */
export interface TermCount {
  term: string
  count: number
  /** Heuristic category label (e.g. メール, 電話, カタカナ語). */
  kind?: string
}

/** Which edge the binding (staple) margin is added to. */
export type BindingSide = 'left' | 'right' | 'top' | 'bottom'

export interface BindingMarginOptions {
  side: BindingSide
  /** Margin width in millimetres. */
  marginMm: number
  /** Apply to every page (true) or only the current page (false). */
  allPages: boolean
  /** Current page index, used when allPages is false. */
  pageIndex: number
}

export const IPC = {
  open: 'pdf:open',
  openFromPath: 'pdf:openFromPath',
  info: 'pdf:info',
  renderPage: 'pdf:renderPage',
  applyRedactions: 'pdf:applyRedactions',
  wordAt: 'pdf:wordAt',
  selectText: 'pdf:selectText',
  findWord: 'pdf:findWord',
  extractCandidates: 'pdf:extractCandidates',
  countTerms: 'pdf:countTerms',
  findTerms: 'pdf:findTerms',
  deletePage: 'pdf:deletePage',
  movePage: 'pdf:movePage',
  rotatePage: 'pdf:rotatePage',
  bindingMargin: 'pdf:bindingMargin',
  undo: 'pdf:undo',
  redo: 'pdf:redo',
  save: 'pdf:save',
  saveAs: 'pdf:saveAs',
  hasUnsavedChanges: 'pdf:hasUnsavedChanges'
} as const
