import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell
} from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_NAME_OPTIONS, IPC } from '../shared/types'
import type {
  BindingMarginOptions,
  OpenMode,
  OpenResult,
  PageNumberOptions,
  RedactionRect,
  RotateDelta,
  SaveNameOptions,
  SaveProfile,
  ScopedTerm,
  StampOptions,
  TextBoxOptions
} from '../shared/types'
import * as pdf from './pdf-service'
import * as license from './license-service'
import {
  imageBytesToPdf,
  imagesToPdf,
  isImagePath,
  naturalSortPaths
} from './convert-image'
import { isWordPath, wordToPdf } from './convert-word'
import { buildConcatenatedPdf } from './convert-merge'

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

/** Base name (no date, no labels, no extension) for the open document. */
function defaultBase(): string {
  if (openMeta?.kind === 'images') {
    return `${openMeta.base}_${openMeta.count}枚`
  }
  return openMeta?.base ?? 'document'
}

/**
 * Suggested save file name built from the chosen name decorations:
 * 「YYMMDD_元名（墨消し＋編集済み）.ext」 — date prefix toggled by `opts`, and the
 * chosen labels combined inside one bracket (「（墨消し）」/「（編集済み）」/both).
 */
function suggestedSaveName(
  opts: SaveNameOptions = DEFAULT_NAME_OPTIONS,
  ext = '.pdf'
): string {
  let name = defaultBase()
  if (opts.datePrefix) {
    const d = new Date()
    const yy = pad2(d.getFullYear() % 100)
    const mm = pad2(d.getMonth() + 1)
    const dd = pad2(d.getDate())
    name = `${yy}${mm}${dd}_${name}`
  }
  // Combine chosen labels inside a single bracket: 「（墨消し＋編集済み）」.
  const labels: string[] = []
  if (opts.redactLabel) labels.push('墨消し')
  if (opts.editLabel) labels.push('編集済み')
  if (labels.length > 0) name += `（${labels.join('＋')}）`
  return name + ext
}

/** Absolute default path for the save dialog: source folder + rule-based name. */
function suggestedSavePath(
  opts: SaveNameOptions = DEFAULT_NAME_OPTIONS,
  ext = '.pdf'
): string {
  const dir = openMeta?.dir ?? app.getPath('documents')
  return join(dir, suggestedSaveName(opts, ext))
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

  const osdCache = join(app.getPath('userData'), 'tessdata')
  const sorted = naturalSortPaths(paths)
  const allImages = sorted.every(isImagePath)

  let bytes: Uint8Array
  let name: string
  let imagesInvolved = false
  let message: string | undefined
  let meta: typeof openMeta = null

  if (allImages) {
    bytes = await imagesToPdf(sorted, osdCache)
    imagesInvolved = true
    const first = baseNoExt(sorted[0])
    const dir = dirname(sorted[0])
    name =
      sorted.length > 1 ? `${first} 他${sorted.length - 1}件.pdf` : `${first}.pdf`
    meta =
      sorted.length >= 2
        ? { kind: 'images', base: first, count: sorted.length, dir }
        : { kind: 'file', base: first, dir }
  } else if (sorted.length === 1) {
    const target = sorted[0]
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
  } else {
    // Multiple files of mixed types → convert each and concatenate in natural
    // file-name order (2 < 10) into a single PDF.
    const res = await buildConcatenatedPdf(sorted, osdCache)
    bytes = res.bytes
    imagesInvolved = sorted.some(isImagePath)
    const first = baseNoExt(sorted[0])
    name = `${first} 他${sorted.length - 1}件.pdf`
    meta = { kind: 'file', base: first, dir: dirname(sorted[0]) }
    if (res.skipped.length > 0) {
      message = `${res.skipped.length}件は取り込めませんでした（対応形式外／変換失敗）。`
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

  // Open-source license info for the About screen (AGPL source availability +
  // bundled third-party notices). Files are shipped via extraResources.
  ipcMain.handle(IPC.appLicenses, async () => {
    const base = app.isPackaged
      ? process.resourcesPath
      : join(import.meta.dirname, '../..')
    const read = async (name: string): Promise<string> => {
      try {
        return await readFile(join(base, name), 'utf8')
      } catch {
        return ''
      }
    }
    return {
      version: app.getVersion(),
      sourceUrl: 'https://github.com/kiisantokyo/pdfmasker',
      license: await read('LICENSE'),
      notices: await read('THIRD-PARTY-NOTICES.md')
    }
  })

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
    (_e, rects: RedactionRect[], fill?: 'black' | 'white') => {
      pdf.applyRedactions(rects, fill ?? 'black')
      return pdf.getInfo()
    }
  )

  ipcMain.handle(IPC.mosaic, (_e, rects: RedactionRect[]) =>
    pdf.applyMosaic(rects)
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
  ipcMain.handle(IPC.visibleText, () => pdf.visibleOnlyText())
  ipcMain.handle(IPC.detectHiddenText, () => pdf.detectHiddenText())
  ipcMain.handle(IPC.removeHiddenText, () => pdf.removeHiddenText())

  ipcMain.handle(IPC.needsOcr, () => pdf.needsOcr())

  ipcMain.handle(IPC.runOcr, async (e) => {
    const cachePath = join(app.getPath('userData'), 'tessdata')
    const total = await pdf.runOcr(cachePath, (page, count) => {
      e.sender.send(IPC.ocrProgress, { page, count })
    })
    return { total, info: pdf.getInfo() }
  })

  ipcMain.handle(IPC.compareVisibleText, async (e) => {
    const cachePath = join(app.getPath('userData'), 'tessdata')
    return pdf.findDiscrepantText(cachePath, (page, count) => {
      e.sender.send(IPC.compareProgress, { page, count })
    })
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
    IPC.movePages,
    (_e, indices: number[], to: number) => pdf.movePages(indices, to)
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

  ipcMain.handle(IPC.insertText, (_e, opts: TextBoxOptions) =>
    pdf.insertTextBox(opts)
  )

  ipcMain.handle(IPC.insertTexts, (_e, items: TextBoxOptions[]) =>
    pdf.insertTextBoxes(items)
  )

  ipcMain.handle(
    IPC.fontContextAt,
    (_e, pageIndex: number, x: number, y: number) =>
      pdf.fontContextAt(pageIndex, x, y)
  )

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

  ipcMain.handle(
    IPC.saveAsSized,
    async (
      _e,
      profile: SaveProfile,
      nameOpts?: SaveNameOptions,
      password?: string
    ) => {
      if (!license.getState().canSave) return { saved: false, gated: true }
      const result = await dialog.showSaveDialog({
        title: 'Save PDF As',
        defaultPath: suggestedSavePath(nameOpts),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return { saved: false }
      const bytes = pdf.saveToBufferProfiled(profile, password || undefined)
      await writeFile(result.filePath, bytes)
      // An encrypted export is not made the working path (a later 上書き保存 must
      // not silently overwrite the protected file with an unencrypted one).
      if (!password) pdf.markSavedAt(result.filePath)
      return { saved: true, path: result.filePath, size: bytes.length }
    }
  )

  // Export the given page as a PNG image (current page only). A separate export
  // artifact — it never becomes "the document", so no markSavedAt.
  ipcMain.handle(
    IPC.saveAsImage,
    async (_e, index: number, nameOpts?: SaveNameOptions) => {
      if (!license.getState().canSave) return { saved: false, gated: true }
      const result = await dialog.showSaveDialog({
        title: 'このページをPNG画像で保存',
        defaultPath: suggestedSavePath(nameOpts, '.png'),
        filters: [{ name: 'PNG', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return { saved: false }
      const bytes = pdf.renderPageImage(index)
      await writeFile(result.filePath, bytes)
      return { saved: true, path: result.filePath, size: bytes.length }
    }
  )

  // Copy the given page to the clipboard as an image (current page). No license
  // gate: this is an on-screen convenience, not a file export.
  ipcMain.handle(IPC.copyPageImage, (_e, index: number) => {
    const png = pdf.renderPageImage(index)
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)))
    return { ok: true }
  })

  // Copy a rectangular region of the given page to the clipboard as an image.
  ipcMain.handle(
    IPC.copyPageRegionImage,
    (_e, index: number, rect: RedactionRect) => {
      const png = pdf.renderRegionImage(index, rect)
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)))
      return { ok: true }
    }
  )

  // Ctrl+V on the welcome screen: build a 1-page PDF from a clipboard image and
  // start editing it. Silently does nothing when the clipboard holds no image.
  ipcMain.handle(IPC.pasteFromClipboard, async () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const png = new Uint8Array(image.toPNG())
    const osdCache = join(app.getPath('userData'), 'tessdata')
    const bytes = await imageBytesToPdf([png], osdCache)
    const base = 'クリップボード画像'
    const info = pdf.loadDocument(bytes, `${base}.pdf`, null)
    openMeta = { kind: 'images', base, count: 1, dir: null }
    return { info, ocr: 'auto' as const }
  })

  ipcMain.handle(
    IPC.extractPages,
    async (_e, indices: number[], nameOpts?: SaveNameOptions) => {
      if (!license.getState().canSave) return { saved: false, gated: true }
      const result = await dialog.showSaveDialog({
        title: '選択ページを別ファイルに書き出し',
        defaultPath: suggestedSavePath(nameOpts),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) return { saved: false }
      const bytes = pdf.extractPagesToBuffer(indices)
      await writeFile(result.filePath, bytes)
      return { saved: true, path: result.filePath, size: bytes.length }
    }
  )

  ipcMain.handle(IPC.trimPages, (_e, indices: number[], marginMm: number) =>
    pdf.trimPages(indices, marginMm)
  )

  ipcMain.handle(
    IPC.saveAsFlattened,
    async (_e, nameOpts?: SaveNameOptions, password?: string) => {
    if (!license.getState().canSave) return { saved: false, gated: true }
    const result = await dialog.showSaveDialog({
      title: 'Save PDF As',
      defaultPath: suggestedSavePath(nameOpts),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    const bytes = pdf.flattenToImages(password || undefined)
    await writeFile(result.filePath, bytes)
    // The flattened image-only file is a separate export, not "the document" —
    // don't mark it as the current path (avoids a later 上書き保存 overwriting the
    // image file with the still-editable text document).
    return { saved: true, path: result.filePath, size: bytes.length }
  })

  ipcMain.handle(IPC.cleanForSubmission, () => pdf.cleanForSubmission())

  // --- License (シリアルキー + 30日試用) ---------------------------------
  ipcMain.handle(IPC.licenseStatus, () => license.getState())
  ipcMain.handle(IPC.licenseActivate, (_e, key: string) =>
    license.activate(key)
  )
  ipcMain.handle(IPC.licenseDeactivate, () => license.deactivate())
}

/**
 * Load the bundled Japanese font used by the 文字入れ feature and hand its bytes
 * to pdf-service (which stays Electron-free). The redistributable production
 * font ships via extraResources (resources/fonts/pmtext-jp.otf). During local
 * development, before that asset is added, fall back to a system Japanese font
 * so the feature is testable — this fallback never ships (packaged builds use
 * the bundled file). Failure is non-fatal: only 文字入れ is affected.
 */
async function loadJpFont(): Promise<void> {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'fonts', 'pmtext-jp.ttf')
    : join(import.meta.dirname, '../..', 'resources', 'fonts', 'pmtext-jp.ttf')
  const candidates = [bundled]
  if (!app.isPackaged && process.platform === 'win32') {
    // Last-resort dev fallback if the bundled font is missing (not redistributed).
    candidates.push('C:/Windows/Fonts/BIZ-UDGothicR.ttc')
  }
  for (const path of candidates) {
    try {
      const bytes = await readFile(path)
      pdf.setJpFont(new Uint8Array(bytes))
      return
    } catch {
      // try the next candidate
    }
  }
  console.warn('[font] 日本語フォントを読み込めませんでした（文字入れは無効）')
}

app.whenReady().then(() => {
  registerIpc()
  void loadJpFont()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
