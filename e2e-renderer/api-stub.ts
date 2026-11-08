/**
 * A stand-in for the preload bridge (src/preload/index.ts) so the renderer can
 * run in a plain browser page.
 *
 * Every NawiApi method exists: `on*` subscriptions return a no-op unsubscribe,
 * everything else resolves `{ ok: true, value }` with the value from
 * `answers` (or null). Nothing here talks to a main process, so a view that
 * needs a live answer the stub does not give shows its empty/default state —
 * which is the state these specs check.
 */
import type { Page } from '@playwright/test'
import { idleStatus } from '../src/shared/recording'
import { defaultSettings } from '../src/shared/settings'
import type { AgentAccessState, DiskPressure, LibraryItem, PermissionState, Settings } from '../src/shared/types'

export type Theme = 'light' | 'dark'

export interface StubOptions {
  theme: Theme
  items?: LibraryItem[]
}

/** Two library items with fixed ids/dates, so every run renders the same list. */
export function sampleItems(): LibraryItem[] {
  const base = {
    captureKind: 'fullscreen' as const,
    annotations: null,
    durationMs: null
  }
  return [
    {
      ...base,
      id: 'item-shot-1',
      name: 'Checkout page',
      kind: 'image',
      filePath: '/tmp/nawi-fixture/item-shot-1.png',
      width: 1440,
      height: 900,
      size: 214_000,
      createdAt: '2026-01-15T10:00:00.000Z'
    },
    {
      ...base,
      id: 'item-video-1',
      name: 'Sign-up flow',
      kind: 'video',
      captureKind: 'window',
      filePath: '/tmp/nawi-fixture/item-video-1.webm',
      width: 1280,
      height: 720,
      size: 3_400_000,
      durationMs: 42_000,
      createdAt: '2026-01-14T09:30:00.000Z'
    }
  ] as LibraryItem[]
}

/** Runs in the page before any app script: defines `window.api`. */
function installApi(answers: Record<string, unknown>): void {
  const ok = (value: unknown): Promise<unknown> => Promise.resolve({ ok: true, value })
  const target: Record<string, unknown> = {}
  ;(window as unknown as { api: unknown }).api = new Proxy(target, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined
      if (/^on[A-Z]/.test(prop)) return () => () => undefined
      if (prop === 'pathForFile') return () => ''
      if (prop === 'commitRegion' || prop === 'cancelRegion') return () => undefined
      return () => ok(prop in answers ? answers[prop] : null)
    }
  })
}

export async function stubApi(page: Page, opts: StubOptions): Promise<void> {
  const settings: Settings = { ...defaultSettings(), theme: opts.theme }
  const answers: Record<string, unknown> = {
    getSettings: settings,
    updateSettings: settings,
    listLibrary: opts.items ?? [],
    listRecoverableRecordings: [],
    listSources: [],
    listDisplays: [],
    listAudioInputs: [],
    getAgentAccess: {
      paused: false,
      endpoint: { port: 47123, url: 'http://127.0.0.1:47123/mcp' }
    } satisfies AgentAccessState,
    getScreenPermission: {
      platform: 'linux',
      screen: 'granted',
      settingsPath: '',
      relaunchMayBeRequired: false
    } satisfies PermissionState,
    getRecordingStatus: idleStatus(),
    getDiskPressure: {
      known: true,
      freeBytes: 200e9,
      estimatedBytes: 300e6,
      estimateMinutes: 5,
      low: false
    } satisfies DiskPressure
  }
  await page.addInitScript(installApi, answers)
}
