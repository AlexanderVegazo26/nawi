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
    // `.tsx` too: some PRD-002 state requirements ("this surface renders a
    // skeleton, never a spinner") are claims about rendered output, and the
    // only honest way to check them without a browser is to render the
    // component. `react-dom/server` does that in a node environment with no new
    // dependency. Interaction tests (clicks, IPC replies, broadcasts) opt into a
    // DOM per file with `// @vitest-environment jsdom` + Testing Library, e.g.
    // src/renderer/components/agent-access-toggle.test.tsx.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    // e2e/ is Playwright's; running it under Vitest would load a different runner's globals.
    exclude: ['e2e/**', 'node_modules/**', 'out/**', 'release/**']
  }
})
