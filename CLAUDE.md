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
- Ctrl+ホイールズーム: `components/PageCanvas.tsx`（passive:false の wheel リスナ）。

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
