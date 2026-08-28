import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out',
      rollupOptions: {
        input: {
          'main/index': resolve(__dirname, 'src/main/index.ts'),
          'mcp/stdio-bridge': resolve(__dirname, 'src/mcp/stdio-bridge.ts')
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
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
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
