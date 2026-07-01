import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { IPC } from '../shared/types'
import type {
  BindingMarginOptions,
  OpenMode,
  OpenResult,
  PageNumberOptions,
  RedactionRect,
  RotateDelta,
  ScopedTerm,
  StampOptions
} from '../shared/types'
import * as pdf from './pdf-service'
import * as license from './license-service'
import { imagesToPdf, isImagePath } from './convert-image'
import { isWordPath, wordToPdf } from './convert-word'

// Remembers what the currently-open document was made from, so 名前を付けて保存
// can suggest a sensible default file name and folder. `dir` is the source
// file's folder (the default save location).
let openMeta:
  | { kind: 'file'; base: string; dir: string | null }
  | { kind: 'images'; base: string; count: number; dir: string | null }
  | null = null

/** File name without its extension. */
function baseNoExt(p: string): string {
  return basename(p).replace(/\.[^.]+$/, '')
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/**
 * Default "save as" file name:
 * - multiple images → 「先頭ファイル名_N枚（墨消し）.pdf」
 * - otherwise       → 「yymmdd_元のファイル名（墨消し）.pdf」
 */
function suggestedSaveName(): string {
  if (openMeta?.kind === 'images') {
    return `${openMeta.base}_${openMeta.count}枚（墨消し）.pdf`
  }
  const d = new Date()
  const yy = pad2(d.getFullYear() % 100)
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const base = openMeta?.base ?? 'document'
  return `${yy}${mm}${dd}_${base}（墨消し）.pdf`
}

/** Absolute default path for the save dialog: source folder + rule-based name. */
function suggestedSavePath(): string {
  const dir = openMeta?.dir ?? app.getPath('documents')
  return join(dir, suggestedSaveName())
}

// Whether the renderer currently has unsaved work (applied-but-unsaved edits or
// pending marks); drives the close-confirmation dialog.
let hasUnsavedWork = false

/**
 * Turn dropped files into a single PDF, then apply it according to `mode`:
 * replace the current document ('new') or merge before/after it.
 */
async function openDropped(
  paths: string[],
  mode: OpenMode
): Promise<OpenResult> {
  if (paths.length === 0) throw new Error('ファイルが指定されていません')

  const images = paths.filter(isImagePath)
  const allImages = images.length === paths.length

  let bytes: Uint8Array
  let name: string
  let imagesInvolved = false
  let message: string | undefined
  let meta: typeof openMeta = null

  if (allImages) {
    const osdCache = join(app.getPath('userData'), 'tessdata')
    bytes = await imagesToPdf(images, osdCache)
    imagesInvolved = true
    const first = baseNoExt(images[0])
    const dir = dirname(images[0])
    name =
      images.length > 1 ? `${first} 他${images.length - 1}件.pdf` : `${first}.pdf`
    meta =
      images.length >= 2
        ? { kind: 'images', base: first, count: images.length, dir }
        : { kind: 'file', base: first, dir }
  } else {
    // Mixed or non-image drop: process the first non-image file only.
    const target = paths.find((p) => !isImagePath(p)) ?? paths[0]
    if (isWordPath(target)) {
      bytes = await wordToPdf(target)
      name = baseNoExt(target) + '.pdf'
    } else {
      // Anything else is tried as a PDF by content — the extension does not
      // have to be .pdf (loadDocument validates the bytes and errors if not).
      bytes = new Uint8Array(await readFile(target))
      name = basename(target)
    }
    meta = { kind: 'file', base: baseNoExt(target), dir: dirname(target) }
    if (paths.length > 1) {
      message = '複数ファイルのうち先頭の1件のみを開きました。'
    }
  }

  if (mode === 'before' || mode === 'after') {
    // A merge keeps the current document's identity (and its save name).
    const info = pdf.insertExternalPdf(bytes, mode)
    const ocr = imagesInvolved ? 'auto' : pdf.needsOcr() ? 'prompt' : 'none'
    return { info, ocr, message }
  }

  // currentPath stays null so the first save never silently overwrites the
  // source; saveAs proposes the rule-based 「（墨消し）」 name in the source folder.
  const info = pdf.loadDocument(bytes, name, null)
  openMeta = meta
  const ocr = imagesInvolved ? 'auto' : pdf.needsOcr() ? 'prompt' : 'none'
  return { info, ocr, message }
}

function createWindow(): BrowserWindow {
  // Sumi-bottle app icon. Packaged: copied into resources via extraResources;
  // dev: read from the project's build/ dir (import.meta.dirname is out/main).
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(import.meta.dirname, '../../build/icon.png')
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '究極の墨消し',
    icon: iconPath,
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

  // Warn before closing with unsaved work. The renderer keeps `hasUnsavedWork`
  // current via the unsavedState channel.
  let forceClose = false
  win.on('close', (e) => {
    if (forceClose || !hasUnsavedWork) return
    e.preventDefault()
    dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['キャンセル', '保存せずに終了'],
        defaultId: 0,
        cancelId: 0,
        title: '終了の確認',
        message: '未保存の作業があります。',
        detail: '保存していない変更があります。終了してよろしいですか？'
      })
      .then(({ response }) => {
        if (response === 1) {
          forceClose = true
          win.close()
        }
      })
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  // App version (from package.json), shown in the UI so users can tell which
  // build they are running.
  ipcMain.handle(IPC.appVersion, () => app.getVersion())

  ipcMain.handle(IPC.open, async () => {
    const result = await dialog.showOpenDialog({
      title: 'ファイルを開く',
      // No extension restriction. PDF / Word / images are converted as needed;
      // anything else is attempted as a PDF by content (see openDropped).
      filters: [
        { name: 'すべてのファイル', extensions: ['*'] },
        {
          name: '対応ファイル（PDF / Word / 画像）',
          extensions: [
            'pdf', 'doc', 'docx', 'docm', 'rtf',
            'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff'
          ]
        }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Route through the same pipeline as drag-and-drop so Word/images open too.
    return openDropped([result.filePaths[0]], 'new')
  })

  ipcMain.handle(IPC.openFromPath, async (_e, path: string) => {
    const bytes = await readFile(path)
    const info = pdf.loadDocument(new Uint8Array(bytes), basename(path), null)
    openMeta = { kind: 'file', base: baseNoExt(path), dir: dirname(path) }
    return info
  })

  ipcMain.handle(IPC.openFiles, (_e, paths: string[], mode: OpenMode) =>
    openDropped(paths, mode)
  )

  ipcMain.handle(IPC.clearMetadata, (_e, keys: string[]) =>
    pdf.clearMetadata(keys)
  )
  ipcMain.handle(IPC.readMetadata, () => pdf.readMetadata())

  ipcMain.handle(IPC.closeDoc, () => {
    pdf.closeDocument()
    openMeta = null
    hasUnsavedWork = false
  })

  ipcMain.on(IPC.unsavedState, (_e, flag: boolean) => {
    hasUnsavedWork = flag
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

  ipcMain.handle(
    IPC.selectText,
    (_e, pageIndex: number, x0: number, y0: number, x1: number, y1: number) =>
      pdf.selectText(pageIndex, x0, y0, x1, y1)
  )

  ipcMain.handle(
    IPC.selectionString,
    (_e, pageIndex: number, x0: number, y0: number, x1: number, y1: number) =>
      pdf.selectionString(pageIndex, x0, y0, x1, y1)
  )

  ipcMain.handle(IPC.highlight, (_e, rects: RedactionRect[]) =>
    pdf.highlightRects(rects)
  )

  ipcMain.handle(IPC.findWord, (_e, needle: string) => pdf.findWord(needle))

  ipcMain.handle(IPC.extractCandidates, () => pdf.extractCandidates())

  ipcMain.handle(IPC.countTerms, (_e, terms: string[]) => pdf.countTerms(terms))

  ipcMain.handle(IPC.findTerms, (_e, terms: string[]) => pdf.findTerms(terms))

  ipcMain.handle(IPC.findTermsScoped, (_e, items: ScopedTerm[]) =>
    pdf.findTermsScoped(items)
  )

  ipcMain.handle(IPC.documentText, () => pdf.getDocumentText())

  ipcMain.handle(IPC.needsOcr, () => pdf.needsOcr())

  ipcMain.handle(IPC.runOcr, async (e) => {
    const cachePath = join(app.getPath('userData'), 'tessdata')
    const total = await pdf.runOcr(cachePath, (page, count) => {
      e.sender.send(IPC.ocrProgress, { page, count })
    })
    return { total, info: pdf.getInfo() }
  })

  ipcMain.handle(IPC.deletePage, (_e, index: number) => pdf.deletePage(index))

  ipcMain.handle(IPC.deletePages, (_e, indices: number[]) =>
    pdf.deletePages(indices)
  )

  ipcMain.handle(
    IPC.rotatePages,
    (_e, indices: number[], delta: RotateDelta) =>
      pdf.rotatePages(indices, delta)
  )

  ipcMain.handle(
    IPC.resizePages,
    (_e, indices: number[], widthMm: number, heightMm: number) =>
      pdf.resizePages(indices, widthMm, heightMm)
  )

  ipcMain.handle(
    IPC.movePage,
    (_e, from: number, to: number) => pdf.movePage(from, to)
  )

  ipcMain.handle(
    IPC.rotatePage,
    (_e, index: number, delta: RotateDelta) => pdf.rotatePage(index, delta)
  )

  ipcMain.handle(
    IPC.bindingMargin,
    (_e, opts: BindingMarginOptions) => pdf.addBindingMargin(opts)
  )

  ipcMain.handle(
    IPC.addPageNumbers,
    (_e, opts: PageNumberOptions) => pdf.addPageNumbers(opts)
  )

  ipcMain.handle(IPC.addStamp, (_e, opts: StampOptions) => pdf.addStamp(opts))

  ipcMain.handle(IPC.undo, () => pdf.undo())
  ipcMain.handle(IPC.redo, () => pdf.redo())

  ipcMain.handle(IPC.hasUnsavedChanges, () => pdf.hasUnsavedChanges())

  ipcMain.handle(IPC.save, async () => {
    // 案1 保存ゲート: the redacted output is the product's value, so 保存／
    // 書き出し is what the trial gates. canSave is the single source of truth.
    if (!license.getState().canSave) return { saved: false, gated: true }
    const path = pdf.getPath()
    if (!path) return { saved: false, needsPath: true }
    await writeFile(path, pdf.saveToBuffer())
    pdf.markSavedAt(path)
    return { saved: true, path }
  })

  ipcMain.handle(IPC.saveAs, async () => {
    if (!license.getState().canSave) return { saved: false, gated: true }
    // Always propose the rule-based name in the source folder. `current` (a path
    // from a previous save) is only used for plain 上書き保存, not as the default.
    const result = await dialog.showSaveDialog({
      title: 'Save PDF As',
      defaultPath: suggestedSavePath(),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, pdf.saveToBuffer())
    pdf.markSavedAt(result.filePath)
    return { saved: true, path: result.filePath }
  })

  // --- License (シリアルキー + 30日試用) ---------------------------------
  ipcMain.handle(IPC.licenseStatus, () => license.getState())
  ipcMain.handle(IPC.licenseActivate, (_e, key: string) =>
    license.activate(key)
  )
  ipcMain.handle(IPC.licenseDeactivate, () => license.deactivate())
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
