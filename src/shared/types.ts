// Shared types used across main / preload / renderer.

/** Per-page geometry, in PDF points (1pt = 1/72 inch). */
export interface PageInfo {
  index: number
  /** Page width in PDF points, after rotation is accounted for by mupdf bounds. */
  width: number
  height: number
  /** Page /Rotate value: 0 | 90 | 180 | 270. */
  rotation: number
  /** Original size (PDF points) before a paper-size change, if any. */
  origWidth?: number
  origHeight?: number
}

export interface DocumentInfo {
  /** Absolute path on disk, or null for an unsaved/in-memory document. */
  path: string | null
  name: string
  pageCount: number
  pages: PageInfo[]
  /**
   * True if the document still carries distribution-unsafe properties (a
   * non-empty Document Info field or an XMP metadata stream). Drives the
   * 「配布情報なし」 status badge; stays in sync through edits/undo/redo.
   */
  hasMetadata: boolean
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

/**
 * Output file-size profile for saving.
 * - 'original': images untouched (lossless, largest).
 * - 'standard': images downsampled to ~200dpi, JPEG q80 (balanced, default).
 * - 'light': images downsampled to ~150dpi, JPEG q55 (smallest, for email).
 */
export type SaveProfile = 'original' | 'standard' | 'light'

/** What 提出前クリーニング removed (all in one undoable step). */
export interface CleanReport {
  info: DocumentInfo
  hiddenRuns: number
  metaRemoved: string[]
  attachments: boolean
  javascript: boolean
}

/** One line where embedded text differs from what is visibly rendered. */
export interface DiscrepancyItem {
  page: number
  /** The embedded (extractable) text that is not visibly present. */
  embedded: string
  /** What is actually visible at that position (from OCR of the render). */
  visible: string
}

/** Result of the render-vs-embedded OCR comparison. */
export interface DiscrepancyReport {
  runs: number
  items: DiscrepancyItem[]
}

/** Result of scanning for hidden (invisible) text. */
export interface HiddenTextReport {
  /** Number of invisible text-showing operators found. */
  runs: number
  /** Per-page readable preview of the hidden text. */
  items: { page: number; text: string }[]
}

/** A term to redact, with how widely to apply it. */
export interface ScopedTerm {
  text: string
  /** 'all' = every occurrence (default), 'first' = first occurrence only. */
  scope?: 'all' | 'first'
}

/**
 * Where a dropped file's content goes relative to the document already open.
 * 'new' replaces the current document; 'before'/'after' merge the dropped
 * pages in front of / behind the current pages.
 */
export type OpenMode = 'new' | 'before' | 'after'

/** Result of opening/merging dropped files. */
export interface OpenResult {
  info: DocumentInfo
  /**
   * What to do about OCR after opening:
   * - 'auto'   : images were rasterised → run OCR automatically (no prompt)
   * - 'prompt' : a text-less PDF was opened → ask the user
   * - 'none'   : the document already has text
   */
  ocr: 'auto' | 'prompt' | 'none'
  /** Optional note for the status bar (e.g. conversion summary / skipped files). */
  message?: string
}

/** Result of clearing document properties: which fields were actually removed. */
export interface MetaClearResult {
  info: DocumentInfo
  /** Japanese labels of the properties that were present and removed. */
  removed: string[]
}

/** One embedded document property, for the properties viewer. */
export interface MetadataEntry {
  /** Info-dict key (e.g. 'Author') or 'XMP'. */
  key: string
  /** Japanese label shown to the user. */
  label: string
  /** Human-readable value (dates are formatted). */
  value: string
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

/** Which pages an operation applies to. */
export type ApplyScope = 'all' | 'current' | 'range'

/** Page-number text format (phase 1: ASCII-only, no font embedding needed). */
export type PageNumberFormat = 'plain' | 'slash' | 'dash' | 'p-dot'

/** Where the page number sits along the bottom edge. */
export type PageNumberPosition = 'bottom-left' | 'bottom-center' | 'bottom-right'

export interface PageNumberOptions {
  format: PageNumberFormat
  position: PageNumberPosition
  /** Number printed on the first targeted page (e.g. 1). */
  startNumber: number
  scope: ApplyScope
  /** Current page index (0-based), used when scope is 'current'. */
  pageIndex: number
  /** 1-based inclusive page range, used when scope is 'range'. */
  rangeFrom: number
  rangeTo: number
}

/** Predefined red 朱印 stamps (keys match STAMP_PNG_BASE64 / the asset script). */
export type StampKind =
  | 'maru-hi'
  | 'shagaihi'
  | 'toriatsukai-chui'
  | 'fukusei-genkin'
  | 'confidential'

/** Labels for the stamp picker UI. */
export const STAMP_LABELS: Record<StampKind, string> = {
  'maru-hi': '秘',
  shagaihi: '社外秘',
  'toriatsukai-chui': '取扱注意',
  'fukusei-genkin': '複製厳禁',
  confidential: 'Confidential'
}

/** Where the stamp is placed on the page. */
export type StampPosition = 'center' | 'top-right' | 'bottom-right'

export interface StampOptions {
  kind: StampKind
  position: StampPosition
  scope: ApplyScope
  /** Current page index (0-based), used when scope is 'current'. */
  pageIndex: number
  /** 1-based inclusive page range, used when scope is 'range'. */
  rangeFrom: number
  rangeTo: number
}

/**
 * License lifecycle, computed by license-service (single source of truth for
 * the save gate). 'trial' = within the 30-day trial; 'trial_expired' = trial
 * over and no valid key; 'active' = a valid key is activated; 'grace' = active
 * but awaiting a routine online re-check; 'revoked' = a previously-activated
 * key is no longer valid (refund/disable) and the trial is also over.
 */
export type LicenseKind =
  | 'free'
  | 'trial'
  | 'trial_expired'
  | 'active'
  | 'grace'
  | 'revoked'

export interface LicenseState {
  kind: LicenseKind
  /** Whole days left in the trial (only when kind === 'trial'). */
  trialDaysLeft?: number
  /** License expiry ISO date, or null for a perpetual (buy-once) key. */
  expiresAt?: string | null
  /**
   * The save gate (案1「保存ゲート」): whether 保存／書き出し is permitted.
   * true during the trial and while licensed; false once the trial expires.
   */
  canSave: boolean
  /** Short message for the trial banner / dialog. */
  message?: string
}

/** Result of a key activation attempt. */
export interface ActivateResult {
  ok: boolean
  state: LicenseState
  /** Human-readable failure reason (Japanese) when ok === false. */
  error?: string
}

export const IPC = {
  appVersion: 'app:version',
  open: 'pdf:open',
  openFromPath: 'pdf:openFromPath',
  openFiles: 'pdf:openFiles',
  closeDoc: 'pdf:closeDoc',
  clearMetadata: 'pdf:clearMetadata',
  readMetadata: 'pdf:readMetadata',
  unsavedState: 'pdf:unsavedState',
  info: 'pdf:info',
  renderPage: 'pdf:renderPage',
  applyRedactions: 'pdf:applyRedactions',
  wordAt: 'pdf:wordAt',
  selectText: 'pdf:selectText',
  selectionString: 'pdf:selectionString',
  highlight: 'pdf:highlight',
  findWord: 'pdf:findWord',
  extractCandidates: 'pdf:extractCandidates',
  countTerms: 'pdf:countTerms',
  findTerms: 'pdf:findTerms',
  findTermsScoped: 'pdf:findTermsScoped',
  documentText: 'pdf:documentText',
  visibleText: 'pdf:visibleText',
  detectHiddenText: 'pdf:detectHiddenText',
  removeHiddenText: 'pdf:removeHiddenText',
  compareVisibleText: 'pdf:compareVisibleText',
  compareProgress: 'pdf:compareProgress',
  needsOcr: 'pdf:needsOcr',
  runOcr: 'pdf:runOcr',
  ocrProgress: 'pdf:ocrProgress',
  deletePage: 'pdf:deletePage',
  deletePages: 'pdf:deletePages',
  movePage: 'pdf:movePage',
  movePages: 'pdf:movePages',
  rotatePage: 'pdf:rotatePage',
  rotatePages: 'pdf:rotatePages',
  resizePages: 'pdf:resizePages',
  bindingMargin: 'pdf:bindingMargin',
  addPageNumbers: 'pdf:addPageNumbers',
  addStamp: 'pdf:addStamp',
  undo: 'pdf:undo',
  redo: 'pdf:redo',
  save: 'pdf:save',
  saveAs: 'pdf:saveAs',
  saveAsSized: 'pdf:saveAsSized',
  saveAsFlattened: 'pdf:saveAsFlattened',
  cleanForSubmission: 'pdf:cleanForSubmission',
  hasUnsavedChanges: 'pdf:hasUnsavedChanges',
  licenseStatus: 'license:status',
  licenseActivate: 'license:activate',
  licenseDeactivate: 'license:deactivate',
  appLicenses: 'app:licenses'
} as const

/** Open-source license info for the About / license screen. */
export interface AboutInfo {
  version: string
  /** Public source-code repository URL (AGPL source availability). */
  sourceUrl: string
  /** Full AGPL-3.0 license text (this app's license). */
  license: string
  /** THIRD-PARTY-NOTICES.md contents (bundled OSS notices). */
  notices: string
}
