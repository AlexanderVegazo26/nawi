import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Electron tests share one app instance and mutate a library, so they must
  // run in order within the file and never in parallel across workers.
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']]
})
