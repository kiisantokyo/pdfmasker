import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IPC } from '../shared/types'
import type { RedactionRect, RotateDelta } from '../shared/types'
import * as pdf from './pdf-service'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '究極の墨消し',
    backgroundColor: '#f4f1fb',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.removeMenu()
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  ipcMain.handle(IPC.open, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open PDF',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const bytes = await readFile(path)
    return pdf.loadDocument(new Uint8Array(bytes), basename(path), path)
  })

  ipcMain.handle(IPC.openFromPath, async (_e, path: string) => {
    const bytes = await readFile(path)
    return pdf.loadDocument(new Uint8Array(bytes), basename(path), path)
  })

  ipcMain.handle(IPC.info, () => pdf.getInfo())

  ipcMain.handle(
    IPC.renderPage,
    (_e, index: number, zoom: number) => pdf.renderPage(index, zoom)
  )

  ipcMain.handle(
    IPC.applyRedactions,
    (_e, rects: RedactionRect[]) => {
      pdf.applyRedactions(rects)
      return pdf.getInfo()
    }
  )

  ipcMain.handle(
    IPC.wordAt,
    (_e, pageIndex: number, x: number, y: number) => pdf.wordAt(pageIndex, x, y)
  )

  ipcMain.handle(IPC.findWord, (_e, needle: string) => pdf.findWord(needle))

  ipcMain.handle(IPC.deletePage, (_e, index: number) => pdf.deletePage(index))

  ipcMain.handle(
    IPC.movePage,
    (_e, from: number, to: number) => pdf.movePage(from, to)
  )

  ipcMain.handle(
    IPC.rotatePage,
    (_e, index: number, delta: RotateDelta) => pdf.rotatePage(index, delta)
  )

  ipcMain.handle(IPC.hasUnsavedChanges, () => pdf.hasUnsavedChanges())

  ipcMain.handle(IPC.save, async () => {
    const path = pdf.getPath()
    if (!path) return { saved: false, needsPath: true }
    await writeFile(path, pdf.saveToBuffer())
    pdf.markSavedAt(path)
    return { saved: true, path }
  })

  ipcMain.handle(IPC.saveAs, async () => {
    const current = pdf.getPath()
    const result = await dialog.showSaveDialog({
      title: 'Save PDF As',
      defaultPath: current ?? 'redacted.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, pdf.saveToBuffer())
    pdf.markSavedAt(result.filePath)
    return { saved: true, path: result.filePath }
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
