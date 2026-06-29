import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Build stamp injected into the renderer so each build is uniquely identifiable
// without bumping the human version number. Computed at build/dev-start time so
// git is NOT required at runtime (the packaged .exe still shows it). Falls back
// gracefully when git is unavailable.
function gitHash(): string {
  try {
    const hash = execSync('git rev-parse --short HEAD').toString().trim()
    const dirty =
      execSync('git status --porcelain').toString().trim().length > 0
    return dirty ? `${hash}+` : hash // "+" = uncommitted changes in this build
  } catch {
    return 'nogit'
  }
}

function buildDate(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const BUILD_DEFINE = {
  __GIT_HASH__: JSON.stringify(gitHash()),
  __BUILD_DATE__: JSON.stringify(buildDate())
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    define: BUILD_DEFINE,
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react()],
    // mupdf ships a WASM file; keep it un-bundled / optimizable
    optimizeDeps: {
      exclude: ['mupdf']
    }
  }
})
