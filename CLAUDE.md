# 究極の墨消し (pdfmasker) — project notes for Claude

製品名は **究極の墨消し**（npm/コードネームは `pdfmasker`）。
Desktop PDF **true-redaction** + page-editing app. UI is in Japanese.
Unrelated to other projects in this workspace (e.g. Mints Party Manager).

## Undo/Redo（統一履歴）
- ドキュメント変更は mupdf ジャーナル（`enableJournal` を loadDocument で有効化、各変更を
  `operation()`＝beginOperation/endOperation で包む）。`undo()/redo()` を pdf-service に用意。
- 未適用マーク(pending)はレンダラ状態。App に `undoStack/redoStack`（`{isDoc, before, after}`）を持ち、
  doc変更はジャーナル undo/redo と LIFO で同期、marks は before/after で復元。Ctrl+Z / Ctrl+Y。
- 全アクション（マーク追加・墨消し適用・削除/移動/回転・閉じ代・AI取り込み）が対象。

## Feature map (where things live)
- 真の墨消し / 単語クリック / 検索 / 候補抽出 / 閉じ代: すべて `src/main/pdf-service.ts`
  （Electron非依存・純mupdf）。IPCは `src/main/index.ts`、橋渡しは `src/preload/index.ts`、
  チャンネル名と型は `src/shared/types.ts`。
- 単語クリック: `wordAt`（snap("words")＋中央ライン水平スイープでテキスト取得）/ `findWord`（page.search）。
- なぞって選択: `selectText`（StructuredText.highlight でテキスト選択quad）。選択モードは
  `SelectMode='text'|'rect'`（既定 text）。ドラッグ中はIPCをthrottle(40ms)してライブプレビュー。
- 選択→処理の分離（ポップアップ廃止）: なぞる/クリック/四角は `pending`（選択セット, 青オーバーレイ）に
  **加算**。上部ツールバーの「墨(N)」=`applyRedactions`（破壊削除）/「黄(N)」=`highlightRects`（Highlight注釈）/
  「同語＋」=直前選択テキスト`lastSelText`で`findWord`して選択追加/「✕」=クリア。`selectionString` が
  選択範囲のテキスト＋矩形を返す（OCRフォールバック対応）。黄マーカーは `renderPage` の showExtras=true で描画。
- ページ一覧の表示: pt寸法は分かりにくいので `PageSidebar` の `sizeLabel` で A4縦 等の用紙名に変換
  （許容±4mm、未一致は mm 表記）。
- サムネイルサイドバー: `PageSidebar` が実画像サムネ（`Thumb` が IntersectionObserver で遅延レンダ、
  blobURLはunmount/再描画時にrevoke、`refreshKey`で編集後に再生成）。チェックボックス＋複数選択
  （クリックでナビ＋アンカー、Shiftで範囲チェック、Ctrlでトグル）。一括削除/回転は
  `deletePages`/`rotatePages`（各1ジャーナル操作＝1undo）。削除はインデックスがずれるため pending を全クリア、
  回転は対象ページのマークのみ除去。
- 固有名詞・指示・AI連携: UIは `components/RedactByTermsModal.tsx`（2タブ「AIに依頼」「結果を貼り戻す/自動抽出」）。
  - 依頼: カテゴリ＋自由記述＋（任意で本文同梱）から JSON出力契約のプロンプトを生成し、`writeClipboard`（preloadのelectron clipboard）でコピー。本文は `documentText`/`getDocumentText`。
  - 貼り戻し: `parsePlan`（コードフェンス/前後文混在でもJSON抽出、ダメなら`parseMarkdown`にフォールバック）。`{text,reason,scope}`。
  - 検索/適用: `countTerms`（件数・0件は不一致表示）/ `findTermsScoped`（scope=all|firstを尊重）/ `findTerms` / `extractCandidates`。
  - **方針: アプリは外部送信しない。** PDFを外部AIに送るのはユーザー操作（モーダルに警告表示）。AI案は必ず一覧で人間が取捨選択。
- 閉じ代: `addBindingMargin`（コンテンツストリームを `q s 0 0 s tx ty cm ... Q` で包んで均等縮小・シフト）。
- ページ番号 / 赤いスタンプ: `addPageNumbers` / `addStamp`（`pdf-service.ts`、各1ジャーナル操作＝1undo）。
  どちらも元コンテンツを `q ... Q` で囲って上に追記する方式（`addBindingMargin` と同系統）。
  `pageVisualMatrix` で /Rotate を吸収し、視覚座標（正立ページの左下原点）に配置。`ownResources` /
  `ownSubDict` は継承 /Resources を複製してから自前の名前（`/PMHELV` `/PMSTAMP` `/PMGS`）を足す
  （親 Pages を破壊しない）。
  - ページ番号: ASCII書式のみ（`1` / `1/総数` / `-1-` / `P.1`）で base-14 Helvetica（埋め込み不要）。下中央固定。
    番号は対象ページ列の先頭=`startNumber`。UIは App.tsx の `pnOpen` モーダル。
  - スタンプ: **案1（同梱朱印画像）**。赤ハンコPNGは `src/main/stamp-assets.ts`（base64）で、
    `scripts/gen-stamp-assets.ps1`（System.Drawing＋日本語フォント, 純ASCII・コードポイント生成）が出力。
    画像XObject＋ExtGStateで配置。中央=大・半透明(ca0.28)、右上/右下=小・不透明。種類/位置/対象はモーダル。
    文字種を増やすときは ps1 を編集して再実行＋`types.ts` の `StampKind`/`STAMP_LABELS` を更新。
- Ctrl+ホイールズーム: `components/PageCanvas.tsx`（passive:false の wheel リスナ）。
- 連続スクロールビュー: `components/ContinuousViewer.tsx`。全ページをスタックし、IntersectionObserver で
  ①近傍ページを遅延マウント（`mounted` Set、rootMargin 500px）②最可視ページを `onVisiblePage` で currentPage に反映。
  外部ナビは `scrollTarget={page,n}`（nを増やして scrollIntoView）→ スクロール起因の更新とループしない。
  `PageCanvas` は1ページ単位の描画/選択を担当（`onWordClick` は pageIndex 付き）。

## OCR（スキャンPDF対応）
- 開いたPDFに文字情報が無い（`needsOcr`）と確認ダイアログ→「はい」で `runOcr`（Tesseract.js, jpn+eng,
  メインプロセス）。各ページを200dpiでpixmap化→認識→単語＋bboxを **px/zoom で page-pt に変換**し
  `ocr: Map<pageIndex, OcrWord[]>` にメモリ保持（`enableJournal` 対象外・保存しない）。
- `documentText`/`wordAt`/`findWord`/`selectText` はネイティブ文字が無いとき OCR にフォールバック。
  → 検索・単語クリック・なぞり・固有名詞抽出・AI同梱がスキャンPDFでも機能。墨消し自体は画像領域の実削除。
- `findWord` の OCR 照合は **行単位で連結したテキスト**に対して行い、ヒット範囲を構成トークンの
  bbox に戻す（CJK は語が1文字ずつ別トークンに分割されるため。これで「山田由美」等の複数トークン語が
  ページ横断で拾える）。正規化は NFKC＋記号/絵文字除去＋小書きかな畳み込み。
- 既知の制約（意図的に未対応）: **装飾付き文字（例: 「シユン⭐」）はOCRの認識がインスタンスごとに
  ブレる**（星等の影響で2〜3文字目が `シユ私る`/`シユシミ`/`シユンマ` 等になる）ため、『同語＋』では
  拾い切れないことがある。findWord をあいまい化すると全機能で過剰墨消しのリスクがあるため厳密一致を維持し、
  この種はなぞり選択／四角で個別に墨消しする運用とする。
- モデルは `app.getPath('userData')/tessdata` にキャッシュ（初回のみネットワーク取得）。PDFは外部送信しない。
- 注意: OCRランタイム（モデルDL/worker）はヘッドレスで未検証。パッケージ時は worker/core/traineddata の
  同梱（asar unpack 等）が別途必要になる見込み。

## Drag & drop
- Opening a PDF works via the 開く button **and** by dropping a file on the
  window. Electron 42 removed `File.path`, so the dropped path is resolved with
  `webUtils.getPathForFile(file)` exposed through the preload bridge
  (`window.pdf.getPathForFile`), then loaded via the `openFromPath` IPC.

## Stack / commands
- Electron 42 + electron-vite + **Vite 7** + React 19 + TypeScript.
- PDF engine: **mupdf** (WASM, ESM-only) — runs in the **main process**.
- `pnpm dev` / `pnpm typecheck` / `pnpm build` / `pnpm start` / `pnpm package`.
- Use `pnpm` scripts; don't invoke bundlers/tsc directly.

## Hard environment constraints (do not "fix" by upgrading)
- **Smart App Control is ON** on this machine → unsigned native bundler
  binaries (rolldown/rollup `.node`) are blocked by the OS.
  - Therefore: Vite is pinned to **^7** (not 8), `@vitejs/plugin-react` to **^4**,
    and **`@rollup/wasm-node`** provides Rollup's WASM build so no native binary
    is loaded. Keep it this way unless SAC is disabled.
- `pnpm` settings live in `pnpm-workspace.yaml` (`allowBuilds:`), not the
  `pnpm` field in package.json (pnpm 11 ignores that field).

## Key design decisions
- **True redaction** is the product's whole point: never just draw a black box.
  Redaction goes through `PDFPage.applyRedactions(true, REDACT_IMAGE_REMOVE)` in
  `src/main/pdf-service.ts`, which deletes underlying text/image data.
  Verified: redacted text is gone from `toStructuredText()` output.
- `pdf-service.ts` imports **no Electron** → testable in plain Node.
- Coordinate space: redaction rects are PDF points, top-left origin (matches
  mupdf annotation rects and `page.getBounds()`). Renderer maps canvas px → pts
  by dividing by `zoom` (pixels-per-point).
- ESM throughout (`"type": "module"`). In the main process import Electron with
  **named imports** (`import { app } from 'electron'`); default-import is `undefined`.

## Gotchas observed
- `ELECTRON_RUN_AS_NODE=1` in some shells makes `electron` resolve to the npm
  path stub (not the built-in module) → `app` is undefined. Unset it to run GUI.
  (Not present in a normal user terminal.)
