import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Unit tests only — the Playwright E2E suite drives the packaged app and stays
 * where it is. Aliases mirror electron.vite.config.ts so a module under test
 * resolves `@shared`/`@` the same way it does in the real build.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // e2e/ is Playwright's; running it under Vitest would load a different runner's globals.
    exclude: ['e2e/**', 'node_modules/**', 'out/**', 'release/**']
  }
})
