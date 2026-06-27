import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApplyScope,
  BindingSide,
  DocumentInfo,
  PageNumberFormat,
  PageNumberPosition,
  RedactionRect,
  RotateDelta,
  SelectMode,
  StampKind,
  StampPosition
} from '@shared/types'
import { STAMP_LABELS } from '@shared/types'
import { pdfApi } from './lib/api'
import Toolbar from './components/Toolbar'
import PageSidebar from './components/PageSidebar'
import ContinuousViewer from './components/ContinuousViewer'
import RedactByTermsModal from './components/RedactByTermsModal'

// Auto build stamp (date + git commit), injected at build time. Lets every
// build be told apart without manually bumping the version number.
const BUILD_STAMP = `${__BUILD_DATE__} ${__GIT_HASH__}`

const PAPER_SIZES = [
  { name: 'A3', w: 297, h: 420 },
  { name: 'A4', w: 210, h: 297 },
  { name: 'A5', w: 148, h: 210 },
  { name: 'B4', w: 257, h: 364 },
  { name: 'B5', w: 182, h: 257 },
  { name: 'レター', w: 216, h: 279 },
  { name: 'リーガル', w: 216, h: 356 }
]

export default function App(): React.JSX.Element {
  const [doc, setDoc] = useState<DocumentInfo | null>(null)
  const [currentPage, setCurrentPage] = useState(0)
  const [zoom, setZoom] = useState(1.5)
  const [pending, setPending] = useState<RedactionRect[]>([])
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [status, setStatus] = useState(
    'PDF・Word・画像ファイルを開いて始めましょう。'
  )
  const [dragging, setDragging] = useState(false)
  const [selectMode, setSelectMode] = useState<SelectMode>('text')
  const [scrollTarget, setScrollTarget] = useState({ page: 0, n: 0 })
  const [sidebarW, setSidebarW] = useState(210)
  // App version (package.json), shown in the welcome screen and status bar.
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    void pdfApi.appVersion().then(setAppVersion)
  }, [])

  const startResize = (e: React.PointerEvent): void => {
    const startX = e.clientX
    const startW = sidebarW
    const onMove = (ev: PointerEvent): void => {
      const max = Math.round(window.innerWidth * 0.7)
      setSidebarW(Math.max(150, Math.min(max, startW + (ev.clientX - startX))))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const navigateTo = useCallback((index: number) => {
    setCurrentPage(index)
    setScrollTarget((t) => ({ page: index, n: t.n + 1 }))
  }, [])

  const onVisiblePage = useCallback((index: number) => {
    setCurrentPage(index)
  }, [])
  // Text of the most recent selection, used by the "同語＋" toolbar button.
  const [lastSelText, setLastSelText] = useState('')
  const [termsOpen, setTermsOpen] = useState(false)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [bindSide, setBindSide] = useState<BindingSide>('left')
  const [bindMm, setBindMm] = useState(20)
  const [bindAll, setBindAll] = useState(true)
  const [resizeOpen, setResizeOpen] = useState(false)
  const [resizePaper, setResizePaper] = useState('A4')
  const [resizeAll, setResizeAll] = useState(false)
  // ページ番号モーダル
  const [pnOpen, setPnOpen] = useState(false)
  const [pnFormat, setPnFormat] = useState<PageNumberFormat>('plain')
  const [pnPos, setPnPos] = useState<PageNumberPosition>('bottom-center')
  const [pnStart, setPnStart] = useState(1)
  const [pnScope, setPnScope] = useState<ApplyScope>('all')
  const [pnFrom, setPnFrom] = useState(1)
  const [pnTo, setPnTo] = useState(1)
  // スタンプモーダル
  const [stampOpen, setStampOpen] = useState(false)
  const [stampKind, setStampKind] = useState<StampKind>('maru-hi')
  const [stampPos, setStampPos] = useState<StampPosition>('top-right')
  const [stampScope, setStampScope] = useState<ApplyScope>('current')
  const [stampFrom, setStampFrom] = useState(1)
  const [stampTo, setStampTo] = useState(1)
  const [ocrPrompt, setOcrPrompt] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState({ page: 0, count: 0 })
  // Files awaiting a placement decision (dropped while a document is open).
  const [dropPaths, setDropPaths] = useState<string[]>([])
  const [placeOpen, setPlaceOpen] = useState(false)
  // Message shown while a dropped file is being converted to PDF (null = idle).
  const [processing, setProcessing] = useState<string | null>(null)
  // Confirm before overwriting an existing file via plain 保存.
  const [overwriteConfirm, setOverwriteConfirm] = useState(false)
  // Result of プロパティ消去 (null = dialog hidden), shown to confirm the action.
  const [metaCleared, setMetaCleared] = useState<string[] | null>(null)
  // Confirm before closing a document with unsaved work.
  const [closeConfirm, setCloseConfirm] = useState(false)

  const clampZoom = useCallback(
    (z: number) => setZoom(Math.min(3, Math.max(0.5, Math.round(z * 100) / 100))),
    []
  )

  const pendingCountByPage = useMemo(() => {
    const m: Record<number, number> = {}
    for (const r of pending) m[r.pageIndex] = (m[r.pageIndex] ?? 0) + 1
    return m
  }, [pending])

  const run = useCallback(
    async (fn: () => Promise<void>, label: string) => {
      setBusy(true)
      try {
        await fn()
      } catch (err) {
        setStatus(`${label}に失敗しました: ${(err as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    []
  )

  // --- Unified undo/redo -------------------------------------------------
  // Each entry snapshots the pending marks before/after an action. Document
  // mutations (isDoc) are additionally reverted via the mupdf journal, whose
  // LIFO order stays in sync with the isDoc entries in these stacks.
  type Hist = { isDoc: boolean; before: RedactionRect[]; after: RedactionRect[] }
  const undoStack = useRef<Hist[]>([])
  const redoStack = useRef<Hist[]>([])
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const syncHist = useCallback(() => {
    setCanUndo(undoStack.current.length > 0)
    setCanRedo(redoStack.current.length > 0)
  }, [])

  const resetHist = useCallback(() => {
    undoStack.current = []
    redoStack.current = []
    syncHist()
  }, [syncHist])

  const pushHist = useCallback(
    (isDoc: boolean, before: RedactionRect[], after: RedactionRect[]) => {
      undoStack.current.push({ isDoc, before, after })
      redoStack.current = []
      syncHist()
    },
    [syncHist]
  )

  /** Change pending marks as one undoable step (deduping overlapping rects). */
  const commitMarks = useCallback(
    (next: RedactionRect[]) => {
      const seen = new Set<string>()
      const deduped: RedactionRect[] = []
      for (const r of next) {
        const key = `${r.pageIndex}:${Math.round(r.x0)}:${Math.round(r.y0)}:${Math.round(r.x1)}:${Math.round(r.y1)}`
        if (!seen.has(key)) {
          seen.add(key)
          deduped.push(r)
        }
      }
      pushHist(false, pending, deduped)
      setPending(deduped)
    },
    [pending, pushHist]
  )

  const applyOpened = useCallback(
    (info: DocumentInfo) => {
      setDoc(info)
      setCurrentPage(0)
      setPending([])
      setDirty(false)
      setRefreshKey((k) => k + 1)
      resetHist()
      setStatus(`「${info.name}」を開きました（${info.pageCount} ページ）。`)
    },
    [resetHist]
  )

  const open = (): Promise<void> =>
    run(async () => {
      const info = await pdfApi.open()
      if (!info) return
      applyOpened(info)
      if (await pdfApi.needsOcr()) setOcrPrompt(true)
    }, '開く')

  const runOcr = (): Promise<void> =>
    run(async () => {
      setOcrPrompt(false)
      setOcrBusy(true)
      setOcrProgress({ page: 0, count: 0 })
      const off = pdfApi.onOcrProgress((p) => setOcrProgress(p))
      try {
        const { info, total } = await pdfApi.runOcr()
        setDoc(info)
        setRefreshKey((k) => k + 1)
        setStatus(
          total > 0
            ? `OCR完了：${total} 個の語を認識しました。検索・単語クリック・固有名詞抽出が使えます。`
            : 'OCRを実行しましたが、文字を認識できませんでした。'
        )
      } finally {
        off()
        setOcrBusy(false)
      }
    }, 'OCR')

  // Open / merge dropped files (PDF / Word / images). `mode` decides placement
  // relative to the currently-open document; 'new' replaces it.
  const runOpenFiles = useCallback(
    (paths: string[], mode: 'new' | 'before' | 'after'): Promise<void> =>
      run(async () => {
        const lower = paths.map((p) => p.toLowerCase())
        const label = lower.some((p) => /\.(docx?|docm|rtf)$/.test(p))
          ? 'Word から PDF を作成しています…'
          : lower.some((p) => /\.(png|jpe?g|bmp|gif|webp|tiff?)$/.test(p))
            ? '画像から PDF を作成しています…'
            : 'ファイルを読み込んでいます…'
        let res: Awaited<ReturnType<typeof pdfApi.openFiles>>
        setProcessing(label)
        try {
          res = await pdfApi.openFiles(paths, mode)
        } finally {
          setProcessing(null)
        }
        if (mode === 'new') {
          applyOpened(res.info)
        } else {
          // A merge is a single undoable document mutation.
          pushHist(true, pending, [])
          setDoc(res.info)
          setPending([])
          if (mode === 'before') navigateTo(0)
          setDirty(true)
          setRefreshKey((k) => k + 1)
          setStatus(
            `ファイルを${mode === 'before' ? '先頭' : '末尾'}に追加しました（全 ${res.info.pageCount} ページ）。`
          )
        }
        if (res.message) setStatus(res.message)
        if (res.ocr === 'auto') await runOcr()
        else if (res.ocr === 'prompt') setOcrPrompt(true)
      }, 'ファイルの読み込み'),
    [run, applyOpened, pushHist, pending, navigateTo, runOcr]
  )

  const clearMetadata = (): Promise<void> =>
    run(async () => {
      if (!doc) return
      const res = await pdfApi.clearMetadata()
      pushHist(true, pending, pending)
      setDoc(res.info)
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setMetaCleared(res.removed)
      setStatus(
        res.removed.length
          ? `文書プロパティを消去しました（${res.removed.join('・')}）。`
          : '削除対象の文書プロパティはありませんでした。'
      )
    }, 'プロパティ消去')

  const applyRedactions = (): Promise<void> =>
    run(async () => {
      if (pending.length === 0) return
      const info = await pdfApi.applyRedactions(pending)
      pushHist(true, pending, [])
      setDoc(info)
      const removed = pending.length
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`${removed} 箇所を墨消ししました（下の文字・画像を削除）。`)
    }, '墨消しの適用')

  const applyHighlight = (): Promise<void> =>
    run(async () => {
      if (pending.length === 0) return
      const info = await pdfApi.highlight(pending)
      pushHist(true, pending, [])
      setDoc(info)
      const n = pending.length
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`${n} 箇所に黄色マーカーを引きました。`)
    }, '黄色マーカー')

  const searchAdd = (keyword: string): Promise<void> =>
    run(async () => {
      const term = keyword.trim()
      if (!term) return
      const rects = await pdfApi.findWord(term)
      if (rects.length === 0) {
        setStatus(`「${term}」は見つかりませんでした。`)
        return
      }
      commitMarks([...pending, ...rects])
      setLastSelText(term)
      setStatus(
        `「${term}」を ${rects.length} 箇所、選択に追加しました。上部の「墨」または「黄」で処理します。`
      )
    }, 'キーワード検索')

  const expandSameWord = (): Promise<void> =>
    run(async () => {
      const term = lastSelText.trim()
      if (!term) return
      const rects = await pdfApi.findWord(term)
      commitMarks([...pending, ...rects])
      setStatus(`「${term}」を ${rects.length} 箇所、選択に追加しました。`)
    }, '同語の追加')

  const rotate = (delta: RotateDelta): Promise<void> =>
    run(async () => {
      if (!doc) return
      const info = await pdfApi.rotatePage(currentPage, delta)
      const next = pending.filter((r) => r.pageIndex !== currentPage)
      pushHist(true, pending, next)
      setDoc(info)
      setPending(next)
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(
        `ページ ${currentPage + 1} を${delta < 0 ? '左' : '右'}に回転しました。`
      )
    }, '回転')

  const applyBinding = (): Promise<void> =>
    run(async () => {
      if (!doc) return
      const info = await pdfApi.bindingMargin({
        side: bindSide,
        marginMm: bindMm,
        allPages: bindAll,
        pageIndex: currentPage
      })
      pushHist(true, pending, [])
      setDoc(info)
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setBindingOpen(false)
      const sideJa = { left: '左', right: '右', top: '上', bottom: '下' }[bindSide]
      setStatus(
        `閉じ代（${sideJa}・${bindMm}mm）を${bindAll ? '全' : '現在の'}ページに適用しました。`
      )
    }, '閉じ代の適用')

  const deletePage = (): Promise<void> =>
    run(async () => {
      if (!doc) return
      const info = await pdfApi.deletePage(currentPage)
      pushHist(true, pending, [])
      setDoc(info)
      setPending([])
      setCurrentPage((c) => Math.min(c, info.pageCount - 1))
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`ページを削除しました（残り ${info.pageCount} ページ）。`)
    }, 'ページ削除')

  const applyResize = (): Promise<void> =>
    run(async () => {
      if (!doc) return
      const paper = PAPER_SIZES.find((p) => p.name === resizePaper) ?? PAPER_SIZES[1]
      const indices = resizeAll ? doc.pages.map((p) => p.index) : [currentPage]
      const info = await pdfApi.resizePages(indices, paper.w, paper.h)
      pushHist(true, pending, [])
      setDoc(info)
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setResizeOpen(false)
      setStatus(
        `${indices.length} ページを ${paper.name} に変更しました（向きは維持）。`
      )
    }, '用紙サイズ変更')

  const applyPageNumbers = (): Promise<void> =>
    run(async () => {
      if (!doc) return
      const info = await pdfApi.addPageNumbers({
        format: pnFormat,
        position: pnPos,
        startNumber: pnStart,
        scope: pnScope,
        pageIndex: currentPage,
        rangeFrom: pnFrom,
        rangeTo: pnTo
      })
      pushHist(true, pending, [])
      setDoc(info)
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setPnOpen(false)
      setStatus('ページ番号を付けました。')
    }, 'ページ番号の付与')

  const applyStamp = (): Promise<void> =>
    run(async () => {
      if (!doc) return
      const info = await pdfApi.addStamp({
        kind: stampKind,
        position: stampPos,
        scope: stampScope,
        pageIndex: currentPage,
        rangeFrom: stampFrom,
        rangeTo: stampTo
      })
      pushHist(true, pending, [])
      setDoc(info)
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStampOpen(false)
      setStatus(`スタンプ「${STAMP_LABELS[stampKind]}」を押しました。`)
    }, 'スタンプの付与')

  const bulkDelete = (indices: number[]): Promise<void> =>
    run(async () => {
      if (!doc || indices.length === 0) return
      const info = await pdfApi.deletePages(indices)
      pushHist(true, pending, [])
      setDoc(info)
      setPending([]) // page indices shift after deletion
      setCurrentPage((c) => Math.min(c, info.pageCount - 1))
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`${indices.length} ページを削除しました（残り ${info.pageCount} ページ）。`)
    }, 'ページ一括削除')

  const bulkRotate = (indices: number[], delta: RotateDelta): Promise<void> =>
    run(async () => {
      if (!doc || indices.length === 0) return
      const info = await pdfApi.rotatePages(indices, delta)
      const set = new Set(indices)
      const next = pending.filter((r) => !set.has(r.pageIndex))
      pushHist(true, pending, next)
      setDoc(info)
      setPending(next)
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`${indices.length} ページを回転しました。`)
    }, 'ページ一括回転')

  const move = (dir: -1 | 1): Promise<void> =>
    run(async () => {
      if (!doc) return
      const to = currentPage + dir
      if (to < 0 || to >= doc.pageCount) return
      const info = await pdfApi.movePage(currentPage, to)
      pushHist(true, pending, [])
      setDoc(info)
      setPending([])
      // Follow the moved page to its new position so focus stays on it.
      navigateTo(to)
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`ページを ${to + 1} 番目に移動しました。`)
    }, 'ページ移動')

  const save = (): Promise<void> =>
    run(async () => {
      const res = await pdfApi.save()
      if (res.needsPath) {
        await saveAs()
        return
      }
      if (res.saved) {
        setDirty(false)
        setStatus(`${res.path} に保存しました。`)
      }
    }, '保存')

  // Close the current document and return to the welcome screen.
  const doCloseFile = (): Promise<void> =>
    run(async () => {
      await pdfApi.closeDoc()
      setDoc(null)
      setPending([])
      resetHist()
      setDirty(false)
      setCurrentPage(0)
      setRefreshKey((k) => k + 1)
      setLastSelText('')
      setStatus('PDF・Word・画像ファイルを開いて始めましょう。')
    }, '閉じる')

  const closeFile = (): void => {
    if (dirty || pending.length > 0) setCloseConfirm(true)
    else void doCloseFile()
  }

  // Plain 保存: confirm first only when it would overwrite an existing file
  // (doc.path is set). With no path yet, save() routes to 名前を付けて保存,
  // whose OS dialog handles its own overwrite prompt.
  const requestSave = (): void => {
    if (doc?.path) setOverwriteConfirm(true)
    else void save()
  }

  const saveAs = (): Promise<void> =>
    run(async () => {
      const res = await pdfApi.saveAs()
      if (res.saved) {
        setDirty(false)
        if (doc) setDoc({ ...doc, path: res.path ?? doc.path })
        setStatus(`${res.path} に保存しました。`)
      }
    }, '名前を付けて保存')

  // Clicking a word adds it to the selection (and remembers its text).
  const onWordClick = (
    pageIndex: number,
    pagePt: { x: number; y: number },
    _clientPt: { x: number; y: number }
  ): Promise<void> =>
    run(async () => {
      const hit = await pdfApi.wordAt(pageIndex, pagePt.x, pagePt.y)
      if (!hit) {
        setStatus('単語が見つかりませんでした（画像化されたPDFかもしれません）。')
        return
      }
      commitMarks([...pending, hit.rect])
      setLastSelText(hit.word)
      setStatus('選択に追加しました。上部の「墨」または「黄」で処理します。')
    }, '単語の選択')

  // Ctrl/Cmd + click removes a selected mark under the cursor (deselect).
  const onCtrlClick = (
    pageIndex: number,
    pt: { x: number; y: number }
  ): void => {
    const next = pending.filter(
      (r) =>
        !(
          r.pageIndex === pageIndex &&
          pt.x >= Math.min(r.x0, r.x1) &&
          pt.x <= Math.max(r.x0, r.x1) &&
          pt.y >= Math.min(r.y0, r.y1) &&
          pt.y <= Math.max(r.y0, r.y1)
        )
    )
    if (next.length !== pending.length) {
      commitMarks(next)
      setStatus('選択を解除しました。')
    }
  }

  // Dragging text adds the selection (accumulates) and remembers its text.
  const onTextSelect = (
    pageIndex: number,
    sel: { x0: number; y0: number; x1: number; y1: number },
    _clientPt: { x: number; y: number }
  ): Promise<void> =>
    run(async () => {
      const res = await pdfApi.selectionString(
        pageIndex,
        sel.x0,
        sel.y0,
        sel.x1,
        sel.y1
      )
      if (res.rects.length === 0) {
        setStatus('文字を選択できませんでした。')
        return
      }
      commitMarks([...pending, ...res.rects])
      setLastSelText(res.text)
      setStatus(
        `${res.rects.length} 箇所を選択に追加しました。上部の「墨」または「黄」で処理します。`
      )
    }, '範囲の選択')

  const doUndo = useCallback(
    (): Promise<void> =>
      run(async () => {
        const entry = undoStack.current.pop()
        if (!entry) return
        if (entry.isDoc) {
          const info = await pdfApi.undo()
          setDoc(info)
          setCurrentPage((c) => Math.min(c, info.pageCount - 1))
          setRefreshKey((k) => k + 1)
          setDirty(await pdfApi.hasUnsavedChanges())
        }
        setPending(entry.before)
        redoStack.current.push(entry)
        syncHist()
        setStatus('元に戻しました。')
      }, '元に戻す'),
    [run, syncHist]
  )

  const doRedo = useCallback(
    (): Promise<void> =>
      run(async () => {
        const entry = redoStack.current.pop()
        if (!entry) return
        if (entry.isDoc) {
          const info = await pdfApi.redo()
          setDoc(info)
          setCurrentPage((c) => Math.min(c, info.pageCount - 1))
          setRefreshKey((k) => k + 1)
          setDirty(await pdfApi.hasUnsavedChanges())
        }
        setPending(entry.after)
        undoStack.current.push(entry)
        syncHist()
        setStatus('やり直しました。')
      }, 'やり直す'),
    [run, syncHist]
  )

  // Keep the main process informed of unsaved work so it can warn on close.
  useEffect(() => {
    pdfApi.setUnsaved(dirty || pending.length > 0)
  }, [dirty, pending])

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) for undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        void doUndo()
      } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
        e.preventDefault()
        void doRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doUndo, doRedo])

  const onDragOver = (e: React.DragEvent): void => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      setDragging(true)
    }
  }

  const onDragLeave = (e: React.DragEvent): void => {
    // Only clear when the cursor actually leaves the window.
    if (e.relatedTarget === null) setDragging(false)
  }

  const SUPPORTED_RE =
    /\.(pdf|docx?|docm|rtf|png|jpe?g|bmp|gif|webp|tiff?)$/i

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    if (files.length > 10) {
      setStatus('一度にドロップできるのは10ファイルまでです。')
      return
    }
    const supported = files.filter((f) => SUPPORTED_RE.test(f.name))
    if (supported.length === 0) {
      setStatus('対応していないファイル形式です（PDF / Word / 画像）。')
      return
    }
    const paths = supported
      .map((f) => pdfApi.getPathForFile(f))
      .filter((p): p is string => !!p)
    if (paths.length === 0) {
      setStatus('ファイルのパスを取得できませんでした。')
      return
    }
    if (doc) {
      // A document is already open → ask where the dropped files should go.
      setDropPaths(paths)
      setPlaceOpen(true)
    } else {
      void runOpenFiles(paths, 'new')
    }
  }

  const choosePlacement = (mode: 'before' | 'after' | 'new'): void => {
    setPlaceOpen(false)
    const paths = dropPaths
    setDropPaths([])
    if (paths.length > 0) void runOpenFiles(paths, mode)
  }

  return (
    <div
      className="app"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <div className="drop-icon">⬇</div>
            ここにファイルをドロップ（PDF / Word / 画像・最大10件）
          </div>
        </div>
      )}

      {placeOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setPlaceOpen(false)
            setDropPaths([])
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>ドロップしたファイルをどうしますか？</h2>
            <p className="modal-desc">
              すでに「{doc?.name}」を開いています。ドロップした
              {dropPaths.length > 1 ? `${dropPaths.length} 件の` : ''}
              ファイルの扱いを選んでください。
            </p>
            <div className="place-grid">
              <button className="place-btn" onClick={() => choosePlacement('before')}>
                <span className="place-title">先頭に追加</span>
                <span className="place-sub">今の文書の前に差し込む（1つに結合・元に戻せます）</span>
              </button>
              <button className="place-btn" onClick={() => choosePlacement('after')}>
                <span className="place-title">末尾に追加</span>
                <span className="place-sub">今の文書の後ろに差し込む（1つに結合・元に戻せます）</span>
              </button>
              <button className="place-btn" onClick={() => choosePlacement('new')}>
                <span className="place-title">開き直す（置き換え）</span>
                <span className="place-sub">今の文書を閉じて、ドロップした分だけを開く</span>
              </button>
            </div>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => {
                  setPlaceOpen(false)
                  setDropPaths([])
                }}
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {closeConfirm && (
        <div className="modal-backdrop" onClick={() => setCloseConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>ファイルを閉じる確認</h2>
            <p className="modal-desc">
              未保存の作業があります。保存せずに閉じてよろしいですか？
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setCloseConfirm(false)}
              >
                キャンセル
              </button>
              <button
                className="modal-primary"
                onClick={() => {
                  setCloseConfirm(false)
                  void doCloseFile()
                }}
              >
                保存せずに閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {overwriteConfirm && (
        <div
          className="modal-backdrop"
          onClick={() => setOverwriteConfirm(false)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>上書き保存の確認</h2>
            <p className="modal-desc">
              「{doc?.path?.replace(/^.*[\\/]/, '')}」を上書きします。よろしいですか？
            </p>
            <div className="modal-actions">
              <button
                className="modal-cancel"
                onClick={() => setOverwriteConfirm(false)}
              >
                キャンセル
              </button>
              <button
                className="modal-primary"
                onClick={() => {
                  setOverwriteConfirm(false)
                  void save()
                }}
              >
                上書きする
              </button>
            </div>
          </div>
        </div>
      )}

      {metaCleared && (
        <div className="modal-backdrop" onClick={() => setMetaCleared(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>プロパティを消去しました</h2>
            {metaCleared.length > 0 ? (
              <>
                <p className="modal-desc">
                  次の文書プロパティを削除しました：
                </p>
                <ul className="meta-list">
                  {metaCleared.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="modal-desc">
                削除対象の文書プロパティ（作成者・作成日時・XMPなど）はありませんでした。
              </p>
            )}
            <div className="modal-actions">
              <button
                className="modal-primary"
                onClick={() => setMetaCleared(null)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {termsOpen && (
        <RedactByTermsModal
          onClose={() => setTermsOpen(false)}
          onAddRects={(rects, summary) => {
            commitMarks([...pending, ...rects])
            setStatus(summary)
          }}
        />
      )}

      {bindingOpen && (
        <div className="modal-backdrop" onClick={() => setBindingOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>閉じ代を確保</h2>
            <p className="modal-desc">
              ページサイズはそのままで、中身を縮小して指定した側に余白を作ります。
            </p>

            <div className="field">
              <span className="field-label">綴じる側</span>
              <div className="side-grid">
                {(
                  [
                    ['left', '左'],
                    ['right', '右'],
                    ['top', '上'],
                    ['bottom', '下']
                  ] as [BindingSide, string][]
                ).map(([s, label]) => (
                  <button
                    key={s}
                    className={'side-btn' + (bindSide === s ? ' active' : '')}
                    onClick={() => setBindSide(s)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field-label">余白の幅</span>
              <div className="mm-row">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={bindMm}
                  onChange={(e) => setBindMm(Number(e.target.value))}
                />
                <span>mm</span>
              </div>
            </div>

            <div className="field">
              <span className="field-label">対象</span>
              <label className="radio">
                <input
                  type="radio"
                  checked={bindAll}
                  onChange={() => setBindAll(true)}
                />
                全ページ
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={!bindAll}
                  onChange={() => setBindAll(false)}
                />
                現在のページのみ
              </label>
            </div>

            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setBindingOpen(false)}>
                キャンセル
              </button>
              <button className="modal-primary" onClick={applyBinding} disabled={busy}>
                適用
              </button>
            </div>
          </div>
        </div>
      )}

      {ocrPrompt && (
        <div className="modal-backdrop" onClick={() => setOcrPrompt(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>OCR（文字認識）を実行しますか？</h2>
            <p className="modal-desc">
              このPDFには文字情報が見つかりませんでした（スキャン画像の可能性）。
              OCRを実行すると、検索・単語クリック・固有名詞抽出・AI連携が使えるようになります。
              処理は端末内で行われ、外部に送信しません。
            </p>
            <p className="warn">
              ⚠ 初回は日本語/英語の認識モデル（数十MB）の取得が必要です。ページ数に応じて時間がかかります。
            </p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setOcrPrompt(false)}>
                いいえ
              </button>
              <button className="modal-primary" onClick={runOcr}>
                はい（OCRを実行）
              </button>
            </div>
          </div>
        </div>
      )}

      {processing && (
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{processing}</h2>
            <p className="modal-desc">
              ファイルのサイズによっては時間がかかることがあります。
              そのままお待ちください（フリーズではありません）。
            </p>
            <div className="ocr-bar">
              <div className="ocr-bar-fill ocr-bar-indeterminate" />
            </div>
          </div>
        </div>
      )}

      {ocrBusy && (
        <div className="modal-backdrop">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>OCR処理中…</h2>
            <p className="modal-desc">
              {ocrProgress.count > 0
                ? `ページ ${ocrProgress.page} / ${ocrProgress.count} を処理しています。`
                : '認識モデルを準備しています…'}
            </p>
            <div className="ocr-bar">
              <div
                className="ocr-bar-fill"
                style={{
                  width:
                    ocrProgress.count > 0
                      ? `${(ocrProgress.page / ocrProgress.count) * 100}%`
                      : '10%'
                }}
              />
            </div>
          </div>
        </div>
      )}

      {resizeOpen && (
        <div className="modal-backdrop" onClick={() => setResizeOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>用紙サイズを変更</h2>
            <p className="modal-desc">
              指定したページを選んだ用紙サイズに変更し、内容を縦横比を保ったまま
              拡大／縮小して中央に配置します。
            </p>

            <div className="field">
              <span className="field-label">用紙サイズ</span>
              <select
                className="text-input"
                value={resizePaper}
                onChange={(e) => setResizePaper(e.target.value)}
              >
                {PAPER_SIZES.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <p className="modal-desc" style={{ margin: '0 0 12px' }}>
              ※ 向きは各ページの現状を維持します（回転は回転ボタンで行ってください）。
            </p>

            <div className="field">
              <span className="field-label">対象</span>
              <label className="radio">
                <input
                  type="radio"
                  checked={!resizeAll}
                  onChange={() => setResizeAll(false)}
                />
                現在のページ（{currentPage + 1}）
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={resizeAll}
                  onChange={() => setResizeAll(true)}
                />
                全ページ
              </label>
            </div>

            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setResizeOpen(false)}>
                キャンセル
              </button>
              <button className="modal-primary" onClick={applyResize} disabled={busy}>
                変更
              </button>
            </div>
          </div>
        </div>
      )}

      {pnOpen && (
        <div className="modal-backdrop" onClick={() => setPnOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>ページ番号を付ける</h2>
            <p className="modal-desc">
              各ページの下中央にノンブル（ページ番号）を印字します。
            </p>

            <div className="field">
              <span className="field-label">書式</span>
              <select
                className="text-input"
                value={pnFormat}
                onChange={(e) => setPnFormat(e.target.value as PageNumberFormat)}
              >
                <option value="plain">1</option>
                <option value="slash">1 / 10</option>
                <option value="dash">- 1 -</option>
                <option value="p-dot">P.1</option>
              </select>
            </div>

            <div className="field">
              <span className="field-label">位置</span>
              <div className="side-grid">
                {(
                  [
                    ['bottom-left', '左下'],
                    ['bottom-center', '中央'],
                    ['bottom-right', '右下']
                  ] as [PageNumberPosition, string][]
                ).map(([p, label]) => (
                  <button
                    key={p}
                    className={'side-btn' + (pnPos === p ? ' active' : '')}
                    onClick={() => setPnPos(p)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field-label">開始番号</span>
              <div className="mm-row">
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={pnStart}
                  onChange={(e) => setPnStart(Number(e.target.value))}
                />
                <span>から</span>
              </div>
            </div>

            <div className="field">
              <span className="field-label">対象</span>
              <label className="radio">
                <input
                  type="radio"
                  checked={pnScope === 'all'}
                  onChange={() => setPnScope('all')}
                />
                全ページ
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={pnScope === 'range'}
                  onChange={() => setPnScope('range')}
                />
                範囲指定
              </label>
            </div>

            {pnScope === 'range' && (
              <div className="field">
                <span className="field-label">ページ範囲</span>
                <div className="mm-row">
                  <input
                    type="number"
                    min={1}
                    max={doc?.pageCount ?? 1}
                    value={pnFrom}
                    onChange={(e) => setPnFrom(Number(e.target.value))}
                  />
                  <span>〜</span>
                  <input
                    type="number"
                    min={1}
                    max={doc?.pageCount ?? 1}
                    value={pnTo}
                    onChange={(e) => setPnTo(Number(e.target.value))}
                  />
                  <span>ページ</span>
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setPnOpen(false)}>
                キャンセル
              </button>
              <button
                className="modal-primary"
                onClick={applyPageNumbers}
                disabled={busy}
              >
                付ける
              </button>
            </div>
          </div>
        </div>
      )}

      {stampOpen && (
        <div className="modal-backdrop" onClick={() => setStampOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>赤いスタンプを押す</h2>
            <p className="modal-desc">
              「秘」などの朱印を選んだ位置に重ねます（中央は大きめの透かし表示）。
            </p>

            <div className="field">
              <span className="field-label">種類</span>
              <div className="side-grid stamp-grid">
                {(Object.keys(STAMP_LABELS) as StampKind[]).map((k) => (
                  <button
                    key={k}
                    className={
                      'side-btn stamp-btn' + (stampKind === k ? ' active' : '')
                    }
                    onClick={() => setStampKind(k)}
                  >
                    {STAMP_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field-label">位置</span>
              <div className="side-grid">
                {(
                  [
                    ['top-right', '右上'],
                    ['bottom-right', '右下'],
                    ['center', '中央（大）']
                  ] as [StampPosition, string][]
                ).map(([p, label]) => (
                  <button
                    key={p}
                    className={'side-btn' + (stampPos === p ? ' active' : '')}
                    onClick={() => setStampPos(p)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field-label">対象</span>
              <label className="radio">
                <input
                  type="radio"
                  checked={stampScope === 'current'}
                  onChange={() => setStampScope('current')}
                />
                現在のページ（{currentPage + 1}）
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={stampScope === 'all'}
                  onChange={() => setStampScope('all')}
                />
                全ページ
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={stampScope === 'range'}
                  onChange={() => setStampScope('range')}
                />
                範囲指定
              </label>
            </div>

            {stampScope === 'range' && (
              <div className="field">
                <span className="field-label">ページ範囲</span>
                <div className="mm-row">
                  <input
                    type="number"
                    min={1}
                    max={doc?.pageCount ?? 1}
                    value={stampFrom}
                    onChange={(e) => setStampFrom(Number(e.target.value))}
                  />
                  <span>〜</span>
                  <input
                    type="number"
                    min={1}
                    max={doc?.pageCount ?? 1}
                    value={stampTo}
                    onChange={(e) => setStampTo(Number(e.target.value))}
                  />
                  <span>ページ</span>
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setStampOpen(false)}>
                キャンセル
              </button>
              <button
                className="modal-primary"
                onClick={applyStamp}
                disabled={busy}
              >
                押す
              </button>
            </div>
          </div>
        </div>
      )}

      <Toolbar
        hasDoc={!!doc}
        pendingCount={pending.length}
        zoom={zoom}
        busy={busy}
        dirty={dirty}
        selectMode={selectMode}
        onToggleSelectMode={() =>
          setSelectMode((m) => (m === 'text' ? 'rect' : 'text'))
        }
        onOpen={open}
        onClose={closeFile}
        onRedact={applyRedactions}
        onHighlight={applyHighlight}
        onExpandSameWord={expandSameWord}
        canExpand={lastSelText.trim().length > 0}
        onSearchAdd={searchAdd}
        onClearPending={() => commitMarks([])}
        onUndo={doUndo}
        onRedo={doRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onRedactByTerms={() => setTermsOpen(true)}
        onRotateLeft={() => rotate(-90)}
        onRotateRight={() => rotate(90)}
        onBindingMargin={() => setBindingOpen(true)}
        onPageNumbers={() => setPnOpen(true)}
        onStamp={() => setStampOpen(true)}
        onResizePage={() => setResizeOpen(true)}
        onClearMetadata={clearMetadata}
        onDeletePage={deletePage}
        onMoveUp={() => move(-1)}
        onMoveDown={() => move(1)}
        onZoom={setZoom}
        onSave={requestSave}
        onSaveAs={saveAs}
      />

      <div className="body">
        {doc && (
          <>
            <PageSidebar
              doc={doc}
              width={sidebarW}
              currentPage={currentPage}
              pendingCountByPage={pendingCountByPage}
              refreshKey={refreshKey}
              onSelect={navigateTo}
              onBulkDelete={bulkDelete}
              onBulkRotate={bulkRotate}
            />
            <div
              className="resizer"
              onPointerDown={startResize}
              title="ドラッグでサムネイル幅を変更"
            />
          </>
        )}

        {doc ? (
          <ContinuousViewer
            pages={doc.pages}
            zoom={zoom}
            pending={pending}
            selectMode={selectMode}
            refreshKey={refreshKey}
            scrollTarget={scrollTarget}
            onVisiblePage={onVisiblePage}
            onAddRects={(rs) => commitMarks([...pending, ...rs])}
            onWordClick={onWordClick}
            onCtrlClick={onCtrlClick}
            onTextSelect={onTextSelect}
            onZoomChange={clampZoom}
          />
        ) : (
          <main className="viewer">
            <div className="welcome">
              <div className="welcome-head">
                <h1>究極の墨消し</h1>
                <p className="welcome-tag">
                  PDFの<b>真の墨消し</b>。黒い四角を重ねるのではなく、下に隠れた
                  文字・画像データごと完全に削除します。
                </p>
                <button className="welcome-open" onClick={open}>
                  ファイルを開く
                </button>
                <p className="welcome-drop">
                  PDF・Word・画像（PNG/JPEG など）をドラッグ＆ドロップでも開けます（最大10件）
                </p>
              </div>

              <div className="welcome-cards">
                <div className="welcome-card">
                  <div className="welcome-card-icon">■</div>
                  <h3>真の墨消し</h3>
                  <p>対象範囲の文字・画像データそのものを削除。コピーや抽出でも復元できません。</p>
                </div>
                <div className="welcome-card">
                  <div className="welcome-card-icon">🗂</div>
                  <h3>幅広い形式</h3>
                  <p>PDFに加え、Word（修正履歴なし版に変換）と画像（余白付きPDF化＋OCR）に対応。</p>
                </div>
                <div className="welcome-card">
                  <div className="welcome-card-icon">🛡</div>
                  <h3>透明文字も安全</h3>
                  <p>スキャン文書の透明文字（OCRテキスト層）も墨消し範囲ごと削除。隠し文字は残りません。</p>
                </div>
                <div className="welcome-card">
                  <div className="welcome-card-icon">🤖</div>
                  <h3>AIと連携した柔軟な墨消し</h3>
                  <p>GeminiやChatGPTに墨消し候補を相談し、結果を貼り戻して一括処理。固有名詞や指示に沿った効率的な墨消しが行えます。</p>
                </div>
              </div>

              <div className="welcome-note">
                <strong>透明文字（OCRテキスト）について：</strong>
                墨消しは見えている画像だけでなく<b>下層の文字データごと削除</b>するため、
                画面に見えない透明文字も残りません。さらに本アプリのOCR結果は
                <b>端末内のメモリにのみ保持</b>し、PDFへ埋め込まず・外部へも送信しません。
                安心して配布用ファイルを作成できます。
              </div>

              <div className="welcome-note">
                <strong>インターネット通信について：</strong>
                本アプリは<b>それ自体がインターネットに接続しません</b>。読み込んだPDFや
                ユーザーデータが<b>自動的に外部へ送信されることは一切ありません</b>。AIに相談する際も、
                コピーした内容を<b>お客様自身が</b>GeminiやChatGPTへ貼り付ける操作をしたときだけ送信され、
                その範囲も画面で確認できます。
              </div>

              <footer className="welcome-footer">
                {appVersion && (
                  <div>
                    バージョン {appVersion}
                    <span className="welcome-build">（{BUILD_STAMP}）</span>
                  </div>
                )}
                <div>© Kiichi Takahashi</div>
                <div>お問い合わせ先：弁護士法人コスモポリタン法律事務所</div>
                <div>
                  <a
                    href="https://www.cosmo-law.jp"
                    target="_blank"
                    rel="noreferrer"
                  >
                    https://www.cosmo-law.jp
                  </a>
                </div>
              </footer>
            </div>
          </main>
        )}
      </div>

      <footer className="statusbar">
        <span className="status-msg">{status}</span>
        {doc && (
          <span className="status-right">
            {(dirty || pending.length > 0) && (
              <span className="badge badge-unsaved">● 未保存</span>
            )}
            {!doc.hasMetadata && (
              <span className="badge badge-clean" title="作成者・日時・XMP等の配布に適さない情報がありません">
                ✓ 配布情報なし
              </span>
            )}
            {pending.length > 0 && (
              <span className="status-item">未適用 {pending.length}件</span>
            )}
            <span className="status-item">
              {currentPage + 1} / {doc.pageCount} ページ
            </span>
          </span>
        )}
        {appVersion && (
          <span
            className="status-ver"
            title={`バージョン ${appVersion}・ビルド ${BUILD_STAMP}`}
          >
            v{appVersion}
          </span>
        )}
      </footer>
    </div>
  )
}
