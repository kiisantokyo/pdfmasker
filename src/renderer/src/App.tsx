import { useCallback, useMemo, useState } from 'react'
import type {
  BindingSide,
  DocumentInfo,
  RedactionRect,
  WordHit
} from '@shared/types'
import { pdfApi } from './lib/api'
import Toolbar from './components/Toolbar'
import PageSidebar from './components/PageSidebar'
import PageCanvas from './components/PageCanvas'

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
  const [wordMenu, setWordMenu] = useState<
    (WordHit & { x: number; y: number }) | null
  >(null)
  const [bindingOpen, setBindingOpen] = useState(false)
  const [bindSide, setBindSide] = useState<BindingSide>('left')
  const [bindMm, setBindMm] = useState(20)
  const [bindAll, setBindAll] = useState(true)

  const clampZoom = useCallback(
    (z: number) => setZoom(Math.min(3, Math.max(0.5, Math.round(z * 100) / 100))),
    []
  )

  const pendingForPage = useMemo(
    () => pending.filter((r) => r.pageIndex === currentPage),
    [pending, currentPage]
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

  const applyOpened = useCallback((info: DocumentInfo) => {
    setDoc(info)
    setCurrentPage(0)
    setPending([])
    setDirty(false)
    setRefreshKey((k) => k + 1)
    setStatus(`「${info.name}」を開きました（${info.pageCount} ページ）。`)
  }, [])

  const open = (): Promise<void> =>
    run(async () => {
      const info = await pdfApi.open()
      if (!info) return
      applyOpened(info)
    }, '開く')

  const openPath = useCallback(
    (path: string): Promise<void> =>
      run(async () => {
        const info = await pdfApi.openFromPath(path)
        applyOpened(info)
      }, '開く'),
    [run, applyOpened]
  )

  const applyRedactions = (): Promise<void> =>
    run(async () => {
      if (pending.length === 0) return
      const info = await pdfApi.applyRedactions(pending)
      setDoc(info)
      const removed = pending.length
      setPending([])
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`${removed} 箇所を墨消ししました（下の文字・画像を削除）。`)
    }, '墨消しの適用')

  const rotate = (): Promise<void> =>
    run(async () => {
      if (!doc) return
      const info = await pdfApi.rotatePage(currentPage, 90)
      setDoc(info)
      setPending((p) => p.filter((r) => r.pageIndex !== currentPage))
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`ページ ${currentPage + 1} を回転しました。`)
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
      setDoc(info)
      setPending([])
      setCurrentPage((c) => Math.min(c, info.pageCount - 1))
      setDirty(true)
      setRefreshKey((k) => k + 1)
      setStatus(`ページを削除しました（残り ${info.pageCount} ページ）。`)
    }, 'ページ削除')

  const move = (dir: -1 | 1): Promise<void> =>
    run(async () => {
      if (!doc) return
      const to = currentPage + dir
      if (to < 0 || to >= doc.pageCount) return
      const info = await pdfApi.movePage(currentPage, to)
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

  const onWordClick = (
    pagePt: { x: number; y: number },
    clientPt: { x: number; y: number }
  ): Promise<void> =>
    run(async () => {
      const hit = await pdfApi.wordAt(currentPage, pagePt.x, pagePt.y)
      if (!hit) {
        setWordMenu(null)
        setStatus('単語が見つかりませんでした（画像化されたPDFかもしれません）。')
        return
      }
      setWordMenu({ ...hit, x: clientPt.x, y: clientPt.y })
    }, '単語の選択')

  const redactWordOnce = (): void => {
    if (!wordMenu) return
    setPending((p) => [...p, wordMenu.rect])
    setStatus(`「${wordMenu.word}」を1箇所マークしました。`)
    setWordMenu(null)
  }

  const redactWordAll = (): Promise<void> =>
    run(async () => {
      if (!wordMenu) return
      const { word } = wordMenu
      const rects = await pdfApi.findWord(word)
      setPending((p) => [...p, ...rects])
      setStatus(`「${word}」を文書内 ${rects.length} 箇所マークしました。`)
      setWordMenu(null)
    }, '単語の一括選択')

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

      {wordMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setWordMenu(null)} />
          <div
            className="word-menu"
            style={{ left: wordMenu.x, top: wordMenu.y }}
          >
            <div className="word-menu-head">
              選択した語：<b>{wordMenu.word}</b>
            </div>
            <button onClick={redactWordOnce}>この語のみ墨消し</button>
            <button onClick={redactWordAll}>文書内の同じ語をすべて墨消し</button>
            <button className="word-menu-cancel" onClick={() => setWordMenu(null)}>
              キャンセル
            </button>
          </div>
        </>
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

      <Toolbar
        hasDoc={!!doc}
        pendingCount={pending.length}
        zoom={zoom}
        busy={busy}
        dirty={dirty}
        onOpen={open}
        onApplyRedactions={applyRedactions}
        onClearPending={() => setPending([])}
        onRotate={rotate}
        onBindingMargin={() => setBindingOpen(true)}
        onDeletePage={deletePage}
        onMoveUp={() => move(-1)}
        onMoveDown={() => move(1)}
        onZoom={setZoom}
        onSave={save}
        onSaveAs={saveAs}
      />

      <div className="body">
        {doc && (
          <PageSidebar
            doc={doc}
            currentPage={currentPage}
            pendingCountByPage={pendingCountByPage}
            onSelect={setCurrentPage}
          />
        )}

        <main className="viewer">
          {doc ? (
            <PageCanvas
              pageIndex={currentPage}
              zoom={zoom}
              pendingRects={pendingForPage}
              refreshKey={refreshKey}
              onAddRect={(r) => setPending((p) => [...p, r])}
              onWordClick={onWordClick}
              onZoomChange={clampZoom}
            />
          ) : (
            <div className="empty">
              <h1>究極の墨消し</h1>
              <p>
                PDFを開き、ドラッグで領域をマークして<b>「墨消しを適用」</b>すると、
                下にある文字・画像を完全に削除します。
              </p>
              <button onClick={open}>PDFを開く…</button>
              <p className="empty-hint">
                ここにPDFファイルをドラッグ＆ドロップしても開けます。
              </p>
            </div>
          )}
        </main>
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
