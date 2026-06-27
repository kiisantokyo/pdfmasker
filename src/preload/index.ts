import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type {
  BindingMarginOptions,
  DocumentInfo,
  MetaClearResult,
  OpenMode,
  OpenResult,
  PageNumberOptions,
  RedactionRect,
  RotateDelta,
  ScopedTerm,
  StampOptions,
  TermCount,
  WordHit
} from '../shared/types'

export interface SaveResult {
  saved: boolean
  path?: string
  needsPath?: boolean
}

export interface RenderResult {
  png: Uint8Array
  pixelWidth: number
  pixelHeight: number
}

const api = {
  /** App version string (e.g. "1.0.0") from package.json. */
  appVersion: (): Promise<string> => ipcRenderer.invoke(IPC.appVersion),
  open: (): Promise<DocumentInfo | null> => ipcRenderer.invoke(IPC.open),
  openFromPath: (path: string): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.openFromPath, path),
  /** Open / merge dropped files (PDF / Word / images) per placement mode. */
  openFiles: (paths: string[], mode: OpenMode): Promise<OpenResult> =>
    ipcRenderer.invoke(IPC.openFiles, paths, mode),
  /** Close the current document and return to the welcome screen. */
  closeDoc: (): Promise<void> => ipcRenderer.invoke(IPC.closeDoc),
  /** Strip distribution-unsafe document properties (Info dict + XMP). */
  clearMetadata: (): Promise<MetaClearResult> =>
    ipcRenderer.invoke(IPC.clearMetadata),
  /** Tell the main process whether there is unsaved work (for close-confirm). */
  setUnsaved: (flag: boolean): void => ipcRenderer.send(IPC.unsavedState, flag),
  /** Resolve the absolute filesystem path of a dropped File. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  info: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.info),
  renderPage: (index: number, zoom: number): Promise<RenderResult> =>
    ipcRenderer.invoke(IPC.renderPage, index, zoom),
  applyRedactions: (rects: RedactionRect[]): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.applyRedactions, rects),
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
  rotatePage: (index: number, delta: RotateDelta): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.rotatePage, index, delta),
  bindingMargin: (opts: BindingMarginOptions): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.bindingMargin, opts),
  addPageNumbers: (opts: PageNumberOptions): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.addPageNumbers, opts),
  addStamp: (opts: StampOptions): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.addStamp, opts),
  undo: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.undo),
  redo: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.redo),
  save: (): Promise<SaveResult> => ipcRenderer.invoke(IPC.save),
  saveAs: (): Promise<SaveResult> => ipcRenderer.invoke(IPC.saveAs),
  hasUnsavedChanges: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.hasUnsavedChanges)
}

export type PdfApi = typeof api

contextBridge.exposeInMainWorld('pdf', api)
