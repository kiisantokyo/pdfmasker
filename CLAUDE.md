# 究極の墨消し (pdfmasker) — project notes for Claude

製品名は **究極の墨消し**（npm/コードネームは `pdfmasker`）。
Desktop PDF **true-redaction** + page-editing app. UI is in Japanese.
Unrelated to other projects in this workspace (e.g. Mints Party Manager).

## Feature map (where things live)
- 真の墨消し / 単語クリック / 検索 / 候補抽出 / 閉じ代: すべて `src/main/pdf-service.ts`
  （Electron非依存・純mupdf）。IPCは `src/main/index.ts`、橋渡しは `src/preload/index.ts`、
  チャンネル名と型は `src/shared/types.ts`。
- 単語クリック: `wordAt`（snap("words")＋中央ライン水平スイープでテキスト取得）/ `findWord`（page.search）。
- なぞって選択: `selectText`（StructuredText.highlight でテキスト選択quad）。選択モードは
  `SelectMode='text'|'rect'`（既定 text）。ドラッグ中はIPCをthrottle(40ms)してライブプレビュー。
- ページ一覧の表示: pt寸法は分かりにくいので `PageSidebar` の `sizeLabel` で A4縦 等の用紙名に変換
  （許容±4mm、未一致は mm 表記）。
- 固有名詞・指示: `extractCandidates`（オフライン正規表現ヒューリスティック）/ `countTerms` / `findTerms`。
  UIは `components/RedactByTermsModal.tsx`。Markdown解析は同ファイル内 `parseMarkdown`。
  **方針: アプリは外部送信しない。** 高精度が要るときはユーザーが外部AIで作った指示(Markdown)を貼り付ける。
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
