/**
 * Serves the main-window renderer on its own, in a plain browser, for the
 * renderer a11y/responsive suite (playwright.renderer.config.ts).
 *
 * Same root, aliases and plugins as the `renderer` block of
 * electron.vite.config.ts. There is no preload here: every spec installs a
 * stub `window.api` (e2e-renderer/api-stub.ts) before the page loads, so the
 * suite needs neither Electron nor a display and runs anywhere Playwright
 * Chromium does.
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const repo = resolve(import.meta.dirname, '..')

export default defineConfig({
  root: resolve(repo, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(repo, 'src/renderer'),
      '@shared': resolve(repo, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', strictPort: true },
  // Vite's dependency optimiser rewrites node_modules/.vite on the first
  // request and reloads the page mid-test; prebundle up front instead.
  optimizeDeps: { entries: ['index.html'] },
  logLevel: 'warn'
})
