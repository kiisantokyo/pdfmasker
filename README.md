# 究極の墨消し (PDF Masker)

A desktop app for **true redaction** and page editing of PDF files.
（製品名：**究極の墨消し** / コードネーム：pdfmasker）

Unlike tools that just draw a black box over sensitive text (leaving the
underlying text copy‑/extractable), PDF Masker uses mupdf's
`applyRedactions()` to **physically remove the text and image data** beneath
each marked region.

## Features

- 🖍️ **True redaction** — mark areas; underlying text/images are removed, not just covered.
- ✏️ **Two selection modes** — drag *over text* (snaps to words/lines) or draw a freehand rectangle (for images/logos). Toggle in the toolbar.
- 🖱️ **Click a word to redact** — choose "this word only" or "every occurrence in the document".
- 🤖 **AI round-trip workflow** — generate a tailored prompt (pick categories + free-text), copy it to the clipboard, run it in ChatGPT/Gemini yourself with the PDF, then paste the result back (JSON or markdown) and review/apply. The app itself never sends data anywhere; you control the upload.
- 🧾 **Offline entity extraction** — auto-extract likely proper nouns & PII via offline heuristics, no AI needed.
- 🔠 **OCR for scanned PDFs** — on opening a text-less PDF, offer to OCR it (Tesseract.js, jpn+eng) so search / click-word / extraction work; redaction still physically removes the image area. The page image is processed locally (first run downloads the language model).
- 📐 **Binding margin** — shrink page content to leave a staple/binding margin on any edge.
- 📂 **Open via button or drag & drop** — drop a PDF anywhere on the window.
- 🗂️ **Thumbnail sidebar** — real page thumbnails with checkboxes; click to navigate, Shift-click for range-check, Ctrl-click to toggle; bulk-delete / bulk-rotate selected pages.
- 📄 **Page editing** — delete, reorder (move ◀/▶), and rotate pages.
- ↶ **Undo / Redo** (Ctrl+Z / Ctrl+Y) for every action — marks, applied redaction, page delete/move/rotate, binding margin (via the mupdf journal).
- 📜 **Continuous vertical scroll** — all pages in one scrollable view; edit/redact any page without switching. Lazy-rendered with current-page tracking.
- 🔍 Zoomable page viewer (Ctrl + wheel) with per-page pending-redaction badges.
- 💾 Save in place or Save As.
- 🔒 Fully offline — PDFs never leave your machine.

## Tech stack

| Layer        | Choice                                  |
| ------------ | --------------------------------------- |
| Shell        | Electron 42                             |
| Build        | electron-vite + Vite 7 + React 19 + TS  |
| PDF engine   | [mupdf.js](https://www.npmjs.com/package/mupdf) (WASM) |

> **Build note:** This machine has Windows **Smart App Control** enabled, which
> blocks unsigned native bundler binaries. We therefore pin Vite 7 and use
> `@rollup/wasm-node` (the WASM build of Rollup). Do not "upgrade" to Vite 8 /
> remove `@rollup/wasm-node` unless SAC is disabled — the native build will be
> blocked by the OS.

## Architecture

```
src/
  shared/types.ts      IPC channel names + shared data types
  main/
    index.ts           Electron main: window + IPC handlers + file I/O
    pdf-service.ts      Core PDF engine (pure mupdf, no Electron — unit-testable)
  preload/
    index.ts           contextBridge: exposes window.pdf API
    index.d.ts         Window typing
  renderer/
    index.html
    src/
      App.tsx          App state + orchestration
      components/      Toolbar, PageSidebar, PageCanvas (draw redactions)
      lib/api.ts       window.pdf accessor
```

All PDF processing happens in the **main process** (Node + mupdf). The renderer
displays rendered page PNGs and sends redaction rectangles / page operations
over IPC. Redaction coordinates are in PDF points (top-left origin), matching
mupdf's annotation space.

## Development

```bash
pnpm dev          # run with HMR
pnpm typecheck    # tsc for node (main/preload) + web (renderer)
pnpm build        # production build into out/
pnpm start        # preview the production build
pnpm package      # build a distributable (electron-builder)
```

## Status

Implemented: open (button + drag&drop), render, Ctrl+wheel zoom, true redaction,
click-word redaction (single / all occurrences), offline entity extraction +
markdown-instruction import, binding margin, delete/move/rotate page, save / save as.

Not yet: undo/redo, manual rect deletion, text/stamp annotations, OCR for
scanned PDFs, password-protected PDFs, higher-accuracy proper-noun detection
(e.g. a bundled morphological analyzer like kuromoji).

## License

Copyright © 2026 弁護士法人コスモポリタン法律事務所 (Cosmopolitan Law Office)

This program is **free software**: you can redistribute it and/or modify it
under the terms of the **GNU Affero General Public License, version 3 or
later (AGPL-3.0-or-later)**, as published by the Free Software Foundation.
The full license text is in [`LICENSE`](./LICENSE).

This application incorporates **MuPDF** as its PDF engine, which is licensed
under the AGPL-3.0. Because of that copyleft, the application as a whole is
distributed under the AGPL-3.0-or-later, and its **complete corresponding
source code is available at
<https://www.cosmo-law.jp/pdfmasker/#source>**.

Third-party open-source components (Electron, React, Tesseract.js, and others)
and their license notices are listed in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
