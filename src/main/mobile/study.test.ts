import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUiDump } from './hierarchy'
import { type FindingKind, MIN_TOUCH_DP, parseDensity, type ScreenStudy, studyScreen } from './study'

/**
 * Roadmap M3a: what one screen dump says about an app. The fixtures in fixtures/ui-dumps are uiautomator dumps
 * (API 36 attribute set): study-clean.txt has none of the defects, study-defects.txt has each of them once (see the
 * comments in the expectations), study-no-ids.txt is a screen without view ids (as Flutter and Compose apps draw
 * them), and camera-*.txt are real emulator dumps. Every finding class must fire on a screen with the defect and
 * stay quiet on the same screen without it.
 */

const PKG = 'com.example.app'
const PIXEL_6_DPI = 420
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'ui-dumps', name), 'utf8')
const study = (name: string, pkg: string, densityDpi: number | null = PIXEL_6_DPI): ScreenStudy => studyScreen(parseUiDump(fixture(name)), { package: pkg, densityDpi })
const kinds = (s: ScreenStudy): Array<[FindingKind, number | null]> => s.findings.map((f) => [f.kind, f.element])

/** A node of the app; controls are clickable and 147 px (56 dp at 420 dpi) tall unless told otherwise. */
function node(attrs: Record<string, string | boolean>, kids = ''): string {
  const a = { class: 'android.widget.TextView', package: PKG, enabled: true, bounds: '[0,0][1080,147]', ...attrs }
  const open = `<node ${Object.entries(a)
    .map(([k, v]) => `${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join(' ')}`
  return kids ? `${open}>${kids}</node>` : `${open}/>`
}
const button = (attrs: Record<string, string | boolean>, kids = '') => node({ class: 'android.widget.Button', clickable: true, focusable: true, ...attrs }, kids)
const screen = (inner: string, rotation = 0) =>
  parseUiDump(`<hierarchy rotation="${rotation}">${node({ class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' }, inner)}</hierarchy>`)
const run = (inner: string, densityDpi: number | null = PIXEL_6_DPI) => studyScreen(screen(inner), { package: PKG, densityDpi })
const id = (name: string) => `${PKG}:id/${name}`

describe('studyScreen on the fixture screens', () => {
  it('finds nothing wrong on the clean screen and lists every control with an id-based locator', () => {
    const s = study('study-clean.txt', 'com.example.clean')
    expect(s.findings, 'findings on study-clean.txt').toEqual([])
    expect(s.notes, 'only contrast is left unchecked').toEqual(['Contrast is not checked yet: it needs the screenshot (a later M3 slice).'])
    expect(s.package).toBe('com.example.clean')
    expect(s.screen_id).toMatch(/^s-[0-9a-f]{12}$/)
    const controls = s.elements.filter((e) => (e.clickable || e.checkable) && !e.in_collection)
    expect(
      controls.map((e) => [e.label, e.locator_basis]),
      'label and locator basis of each control outside the list'
    ).toEqual([
      ['Back', 'resource_id'],
      ['Email', 'resource_id'],
      ['Password', 'resource_id'],
      ['Notifications', 'resource_id'],
      ['Save', 'resource_id']
    ])
    const rows = s.elements.filter((e) => e.class.endsWith('LinearLayout'))
    expect(rows.map((e) => [e.label, e.in_collection, e.locator]), 'list rows: found by what they show').toEqual([
      ['Item 1', true, { text: 'Item 1' }],
      ['Item 2', true, { text: 'Item 2' }],
      ['Item 3', true, { text: 'Item 3' }]
    ])
  })

  it('fires each finding class on the defect screen, once per defect, and skips disabled and zero-size controls', () => {
    const s = study('study-defects.txt', 'com.example.defects')
    expect(kinds(s), `findings on study-defects.txt:\n${s.findings.map((f) => f.summary).join('\n')}`).toEqual([
      ['missing_label', 1], // ImageButton with no text, description or id
      ['missing_label', 6], // EditText with no hint
      ['small_touch_target', 2], // "Close", 60 px = 23 dp
      ['duplicate_resource_id', 3], // :id/action on "Share" and "Save"
      ['missing_resource_id', 1],
      ['missing_resource_id', 5], // "Continue"
      ['fragile_locator', 1], // nothing unique: position only
      ['fragile_locator', 3], // the shared id leaves only the text
      ['fragile_locator', 4],
      ['fragile_locator', 5]
    ])
    expect(s.findings.find((f) => f.kind === 'small_touch_target')?.summary).toBe('"Close" (ImageView) is 23x23 dp, under the 48x48 dp minimum touch target.')
    expect(s.findings.find((f) => f.kind === 'fragile_locator' && f.element === 1)?.summary).toBe(
      'the ImageButton at [0,100][147,247] matches no unique id, description or text, so a test can only find it by position.'
    )
    expect(s.findings.every((f) => f.fix.length > 0), 'every finding has a fix').toBe(true)
    expect(s.findings.map((f) => f.severity), 'severities follow the kinds').toEqual(['error', 'error', 'warning', 'warning', 'info', 'info', 'warning', 'warning', 'warning', 'warning'])
  })

  it('reports a screen without view ids once, not once per control', () => {
    const s = study('study-no-ids.txt', 'com.example.noids')
    expect(kinds(s)).toEqual([['missing_resource_id', null]])
    expect(s.findings[0].summary).toBe('No view on this screen has a view id, so tests can only find its 2 controls by text, description or position.')
    expect(s.elements.filter((e) => e.clickable).map((e) => e.locator), 'found by their descriptions').toEqual([{ content_desc: 'Get started' }, { content_desc: 'Sign in' }])
  })

  it("judges only the app's own views: Android's permission prompt over the app is not the app's to fix", () => {
    expect(study('camera-permission.txt', 'com.android.camera2').findings).toEqual([])
    const judged = studyScreen(parseUiDump(fixture('camera-permission.txt')), { package: null, densityDpi: PIXEL_6_DPI })
    expect(judged.elements.length, 'the inventory still lists the prompt').toBeGreaterThan(0)
    expect(judged.package).toBe('com.google.android.permissioncontroller')
  })

  it("flags the real camera intro's 42 dp tall check box (an actual AOSP Camera layout)", () => {
    expect(kinds(study('camera-intro.txt', 'com.android.camera2'))).toEqual([['small_touch_target', 8]])
  })
})

describe('each finding class fires on the defect and stays quiet without it', () => {
  it.each<[FindingKind, string, string]>([
    ['missing_label', button({ class: 'android.widget.ImageButton', 'resource-id': id('share') }), button({ class: 'android.widget.ImageButton', 'resource-id': id('share'), 'content-desc': 'Share' })],
    ['missing_label', button({ class: 'android.widget.EditText', 'resource-id': id('q') }), button({ class: 'android.widget.EditText', 'resource-id': id('q'), hint: 'Search' })],
    ['small_touch_target', button({ 'resource-id': id('ok'), text: 'OK', bounds: '[40,300][1040,425]' }), button({ 'resource-id': id('ok'), text: 'OK', bounds: '[40,300][1040,426]' })],
    [
      'duplicate_resource_id',
      button({ 'resource-id': id('go'), text: 'A' }) + button({ 'resource-id': id('go'), text: 'B' }),
      button({ 'resource-id': id('go_a'), text: 'A' }) + button({ 'resource-id': id('go_b'), text: 'B' })
    ],
    ['missing_resource_id', button({ 'resource-id': id('x'), text: 'Next' }) + button({ text: 'Back' }), button({ 'resource-id': id('x'), text: 'Next' }) + button({ 'resource-id': id('back'), text: 'Back' })],
    ['fragile_locator', button({ 'resource-id': id('x'), text: 'Next' }) + button({ text: 'Back' }), button({ 'resource-id': id('x'), text: 'Next' }) + button({ text: 'Back', 'content-desc': 'Go back' })]
  ])('%s', (kind, defect, fixed) => {
    const bad = run(defect)
    const good = run(fixed)
    expect(bad.findings.map((f) => f.kind), `${kind} on ${defect}`).toContain(kind)
    expect(good.findings.map((f) => f.kind), `no ${kind} on ${fixed}: ${good.findings.map((f) => f.summary).join(' | ')}`).not.toContain(kind)
  })

  it('takes a control layout without its own label or id by its child: labelled, and found by the child id', () => {
    const s = run(node({ class: 'android.widget.LinearLayout', clickable: true }, node({ 'resource-id': id('title'), text: 'Profile' })) + button({ 'resource-id': id('x'), text: 'X' }))
    const layout = s.elements.find((e) => e.class === 'android.widget.LinearLayout')
    expect(layout?.label).toBe('Profile')
    expect(layout?.locator, 'the child locator; a tap on it lands inside the layout').toEqual({ resource_id: id('title') })
    expect(kinds(s)).toEqual([])
  })

  it('leaves list rows alone: shared row ids and text-only rows are how lists work', () => {
    const rows = [1, 2, 3].map((k) => node({ class: 'android.widget.LinearLayout', clickable: true, 'resource-id': id('row') }, node({ 'resource-id': id('row_title'), text: `Item ${k}` }))).join('')
    const s = run(node({ class: 'androidx.recyclerview.widget.RecyclerView', 'resource-id': id('list'), scrollable: true }, rows))
    expect(kinds(s)).toEqual([])
    expect(s.elements.filter((e) => e.in_collection).length, 'rows and their titles are in the list').toBe(6)
    expect(s.elements.find((e) => e.class.endsWith('RecyclerView'))?.label, 'a list is not labelled by its rows').toBe('')
  })

  it('still flags an id that a list row shares with a view outside the list', () => {
    const row = node({ class: 'android.widget.LinearLayout', clickable: true }, node({ 'resource-id': id('title'), text: 'Row' }))
    const s = run(node({ 'resource-id': id('title'), text: 'Header' }) + node({ class: 'androidx.recyclerview.widget.RecyclerView', 'resource-id': id('list') }, row + row))
    expect(kinds(s)).toEqual([['duplicate_resource_id', 1]])
    expect(s.findings[0].summary).toBe(`1 view outside a list shares the view id ${id('title')} with 2 list row views, so a test can't tell them apart by id.`)
  })

  it('names the view outside the list even when the list comes first', () => {
    const row = node({ class: 'android.widget.LinearLayout', clickable: true }, node({ 'resource-id': id('title'), text: 'Row' }))
    const s = run(node({ class: 'androidx.recyclerview.widget.RecyclerView', 'resource-id': id('list') }, row + row) + node({ 'resource-id': id('title'), text: 'Footer' }))
    expect(kinds(s)).toEqual([['duplicate_resource_id', 6]])
  })

  it("does not lend a row the locator of a control inside it (a settings row's switch taps the switch, not the row)", () => {
    const s = run(
      node({ class: 'android.widget.LinearLayout', clickable: true, bounds: '[0,300][1080,447]' }, node({ text: 'Wi-Fi', bounds: '[40,320][800,427]' }) + button({ class: 'android.widget.Switch', checkable: true, 'resource-id': id('sw'), 'content-desc': 'Wi-Fi switch', bounds: '[880,300][1040,447]' })) +
        button({ 'resource-id': id('done'), text: 'Done', bounds: '[40,600][1040,747]' })
    )
    const row = s.elements.find((e) => e.class === 'android.widget.LinearLayout')
    expect(row?.locator, 'found by its own label, not by the switch id').toEqual({ text: 'Wi-Fi' })
    expect(kinds(s), s.findings.map((f) => f.summary).join(' | ')).toEqual([
      ['missing_resource_id', 1],
      ['fragile_locator', 1]
    ])
  })

  it('treats a scrollable plain view with repeated children as a list (Compose LazyColumn), but not a scroll view', () => {
    const rows = (k: number) => Array.from({ length: k }, (_, j) => node({ class: 'android.view.View', clickable: true, 'resource-id': 'row', bounds: `[0,${300 + j * 150}][1080,${447 + j * 150}]` }, node({ text: `Item ${j}` }))).join('')
    const lazy = (k: number) => run(node({ class: 'android.view.View', scrollable: true, bounds: '[0,300][1080,2000]' }, rows(k)) + button({ 'resource-id': 'save', text: 'Save', bounds: '[40,2100][1040,2247]' }))
    expect(kinds(lazy(3)), lazy(3).findings.map((f) => f.summary).join(' | ')).toEqual([])
    expect(lazy(3).screen_id, 'rows collapse into the list').toBe(lazy(9).screen_id)
    const scrollView = run(node({ class: 'android.widget.ScrollView', scrollable: true, bounds: '[0,300][1080,2000]' }, rows(2)))
    expect(scrollView.findings.map((f) => f.kind), 'a scroll view is content, not rows').toContain('duplicate_resource_id')
  })


  it("ignores Android's own ids (android:id/...) for duplicates and for the no-ids check", () => {
    const s = run(node({ 'resource-id': 'android:id/text1', text: 'a' }) + node({ 'resource-id': 'android:id/text1', text: 'b' }) + button({ 'content-desc': 'Go' }))
    expect(kinds(s)).toEqual([['missing_resource_id', null]])
  })
})

describe('touch targets and density', () => {
  it('does not flag a row that the list edge cuts (uiautomator reports only its visible part), but flags one inside', () => {
    const list = (inner: string) => node({ class: 'androidx.recyclerview.widget.RecyclerView', 'resource-id': id('list'), scrollable: true, bounds: '[0,300][1080,2400]' }, inner)
    const cut = run(list(button({ 'resource-id': id('a'), text: 'A', bounds: '[0,300][1080,1000]' }) + button({ 'resource-id': id('b'), text: 'B', bounds: '[0,2370][1080,2400]' })))
    expect(kinds(cut), 'the 11 dp sliver at the bottom edge').toEqual([])
    const inside = run(list(button({ 'resource-id': id('b'), text: 'B', bounds: '[0,1000][1080,1030]' })))
    expect(kinds(inside)).toEqual([['small_touch_target', 2]])
    const narrowAtEdge = run(list(button({ 'resource-id': id('b'), text: 'B', bounds: '[0,1000][40,1030]' })))
    expect(kinds(narrowAtEdge), 'the edge excuses the cut side only; 30 px tall is still too small').toEqual([['small_touch_target', 2]])
  })


  it(`measures in dp: ${MIN_TOUCH_DP} dp is ${MIN_TOUCH_DP} px at 160 dpi and 126 px at 420 dpi`, () => {
    const at = (px: number, dpi: number) => kinds(run(button({ 'resource-id': id('b'), text: 'B', bounds: `[100,100][${100 + px},${100 + px}]` }), dpi))
    expect(at(48, 160)).toEqual([])
    expect(at(47, 160)).toEqual([['small_touch_target', 1]])
    expect(at(126, 420)).toEqual([])
    expect(at(125, 420)).toEqual([['small_touch_target', 1]])
  })

  it('does not guess a density: without one, touch targets are skipped and the note says why', () => {
    const s = run(button({ 'resource-id': id('b'), text: 'B', bounds: '[0,0][10,10]' }), null)
    expect(kinds(s)).toEqual([])
    expect(s.notes[0]).toBe('Touch targets were not measured: the screen density is unknown (pass the `wm density` reading).')
    expect(s.density_dpi).toBeNull()
  })

  it.each([
    ['Physical density: 420\n', 420],
    ['Physical density: 420\nOverride density: 560\n', 560],
    ['Physical density: 440\r\nOverride density: 380\r\n', 380],
    ['', null],
    ['Physical density: 9\n', null],
    ['cmd: Failure calling service window', null]
  ])('parseDensity(%j) = %s', (out, dpi) => {
    expect(parseDensity(out)).toBe(dpi)
  })
})

describe('screen id', () => {
  const page = (title: string, items: number, button1 = 'Save', rotation = 0) =>
    studyScreen(
      screen(
        node({ 'resource-id': id('title'), text: title }) +
          node(
            { class: 'androidx.recyclerview.widget.RecyclerView', 'resource-id': id('list') },
            Array.from({ length: items }, (_, k) => node({ class: 'android.widget.LinearLayout', clickable: true }, node({ text: `Row ${k}` }))).join('')
          ) +
          button({ 'resource-id': id('save'), text: button1 }) +
          button({ class: 'android.widget.EditText', 'resource-id': id('name'), text: title }),
        rotation
      ),
      { package: PKG }
    ).screen_id

  it('stays the same when the content changes: titles, typed text, the number of list rows', () => {
    expect(page('Inbox (3)', 3)).toBe(page('Inbox (12)', 40))
  })

  it("changes with what the screen is: another control label, another rotation, another view", () => {
    const base = page('Inbox', 3)
    expect(page('Inbox', 3, 'Delete'), 'a control label').not.toBe(base)
    expect(page('Inbox', 3, 'Save', 1), 'rotation').not.toBe(base)
    expect(run(button({ 'resource-id': id('a'), text: 'A' })).screen_id).not.toBe(run(button({ 'resource-id': id('b'), text: 'A' })).screen_id)
  })

  it('gives the real dumps distinct ids, the same on every read', () => {
    const ids = ['camera-intro.txt', 'camera-permission.txt', 'study-clean.txt', 'study-defects.txt', 'study-no-ids.txt'].map((f) => study(f, 'x').screen_id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(study('camera-intro.txt', 'x').screen_id).toBe(ids[0])
  })
})

describe('text fields', () => {
  it('never takes typed text as a label or a locator', () => {
    const s = run(button({ class: 'android.widget.EditText', text: 'john@example.com', bounds: '[40,300][1040,447]' }) + button({ 'resource-id': id('go'), text: 'Go', bounds: '[40,600][1040,747]' }))
    const field = s.elements.find((e) => e.class === 'android.widget.EditText')
    expect([field?.label, field?.locator, field?.locator_basis]).toEqual(['', null, 'index'])
    expect(kinds(s)).toEqual([
      ['missing_label', 1],
      ['missing_resource_id', 1],
      ['fragile_locator', 1]
    ])
  })

  it('keeps the screen id when a text field inside a clickable wrapper (TextInputLayout) holds other text', () => {
    const form = (typed: string) =>
      run(node({ class: 'com.google.android.material.textfield.TextInputLayout', clickable: true, 'resource-id': id('til') }, button({ class: 'com.google.android.material.textfield.TextInputEditText', 'resource-id': id('name'), text: typed }))).screen_id
    expect(form('a')).toBe(form('bob'))
  })
})

describe('untrusted dumps', () => {
  it('studies a 9,000-node dump of nested controls whose labels repeat in well under the time a user waits', () => {
    // Compact nodes: the parser caps a dump at 1 MB.
    const leaves = `<node package="${PKG}" text="x" bounds="[100,100][300,300]"/>`.repeat(9000 - 9)
    let inner = leaves
    for (let k = 0; k < 8; k++) inner = node({ class: 'android.widget.LinearLayout', clickable: true, bounds: '[0,0][1080,2400]' }, inner)
    const parsed = screen(inner)
    const started = performance.now()
    const s = studyScreen(parsed, { package: PKG, densityDpi: PIXEL_6_DPI })
    const ms = performance.now() - started
    expect(s.elements.length, 'every node but the plain root').toBe(8999)
    expect(ms, `studyScreen took ${Math.round(ms)} ms on 9,000 nodes`).toBeLessThan(3000)
  })

  it("names the window in front like blockers.ts does, even when the root node has no package", () => {
    const s = studyScreen(parseUiDump(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="">${node({ text: 'Hi' })}</node></hierarchy>`))
    expect(s.package).toBe(PKG)
  })
})

describe('password fields', () => {
  it('never puts what the dump shows of a password into the study, nor finds the field by it', () => {
    const s = run(button({ class: 'android.widget.EditText', password: true, text: 'hunter2', hint: 'Password' }) + button({ 'resource-id': id('go'), text: 'Go' }))
    expect(JSON.stringify(s), 'study output').not.toContain('hunter2')
    const field = s.elements.find((e) => e.password)
    expect(field?.label).toBe('Password')
    expect([field?.text, field?.locator, field?.locator_basis], 'no text, and not found by it').toEqual(['', null, 'index'])
  })
})
