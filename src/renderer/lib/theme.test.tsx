import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Settings, ThemePreference } from '@shared/settings'
import type { IpcResult } from '@shared/types'

/**
 * The theme store against a fake main process whose replies the test releases
 * one at a time, so the IPC orderings that raced on CI (a broadcast or an initial
 * read answering *after* a newer click) are reproduced exactly instead of hoped for.
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const ok = (theme: ThemePreference): IpcResult<Settings> =>
  ({ ok: true, value: { theme } as Settings }) as IpcResult<Settings>

/** Lets every already-resolved promise continuation run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let broadcast: (s: Settings) => void
let reads: Deferred<IpcResult<Settings>>[]
let writes: Deferred<IpcResult<Settings>>[]
let dataset: Record<string, string>
let theme: typeof import('./theme')

beforeEach(async () => {
  reads = []
  writes = []
  dataset = {}
  vi.stubGlobal('document', { documentElement: { dataset } })
  vi.stubGlobal('window', {
    api: {
      getSettings: () => {
        const d = deferred<IpcResult<Settings>>()
        reads.push(d)
        return d.promise
      },
      updateSettings: () => {
        const d = deferred<IpcResult<Settings>>()
        writes.push(d)
        return d.promise
      },
      onSettingsChanged: (cb: (s: Settings) => void) => {
        broadcast = cb
        return () => undefined
      }
    }
  })
  // The store is module state; a fresh copy per test keeps the tests independent.
  vi.resetModules()
  theme = await import('./theme')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** What the user would see: the store's value and the painted attribute. */
function shown(): { store: ThemePreference; painted: string } {
  return { store: theme.getThemePreference(), painted: dataset.theme ?? 'system' }
}

async function synced(initial: ThemePreference): Promise<void> {
  const started = theme.startThemeSync()
  reads[0].resolve(ok(initial))
  await started
}

describe('theme store — stale settings:changed broadcasts', () => {
  it('a late broadcast of an older write does not undo a newer click', async () => {
    await synced('system')

    const first = theme.setThemePreference('light')
    const second = theme.setThemePreference('dark')
    expect(shown(), 'two clicks paint the second one immediately').toEqual({ store: 'dark', painted: 'dark' })

    // Main applies and broadcasts in order; the first click's broadcast arrives
    // while the second click is still in flight.
    broadcast({ theme: 'light' } as Settings)
    writes[0].resolve(ok('light'))
    await flush()
    expect(shown(), 'the first click\'s broadcast/reply must not repaint "light" over "dark"').toEqual({
      store: 'dark',
      painted: 'dark'
    })

    broadcast({ theme: 'dark' } as Settings)
    writes[1].resolve(ok('dark'))
    await Promise.all([first, second])
    expect(shown()).toEqual({ store: 'dark', painted: 'dark' })
  })

  it('a broadcast with no local write in flight is applied (another window, an agent)', async () => {
    await synced('system')
    broadcast({ theme: 'dark' } as Settings)
    expect(shown()).toEqual({ store: 'dark', painted: 'dark' })
  })
})

describe('theme store — reads and writes that answer late', () => {
  it('an initial read answered after a click does not overwrite the click', async () => {
    const started = theme.startThemeSync()
    const click = theme.setThemePreference('light')
    reads[0].resolve(ok('system'))
    await started
    expect(shown(), 'startup read of "system" must not revert the "light" click').toEqual({
      store: 'light',
      painted: 'light'
    })
    writes[0].resolve(ok('light'))
    await click
    expect(shown()).toEqual({ store: 'light', painted: 'light' })
  })

  it('when the last write settles, the value main saved wins', async () => {
    await synced('system')
    const click = theme.setThemePreference('dark')
    writes[0].resolve(ok('light'))
    await click
    expect(shown(), 'main saved "light"; the UI must not keep claiming "dark"').toEqual({
      store: 'light',
      painted: 'light'
    })
  })

  it('a failed write falls back to what is on disk', async () => {
    await synced('system')
    const click = theme.setThemePreference('dark')
    writes[0].resolve({ ok: false, error: 'EACCES' })
    await flush()
    reads[1].resolve(ok('system'))
    await click
    expect(shown(), 'a write that did not persist must not stay painted').toEqual({
      store: 'system',
      painted: 'system'
    })
  })
})

describe('ThemeToggle', () => {
  it('names the current theme and the next one from the shared store', async () => {
    await synced('dark')
    const { ThemeToggle } = await import('../components/ThemeToggle')
    const html = renderToStaticMarkup(<ThemeToggle />)
    expect(html).toContain('Theme: Dark. Switch to Match system.')
  })
})
