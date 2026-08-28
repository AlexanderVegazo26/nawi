import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HOTKEYS } from '@shared/settings'
import type { Settings } from '@shared/settings'

/**
 * `settings.ts` resolves its path through `app.getPath('userData')` on every call,
 * so a mutable pointer here is enough to give each test its own directory. That
 * laziness is the property being relied on — a module-scope `const path = ...`
 * would make this mock useless.
 */
let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

type SettingsModule = typeof import('./settings')

/** Fresh module instance per test: `cache` and `writeChain` are module singletons. */
async function loadModule(): Promise<SettingsModule> {
  vi.resetModules()
  return import('./settings')
}

const settingsFile = (): string => join(userData, 'settings.json')

beforeEach(async () => {
  userData = await fs.mkdtemp(join(tmpdir(), 'nawi-settings-'))
})

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true })
})

describe('defaults', () => {
  it('returns the full default set when no file exists, without creating one', async () => {
    const settings = await loadModule()
    const s = await settings.getSettings()

    expect(s.version).toBe(1)
    expect(s.theme).toBe('system')
    expect(s.hotkeys).toEqual(DEFAULT_HOTKEYS)
    expect(s.maskedApps).toEqual([])
    expect(s.redactionRules).toEqual([])
    expect(s.captureDefaults.recordAudio).toBe(false)

    // Reading must not write. A first run that only reads leaves userData clean.
    await expect(fs.access(settingsFile())).rejects.toThrow()
  })

  it('defaults the six hotkeys to the accelerators main used to hardcode', async () => {
    const settings = await loadModule()
    const s = await settings.getSettings()
    expect(s.hotkeys).toEqual({
      'capture-region': 'CommandOrControl+Shift+1',
      'capture-fullscreen': 'CommandOrControl+Shift+2',
      'capture-window': 'CommandOrControl+Shift+3',
      'record-start': 'CommandOrControl+Shift+4',
      'record-stop': 'CommandOrControl+Shift+S',
      'show-main': 'CommandOrControl+Shift+0'
    })
  })
})

describe('round-trip', () => {
  it('persists to disk and reads back identically in a fresh process', async () => {
    const first = await loadModule()
    const saved = await first.updateSettings({
      theme: 'light',
      maskedApps: ['1Password', 'Bitwarden'],
      redactionRules: [{ id: 'jwt', label: 'JWT', pattern: 'eyJ[\\w-]+', enabled: true }]
    })
    expect(saved.theme).toBe('light')

    const onDisk: unknown = JSON.parse(await fs.readFile(settingsFile(), 'utf-8'))
    expect(onDisk).toEqual(saved)

    // Fresh module = cold cache, so this genuinely re-reads the file.
    const second = await loadModule()
    expect(await second.getSettings()).toEqual(saved)
  })

  it('writes atomically, leaving no .tmp file behind', async () => {
    const settings = await loadModule()
    await settings.updateSettings({ theme: 'dark' })
    expect(await fs.readdir(userData)).toEqual(['settings.json'])
  })

  it('serializes concurrent writes rather than losing one', async () => {
    const settings = await loadModule()
    await Promise.all([
      settings.updateSettings({ theme: 'dark' }),
      settings.updateSettings({ maskedApps: ['KeePass'] }),
      settings.updateSettings({ hotkeys: { 'show-main': 'CommandOrControl+Alt+9' } })
    ])

    const final = await (await loadModule()).getSettings()
    expect(final.theme).toBe('dark')
    expect(final.maskedApps).toEqual(['KeePass'])
    expect(final.hotkeys['show-main']).toBe('CommandOrControl+Alt+9')
  })
})

describe('merge on partial update', () => {
  it('changes one hotkey and leaves the other five alone', async () => {
    const settings = await loadModule()
    const next = await settings.updateSettings({
      hotkeys: { 'capture-region': 'CommandOrControl+Alt+R' }
    })

    expect(next.hotkeys['capture-region']).toBe('CommandOrControl+Alt+R')
    expect(next.hotkeys['capture-fullscreen']).toBe(DEFAULT_HOTKEYS['capture-fullscreen'])
    expect(next.hotkeys['show-main']).toBe(DEFAULT_HOTKEYS['show-main'])
  })

  it('leaves untouched top-level fields at their previous values', async () => {
    const settings = await loadModule()
    await settings.updateSettings({ theme: 'dark', maskedApps: ['Slack'] })
    const next = await settings.updateSettings({ captureDefaults: { recordAudio: true } })

    expect(next.theme).toBe('dark')
    expect(next.maskedApps).toEqual(['Slack'])
    expect(next.captureDefaults.recordAudio).toBe(true)
    // Sibling capture defaults survive a single-key patch.
    expect(next.captureDefaults.copyToClipboard).toBe(true)
  })

  it('rejects unknown actions, bad types and polluting keys from the renderer', async () => {
    const settings = await loadModule()
    const next = await settings.updateSettings({
      theme: 'neon',
      hotkeys: {
        'capture-region': 42,
        'not-an-action': 'CommandOrControl+X',
        __proto__: { polluted: true }
      },
      captureDefaults: { recordAudio: 'yes' },
      maskedApps: 'Slack',
      redactionRules: [{ id: 'ok', label: 'OK', pattern: 'a+' }, { id: 'broken' }]
    } as never)

    expect(next.theme).toBe('system')
    expect(next.hotkeys['capture-region']).toBe(DEFAULT_HOTKEYS['capture-region'])
    expect(Object.keys(next.hotkeys).sort()).toEqual(Object.keys(DEFAULT_HOTKEYS).sort())
    expect(next.captureDefaults.recordAudio).toBe(false)
    // A non-array maskedApps is ignored, not coerced into a list of characters.
    expect(next.maskedApps).toEqual([])
    // The rule missing `pattern` is dropped; the valid one survives and defaults enabled.
    expect(next.redactionRules).toEqual([{ id: 'ok', label: 'OK', pattern: 'a+', enabled: true }])

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(next.hotkeys)).toBe(Object.prototype)
  })
})

describe('corrupt file recovery', () => {
  it('returns defaults for unparseable JSON and does not destroy the file', async () => {
    const garbage = '{"theme": "dark", this is not json'
    await fs.writeFile(settingsFile(), garbage, 'utf-8')

    const settings = await loadModule()
    const s = await settings.getSettings()
    expect(s.theme).toBe('system')
    expect(s.hotkeys).toEqual(DEFAULT_HOTKEYS)

    // The user's bytes are the only copy of whatever they meant; reading must not
    // silently overwrite them.
    expect(await fs.readFile(settingsFile(), 'utf-8')).toBe(garbage)
  })

  it('repairs a structurally wrong but parseable file field-by-field', async () => {
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({ theme: 'light', hotkeys: 'nope', maskedApps: ['Vault'] }),
      'utf-8'
    )

    const settings = await loadModule()
    const s: Settings = await settings.getSettings()
    // Salvage what is valid rather than discarding the whole file.
    expect(s.theme).toBe('light')
    expect(s.maskedApps).toEqual(['Vault'])
    expect(s.hotkeys).toEqual(DEFAULT_HOTKEYS)
  })

  it('recovers a JSON scalar or null where an object was expected', async () => {
    await fs.writeFile(settingsFile(), 'null', 'utf-8')
    const s = await (await loadModule()).getSettings()
    expect(s.theme).toBe('system')
    expect(s.hotkeys).toEqual(DEFAULT_HOTKEYS)
  })
})

describe('change notification', () => {
  it('notifies listeners with the persisted value, and unsubscribes cleanly', async () => {
    const settings = await loadModule()
    const seen: Settings[] = []
    const off = settings.onSettingsChanged((s) => seen.push(s))

    const first = await settings.updateSettings({ theme: 'dark' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(first)

    off()
    await settings.updateSettings({ theme: 'light' })
    expect(seen).toHaveLength(1)
  })

  it('does not fail the write when a listener throws', async () => {
    const settings = await loadModule()
    settings.onSettingsChanged(() => {
      throw new Error('listener exploded')
    })

    await expect(settings.updateSettings({ theme: 'dark' })).resolves.toMatchObject({
      theme: 'dark'
    })
    expect(await (await loadModule()).getSettings()).toMatchObject({ theme: 'dark' })
  })
})
