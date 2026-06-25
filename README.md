# 究極の墨消し (PDF Masker)

A desktop app for **true redaction** and page editing of PDF files.
（製品名：**究極の墨消し** / コードネーム：pdfmasker）

Unlike tools that just draw a black box over sensitive text (leaving the
underlying text copy‑/extractable), PDF Masker uses mupdf's
`applyRedactions()` to **physically remove the text and image data** beneath
each marked region.

## Features

- 🖍️ **True redaction** — drag to mark areas; underlying text/images are removed, not just covered.
- 📂 **Open via button or drag & drop** — drop a PDF anywhere on the window.
- 📄 **Page editing** — delete, reorder (move ◀/▶), and rotate pages.
- 🔍 Zoomable page viewer with per-page pending-redaction badges.
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

MVP. Implemented: open, render, true redaction, delete/move/rotate page,
save / save as. Not yet: multi-rect undo, text/stamp annotations, OCR,
password-protected PDFs.
