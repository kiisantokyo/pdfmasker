import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type {
  BindingMarginOptions,
  DocumentInfo,
  RedactionRect,
  RotateDelta,
  ScopedTerm,
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
  open: (): Promise<DocumentInfo | null> => ipcRenderer.invoke(IPC.open),
  openFromPath: (path: string): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.openFromPath, path),
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
  undo: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.undo),
  redo: (): Promise<DocumentInfo> => ipcRenderer.invoke(IPC.redo),
  save: (): Promise<SaveResult> => ipcRenderer.invoke(IPC.save),
  saveAs: (): Promise<SaveResult> => ipcRenderer.invoke(IPC.saveAs),
  hasUnsavedChanges: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.hasUnsavedChanges)
}

export type PdfApi = typeof api

contextBridge.exposeInMainWorld('pdf', api)
