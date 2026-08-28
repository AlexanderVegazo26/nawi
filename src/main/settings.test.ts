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

describe('regressions found in M0 review', () => {
  it('a cold read that resolves after a write does not revert it', async () => {
    // The read-and-publish in getSettings is not atomic: a caller can enter with
    // an empty cache, suspend on readFile, and then publish its now-stale bytes
    // over a write that landed in the meantime. The next merge builds on that
    // stale base and silently undoes the user's change.
    const settings = await loadModule()

    const coldRead = settings.getSettings()
    const written = await settings.updateSettings({ theme: 'light' })
    await coldRead

    expect(written.theme).toBe('light')
    // The cache must agree with disk, not with the pre-write bytes.
    expect((await settings.getSettings()).theme).toBe('light')

    // The real damage showed up on the *next* write, which merged onto the stale base.
    await settings.updateSettings({ maskedApps: ['1Password'] })
    const onDisk = JSON.parse(await fs.readFile(settingsFile(), 'utf-8')) as Settings
    expect(onDisk.theme).toBe('light')
    expect(onDisk.maskedApps).toEqual(['1Password'])
  })

  it('concurrent cold reads parse the file once and agree', async () => {
    await fs.writeFile(settingsFile(), JSON.stringify({ version: 1, theme: 'dark' }), 'utf-8')
    const settings = await loadModule()

    const [a, b, c] = await Promise.all([
      settings.getSettings(),
      settings.getSettings(),
      settings.getSettings()
    ])
    // Same object, not merely equal values — proves the in-flight read was shared.
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a.theme).toBe('dark')
  })

  it('a failed write leaves the queue usable and the cache honest', async () => {
    const settings = await loadModule()
    await settings.updateSettings({ theme: 'dark' })

    // Make rename fail exactly once, simulating a transient FS error mid-write.
    const rename = fs.rename
    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EPERM'))
    await expect(settings.updateSettings({ theme: 'light' })).rejects.toThrow('EPERM')
    spy.mockRestore()
    expect(fs.rename).toBe(rename)

    // The queue must not be poisoned by the rejection: the next write still lands.
    await expect(settings.updateSettings({ theme: 'light' })).resolves.toMatchObject({
      theme: 'light'
    })
    const onDisk = JSON.parse(await fs.readFile(settingsFile(), 'utf-8')) as Settings
    expect(onDisk.theme).toBe('light')
    // And the failed write must not have left 'light' cached as though it persisted.
    expect((await settings.getSettings()).theme).toBe('light')
  })

  it('rejects a chord already claimed by another action instead of silently unbinding one', async () => {
    // A global accelerator goes to whoever registers it first; the loser just
    // fails. Nothing surfaces that, so the user loses a hotkey with no signal.
    const settings = await loadModule()
    const region = DEFAULT_HOTKEYS['capture-region']

    const saved = await settings.updateSettings({ hotkeys: { 'record-stop': region } })

    // The action the user just asked for wins the chord...
    expect(saved.hotkeys['record-stop']).toBe(region)
    // ...and the displaced one must not still be claiming it.
    expect(saved.hotkeys['capture-region']).not.toBe(region)

    const chords = Object.values(saved.hotkeys).filter((c) => c !== '')
    expect(new Set(chords).size).toBe(chords.length)
  })
})

/* ------------------------------------------------------------------------- *
 * F6 — the UX-AGT.3 kill switch must survive the loss of the file recording it.
 * ------------------------------------------------------------------------- */

describe('agent access pause is fail-closed against settings loss', () => {
  it('reads as NOT paused when no settings file exists, because that is first run', async () => {
    // Deliberately NOT fail-closed: a missing file is indistinguishable from a
    // first run, and pausing here would disable agent access for every new
    // install. It would also buy little — a process that can delete the file can
    // equally write `paused: false` into it. See the read path's comment.
    const settings = await loadModule()
    expect((await settings.getSettings()).agentAccessPaused).toBe(false)
  })

  it('reads as PAUSED when the file is unparseable', async () => {
    await fs.writeFile(settingsFile(), '{ this is not json', 'utf-8')
    const settings = await loadModule()
    expect((await settings.getSettings()).agentAccessPaused).toBe(true)
  })

  it('reads as PAUSED when the file is truncated to nothing', async () => {
    await fs.writeFile(settingsFile(), '', 'utf-8')
    const settings = await loadModule()
    expect((await settings.getSettings()).agentAccessPaused).toBe(true)
  })

  it('reads as PAUSED on an I/O failure that is not a parse failure', async () => {
    // A directory where the file should be gives EISDIR. This proves the branch
    // is on the error CODE and not merely on "JSON.parse threw" — EACCES and a
    // decode failure take the same path.
    await fs.mkdir(settingsFile())
    const settings = await loadModule()
    expect((await settings.getSettings()).agentAccessPaused).toBe(true)
  })

  it('still reads as NOT paused for a file predating the field', async () => {
    // The upgrade property the flag was named for: a settings file written
    // before `agentAccessPaused` existed must not read as paused and silently
    // break a working agent setup. Only *unreadability* fails closed.
    await fs.writeFile(settingsFile(), JSON.stringify({ version: 1, theme: 'dark' }), 'utf-8')
    const settings = await loadModule()
    const s = await settings.getSettings()
    expect(s.agentAccessPaused).toBe(false)
    // …and the rest of the file was still honoured, so this is not a wholesale
    // fallback masquerading as a merge.
    expect(s.theme).toBe('dark')
  })

  it('honours a legitimately written false', async () => {
    await fs.writeFile(
      settingsFile(),
      JSON.stringify({ version: 1, agentAccessPaused: false }),
      'utf-8'
    )
    const settings = await loadModule()
    expect((await settings.getSettings()).agentAccessPaused).toBe(false)
  })

})
