import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecResult } from './doctor'
import { canvas, encodePng } from './fixtures/make-png'
import { parseUiDump } from './hierarchy'
import { screenIdOf } from './study'
import { discardExploration, exploreLiveApp, screenshotSpool, writeExploration, type ExploreLiveHost, type LiveExploreRequest } from './explore-live'
import type { ExploreResult } from './explore'

/**
 * mobile_explore's engine (roadmap M3c2) against a simulated device: how it picks the device and the app (like
 * mobile_study), that it hands the budgets and never-press words to the explorer, that a secret typed into the app
 * never comes back, and how a graph is saved. The explorer itself is tested in explore.test.ts.
 */

const PKG = 'dev.nawi.mini'
const SECRET = 'hunter2-typed'
let root: string
let sdkDir: string
let calls: string[][]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-explore-live-'))
  mkdirSync(join(root, 'home'))
  sdkDir = join(root, 'sdk')
  const adb = join(sdkDir, 'platform-tools', 'adb')
  mkdirSync(join(adb, '..'), { recursive: true })
  writeFileSync(adb, '#!/bin/sh\n')
  chmodSync(adb, 0o755)
  calls = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const WHITE_PNG = encodePng(canvas(1080, 2400, [255, 255, 255]), { alpha: true })
type Box = [number, number, number, number]
interface Control {
  id: string
  text: string
  bounds: Box
  go?: string
  cls?: string
}
const button = (id: string, text: string, bounds: Box, go?: string): Control => ({ id, text, bounds, go, cls: 'android.widget.Button' })

/** A two-screen app: home (Settings opens settings; Delete account would destroy) and settings. */
function app(greeting: string): Record<string, { pkg: string; controls: Control[] }> {
  return {
    home: {
      pkg: PKG,
      controls: [
        { id: 'greeting', text: greeting, bounds: [40, 100, 1040, 250], cls: 'android.widget.TextView' },
        button('settings', 'Settings', [40, 300, 1040, 450], 'settings'),
        button('delete_account', 'Delete account', [40, 600, 1040, 750], 'gone')
      ]
    },
    settings: { pkg: PKG, controls: [{ id: 'version', text: 'Version 2', bounds: [40, 100, 1040, 250], cls: 'android.widget.TextView' }] },
    gone: { pkg: PKG, controls: [{ id: 'bye', text: 'Account deleted', bounds: [40, 100, 1040, 250], cls: 'android.widget.TextView' }] },
    launcher: { pkg: 'com.android.launcher3', controls: [] },
    shade: { pkg: 'com.android.systemui', controls: [{ id: 'clock', text: '12:00', bounds: [0, 0, 300, 80], cls: 'android.widget.TextView' }] }
  }
}

function dumpOf(screen: { pkg: string; controls: Control[] }): string {
  const nodes = screen.controls
    .map(
      (c) =>
        `<node index="0" text="${c.text}" resource-id="${screen.pkg}:id/${c.id}" class="${c.cls}" package="${screen.pkg}" content-desc="" checkable="false" checked="false" clickable="${c.go !== undefined}" enabled="true" focusable="${c.go !== undefined}" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" hint="" bounds="[${c.bounds[0]},${c.bounds[1]}][${c.bounds[2]},${c.bounds[3]}]"/>`
    )
    .join('')
  return (
    'UI hierchary dumped to: /data/local/tmp/nawi-window-1.xml\n' +
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${screen.pkg}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" hint="" bounds="[0,0][1080,2400]">${nodes}</node></hierarchy>`
  )
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, error: 'failed' })

interface Sim {
  devices: Array<{ serial: string; avd?: string }>
  /** The screen in front at the start (default home). */
  start?: string
  greeting?: string
  /** The on-screen keyboard is up and stays up (Back does not hide it). */
  keyboard?: boolean
}

/** A device running the app: taps go where the control under the point leads, Back pops the screen stack. */
function simHost(sim: Sim): ExploreLiveHost {
  const kvm = join(root, 'kvm')
  writeFileSync(kvm, '')
  const screens = app(sim.greeting ?? 'Hello')
  const stack = [sim.start ?? 'home']
  let clock = 0
  return {
    env: { ANDROID_HOME: sdkDir },
    platform: 'linux',
    arch: 'x64',
    home: join(root, 'home'),
    kvmPath: kvm,
    now: () => clock,
    delay: async (ms) => {
      clock += ms
    },
    exec: async (file, args) => {
      calls.push([file.replace(sdkDir, '<sdk>'), ...args])
      if (args[0] === 'version') return ok('Android Debug Bridge version 1.0.41\n')
      if (args[0] === 'devices') return ok(`List of devices attached\n${sim.devices.map((d) => `${d.serial}\tdevice`).join('\n')}\n`)
      const d = sim.devices.find((x) => x.serial === args[1])
      if (args[0] !== '-s' || !d) return failed(`unexpected ${args.join(' ')}`)
      if (args[2] === 'emu') return d.avd ? ok(`${d.avd}\nOK\n`) : failed('not an emulator')
      const line = args[3]
      if (line.startsWith('getprop ro.build')) return ok('35\nx86_64\n')
      if (line.startsWith('uiautomator dump')) return ok(dumpOf(screens[stack[stack.length - 1]]))
      if (line === 'wm density') return ok('Physical density: 420\n')
      if (line.startsWith('dumpsys input_method')) return ok(`mInputShown=${sim.keyboard === true}\n`)
      if (line.startsWith('cmd package resolve-activity')) return ok('priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.launcher3/.uioverrides.QuickstepLauncher\n')
      if (line === 'input keyevent KEYCODE_BACK') {
        if (stack.length > 1) stack.pop()
        else stack[0] = 'launcher'
        return ok()
      }
      const tap = /^input tap (\d+) (\d+)$/.exec(line)
      if (tap) {
        const [x, y] = [Number(tap[1]), Number(tap[2])]
        const hit = screens[stack[stack.length - 1]].controls.find((c) => c.go && x >= c.bounds[0] && x < c.bounds[2] && y >= c.bounds[1] && y < c.bounds[3])
        if (hit?.go) stack.push(hit.go)
        return ok()
      }
      return failed(`unexpected shell ${line}`)
    },
    execBinary: async (file, args) => {
      calls.push([file.replace(sdkDir, '<sdk>'), ...args])
      return { code: 0, stdout: WHITE_PNG, stderr: '' }
    }
  }
}

const deviceCommands = (): string[] => calls.filter((c) => c[1] === '-s').map((c) => c.slice(3).join(' '))
const idOf = (name: string, greeting = 'Hello'): string => screenIdOf(parseUiDump(dumpOf(app(greeting)[name])))
const explore = (req: LiveExploreRequest, sim: Sim = { devices: [{ serial: 'R5CT1234' }] }) => exploreLiveApp(req, simHost(sim))

describe('exploreLiveApp', () => {
  it('explores the app in front of the only device: home -> settings, Delete account left alone', async () => {
    const r = await explore({})
    expect(r.ok, `explore failed: ${r.error} / ${r.fix}`).toBe(true)
    expect(r, 'device, the app in front and its density').toMatchObject({ target: { kind: 'device', name: 'R5CT1234', serial: 'R5CT1234', api: 35 }, package: PKG, density_dpi: 420 })
    const x = r.exploration
    expect(x?.start, 'start screen id').toBe(idOf('home'))
    expect(x?.screens.map((s) => [s.screen_id, s.depth, s.path.map((p) => p.label)]), 'screens found').toEqual([
      [idOf('home'), 0, []],
      [idOf('settings'), 1, ['Settings']]
    ])
    expect(x?.edges.map((e) => [e.from, e.to, e.tap.label, e.result]), 'edges').toEqual([[idOf('home'), idOf('settings'), 'Settings', 'screen']])
    expect(x?.skipped.map((k) => [k.label, k.reason]), 'controls left alone').toEqual([['Delete account', 'never_press']])
    expect(x?.stopped).toBe('done')
    expect(x?.screens.every((s) => s.screenshot !== null && s.study.findings.every((f) => f.kind !== undefined)), 'a screenshot per screen').toBe(true)
  })

  it('sends only reads, taps and Back: no install, launch, settings change or boot', async () => {
    await explore({}, { devices: [{ serial: 'emulator-5554', avd: 'Pixel_9' }] })
    const allowed = /^(shell getprop ro\.build|shell uiautomator dump |shell wm density$|emu avd name$|exec-out screencap -p$|shell dumpsys input_method \| grep -m 1 mInputShown$|shell input tap \d+ \d+$|shell input keyevent KEYCODE_BACK$|shell cmd package resolve-activity --brief -a android\.intent\.action\.MAIN -c android\.intent\.category\.HOME$)/
    const sent = deviceCommands()
    expect(sent.filter((c) => !allowed.test(c)), `unexpected adb commands in ${JSON.stringify(sent)}`).toEqual([])
    expect(sent.filter((c) => c.startsWith('shell input tap')), 'one tap: Settings (Delete account is never pressed)').toEqual(['shell input tap 540 375'])
  })

  it('adds the never_press words to the built-in list', async () => {
    const r = await explore({ neverPress: ['settings'] })
    expect(r.exploration?.screens.map((s) => s.screen_id), 'only the start screen').toEqual([idOf('home')])
    expect(r.exploration?.skipped.map((k) => [k.label, k.reason])).toEqual([
      ['Settings', 'never_press'],
      ['Delete account', 'never_press']
    ])
    expect(deviceCommands().filter((c) => c.startsWith('shell input tap')), 'nothing tapped').toEqual([])
  })

  it('passes the budgets through: max_depth 0 studies the start screen and taps nothing', async () => {
    const r = await explore({ maxDepth: 0 })
    expect(r.exploration?.screens.length).toBe(1)
    expect(r.exploration?.taps).toBe(0)
    const tight = await explore({ maxScreens: 1 })
    expect(tight.exploration?.stopped, 'max_screens 1 stops at the first new screen').toBe('max_screens')
  })

  it('scrubs a secret typed into the app from every study and keeps no screenshot of a screen showing it', async () => {
    const r = await explore({ secrets: { pw: SECRET } }, { devices: [{ serial: 'R5CT1234' }], greeting: `Hi ${SECRET}` })
    expect(r.ok, `explore failed: ${r.error}`).toBe(true)
    expect(JSON.stringify(r.exploration, (_k, v) => (v instanceof Uint8Array ? `<png ${v.length}>` : v)), 'the secret value appears nowhere in the result').not.toContain(SECRET)
    const home = r.exploration?.screens[0]
    expect(home?.study.elements.some((e) => e.text === 'Hi ${secret.pw}'), 'replaced by its placeholder').toBe(true)
    expect(home?.screenshot, 'no screenshot of a screen that shows the secret').toBeNull()
    expect(home?.screenshot_error).toMatch(/secret value/)
    expect(r.exploration?.screens[1].screenshot, 'settings does not show it: screenshot kept').not.toBeNull()
  })

  it('does not explore when the named app is not in front, and says to open it', async () => {
    const r = await explore({ package: 'dev.other.app' })
    expect(r).toMatchObject({ ok: false, package: 'dev.other.app' })
    expect(r.error).toMatch(/dev\.other\.app is not in front/)
    expect(r.fix).toMatch(/mobile-open .* --target R5CT1234/)
    expect(r.exploration?.stopped).toBe('not_in_app')
    expect(deviceCommands().filter((c) => c.startsWith('shell input')), 'nothing tapped').toEqual([])
  })

  it("does not explore when only Android's own windows are on screen", async () => {
    const r = await explore({}, { devices: [{ serial: 'R5CT1234' }], start: 'shade' })
    expect(r).toMatchObject({ ok: false, package: null, exploration: null })
    expect(r.error).toMatch(/only Android's own windows/)
    expect(r.fix).toMatch(/package/)
  })

  it('does not explore the home screen when no app is in front (each tap would launch another app)', async () => {
    const r = await explore({}, { devices: [{ serial: 'R5CT1234' }], start: 'launcher' })
    expect(r).toMatchObject({ ok: false, package: null, exploration: null })
    expect(r.error).toBe('the home screen (com.android.launcher3) is in front, not an app')
    expect(r.fix).toMatch(/mobile-open .* --target R5CT1234/)
    expect(deviceCommands().filter((c) => c.startsWith('shell input')), 'nothing tapped').toEqual([])
  })

  it('says it was cancelled, not that the device is broken, when cancelled before the first screen', async () => {
    const stop = new AbortController()
    stop.abort()
    const r = await explore({ signal: stop.signal }, { devices: [{ serial: 'R5CT1234' }], keyboard: true })
    expect(r).toMatchObject({ ok: false, exploration: { stopped: 'cancelled', start: null } })
    expect(r.fix).toMatch(/cancelled .* resume/)
    const stuck = await explore({}, { devices: [{ serial: 'R5CT1234' }], keyboard: true })
    expect(stuck.exploration?.stopped, 'not cancelled: the keyboard that will not hide is a device error').toBe('device_error')
    expect(stuck.error).toMatch(/keyboard stays up/)
  })

  it.each([
    ['no device is connected', { devices: [] }, /no device is connected/, /then explore it\./],
    ['several devices and no target', { devices: [{ serial: 'A1' }, { serial: 'B2' }] }, /2 devices are connected/, /target/]
  ] as Array<[string, Sim, RegExp, RegExp]>)('does not explore when %s, and reads no screen', async (_why, sim, error, fix) => {
    const r = await explore({}, sim)
    expect(r).toMatchObject({ ok: false, exploration: null })
    expect(r.error).toMatch(error)
    expect(r.fix).toMatch(fix)
    expect(deviceCommands().filter((c) => !c.startsWith('shell getprop') && c !== 'emu avd name'), 'no screen read').toEqual([])
  })

  it.each([
    ['a target with shell characters', { target: 'a;reboot' }, /adb serial/],
    ['a package that is not a package name', { package: '../x' }, /package name/],
    ['a never-press word with shell characters', { neverPress: ['x; rm'] }, /never-press word/],
    ['too many never-press words', { neverPress: Array.from({ length: 51 }, (_, i) => `w${i}`) }, /at most 50/]
  ] as Array<[string, LiveExploreRequest, RegExp]>)('refuses %s before touching adb', async (_why, req, message) => {
    await expect(explore(req)).rejects.toThrow(message)
    expect(calls).toEqual([])
  })
})

describe('writeExploration', () => {
  const ID = '20261106T103900123Z-abc123'
  const graph = (screens: ExploreResult['screens']): ExploreResult => ({ start: screens[0]?.screen_id ?? null, screens, edges: [], skipped: [], stopped: 'done', taps: 0, notes: [] })
  const screen = (id: string, png: Uint8Array | null): ExploreResult['screens'][number] => ({
    screen_id: id,
    depth: 0,
    path: [],
    study: { screen_id: id, package: PKG, rotation: 0, density_dpi: 420, elements: [], findings: [], notes: [] },
    screenshot: png,
    screenshot_file: null,
    screenshot_error: png ? null : 'not taken'
  })

  it('saves graph.json and one <screen_id>.png per screen that has a screenshot', async () => {
    const dir = join(root, 'explorations')
    const saved = await writeExploration(dir, ID, { target: null, package: PKG, density_dpi: 420, taken_at: '2026-11-06T10:39:00.123Z', exploration: graph([screen('s-0123456789ab', WHITE_PNG), screen('s-ba9876543210', null)]) })
    expect(saved.dir).toBe(join(dir, ID))
    expect(readdirSync(saved.dir).sort(), 'folder contents').toEqual(['graph.json', 's-0123456789ab.png'])
    expect([...saved.screenshots]).toEqual([['s-0123456789ab', join(dir, ID, 's-0123456789ab.png')]])
    const json = JSON.parse(readFileSync(join(saved.dir, 'graph.json'), 'utf8'))
    expect(json, 'graph.json: id, facts, screens with the screenshot file name instead of bytes').toMatchObject({
      exploration_id: ID,
      package: PKG,
      start: 's-0123456789ab',
      stopped: 'done',
      screens: [
        { screen_id: 's-0123456789ab', screenshot: 's-0123456789ab.png', screenshot_error: null },
        { screen_id: 's-ba9876543210', screenshot: null, screenshot_error: 'not taken' }
      ]
    })
    expect(readdirSync(dir), 'no temp folder left behind').toEqual([ID])
  })

  it('keeps the screenshots screenshotSpool already wrote to disk, and copies one stored elsewhere', async () => {
    const dir = join(root, 'explorations')
    const spool = screenshotSpool(dir, ID)
    const spooled = await spool('s-0123456789ab', WHITE_PNG)
    expect(spooled, 'spooled into the temp folder').toBe(join(dir, `.tmp-${ID}`, 's-0123456789ab.png'))
    const elsewhere = join(root, 'elsewhere.png')
    writeFileSync(elsewhere, WHITE_PNG)
    const fromDisk = (id: string, file: string) => ({ ...screen(id, null), screenshot_file: file, screenshot_error: null })
    const saved = await writeExploration(dir, ID, { target: null, package: PKG, density_dpi: 420, taken_at: '', exploration: graph([fromDisk('s-0123456789ab', spooled), fromDisk('s-ba9876543210', elsewhere)]) })
    expect(readdirSync(saved.dir).sort(), 'folder contents').toEqual(['graph.json', 's-0123456789ab.png', 's-ba9876543210.png'])
    for (const id of ['s-0123456789ab', 's-ba9876543210']) expect(readFileSync(join(saved.dir, `${id}.png`)), `${id}.png bytes`).toEqual(Buffer.from(WHITE_PNG))
    expect([...saved.screenshots.keys()]).toEqual(['s-0123456789ab', 's-ba9876543210'])
    const json = JSON.parse(readFileSync(join(saved.dir, 'graph.json'), 'utf8'))
    expect(json.screens.map((s: Record<string, unknown>) => [s.screenshot, 'screenshot_file' in s]), 'file names, no absolute paths').toEqual([
      ['s-0123456789ab.png', false],
      ['s-ba9876543210.png', false]
    ])
    expect(readdirSync(dir), 'no temp folder left behind').toEqual([ID])
  })

  it('fails and leaves no temp folder when a spooled screenshot is gone', async () => {
    const dir = join(root, 'explorations')
    const spooled = await screenshotSpool(dir, ID)('s-0123456789ab', WHITE_PNG)
    rmSync(spooled)
    await expect(writeExploration(dir, ID, { target: null, package: PKG, density_dpi: null, taken_at: '', exploration: graph([{ ...screen('s-0123456789ab', null), screenshot_file: spooled }]) })).rejects.toThrow(/ENOENT/)
    expect(readdirSync(dir), 'nothing left').toEqual([])
  })

  it('discardExploration removes what the spool wrote; the spool refuses ids that could leave the folder', async () => {
    const dir = join(root, 'explorations')
    await screenshotSpool(dir, ID)('s-0123456789ab', WHITE_PNG)
    await discardExploration(dir, ID)
    expect(readdirSync(dir), 'temp folder removed').toEqual([])
    await expect(screenshotSpool(dir, ID)('../../x', WHITE_PNG)).rejects.toThrow(/not a screen id/)
    expect(() => screenshotSpool(dir, '../escape'), 'exploration id').toThrow(/not an exploration id/)
    expect(readdirSync(dir), 'nothing written').toEqual([])
  })

  it.each([
    ['an id that is not a run id', '../escape', 's-0123456789ab', /not an exploration id/],
    ['a screen id that is not s-<12 hex>', ID, '../../x', /not a screen id/]
  ])('refuses %s and writes nothing', async (_why, id, screenId, message) => {
    const dir = join(root, 'explorations')
    await expect(writeExploration(dir, id, { target: null, package: PKG, density_dpi: null, taken_at: '', exploration: graph([screen(screenId, WHITE_PNG)]) })).rejects.toThrow(message)
    expect(existsSync(dir) ? readdirSync(dir) : [], 'nothing written').toEqual([])
  })
})
