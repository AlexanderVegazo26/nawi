import { describe, expect, it } from 'vitest'
import type { ExecResult } from './doctor'
import { exploreApp, neverPressWord, NEVER_PRESS, type ExploreHost, type ExploreRequest, type ExploreResult } from './explore'
import { canvas, encodePng } from './fixtures/make-png'
import { parseUiDump } from './hierarchy'
import { studyScreen } from './study'

/**
 * The screen-graph explorer (roadmap M3c) against a simulated notes app behind a fake adb: every screen is a dump
 * built from the spec below, a tap lands on the control whose bounds hold the point, Back pops the screen stack.
 * The expected graph is written out by hand from the spec, so any change in what is tapped, in what order, or what
 * is left alone shows up as a diff.
 */

const PKG = 'dev.nawi.notes'
const ID = (name: string): string => `${PKG}:id/${name}`
type Box = [number, number, number, number]

interface Control {
  cls?: string
  id?: string
  text?: string
  desc?: string
  hint?: string
  checkable?: boolean
  /** Default: tappable when it goes somewhere, toggles or takes text. */
  clickable?: boolean
  bounds: Box
  /** Where a tap leads: a screen name, 'up' (back to the screen below), or nothing (the screen stays). */
  go?: string
  children?: Control[]
}

interface ScreenSpec {
  pkg?: string
  controls: Control[]
  /** Rows of one list (RecyclerView at `listBox`): each row is a clickable layout holding one text. */
  rows?: { text: string; go: string }[]
  listBox?: Box
  /** Where Back leads instead of the screen below (to make the explorer lose its way). */
  back?: string
  /** The on-screen keyboard comes up when the screen opens (a focused text field). */
  keyboard?: boolean
}

const ROW_H = 150
const text = (t: string, bounds: Box, id?: string): Control => ({ text: t, bounds, id })

const APP: Record<string, ScreenSpec> = {
  home: {
    controls: [
      text('Notes', [40, 100, 800, 250]),
      { cls: 'android.widget.ImageButton', id: ID('settings'), desc: 'Settings', bounds: [900, 100, 1060, 250], go: 'settings' },
      { cls: 'android.widget.Button', id: ID('new_note'), text: 'New note', bounds: [40, 300, 1040, 450], go: 'editor' },
      { cls: 'android.widget.Button', id: ID('delete_all'), text: 'Delete all', bounds: [40, 1600, 1040, 1750], go: 'gone' },
      { cls: 'android.widget.Button', id: ID('help'), text: 'Help', bounds: [40, 1800, 1040, 1950], go: 'browser' }
    ],
    listBox: [0, 500, 1080, 1500],
    rows: [
      { text: 'Groceries', go: 'detail' },
      { text: 'Trip', go: 'detail' },
      { text: 'Ideas', go: 'detail' }
    ]
  },
  settings: {
    controls: [
      { cls: 'android.widget.ImageButton', id: ID('up'), desc: 'Navigate up', bounds: [0, 100, 160, 250], go: 'up' },
      { cls: 'android.widget.Switch', id: ID('dark_mode'), text: 'Dark mode', checkable: true, bounds: [40, 300, 1040, 450] },
      { cls: 'android.widget.Button', id: ID('about'), text: 'About', bounds: [40, 500, 1040, 650], go: 'about' },
      { cls: 'android.widget.Button', id: ID('btnSignOut'), text: 'Account', bounds: [40, 700, 1040, 850], go: 'signed_out' },
      // A settings row: the row takes the tap and flips the switch inside it.
      {
        cls: 'android.widget.LinearLayout',
        id: ID('sync_row'),
        clickable: true,
        bounds: [40, 1300, 1040, 1450],
        children: [text('Sync', [40, 1300, 800, 1450], ID('sync_title')), { cls: 'android.widget.Switch', id: ID('sync_switch'), checkable: true, clickable: false, bounds: [850, 1300, 1040, 1450] }]
      }
    ],
    // A settings list: every row opens a different screen.
    listBox: [0, 900, 1080, 1200],
    rows: [
      { text: 'Notifications', go: 'notifications' },
      { text: 'Privacy', go: 'privacy' }
    ]
  },
  about: {
    controls: [
      text('Version 1.0', [40, 100, 1040, 250], ID('version')),
      { cls: 'android.widget.Button', id: ID('licenses'), text: 'Licenses', bounds: [40, 300, 1040, 450], go: 'licenses' },
      // A card whose centre is its Delete button: tapping the card's centre would press Delete.
      {
        cls: 'android.widget.LinearLayout',
        id: ID('promo_card'),
        desc: 'Promo card',
        bounds: [40, 500, 1040, 900],
        go: 'promo',
        children: [{ cls: 'android.widget.Button', id: ID('promo_delete'), text: 'Delete', bounds: [340, 600, 740, 800], go: 'gone' }]
      }
    ]
  },
  licenses: {
    controls: [text('Open source notices', [40, 100, 1040, 250], ID('notices')), { cls: 'android.widget.Button', id: ID('more'), text: 'More', bounds: [40, 300, 1040, 450], go: 'deeper' }]
  },
  notifications: { controls: [text('Reminders', [40, 100, 1040, 250], ID('reminders'))] },
  privacy: { controls: [text('Your data stays on this phone', [40, 100, 1040, 250], ID('privacy_text'))] },
  editor: {
    keyboard: true,
    controls: [
      { cls: 'android.widget.EditText', id: ID('title'), hint: 'Title', bounds: [40, 100, 1040, 250] },
      { cls: 'android.widget.Button', id: ID('save'), text: 'Save', bounds: [40, 300, 1040, 450], go: 'gone' },
      { cls: 'android.widget.Button', id: ID('discard'), text: 'Discard', bounds: [40, 500, 1040, 650], go: 'gone' }
    ]
  },
  detail: {
    controls: [
      text('Milk, eggs', [40, 100, 1040, 250], ID('body')),
      { cls: 'android.widget.Button', id: ID('share'), text: 'Share', bounds: [40, 300, 1040, 450], go: 'chooser' },
      { cls: 'android.widget.Button', id: ID('expand'), text: 'Show more', clickable: true, bounds: [40, 500, 1040, 650] },
      // Opens the next note as a new copy of this screen on top of it.
      { cls: 'android.widget.Button', id: ID('next'), text: 'Next note', bounds: [40, 700, 1040, 850], go: 'detail' }
    ]
  },
  browser: { pkg: 'com.android.chrome', controls: [text('help.example', [0, 0, 1080, 200])] },
  chooser: { pkg: 'com.android.intentresolver', controls: [text('Share with', [0, 1600, 1080, 1700])] },
  launcher: { pkg: 'com.android.launcher3', controls: [{ desc: 'Notes', bounds: [100, 100, 300, 300], go: 'home' }] },
  // Screens a safe run must never reach.
  gone: { controls: [text('Everything is gone', [0, 0, 1080, 200])] },
  signed_out: { controls: [text('Signed out', [0, 0, 1080, 200])] },
  deeper: { controls: [text('Deeper', [0, 0, 1080, 200])] },
  promo: { controls: [text('Try premium', [0, 0, 1080, 200])] }
}

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const box = (b: Box): string => `[${b[0]},${b[1]}][${b[2]},${b[3]}]`
const tappable = (c: Control): boolean => c.clickable ?? (c.go !== undefined || c.checkable === true || /EditText/.test(c.cls ?? ''))

function node(pkg: string, c: Control & { scrollable?: boolean }, inner = ''): string {
  const t = tappable(c)
  const open =
    `<node index="0" text="${attr(c.text ?? '')}" resource-id="${c.id ?? ''}" class="${c.cls ?? 'android.widget.TextView'}" package="${pkg}" ` +
    `content-desc="${attr(c.desc ?? '')}" checkable="${c.checkable === true}" checked="false" clickable="${t}" enabled="true" ` +
    `focusable="${t}" focused="false" scrollable="${c.scrollable === true}" long-clickable="false" password="false" selected="false" ` +
    `bounds="${box(c.bounds)}" hint="${attr(c.hint ?? '')}"`
  const kids = inner + (c.children ?? []).map((k) => node(pkg, k)).join('')
  return kids ? `${open}>${kids}</node>` : `${open}/>`
}

/** The rows of a screen's list as controls: a clickable row holding its text. */
function rowsOf(spec: ScreenSpec): Control[] {
  const top = spec.listBox?.[1] ?? 0
  return (spec.rows ?? []).map((r, k) => {
    const bounds: Box = [0, top + k * ROW_H, 1080, top + (k + 1) * ROW_H]
    return { cls: 'android.widget.LinearLayout', id: ID('row'), clickable: true, bounds, go: r.go, children: [text(r.text, bounds, ID('row_title'))] }
  })
}

function dumpOf(name: string): string {
  const spec = APP[name]
  const pkg = spec.pkg ?? PKG
  let inner = spec.controls.map((c) => node(pkg, c)).join('')
  if (spec.listBox) inner += node(pkg, { cls: 'androidx.recyclerview.widget.RecyclerView', id: ID('list'), bounds: spec.listBox, scrollable: true }, rowsOf(spec).map((r) => node(pkg, r)).join(''))
  const root = node(pkg, { cls: 'android.widget.FrameLayout', bounds: [0, 0, 1080, 2400] }, inner)
  return `UI hierchary dumped to: /data/local/tmp/x.xml\n<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${root}</hierarchy>`
}

/** The screen id the explorer must give each screen of the app (studyScreen is M3a's, pinned by its own tests). */
const idOf = (name: string): string => studyScreen(parseUiDump(dumpOf(name)), { package: PKG }).screen_id

const WHITE_PNG = encodePng(canvas(1080, 2400, [255, 255, 255]), { alpha: true })
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' })

interface Device {
  host: ExploreHost
  /** What each tap landed on, as "<screen>:<label>". */
  tapped: string[]
  stack: string[]
}

interface DeviceOptions {
  onDelay?: () => void
  screencapFails?: boolean
  /** The n-th tap (1-based) fails in adb. */
  failTap?: number
  /** Back never hides the keyboard. */
  keyboardStuck?: boolean
}

/** Every control of a screen with the label a person sees, deepest last (so the last hit is the one on top). */
function flatten(cs: Control[]): Control[] {
  return cs.flatMap((c) => [c, ...flatten(c.children ?? [])])
}

function device(start: string[] = ['launcher', 'home'], over: DeviceOptions = {}): Device {
  const stack = [...start]
  const tapped: string[] = []
  let clock = 0
  let keyboard = false
  let taps = 0
  const top = (): string => stack[stack.length - 1]
  const push = (name: string): void => {
    stack.push(name)
    keyboard = APP[name].keyboard === true
  }
  const host: ExploreHost = {
    exec: async (_file, args) => {
      const line = args[3] ?? ''
      if (line.startsWith('uiautomator dump')) return ok(dumpOf(top()))
      if (line.startsWith('dumpsys input_method')) return ok(`    mInputShown=${keyboard}\n`)
      if (line === 'input keyevent KEYCODE_BACK') {
        if (keyboard) {
          keyboard = over.keyboardStuck === true
          return ok()
        }
        const back = APP[top()].back
        stack.pop()
        if (back) push(back)
        return ok()
      }
      const m = /^input tap (\d+) (\d+)$/.exec(line)
      if (!m) return { code: 1, stdout: '', stderr: `unexpected ${line}`, error: 'failed' }
      if (++taps === over.failTap) return { code: 255, stdout: '', stderr: "error: device 'emulator-5560' not found", error: 'failed' }
      const [x, y] = [Number(m[1]), Number(m[2])]
      const spec = APP[top()]
      const hits = flatten([...spec.controls, ...rowsOf(spec)]).filter((c) => tappable(c) && x >= c.bounds[0] && x < c.bounds[2] && y >= c.bounds[1] && y < c.bounds[3])
      const hit = hits[hits.length - 1]
      const label = hit ? (hit.text ?? hit.desc ?? hit.children?.find((k) => k.text)?.text ?? hit.id) : `nothing at ${x},${y}`
      tapped.push(`${top()}:${label}`)
      if (keyboard) tapped.push('KEY PRESSED')
      if (hit?.go === 'up') stack.pop()
      else if (hit?.go) push(hit.go)
      return ok()
    },
    execBinary: async () => (over.screencapFails ? { code: 1, stdout: new Uint8Array(), stderr: 'screencap: secure window', error: 'failed' } : { code: 0, stdout: WHITE_PNG, stderr: '' }),
    delay: async (ms) => {
      clock += ms
      over.onDelay?.()
    },
    now: () => clock
  }
  return { host, tapped, stack }
}

const REQ: ExploreRequest = { adb: '/sdk/platform-tools/adb', serial: 'emulator-5560', package: PKG, densityDpi: 420 }

/** The graph as readable lines: "from -[label]-> to (result)" with screen names instead of ids. */
function graph(r: ExploreResult): { screens: string[]; edges: string[]; skipped: string[] } {
  const names = new Map(Object.keys(APP).map((n) => [idOf(n), n]))
  const name = (id: string | null): string => (id === null ? '-' : (names.get(id) ?? id))
  return {
    screens: r.screens.map((s) => `${name(s.screen_id)}@${s.depth}`),
    edges: r.edges.map((e) => `${name(e.from)} -[${e.tap.label}]-> ${e.result === 'left_app' ? e.package : name(e.to)}${e.result === 'screen' ? '' : ` (${e.result})`}`),
    skipped: r.skipped.map((s) => `${name(s.screen_id)}: ${s.label} (${s.reason})`)
  }
}

describe('exploreApp (roadmap M3c): screen graph of a fixture app', () => {
  it('builds the hand-built graph of the notes app: every safe control tapped, depth first, in screen order', async () => {
    const d = device()
    const r = await exploreApp(REQ, d.host)
    expect(r.stopped, `notes: ${r.notes.join(' | ')}`).toBe('done')
    expect(r.start).toBe(idOf('home'))
    expect(graph(r)).toEqual({
      screens: ['home@0', 'settings@1', 'about@2', 'licenses@3', 'notifications@2', 'privacy@2', 'editor@1', 'detail@1'],
      edges: [
        'home -[Settings]-> settings',
        'settings -[Navigate up]-> home',
        'settings -[About]-> about',
        'about -[Licenses]-> licenses',
        'settings -[Notifications]-> notifications',
        'settings -[Privacy]-> privacy',
        'home -[New note]-> editor',
        'home -[Help]-> com.android.chrome (left_app)',
        'home -[Groceries]-> detail',
        'detail -[Share]-> com.android.intentresolver (left_app)',
        'detail -[Show more]-> detail (same_screen)',
        'detail -[Next note]-> detail (same_screen)',
        'home -[Trip]-> detail'
      ],
      skipped: [
        'home: Delete all (never_press)',
        'settings: Dark mode (toggle)',
        'settings: Account (never_press)',
        'settings: Sync (toggle)',
        'about: Delete (never_press)',
        'about: Promo card (covered)',
        'editor: Title (text_field)',
        'editor: Save (never_press)',
        'editor: Discard (never_press)',
        'home: Ideas (repeated_row)'
      ]
    })
    expect(r.taps).toBe(13)
    // Up landed on home: the run tapped Settings again to get back instead of pressing Back out of the app.
    expect(d.tapped.filter((t) => t === 'home:Settings'), 'Settings is tapped once to explore and once to come back from Up').toHaveLength(2)
    // Back twice out of the stacked note copies, and the device is where the run started.
    expect(d.stack).toEqual(['launcher', 'home'])
    const screens = new Set(r.screens.map((x) => x.screen_id))
    expect(r.edges.filter((e) => e.to !== null && !screens.has(e.to)), 'edges to a screen missing from screens').toEqual([])
  })

  it('never taps a never-press control, a text field, a toggle or a covered control, nor a key of the keyboard', async () => {
    const d = device()
    await exploreApp(REQ, d.host)
    const forbidden = ['Delete all', 'Account', 'Save', 'Discard', 'Title', 'Dark mode', 'Sync', 'More', 'Ideas', 'Delete', 'Promo card']
    expect(d.tapped.filter((t) => forbidden.includes(t.split(':')[1]) || t === 'KEY PRESSED'), `taps: ${d.tapped.join(', ')}`).toEqual([])
    expect(d.tapped.some((t) => t.includes('nothing at')), `a tap missed every control: ${d.tapped.join(', ')}`).toBe(false)
  })

  it('studies each screen once with its screenshot, and every screen records the path that reached it', async () => {
    const r = await exploreApp(REQ, device().host)
    for (const s of r.screens) {
      expect(s.screenshot, `screenshot of ${s.screen_id}`).toEqual(WHITE_PNG)
      expect(s.screenshot_error).toBeNull()
      expect(s.study.density_dpi).toBe(420)
    }
    expect(r.screens.find((s) => s.screen_id === idOf('licenses'))?.path.map((t) => t.label)).toEqual(['Settings', 'About', 'Licenses'])
    // The screenshot reached the study: contrast was measured, not skipped for want of one.
    expect(r.screens[0].study.notes.filter((n) => /screenshot/i.test(n)), 'notes about a missing screenshot').toEqual([])
  })

  it('is deterministic: two runs on the same app give the same graph', async () => {
    const a = await exploreApp(REQ, device().host)
    const b = await exploreApp(REQ, device().host)
    expect(graph(b)).toEqual(graph(a))
  })

  it('stops at the depth it is given', async () => {
    const r = await exploreApp({ ...REQ, maxDepth: 1 }, device().host)
    expect(r.stopped).toBe('done')
    expect(graph(r).screens).toEqual(['home@0', 'settings@1', 'editor@1', 'detail@1'])
    expect(graph(r).edges).toEqual(['home -[Settings]-> settings', 'home -[New note]-> editor', 'home -[Help]-> com.android.chrome (left_app)', 'home -[Groceries]-> detail', 'home -[Trip]-> detail'])
  })

  it('stops at the screen, tap and time budgets with the graph so far, never with an edge to a screen it did not keep', async () => {
    const screens = await exploreApp({ ...REQ, maxScreens: 2 }, device().host)
    expect([screens.stopped, graph(screens).screens, graph(screens).edges]).toEqual(['max_screens', ['home@0', 'settings@1'], ['home -[Settings]-> settings', 'settings -[Navigate up]-> home']])
    const taps = await exploreApp({ ...REQ, maxTaps: 3 }, device().host)
    expect([taps.stopped, taps.taps, graph(taps).edges.length]).toEqual(['max_taps', 3, 3])
    // Each tap and Back waits EXPLORE_SETTLE_MS (1 s) of simulated time.
    const time = await exploreApp({ ...REQ, timeBudgetMs: 2_500 }, device().host)
    expect(time.stopped).toBe('max_time')
    expect(time.taps).toBeLessThanOrEqual(2)
  })

  it('stops as lost, naming where it ended up, when Back leads off the explored path', async () => {
    APP.about.back = 'promo'
    try {
      const r = await exploreApp(REQ, device().host)
      expect(r.stopped).toBe('lost')
      expect(graph(r).screens).toEqual(['home@0', 'settings@1', 'about@2', 'licenses@3'])
      expect(r.notes.join(' '), 'the note names the screen it was going back to and where Back led').toMatch(new RegExp(`${idOf('settings')}.*${idOf('promo')}`))
    } finally {
      delete APP.about.back
    }
  })

  it('hides the keyboard before reading a screen, and stops if it will not go away', async () => {
    const stuck = device(undefined, { keyboardStuck: true })
    const r = await exploreApp(REQ, stuck.host)
    expect(r.stopped).toBe('device_error')
    expect(r.notes.join(' ')).toContain('keyboard')
    expect(stuck.tapped.at(-1), 'the last tap opened the editor; nothing was tapped with the keyboard up').toBe('home:New note')
  })

  it('stops with the adb error when a tap fails, without recording a dead control', async () => {
    const r = await exploreApp(REQ, device(undefined, { failTap: 2 }).host)
    expect(r.stopped).toBe('device_error')
    expect(r.notes.join(' ')).toMatch(/input tap .* failed on emulator-5560 \(error: device 'emulator-5560' not found\)/)
    expect(graph(r).edges).toEqual(['home -[Settings]-> settings'])
  })

  it('scrubs typed secrets from every study and keeps no screenshot of a screen that shows one', async () => {
    const r = await exploreApp({ ...REQ, secrets: { note: 'Milk, eggs' } }, device().host)
    expect(r.stopped).toBe('done')
    const detail = r.screens.find((s) => s.screen_id === idOf('detail'))
    expect(detail?.screenshot).toBeNull()
    expect(detail?.screenshot_error).toContain('secret value')
    expect(JSON.stringify(r)).not.toContain('Milk, eggs')
    expect(JSON.stringify(detail?.study)).toContain('${secret.note}')
    expect(r.screens.find((s) => s.screen_id === idOf('home'))?.screenshot, 'screens without the secret keep theirs').toEqual(WHITE_PNG)
  })

  it('does nothing when the app is not in front', async () => {
    const d = device(['launcher'])
    const r = await exploreApp(REQ, d.host)
    expect([r.stopped, r.start, r.screens.length, d.tapped]).toEqual(['not_in_app', null, 0, []])
    expect(r.notes[0]).toContain('com.android.launcher3')
  })

  it('stops when cancelled, without another tap', async () => {
    const ctrl = new AbortController()
    let delays = 0
    const d = device(undefined, { onDelay: () => ++delays === 1 && ctrl.abort() })
    const r = await exploreApp({ ...REQ, signal: ctrl.signal }, d.host)
    expect([r.stopped, d.tapped]).toEqual(['cancelled', ['home:Settings']])
  })

  it('explores without screenshots when screencap fails, and says why', async () => {
    const r = await exploreApp(REQ, device(undefined, { screencapFails: true }).host)
    expect(r.stopped).toBe('done')
    expect(r.screens[0].screenshot).toBeNull()
    expect(r.screens[0].screenshot_error).toContain('screencap did not return an image')
    expect(r.screens[0].study.notes.join(' ')).toContain('no screenshot')
  })
})

describe('neverPressWord', () => {
  const el = (label: string, resource_id = '', content_desc = '') => ({ label, resource_id, content_desc })
  it.each([
    ['Delete note', '', 'delete'],
    ['', 'com.x:id/btnSignOut', 'sign out'],
    ['', 'com.x:id/pay_now', 'pay'],
    ['Log out.', '', 'log out'],
    ['Send message', '', 'send'],
    ['Cancel subscription', '', 'cancel subscription'],
    ['Eliminar nota', '', 'eliminar'],
    ['Löschen', '', 'löschen'],
    ['Cerrar sesión', '', 'cerrar sesión']
  ])('"%s" / %s is never pressed (%s)', (label, id, word) => {
    expect(neverPressWord(el(label, id))).toBe(word)
  })
  it.each([['Calls'], ['Saved items'], ['Display'], ['Settings'], ['Payment history']])('"%s" is safe to tap', (label) => {
    expect(neverPressWord(el(label)), `"${label}" should not match a never-press word`).toBeNull()
  })
  it('takes extra words from the caller', () => {
    expect(neverPressWord(el('Archive'), [...NEVER_PRESS, 'archive'])).toBe('archive')
  })
})
