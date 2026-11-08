import { describe, expect, it } from 'vitest'
import type { ExecResult } from './doctor'
import {
  MAX_LOGCAT_MESSAGE,
  maskPng,
  namesPackage,
  parseKeyboardRegion,
  parseDeviceClock,
  parseLogcat,
  parsePackageUid,
  secretBoxes,
  startAndroidEvidence,
  type AndroidEvidenceHost
} from './flow-evidence'
import { parseUiDump, type UiScreen } from './hierarchy'
import { decodePng, encodePng } from './png'
import type { BinaryExecResult } from './screen'

/** Device evidence for android runs (roadmap M5b-2): log parsing, masking, and the per-run setup against a fake adb. */

const PKG = 'dev.nawi.shop'
const none = (text: string): string => text
const scrub = (text: string): string => text.replaceAll('hunter2', '${secret.pw}')

const line = (uid: string, level: string, tag: string, message: string, at = '1794138163.237'): string => `  ${at} ${uid}  4000  4001 ${level} ${tag}: ${message}`

describe('parseLogcat', () => {
  it('keeps the app\'s warnings and errors by uid number or name, and system lines naming the package', () => {
    const out = [
      '--------- beginning of main',
      line('10234', 'E', 'AndroidRuntime', 'FATAL EXCEPTION: main'),
      line('u0_a234', 'W', 'Shop', 'old images print the uid as a name'),
      line('1000', 'E', 'ActivityManager', `ANR in ${PKG} (${PKG}/.Main)`),
      line('1000', 'W', 'WifiService', 'Empty or null ScanResult list'),
      line('10234', 'I', 'Shop', 'info lines are not evidence'),
      'not a log line'
    ].join('\n')
    const r = parseLogcat(out, { pkg: PKG, uid: 10234, redact: none })
    expect(r.lines.map((l) => `${l.level} ${l.tag}`), 'own uid (number and u0_a name) + the ANR naming the package').toEqual(['E AndroidRuntime', 'W Shop', 'E ActivityManager'])
    expect(r.lines[0], 'time from the device clock, as ISO').toMatchObject({ at: '2026-11-08T11:42:43.237Z', message: 'FATAL EXCEPTION: main' })
    expect(r.dropped).toBe(0)
  })

  it('without a known uid keeps only the lines naming the package', () => {
    const out = [line('10234', 'E', 'Shop', 'no package named here'), line('10234', 'E', 'Shop', `crash in ${PKG}`)].join('\n')
    expect(parseLogcat(out, { pkg: PKG, uid: null, redact: none }).lines.map((l) => l.message)).toEqual([`crash in ${PKG}`])
  })

  it('caps the lines, counting the rest, and scrubs secrets before cutting a long message', () => {
    const long = `token hunter2 ${'x'.repeat(MAX_LOGCAT_MESSAGE)}`
    const out = [line('10234', 'E', 'Shop', long), ...Array.from({ length: 4 }, (_, i) => line('10234', 'W', 'Shop', `w${i}`))].join('\n')
    const r = parseLogcat(out, { pkg: PKG, uid: 10234, redact: scrub, max: 3 })
    expect(r.lines.map((l) => l.message.slice(0, 20))).toEqual(['token ${secret.pw} x', 'w0', 'w1'])
    expect(r.lines[0].message, 'cut after scrubbing, marked with an ellipsis').toHaveLength(MAX_LOGCAT_MESSAGE + 1)
    expect(r.lines[0].message.endsWith('…')).toBe(true)
    expect(JSON.stringify(r)).not.toContain('hunter2')
    expect(r.dropped, '5 lines, 3 kept').toBe(2)
  })
})

describe('parseLogcat without a uid', () => {
  it('keeps the lines of the app\'s running process when the device can\'t name its uid', () => {
    const out = [line('10234', 'E', 'AndroidRuntime', 'FATAL EXCEPTION: main'), '  1794138163.240 10300  5000  5000 E Other: not ours'].join('\n')
    expect(parseLogcat(out, { pkg: PKG, uid: null, pids: ['4000'], redact: none }).lines.map((l) => l.tag)).toEqual(['AndroidRuntime'])
  })
})

describe('namesPackage', () => {
  it.each([
    [`ANR in ${PKG}`, true],
    [`${PKG}/.Main died`, true],
    [`(${PKG})`, true],
    [`started ${PKG}.`, true],
    [`${PKG}.debug crashed`, false],
    [`${PKG}2 crashed`, false],
    [`com.${PKG}`, false],
    ['nothing', false]
  ])('%s -> %s', (text, want) => {
    expect(namesPackage(text, PKG)).toBe(want)
  })
})

describe('device answers', () => {
  it('reads the keyboard\'s area from its touchable region, one or several boxes, else null', () => {
    expect(parseKeyboardRegion('    mViewVisibility=0x0\n    touchable region=SkRegion((0,1517,1080,2400))\n')).toEqual([{ left: 0, top: 1517, right: 1080, bottom: 2400 }])
    expect(parseKeyboardRegion('touchable region=SkRegion((0,1500,540,2400)(540,1600,1080,2400))')).toHaveLength(2)
    expect(parseKeyboardRegion('touchable region=SkRegion()'), 'empty region: unknown').toBeNull()
    expect(parseKeyboardRegion('isVisible=true'), 'no region line: unknown').toBeNull()
  })

  it('reads the uid of exactly the package, not one that starts with its name', () => {
    expect(parsePackageUid(`package:${PKG}.debug uid:10235\npackage:${PKG} uid:10234\n`, PKG)).toBe(10234)
    expect(parsePackageUid(`package:${PKG}.debug uid:10235\n`, PKG)).toBeNull()
  })

  it('reads the device clock in ms only from a plain epoch-milliseconds answer', () => {
    expect(parseDeviceClock('1794138163151\n')).toBe(1794138163151)
    expect(parseDeviceClock('%3N\n'), 'a date without %N support').toBeNull()
    expect(parseDeviceClock('1794138163\n'), 'seconds only').toBeNull()
  })
})

function image(width: number, height: number, rgb = [255, 255, 255]): Uint8Array {
  const data = new Uint8Array(width * height * 3)
  for (let i = 0; i < data.length; i += 3) data.set(rgb, i)
  return encodePng({ width, height, rgb: data })
}

function pixel(png: Uint8Array, x: number, y: number): number[] {
  const d = decodePng(png)
  if (!d.ok) throw new Error(d.error)
  const at = (y * d.image.width + x) * 3
  return [...d.image.rgb.subarray(at, at + 3)]
}

describe('maskPng', () => {
  it('paints each box and leaves the rest of the image alone', () => {
    const out = maskPng(image(40, 30), [{ left: 10, top: 5, right: 20, bottom: 15 }])
    expect(out).not.toBeNull()
    expect(pixel(out!, 10, 5), 'inside the box').toEqual([0x5f, 0x63, 0x68])
    expect(pixel(out!, 19, 14), 'last pixel inside the box').toEqual([0x5f, 0x63, 0x68])
    expect(pixel(out!, 20, 14), 'right edge is exclusive').toEqual([255, 255, 255])
  })

  it('refuses a box outside the image (screen read in other coordinates) and bytes that are not a PNG', () => {
    expect(maskPng(image(40, 30), [{ left: 0, top: 0, right: 41, bottom: 10 }])).toBeNull()
    expect(maskPng(new Uint8Array([1, 2, 3]), [{ left: 0, top: 0, right: 1, bottom: 1 }])).toBeNull()
  })

  it('returns the bytes untouched when there is nothing to mask', () => {
    const png = image(4, 4)
    expect(maskPng(png, [])).toBe(png)
  })
})

const dump = (nodes: string): UiScreen =>
  parseUiDump(`<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="${PKG}" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][40,30]">${nodes}</node></hierarchy>`)

const view = (attrs: { id?: string; text?: string; desc?: string; pkg?: string; bounds: string }): string =>
  `<node index="0" text="${attrs.text ?? ''}" resource-id="${attrs.id ?? ''}" class="android.widget.EditText" package="${attrs.pkg ?? PKG}" content-desc="${attrs.desc ?? ''}" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="${attrs.bounds}"/>`

describe('secretBoxes', () => {
  it('covers the secret fields\' views (any of their locators) and any view showing a secret, nothing else', () => {
    const screen = dump(
      view({ id: `${PKG}:id/pin`, bounds: '[0,0][10,10]' }) +
        view({ text: 'Your code is hunter2', bounds: '[10,10][20,20]' }) +
        view({ desc: 'hunter2', pkg: 'android', bounds: '[20,20][30,30]' }) +
        view({ id: `${PKG}:id/name`, text: 'Ana', bounds: '[30,0][40,10]' }) +
        view({ id: `${PKG}:id/pin`, pkg: 'other.app', bounds: '[30,20][40,30]' })
    )
    const boxes = secretBoxes(screen, PKG, [[{ id: `${PKG}:id/gone` }, { id: `${PKG}:id/pin` }]], scrub)
    expect(boxes).toEqual([
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 10, top: 10, right: 20, bottom: 20 },
      { left: 20, top: 20, right: 30, bottom: 30 }
    ])
  })
})

describe('startAndroidEvidence', () => {
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' })

  function host(frames: BinaryExecResult[], answers: Record<string, ExecResult> = {}): AndroidEvidenceHost & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      now: () => 1_000,
      exec: async (_f, args) => {
        calls.push(args[3])
        const key = Object.keys(answers).find((k) => args[3].startsWith(k))
        return key ? answers[key] : { code: 1, stdout: '', stderr: 'unexpected', error: 'failed' }
      },
      execBinary: async (_f, args) => {
        calls.push(args.slice(2).join(' '))
        return frames.shift() ?? { code: 1, stdout: new Uint8Array(), stderr: '', error: 'failed' }
      }
    }
  }
  const REQ = { adb: 'adb', serial: 'emulator-5560', pkg: PKG, logcat: false, secretFields: [], usesSecrets: false, redact: none }

  it('stops taking shots for the run once the device stops answering, but not after a screen that blocks screenshots', async () => {
    const png = image(4, 4)
    const h = host([
      { code: 0, stdout: new Uint8Array(), stderr: '' },
      { code: 0, stdout: png, stderr: '' },
      { code: null, stdout: new Uint8Array(), stderr: '', error: 'timeout' },
      { code: 0, stdout: png, stderr: '' }
    ])
    const ev = await startAndroidEvidence(REQ, h)
    expect(await ev.shot(), 'a blocked screen (no image) is skipped').toBeUndefined()
    expect(await ev.shot(), 'the next screen is shot').toBe(Buffer.from(png).toString('base64'))
    expect(await ev.shot(), 'a timeout gives no shot').toBeUndefined()
    expect(await ev.shot(), 'and no more shots afterwards').toBeUndefined()
    expect(h.calls.filter((c) => c.includes('screencap')), 'no screencap after the timeout').toHaveLength(3)
    expect(h.calls.filter((c) => c.startsWith('uiautomator')), 'no screen reads without a secret typed').toHaveLength(0)
  })

  it('masks when the flow uses secrets; grep finding no keyboard line counts as no keyboard, not as unknown', async () => {
    const png = image(40, 30)
    const screen = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"></hierarchy>`
    const h = host([{ code: 0, stdout: png, stderr: '' }], {
      'uiautomator dump': ok(screen),
      'dumpsys input_method': { code: 1, stdout: '', stderr: '', error: 'failed' }
    })
    const ev = await startAndroidEvidence({ ...REQ, usesSecrets: true }, h)
    expect(await ev.shot(), 'the shot is taken').toBeDefined()
    expect(h.calls.filter((c) => c.startsWith('uiautomator')), 'read before and after the capture').toHaveLength(2)
    expect(h.calls.some((c) => c.startsWith('dumpsys window')), 'no keyboard window asked for').toBe(false)
  })

  it('has no device log without a device clock, and asks the device nothing for logs when logcat is off', async () => {
    const off = host([])
    await (await startAndroidEvidence(REQ, off)).stepLog(1_000)
    expect(off.calls, 'logcat off: no date, uid or logcat call').toEqual([])
    const noClock = host([], { 'date ': ok('%3N\n'), 'cmd package': ok(`package:${PKG} uid:10234\n`), 'logcat ': ok(line('10234', 'E', 'Shop', 'x')) })
    const log = await (await startAndroidEvidence({ ...REQ, logcat: true }, noClock)).stepLog(1_000)
    expect(log).toEqual({ lines: [], dropped: 0 })
    expect(noClock.calls.some((c) => c.startsWith('logcat ')), 'no logcat read without a clock to start it from').toBe(false)
  })

  it('reports no lines when logcat itself fails', async () => {
    const h = host([], { 'date ': ok('1794138163151\n'), 'cmd package': ok(`package:${PKG} uid:10234\n`), 'logcat ': { code: 1, stdout: line('10234', 'E', 'Shop', 'x'), stderr: 'bad', error: 'failed' } })
    expect(await (await startAndroidEvidence({ ...REQ, logcat: true }, h)).stepLog(1_000)).toEqual({ lines: [], dropped: 0 })
  })
})
