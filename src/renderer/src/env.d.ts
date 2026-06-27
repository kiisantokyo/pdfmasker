/// <reference types="vite/client" />

// Build stamp injected at compile time via Vite `define` (electron.vite.config.ts).
declare const __GIT_HASH__: string
declare const __BUILD_DATE__: string
