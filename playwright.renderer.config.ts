import { defineConfig, devices } from '@playwright/test'

/**
 * The renderer suite: the main window's UI in Playwright Chromium, served by
 * Vite with a stub preload (e2e-renderer/). No Electron, no display — it runs
 * wherever the CDP integration suite does, including the CI verify job.
 *
 *   npm run test:renderer
 *
 * The Electron E2E suite (playwright.config.ts, e2e/) still owns everything
 * that needs main: IPC, capture, recording, the MCP endpoint.
 */
const PORT = 4417

export default defineConfig({
  testDir: './e2e-renderer',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: '.test-report/renderer.json' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `npx vite --config e2e-renderer/vite.config.ts --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 60_000
  }
})
