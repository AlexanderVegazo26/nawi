import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Inlined into the CLI so `nawi --version` cannot drift from the
    // package, and so the packaged CLI has no package.json path to resolve at
    // runtime from inside app.asar.unpacked. See src/cli/globals.d.ts.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      outDir: 'out',
      rollupOptions: {
        input: {
          'main/index': resolve(__dirname, 'src/main/index.ts'),
          'mcp/stdio-bridge': resolve(__dirname, 'src/mcp/stdio-bridge.ts'),
          // The `nawi` CLI. Built here rather than in its own config
          // because it shares `src/mcp/endpoint.ts` with the bridge and has the
          // same shape: plain node, no electron import, externalized deps.
          'cli/index': resolve(__dirname, 'src/cli/index.ts')
        }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preload scripts cannot be ES modules, and the package is
        // type: module — so emit CommonJS with an explicit .js name.
        output: { format: 'cjs', entryFileNames: 'index.js' }
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          // ARCHITECTURE.md §1.1's third renderer entry: the hidden window that
          // owns MediaRecorder, plus the always-on-top recording HUD.
          recorder: resolve(__dirname, 'src/renderer/recorder.html'),
          hud: resolve(__dirname, 'src/renderer/hud.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
