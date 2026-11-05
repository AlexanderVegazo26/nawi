import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecResult } from './doctor'
import type { BinaryExecResult } from './screen'
import { parseUiDump } from './hierarchy'
import { studyScreen } from './study'
import { scrubStudy, studyLiveScreen, writeStudy, type LiveStudyResult, type StudyHost } from './study-live'

/**
 * mobile_study's engine (roadmap M3b) against a simulated adb: which device it studies, the exact adb commands it
 * sends (read-only: no install, tap, launch or boot), the density it measures with, the screenshot, and that a
 * secret typed into the app never comes back, not even as pixels. The SDK and /dev/kvm are temp files.
 */

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'ui-dumps', name), 'utf8')

let root: string
let sdkDir: string
let calls: string[][]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nawi-study-live-'))
  mkdirSync(join(root, 'home'))
  sdkDir = join(root, 'sdk')
  const adb = join(sdkDir, 'platform-tools', 'adb')
  mkdirSync(join(adb, '..'), { recursive: true })
  writeFileSync(adb, '#!/bin/sh\n')
  chmodSync(adb, 0o755)
  calls = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A PNG header (signature + IHDR) is all pngSize reads. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  return b
}

/** One window of `pkg` holding a sign-in form whose email field shows `typed`. */
function formDump(pkg: string, typed: string): string {
  const node = (attrs: string): string =>
    `<node index="0" package="${pkg}" checkable="false" checked="false" focusable="true" focused="false" scrollable="false" long-clickable="false" selected="false" enabled="true" hint="" ${attrs}/>`
  return (
    'UI hierchary dumped to: /data/local/tmp/nawi-window-1.xml\n' +
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${pkg}" content-desc="" clickable="false" enabled="true" password="false" bounds="[0,0][1080,2400]">` +
    node(`text="${typed}" resource-id="${pkg}:id/email" class="android.widget.EditText" content-desc="" clickable="true" password="false" bounds="[40,400][1040,560]"`) +
    node(`text="" resource-id="${pkg}:id/password" class="android.widget.EditText" content-desc="" clickable="true" password="true" bounds="[40,600][1040,760]"`) +
    node(`text="Sign in" resource-id="${pkg}:id/submit" class="android.widget.Button" content-desc="" clickable="true" password="false" bounds="[40,800][1040,960]"`) +
    '</node></hierarchy>'
  )
}

interface SimDevice {
  serial: string
  state?: string
  api?: number
  avd?: string
}

interface Sim {
  devices: SimDevice[]
  dump?: ExecResult
  /** Screens in order, one per dump (the last one repeats); overrides `dump`. */
  dumps?: ExecResult[]
  density?: ExecResult
  screencap?: BinaryExecResult
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })
const failed = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr, error: 'failed' })

function simHost(sim: Sim): StudyHost {
  const kvm = join(root, 'kvm')
  writeFileSync(kvm, '')
  let dumpsRead = 0
  return {
    env: { ANDROID_HOME: sdkDir },
    platform: 'linux',
    arch: 'x64',
    home: join(root, 'home'),
    kvmPath: kvm,
    exec: async (file, args) => {
      calls.push([file.replace(sdkDir, '<sdk>'), ...args])
      if (args[0] === 'version') return ok('Android Debug Bridge version 1.0.41\n')
      if (args[0] === 'devices') return ok(`List of devices attached\n${sim.devices.map((d) => `${d.serial}\t${d.state ?? 'device'}`).join('\n')}\n`)
      if (args[0] !== '-s') return failed(`unexpected ${args.join(' ')}`)
      const d = sim.devices.find((x) => x.serial === args[1])
      if (!d) return failed(`adb: device '${args[1]}' not found`)
      const cmd = args.slice(2)
      if (cmd[0] === 'emu') return d.avd ? ok(`${d.avd}\nOK\n`) : failed('not an emulator')
      if (cmd[0] !== 'shell') return failed(`unexpected ${cmd.join(' ')}`)
      const line = cmd[1]
      if (line.startsWith('getprop ro.build')) return ok(`${d.api ?? 34}\nx86_64\n`)
      if (line.startsWith('uiautomator dump')) {
        if (sim.dumps) return sim.dumps[Math.min(dumpsRead++, sim.dumps.length - 1)]
        return sim.dump ?? ok(fixture('study-defects.txt'))
      }
      if (line === 'wm density') return sim.density ?? ok('Physical density: 420\n')
      return failed(`unexpected shell ${line}`)
    },
    execBinary: async (file, args) => {
      calls.push([file.replace(sdkDir, '<sdk>'), ...args])
      return sim.screencap ?? { code: 0, stdout: png(1080, 2400), stderr: '' }
    }
  }
}

/** The adb commands sent to the device itself (not the doctor's `adb version` / `adb devices`). */
const deviceCommands = (): string[] => calls.filter((c) => c[1] === '-s').map((c) => c.slice(3).join(' '))

describe('studyLiveScreen', () => {
  it('studies the only connected device: dump, density, screenshot, and the M3a study of that dump', async () => {
    const r = await studyLiveScreen({}, simHost({ devices: [{ serial: 'R5CT1234' }] }))
    expect(r.ok, `study failed: ${r.error} / ${r.fix}`).toBe(true)
    expect(r.target, 'a phone is named by its serial').toEqual({ kind: 'device', name: 'R5CT1234', serial: 'R5CT1234', api: 34 })
    const offline = studyScreen(parseUiDump(fixture('study-defects.txt')), { package: 'com.example.defects', densityDpi: 420 })
    expect(r.study, 'same study as studyScreen on the dump, with the app in front as the package and wm density').toEqual(offline)
    expect(r.study?.findings.some((f) => f.kind === 'small_touch_target'), 'density measured, so touch targets are checked').toBe(true)
    expect(r.screenshot, 'screenshot size from the PNG header').toMatchObject({ width: 1080, height: 2400 })
    expect(r.screenshot_error).toBeNull()
  })

  it('only reads the device: no install, tap, key, launch, settings change or boot', async () => {
    await studyLiveScreen({}, simHost({ devices: [{ serial: 'emulator-5554', avd: 'Pixel_8' }] }))
    const sent = deviceCommands()
    expect(sent.filter((c) => !/^(shell getprop ro\.build|shell uiautomator dump |shell wm density$|emu avd name$|exec-out screencap -p$)/.test(c)), `unexpected adb commands in ${JSON.stringify(sent)}`).toEqual([])
    expect(sent.some((c) => c.startsWith('shell uiautomator dump')), 'reads the screen').toBe(true)
    expect(sent, 'takes the screenshot with exec-out (binary-safe)').toContain('exec-out screencap -p')
  })

  it('names a running emulator by its AVD and finds it again by that name', async () => {
    const sim = { devices: [{ serial: 'R5CT1234' }, { serial: 'emulator-5556', avd: 'Pixel_8' }] }
    const r = await studyLiveScreen({ target: 'Pixel_8' }, simHost(sim))
    expect(r.ok, `study failed: ${r.error}`).toBe(true)
    expect(r.target, 'AVD name -> its running serial').toEqual({ kind: 'avd', name: 'Pixel_8', serial: 'emulator-5556', api: 34 })
    const bySerial = await studyLiveScreen({ target: 'R5CT1234' }, simHost(sim))
    expect(bySerial.target?.serial, 'a serial picks that device among several').toBe('R5CT1234')
  })

  it.each([
    ['no device is connected', { devices: [] }, undefined, /no device is connected/, /mobile-open/],
    ['several devices and no target', { devices: [{ serial: 'A1' }, { serial: 'B2' }] }, undefined, /2 devices are connected \(A1, B2\)/, /target/],
    ['an unauthorized target', { devices: [{ serial: 'A1', state: 'unauthorized' }] }, 'A1', /A1 is unauthorized/, /.+/],
    ['the only device is unauthorized', { devices: [{ serial: 'A1', state: 'unauthorized' }] }, undefined, /no device is ready \(A1 is unauthorized\)/, /[Aa]llow USB debugging|authori[sz]e/],
    ['a target that is not connected', { devices: [{ serial: 'A1' }] }, 'Z9', /no device Z9/, /mobile-doctor/]
  ] as Array<[string, Sim, string | undefined, RegExp, RegExp]>)('does not study when %s, and says what to do', async (_why, sim, target, error, fix) => {
    const r = await studyLiveScreen({ target }, simHost(sim))
    expect(r, 'refused with a reason and a fix, nothing studied').toMatchObject({ ok: false, study: null, screenshot: null })
    expect(r.error).toMatch(error)
    expect(r.fix).toMatch(fix)
    expect(deviceCommands().filter((c) => !c.startsWith('shell getprop') && c !== 'emu avd name'), 'never reads the screen of a device it did not pick').toEqual([])
  })

  it('points to mobile-open for a virtual device that exists but is not running (a study never boots one)', async () => {
    const avdHome = join(root, 'home', '.android', 'avd')
    mkdirSync(join(avdHome, 'Pixel_8.avd'), { recursive: true })
    writeFileSync(join(avdHome, 'Pixel_8.ini'), `path=${join(avdHome, 'Pixel_8.avd')}\ntarget=android-34\n`)
    writeFileSync(join(avdHome, 'Pixel_8.avd', 'config.ini'), 'abi.type=x86_64\n')
    const r = await studyLiveScreen({ target: 'Pixel_8' }, simHost({ devices: [] }))
    expect(r).toMatchObject({ ok: false, error: 'virtual device Pixel_8 is not running' })
    expect(r.fix).toContain('nawi mobile-open <file.apk> --target Pixel_8')
  })

  it('fails with a fix when the screen cannot be read, and still studies without a density or a screenshot', async () => {
    const hung = await studyLiveScreen({}, simHost({ devices: [{ serial: 'A1' }], dump: { code: null, stdout: '', stderr: '', error: 'timeout' } }))
    expect(hung).toMatchObject({ ok: false, error: 'could not read the screen: uiautomator did not answer', study: null })
    expect(hung.fix).toContain('adb -s A1 shell uiautomator dump')

    const partial = await studyLiveScreen(
      {},
      simHost({ devices: [{ serial: 'A1' }], density: failed('wm: not found'), screencap: { code: 0, stdout: new Uint8Array(), stderr: '' } })
    )
    expect(partial.ok, 'the dump is enough for a study').toBe(true)
    expect(partial.study?.density_dpi, 'no density read: touch targets not measured').toBeNull()
    expect(partial.screenshot).toBeNull()
    expect(partial.screenshot_error, 'why there is no screenshot, with the command to try').toMatch(/screencap did not return an image.*exec-out screencap -p/)
  })

  it('judges the package it is given instead of the app in front', async () => {
    const r = await studyLiveScreen({ package: 'com.other.app' }, simHost({ devices: [{ serial: 'A1' }] }))
    expect(r.study?.findings, 'none of the defects fixture views belong to com.other.app').toEqual([])
  })

  it('scrubs a secret typed into the app from everything it returns and takes no screenshot of it', async () => {
    const secret = 'qa.user+7@example.test'
    const r = await studyLiveScreen({ secrets: { email: secret } }, simHost({ devices: [{ serial: 'A1' }], dump: ok(formDump('com.example.shop', secret)) }))
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r), 'the secret value appears nowhere in the result').not.toContain(secret)
    const email = r.study?.elements.find((e) => e.resource_id === 'com.example.shop:id/email')
    expect(email?.text, 'the field text shows the placeholder').toBe('${secret.email}')
    expect(r.screenshot, 'pixels cannot be scrubbed').toBeNull()
    expect(r.screenshot_error).toMatch(/secret value .* is on the screen/)
    expect(deviceCommands(), 'screencap is never run while a secret is on screen').not.toContain('exec-out screencap -p')
  })

  it('drops the screenshot when a secret shows up between the dump and the screenshot (read again after it)', async () => {
    const secret = 'hunter2-visible'
    const r = await studyLiveScreen(
      { secrets: { pw: secret } },
      simHost({ devices: [{ serial: 'A1' }], dumps: [ok(formDump('com.example.shop', '')), ok(formDump('com.example.shop', secret))] })
    )
    expect(r.ok, 'the study of the first read stands').toBe(true)
    expect(r.screenshot, 'the picture may show the secret: not kept').toBeNull()
    expect(r.screenshot_error).toMatch(/secret value .* is on the screen/)
    expect(JSON.stringify(r)).not.toContain(secret)
    expect(deviceCommands().filter((c) => c.startsWith('shell uiautomator dump')).length, 'read before and after the screenshot').toBe(2)
  })

  it('does not keep the screenshot when secrets were given and the screen cannot be read again after it', async () => {
    const r = await studyLiveScreen(
      { secrets: { pw: 'x-secret' } },
      simHost({ devices: [{ serial: 'A1' }], dumps: [ok(formDump('com.example.shop', '')), { code: null, stdout: '', stderr: '', error: 'timeout' }] })
    )
    expect(r).toMatchObject({ ok: true, screenshot: null })
    expect(r.screenshot_error).toMatch(/could not be read again/)
  })

  it('reads the screen once (no second dump) when no secrets were given', async () => {
    await studyLiveScreen({}, simHost({ devices: [{ serial: 'A1' }] }))
    expect(deviceCommands().filter((c) => c.startsWith('shell uiautomator dump')).length).toBe(1)
  })

  it('judges nothing, with a note, when only Android\'s permission prompt is on screen', async () => {
    const prompt = formDump('com.google.android.permissioncontroller', '')
    const r = await studyLiveScreen({}, simHost({ devices: [{ serial: 'A1' }], dump: ok(prompt) }))
    expect(r.ok).toBe(true)
    expect(r.study?.findings, 'Android\'s own dialog is not the app\'s to fix').toEqual([])
    expect(r.study?.notes.at(-1)).toMatch(/Only Android's own windows are on screen/)
    expect(r.study?.elements.length, 'its elements are still listed (to tap past it)').toBeGreaterThan(0)
  })

  it('judges the app behind the status bar, not the status bar', async () => {
    const dump = fixture('study-defects.txt').replace('<hierarchy rotation="0">', '<hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" clickable="false" enabled="true" password="false" bounds="[0,0][1080,80]"/>')
    const r = await studyLiveScreen({}, simHost({ devices: [{ serial: 'A1' }], dump: ok(dump) }))
    // study.package stays the window in front (M3a); the findings show which app was judged.
    expect(r.study?.findings.length, 'the defects app is judged (judging systemui would find nothing)').toBeGreaterThan(0)
  })

  it('takes the screenshot when the secrets it was given are not on the screen', async () => {
    const r = await studyLiveScreen({ secrets: { pw: 'not-shown-anywhere' } }, simHost({ devices: [{ serial: 'A1' }], dump: ok(formDump('com.example.shop', '')) }))
    expect(r.screenshot, `screenshot expected, got error ${r.screenshot_error}`).not.toBeNull()
  })

  it('refuses a target or package that is not a serial/AVD name or package name before running adb', async () => {
    await expect(studyLiveScreen({ target: 'a b; reboot' }, simHost({ devices: [] }))).rejects.toThrow(/not an adb serial or AVD name/)
    await expect(studyLiveScreen({ package: '../x' }, simHost({ devices: [] }))).rejects.toThrow(/not an Android package name/)
    expect(calls).toEqual([])
  })
})

describe('scrubStudy', () => {
  it('replaces secrets in labels, locators, findings and notes, longest first', () => {
    const study = studyScreen(parseUiDump(formDump('com.example.shop', 'abc123')), { package: 'com.example.shop', densityDpi: 420 })
    const scrubbed = scrubStudy({ ...study, notes: ['saw abc123'] }, [['short', 'abc'], ['long', 'abc123']])
    expect(JSON.stringify(scrubbed)).not.toContain('abc123')
    expect(scrubbed.notes).toEqual(['saw ${secret.long}'])
    expect(scrubStudy(study, []), 'no secrets: the same object').toBe(study)
  })
})

describe('writeStudy', () => {
  const saved = (r: Pick<LiveStudyResult, 'study' | 'target'>) => ({ study: r.study!, target: r.target, taken_at: '2026-11-05T21:00:00.000Z' })

  it('saves study.json and screen.png in one folder per study, with no temp folder left', async () => {
    const r = await studyLiveScreen({}, simHost({ devices: [{ serial: 'A1' }] }))
    const out = await writeStudy(join(root, 'studies'), '20261105T210000000Z-abc123', saved(r), r.screenshot!.png)
    expect(out.dir).toBe(join(root, 'studies', '20261105T210000000Z-abc123'))
    expect(readdirSync(out.dir).sort()).toEqual(['screen.png', 'study.json'])
    expect(readFileSync(out.screenshot!)).toEqual(Buffer.from(r.screenshot!.png))
    const json = JSON.parse(readFileSync(join(out.dir, 'study.json'), 'utf8'))
    expect(json, 'study.json').toMatchObject({ study_id: '20261105T210000000Z-abc123', screenshot: 'screen.png', target: { serial: 'A1' }, study: { screen_id: r.study!.screen_id } })
    expect(readdirSync(join(root, 'studies'))).toEqual(['20261105T210000000Z-abc123'])
  })

  it('saves a study without a screenshot, and refuses an id that is not a study id', async () => {
    const r = await studyLiveScreen({}, simHost({ devices: [{ serial: 'A1' }] }))
    const out = await writeStudy(join(root, 'studies'), '20261105T210000000Z-000000', saved(r), null)
    expect(out.screenshot).toBeNull()
    expect(existsSync(join(out.dir, 'screen.png'))).toBe(false)
    await expect(writeStudy(join(root, 'studies'), '../escape', saved(r), null)).rejects.toThrow(/not a study id/)
  })
})
