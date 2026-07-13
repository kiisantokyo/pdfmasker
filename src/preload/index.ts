import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type {
  AboutInfo,
  ActivateResult,
  BindingMarginOptions,
  CleanReport,
  DiscrepancyReport,
  DocumentInfo,
  HiddenTextReport,
  LicenseState,
  MetaClearResult,
  MetadataEntry,
  OpenMode,
  OpenResult,
  PageNumberOptions,
  RedactionRect,
  RotateDelta,
  SaveNameOptions,
  SaveProfile,
  ScopedTerm,
  StampOptions,
  TermCount,
  TextBoxOptions,
  FontContext,
  WordHit
} from '../shared/types'

export interface SaveResult {
  saved: boolean
  path?: string
  needsPath?: boolean
  /** Blocked by the 案1 save gate (trial over, no valid key). */
  gated?: boolean
  /** Written file size in bytes (set by size-profiled saves). */
  size?: number
}

export interface RenderResult {
  png: Uint8Array
  pixelWidth: number
  pixelHeight: number
}

const api = {
  /** App version string (e.g. "1.0.0") from package.json. */
  appVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appVersion),
  /** Open-source license info (AGPL source URL + third-party notices). */
  appLicenses: (): Promise<AboutInfo> => ipcRenderer.invoke(IPC.appLicenses),
  open: (): Promise<OpenResult | null> => ipcRenderer.invoke(IPC.open),
  openFromPath: (path: string): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.openFromPath, path),
  /** Open / merge dropped files (PDF / Word / images) per placement mode. */
  openFiles: (paths: string[], mode: OpenMode): Promise<OpenResult> =>
    ipcRenderer.invoke(IPC.openFiles, paths, mode),
  /** Close the current document and return to the welcome screen. */
  closeDoc: (): Promise<void> => ipcRenderer.invoke(IPC.closeDoc),
  /** Strip distribution-unsafe document properties (Info dict + XMP). */
  clearMetadata: (keys: string[]): Promise<MetaClearResult> =>
    ipcRenderer.invoke(IPC.clearMetadata, keys),
  /** List the document properties currently embedded (for the viewer). */
  readMetadata: (): Promise<MetadataEntry[]> =>
    ipcRenderer.invoke(IPC.readMetadata),
  /** Tell the main process whether there is unsaved work (for close-confirm). */
  setUnsaved: (flag: boolean): void => ipcRenderer.send(IPC.unsavedState, flag),
  /** Resolve the absolute filesystem path of a dropped File. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  info: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.info),
  renderPage: (index: number, zoom: number): Promise<RenderResult> =>
    ipcRenderer.invoke(IPC.renderPage, index, zoom),
  applyRedactions: (
    rects: RedactionRect[],
    fill?: 'black' | 'white'
  ): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.applyRedactions, rects, fill),
  /** True-redact each rect and paint a pixelated (mosaic) render back over it. */
  mosaic: (rects: RedactionRect[]): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.mosaic, rects),
  wordAt: (pageIndex: number, x: number, y: number): Promise<WordHit | null> =>
    ipcRenderer.invoke(IPC.wordAt, pageIndex, x, y),
  selectText: (
    pageIndex: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): Promise<RedactionRect[]> =>
    ipcRenderer.invoke(IPC.selectText, pageIndex, x0, y0, x1, y1),
  selectionString: (
    pageIndex: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): Promise<{ text: string; rects: RedactionRect[] }> =>
    ipcRenderer.invoke(IPC.selectionString, pageIndex, x0, y0, x1, y1),
  highlight: (rects: RedactionRect[]): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.highlight, rects),
  findWord: (needle: string): Promise<RedactionRect[]> =>
    ipcRenderer.invoke(IPC.findWord, needle),
  extractCandidates: (): Promise<TermCount[]> =>
    ipcRenderer.invoke(IPC.extractCandidates),
  countTerms: (terms: string[]): Promise<TermCount[]> =>
    ipcRenderer.invoke(IPC.countTerms, terms),
  findTerms: (terms: string[]): Promise<RedactionRect[]> =>
    ipcRenderer.invoke(IPC.findTerms, terms),
  findTermsScoped: (items: ScopedTerm[]): Promise<RedactionRect[]> =>
    ipcRenderer.invoke(IPC.findTermsScoped, items),
  documentText: (): Promise<string> => ipcRenderer.invoke(IPC.documentText),
  /** Whole-document text with invisible text removed (safe to hand to an AI). */
  visibleText: (): Promise<string> => ipcRenderer.invoke(IPC.visibleText),
  /** Scan for hidden (invisible) text; returns count + per-page preview. */
  detectHiddenText: (): Promise<HiddenTextReport> =>
    ipcRenderer.invoke(IPC.detectHiddenText),
  /** Permanently remove invisible text (one undoable operation). */
  removeHiddenText: (): Promise<{ info: DocumentInfo; removed: number }> =>
    ipcRenderer.invoke(IPC.removeHiddenText),
  /** Thorough audit: OCR each page and flag embedded text not visibly present. */
  compareVisibleText: (): Promise<DiscrepancyReport> =>
    ipcRenderer.invoke(IPC.compareVisibleText),
  onCompareProgress: (
    cb: (p: { page: number; count: number }) => void
  ): (() => void) => {
    const handler = (_e: unknown, p: { page: number; count: number }): void =>
      cb(p)
    ipcRenderer.on(IPC.compareProgress, handler)
    return () => ipcRenderer.removeListener(IPC.compareProgress, handler)
  },
  writeClipboard: (text: string): void => clipboard.writeText(text),
  needsOcr: (): Promise<boolean> => ipcRenderer.invoke(IPC.needsOcr),
  runOcr: (): Promise<{ total: number; info: DocumentInfo }> =>
    ipcRenderer.invoke(IPC.runOcr),
  onOcrProgress: (cb: (p: { page: number; count: number }) => void): (() => void) => {
    const handler = (_e: unknown, p: { page: number; count: number }): void =>
      cb(p)
    ipcRenderer.on(IPC.ocrProgress, handler)
    return () => ipcRenderer.removeListener(IPC.ocrProgress, handler)
  },
  deletePage: (index: number): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.deletePage, index),
  deletePages: (indices: number[]): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.deletePages, indices),
  rotatePages: (indices: number[], delta: RotateDelta): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.rotatePages, indices, delta),
  resizePages: (
    indices: number[],
    widthMm: number,
    heightMm: number
  ): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.resizePages, indices, widthMm, heightMm),
  movePage: (from: number, to: number): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.movePage, from, to),
  movePages: (indices: number[], to: number): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.movePages, indices, to),
  rotatePage: (index: number, delta: RotateDelta): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.rotatePage, index, delta),
  bindingMargin: (opts: BindingMarginOptions): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.bindingMargin, opts),
  addPageNumbers: (opts: PageNumberOptions): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.addPageNumbers, opts),
  addStamp: (opts: StampOptions): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.addStamp, opts),
  /** Burn a text box into a page as real embedded (selectable) text. */
  insertText: (opts: TextBoxOptions): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.insertText, opts),
  /** Sample the nearest existing text's size (pt) to seed the editor default. */
  fontContextAt: (
    pageIndex: number,
    x: number,
    y: number
  ): Promise<FontContext> => ipcRenderer.invoke(IPC.fontContextAt, pageIndex, x, y),
  undo: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.undo),
  redo: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.redo),
  save: (): Promise<SaveResult> => ipcRenderer.invoke(IPC.save),
  /** Save as PDF with a size profile; `password` (optional) → AES-256 encrypted. */
  saveAsSized: (
    profile: SaveProfile,
    nameOpts?: SaveNameOptions,
    password?: string
  ): Promise<SaveResult> =>
    ipcRenderer.invoke(IPC.saveAsSized, profile, nameOpts, password),
  /** Save as an image-only PDF; `password` (optional) → AES-256 encrypted. */
  saveAsFlattened: (
    nameOpts?: SaveNameOptions,
    password?: string
  ): Promise<SaveResult> =>
    ipcRenderer.invoke(IPC.saveAsFlattened, nameOpts, password),
  /** Export the given page as a PNG image (current page only). */
  saveAsImage: (
    index: number,
    nameOpts?: SaveNameOptions
  ): Promise<SaveResult> =>
    ipcRenderer.invoke(IPC.saveAsImage, index, nameOpts),
  /** Copy the given page to the clipboard as an image. */
  copyPageImage: (index: number): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.copyPageImage, index),
  /** Copy a rectangular region (page-space pt) of a page to the clipboard. */
  copyPageRegionImage: (
    index: number,
    rect: RedactionRect
  ): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.copyPageRegionImage, index, rect),
  /** Ctrl+V on the welcome screen: load a clipboard image, or null if none. */
  pasteFromClipboard: (): Promise<OpenResult | null> =>
    ipcRenderer.invoke(IPC.pasteFromClipboard),
  /** Write the given pages to a separate PDF file (dialog picks the path). */
  extractPages: (
    indices: number[],
    nameOpts?: SaveNameOptions
  ): Promise<SaveResult> =>
    ipcRenderer.invoke(IPC.extractPages, indices, nameOpts),
  /** Trim a uniform margin (mm) off every edge of the given pages. */
  trimPages: (indices: number[], marginMm: number): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.trimPages, indices, marginMm),
  cleanForSubmission: (): Promise<CleanReport> =>
    ipcRenderer.invoke(IPC.cleanForSubmission),
  hasUnsavedChanges: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.hasUnsavedChanges)
}

export type PdfApi = typeof api

// License bridge (シリアルキー + 30日試用). Separate namespace from pdf.
const license = {
  /** Current license/trial state — drives the banner and the save gate. */
  status: (): Promise<LicenseState> => ipcRenderer.invoke(IPC.licenseStatus),
  /** Activate a serial key on this device. */
  activate: (key: string): Promise<ActivateResult> =>
    ipcRenderer.invoke(IPC.licenseActivate, key),
  /** Release this device's activation (move to another PC). */
  deactivate: (): Promise<LicenseState> =>
    ipcRenderer.invoke(IPC.licenseDeactivate)
}

export type LicenseApi = typeof license

contextBridge.exposeInMainWorld('pdf', api)
contextBridge.exposeInMainWorld('license', license)
