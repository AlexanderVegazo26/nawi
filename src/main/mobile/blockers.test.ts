import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findAll, findFirstRunBlockers, locatorFor } from './blockers'
import { parseUiDump } from './hierarchy'

/**
 * First-run blockers (roadmap M2c): each kind fires on a screen that has it and stays quiet on screens that look
 * close but are not one (an OK button without consent words, Next on a form, a lone text field). Two of the screens
 * are real dumps from an API 36 emulator (fixtures/ui-dumps); the rest are built here.
 */

const PKG = 'com.example.app'
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'ui-dumps', name), 'utf8')

let y = 0
/** One node of the app; clickable nodes get a box so they can be tapped. */
function node(attrs: Record<string, string | boolean>, pkg = PKG): string {
  y += 100
  const a = { class: 'android.widget.TextView', package: pkg, enabled: true, bounds: `[0,${y}][500,${y + 80}]`, ...attrs }
  return `<node ${Object.entries(a)
    .map(([k, v]) => `${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join(' ')}/>`
}
const screen = (...nodes: string[]) => parseUiDump(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="${PKG}">${nodes.join('')}</node></hierarchy>`)
const button = (text: string, extra: Record<string, string | boolean> = {}) => node({ class: 'android.widget.Button', text, clickable: true, ...extra })

describe('findFirstRunBlockers on real emulator dumps', () => {
  it("names Android's permission prompt and taps 'While using the app' (the narrowest allow) by its view id", () => {
    const r = findFirstRunBlockers(parseUiDump(fixture('camera-permission.txt')), 'com.android.camera2')
    expect(r.package).toBe('com.google.android.permissioncontroller')
    expect(r.blockers).toEqual([
      {
        kind: 'permission_dialog',
        summary: 'Android asks: "Allow Camera to access this device’s location?"',
        tap: { resource_id: 'com.android.permissioncontroller:id/permission_allow_foreground_only_button' },
        tap_label: 'While using the app',
        fix: 'Tap "While using the app" to go on, or grant that permission before launch (the profile\'s permissions.grant) so the prompt never shows.'
      }
    ])
  })

  it("names the app's own intro screen and taps NEXT (no text field on it)", () => {
    const r = findFirstRunBlockers(parseUiDump(fixture('camera-intro.txt')), 'com.android.camera2')
    expect(r.package).toBe('com.android.camera2')
    expect(r.blockers).toEqual([
      { kind: 'intro', summary: 'an intro screen ("NEXT" button)', tap: { resource_id: 'com.android.camera2:id/confirm_button' }, tap_label: 'NEXT', fix: 'Tap "NEXT" to go past it.' }
    ])
  })
})

describe('findFirstRunBlockers on built screens', () => {
  it('stays quiet on an ordinary screen', () => {
    expect(findFirstRunBlockers(screen(node({ text: 'Inbox' }), button('Compose')), PKG)).toEqual({ package: PKG, blockers: [] })
  })

  it('names a consent screen, preferring "Accept all" over "OK" and over a reject button', () => {
    const r = findFirstRunBlockers(screen(node({ text: 'We use cookies to improve your experience.' }), button('Reject all'), button('OK'), button('Accept all')), PKG)
    expect(r.blockers).toEqual([{ kind: 'consent', summary: 'a consent screen ("Accept all" button)', tap: { text: 'Accept all' }, tap_label: 'Accept all', fix: 'Tap "Accept all" to accept it for this test device.' }])
  })

  it('does not call an OK button a consent screen without consent words', () => {
    expect(findFirstRunBlockers(screen(node({ text: 'Update available' }), button('OK')), PKG).blockers).toEqual([])
    expect(findFirstRunBlockers(screen(node({ text: 'Start tracking your runs' }), button('OK')), PKG).blockers, '"tracking" alone is not ad tracking').toEqual([])
  })

  it("does not call a sign-in form's terms footer a consent screen: Continue there submits the form", () => {
    const r = findFirstRunBlockers(
      screen(
        node({ class: 'android.widget.EditText', text: 'Email' }),
        button('Continue'),
        node({ text: 'By continuing you agree to our Terms of Service and Privacy Policy.' }),
        button('Sign in')
      ),
      PKG
    )
    expect(r.blockers.map((b) => b.kind)).toEqual(['login_wall'])
  })

  it('still names an explicit accept button on a screen that also has a text field', () => {
    const r = findFirstRunBlockers(screen(node({ class: 'android.widget.EditText', text: 'Search' }), node({ text: 'We use cookies' }), button('Accept all')), PKG)
    expect(r.blockers.map((b) => [b.kind, b.tap_label])).toEqual([['consent', 'Accept all']])
  })

  it('finds a label inside a clickable layout (the tap lands on the label) and ignores a disabled button', () => {
    const r = findFirstRunBlockers(
      parseUiDump(
        `<hierarchy><node package="${PKG}" bounds="[0,0][9,9]"><node package="${PKG}" clickable="true" bounds="[0,0][500,100]"><node package="${PKG}" text="Skip" bounds="[10,10][90,90]"/></node>${button('Get started', { enabled: false })}</node></hierarchy>`
      ),
      PKG
    )
    expect(r.blockers.map((b) => [b.kind, b.tap_label])).toEqual([['intro', 'Skip']])
  })

  it('names a sign-in form without a tap, and never treats Next on a form as an intro', () => {
    const r = findFirstRunBlockers(
      screen(node({ class: 'android.widget.EditText', text: 'Email' }), node({ class: 'android.widget.EditText', password: true }), button('Next')),
      PKG
    )
    expect(r.blockers).toEqual([
      { kind: 'login_wall', summary: 'a sign-in form (password field)', tap: null, tap_label: null, fix: expect.stringMatching(/test account.*never put the password in the profile/) }
    ])
  })

  it('names a sign-in screen by its button next to a text field, and offers the guest way out first', () => {
    const r = findFirstRunBlockers(screen(node({ class: 'android.widget.EditText', text: 'Phone number' }), button('Continue with Google'), button('Continue as guest')), PKG)
    expect(r.blockers.map((b) => b.kind)).toEqual(['intro', 'login_wall'])
    expect(r.blockers[0].tap).toEqual({ text: 'Continue as guest' })
    expect(r.blockers[1].summary).toBe('a sign-in screen ("Continue with Google")')
  })

  it('does not call a lone search field a login wall', () => {
    expect(findFirstRunBlockers(screen(node({ class: 'android.widget.EditText', text: 'Search' }), button('Search')), PKG).blockers).toEqual([])
  })

  it("ignores another app's buttons and reports the window in front", () => {
    const r = findFirstRunBlockers(parseUiDump(`<hierarchy><node package="com.other" bounds="[0,0][9,9]">${node({ text: 'cookies' }, 'com.other')}${button('Accept', { package: 'com.other' })}</node></hierarchy>`), PKG)
    expect(r).toEqual({ package: 'com.other', blockers: [] })
  })

  it('says so instead of guessing when two identical buttons can not be told apart', () => {
    const r = findFirstRunBlockers(screen(node({ text: 'Privacy settings' }), button('Accept'), button('Accept')), PKG)
    expect(r.blockers).toEqual([{ kind: 'consent', summary: 'a consent screen ("Accept" button)', tap: null, tap_label: null, fix: expect.stringMatching(/can't name one to tap: get past the consent screen/) }])
  })
})

describe('locatorFor', () => {
  it('picks the shortest unique locator: id, then description, then text, then id + text', () => {
    const s = screen(
      button('A', { 'resource-id': 'x:id/a' }),
      button('B', { 'content-desc': 'bee' }),
      button('C'),
      button('D', { 'resource-id': 'x:id/row' }),
      button('E', { 'resource-id': 'x:id/row' })
    )
    const by = (text: string) => s.nodes.find((n) => n.text === text)!
    expect(locatorFor(s.nodes, by('A'))).toEqual({ resource_id: 'x:id/a' })
    expect(locatorFor(s.nodes, by('B'))).toEqual({ content_desc: 'bee' })
    expect(locatorFor(s.nodes, by('C'))).toEqual({ text: 'C' })
    expect(locatorFor(s.nodes, by('D')), 'a shared row id falls back to the text').toEqual({ text: 'D' })
    for (const n of s.nodes.filter((x) => x.text)) expect(findAll(s.nodes, locatorFor(s.nodes, n)!), `locator for ${n.text} finds only it`).toEqual([n])
  })

  it('an empty locator matches nothing', () => {
    expect(findAll(screen(button('A')).nodes, {})).toEqual([])
  })
})
