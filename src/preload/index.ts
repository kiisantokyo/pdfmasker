import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type {
  DocumentInfo,
  RedactionRect,
  RotateDelta
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
  deletePage: (index: number): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.deletePage, index),
  movePage: (from: number, to: number): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.movePage, from, to),
  rotatePage: (index: number, delta: RotateDelta): Promise<DocumentInfo> =>
    ipcRenderer.invoke(IPC.rotatePage, index, delta),
  save: (): Promise<SaveResult> => ipcRenderer.invoke(IPC.save),
  saveAs: (): Promise<SaveResult> => ipcRenderer.invoke(IPC.saveAs),
  hasUnsavedChanges: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC.hasUnsavedChanges)
}

export type PdfApi = typeof api

contextBridge.exposeInMainWorld('pdf', api)
