import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BindingSide,
  DocumentInfo,
  RedactionRect,
  RotateDelta,
  SelectMode
} from '@shared/types'
import { pdfApi } from './lib/api'
import Toolbar from './components/Toolbar'
import PageSidebar from './components/PageSidebar'
import ContinuousViewer from './components/ContinuousViewer'
import RedactByTermsModal from './components/RedactByTermsModal'

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
  const [status, setStatus] = useState('PDFを開いて始めましょう。')
  const [dragging, setDragging] = useState(false)
  const [selectMode, setSelectMode] = useState<SelectMode>('text')
  const [scrollTarget, setScrollTarget] = useState({ page: 0, n: 0 })
  const [sidebarW, setSidebarW] = useState(210)

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
  const [resizeOrient, setResizeOrient] = useState<'portrait' | 'landscape'>(
    'portrait'
  )
  const [resizeAll, setResizeAll] = useState(false)
  const [ocrPrompt, setOcrPrompt] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState({ page: 0, count: 0 })

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

  const openPath = useCallback(
    (path: string): Promise<void> =>
      run(async () => {
        const info = await pdfApi.openFromPath(path)
        applyOpened(info)
        if (await pdfApi.needsOcr()) setOcrPrompt(true)
      }, '開く'),
    [run, applyOpened]
  )

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
      const [wmm, hmm] =
        resizeOrient === 'portrait' ? [paper.w, paper.h] : [paper.h, paper.w]
      const indices = resizeAll ? doc.pages.map((p) => p.index) : [currentPage]
      const info = await pdfApi.resizePages(indices, wmm, hmm)
      pushHist(true, pending, [])
      setDoc(info)
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setResizeOpen(false)
      setStatus(
        `${indices.length} ページを ${paper.name}${resizeOrient === 'portrait' ? '縦' : '横'} に変更しました。`
      )
    }, '用紙サイズ変更')

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
      setCurrentPage(to)
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

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const file = Array.from(e.dataTransfer.files).find((f) =>
      f.name.toLowerCase().endsWith('.pdf')
    )
    if (!file) {
      setStatus('PDFファイルをドロップしてください。')
      return
    }
    const path = pdfApi.getPathForFile(file)
    if (!path) {
      setStatus('ファイルのパスを取得できませんでした。')
      return
    }
    void openPath(path)
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
            ここにPDFをドロップして開く
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

            <div className="field">
              <span className="field-label">向き</span>
              <label className="radio">
                <input
                  type="radio"
                  checked={resizeOrient === 'portrait'}
                  onChange={() => setResizeOrient('portrait')}
                />
                縦
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={resizeOrient === 'landscape'}
                  onChange={() => setResizeOrient('landscape')}
                />
                横
              </label>
            </div>

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
        onRedact={applyRedactions}
        onHighlight={applyHighlight}
        onExpandSameWord={expandSameWord}
        canExpand={lastSelText.trim().length > 0}
        onClearPending={() => commitMarks([])}
        onUndo={doUndo}
        onRedo={doRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onRedactByTerms={() => setTermsOpen(true)}
        onRotateLeft={() => rotate(-90)}
        onRotateRight={() => rotate(90)}
        onBindingMargin={() => setBindingOpen(true)}
        onResizePage={() => setResizeOpen(true)}
        onDeletePage={deletePage}
        onMoveUp={() => move(-1)}
        onMoveDown={() => move(1)}
        onZoom={setZoom}
        onSave={save}
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
            <div className="empty">
              <h1>究極の墨消し</h1>
              <p>
                文字をなぞる（または四角で囲む）と墨消し対象になり、
                <b>「墨消しを適用」</b>で下にある文字・画像を完全に削除します。
              </p>
              <button onClick={open}>PDFを開く…</button>
              <p className="empty-hint">
                ここにPDFファイルをドラッグ＆ドロップしても開けます。
              </p>
            </div>
          </main>
        )}
      </div>

      <footer className="statusbar">
        <span>{status}</span>
        {doc && (
          <span className="status-right">
            {currentPage + 1} / {doc.pageCount} ページ
          </span>
        )}
      </footer>
    </div>
  )
}
