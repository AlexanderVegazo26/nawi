import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseUiDump } from './hierarchy'
import { MAX_ONBOARDING_ENTRIES, mergeOnboarding, nextOnboardingTap, screenKey, type OnboardingTap } from './onboarding'

/**
 * Which onboarding tap to make on a screen (roadmap M2c part 2): saved taps first, learned ones only in learn mode,
 * and never a tap on the wrong window, on an ambiguous locator, on a disabled element or past a sign-in form. Two of
 * the screens are real API 36 emulator dumps (fixtures/ui-dumps); the rest are built here.
 */

const PKG = 'com.example.app'
const PROMPT = 'com.google.android.permissioncontroller'
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'ui-dumps', name), 'utf8')

let y = 0
function node(attrs: Record<string, string | boolean>, pkg = PKG): string {
  // Rows stay on the 2400 px screen whatever ran before (nodes off screen are never tapped).
  y = y >= 2000 ? 100 : y + 100
  const a = { class: 'android.widget.Button', package: pkg, enabled: true, clickable: true, bounds: `[0,${y}][500,${y + 80}]`, ...attrs }
  return `<node ${Object.entries(a)
    .map(([k, v]) => `${k.replace('_', '-')}="${String(v)}"`)
    .join(' ')}/>`
}
const screen = (front: string, ...nodes: string[]) =>
  parseUiDump(`<hierarchy rotation="0"><node class="android.widget.FrameLayout" package="${front}" bounds="[0,0][1080,2400]">${nodes.join('')}</node></hierarchy>`)

const skip: OnboardingTap = { when: 'intro', tap: { text: 'Skip' } }
const allow: OnboardingTap = { when: 'permission_dialog', tap: { resource_id: 'com.android.permissioncontroller:id/permission_allow_button' } }

describe('nextOnboardingTap', () => {
  it('taps the center of the saved element on the app', () => {
    const s = screen(PKG, node({ text: 'Skip', bounds: '[100,2000][300,2100]' }))
    expect(nextOnboardingTap(s, PKG, [skip], false), 'saved intro tap on the app').toMatchObject({ entry: skip, x: 200, y: 2050, label: 'Skip', learned: false })
  })

  it('takes the first saved tap that is on screen, in profile order', () => {
    const s = screen(PKG, node({ text: 'Get started' }), node({ text: 'Skip' }))
    const start: OnboardingTap = { when: 'intro', tap: { text: 'Get started' } }
    expect(nextOnboardingTap(s, PKG, [skip, start], false)?.entry, 'Skip is first in the profile').toEqual(skip)
    expect(nextOnboardingTap(s, PKG, [start, skip], false)?.entry, 'Get started is first in the profile').toEqual(start)
  })

  it('while the permission prompt is up taps only the prompt, whatever the profile order (the app is behind it)', () => {
    const s = screen(PROMPT, node({ resource_id: 'com.android.permissioncontroller:id/permission_allow_button', text: 'Allow' }, PROMPT), node({ text: 'Skip' }))
    expect(nextOnboardingTap(s, PKG, [skip, allow], false)?.entry).toEqual(allow)
    expect(nextOnboardingTap(s, PKG, [skip], true), 'Skip under the prompt is not pressed, even learning').toMatchObject({ entry: { when: 'permission_dialog' } })
    expect(nextOnboardingTap(s, PKG, [skip], false)).toBeNull()
  })

  it('replays no app tap on a sign-in form, and no generic Next/OK/Continue/Got it on a screen with text fields', () => {
    const form = (label: string) => screen(PKG, node({ class: 'android.widget.EditText', clickable: true }), node({ text: label }))
    for (const label of ['Next', 'OK', 'Continue', 'Got it.']) {
      expect(nextOnboardingTap(form(label), PKG, [{ when: 'intro', tap: { text: label } }], false), `${label} on a form`).toBeNull()
    }
    expect(nextOnboardingTap(form('Skip'), PKG, [skip], false), 'Skip is not a submit label').toMatchObject({ entry: skip })
    const signIn = screen(PKG, node({ class: 'android.widget.EditText', password: true }), node({ text: 'Skip' }))
    expect(nextOnboardingTap(signIn, PKG, [skip], true), 'a password field on screen').toBeNull()
  })

  it('does not learn a locator the profile could not save', () => {
    const s = screen(PKG, node({ text: 'Get&#10;started' }))
    expect(nextOnboardingTap(s, PKG, [], true), 'a label with a line break').toBeNull()
  })

  it('never lands a permission tap on the app, nor an app tap on another window', () => {
    const fake = screen(PKG, node({ resource_id: 'com.android.permissioncontroller:id/permission_allow_button', text: 'Allow' }))
    expect(nextOnboardingTap(fake, PKG, [allow], false), 'an app view reusing the prompt\'s id is not the prompt').toBeNull()
    const other = screen('com.other.app', node({ text: 'Skip' }, 'com.other.app'))
    expect(nextOnboardingTap(other, PKG, [skip], false), 'Skip on another app in front').toBeNull()
  })

  it.each([
    ['two elements match', [node({ text: 'Skip' }), node({ text: 'Skip' })]],
    ['the element is disabled', [node({ text: 'Skip', enabled: false })]],
    ['the element has no bounds', [node({ text: 'Skip', bounds: 'none' })]],
    ['the element is off screen to the left', [node({ text: 'Skip', bounds: '[-400,100][-100,200]' })]],
    ['the element\'s center is past the right edge', [node({ text: 'Skip', bounds: '[1000,100][2000,200]' })]],
    ['the element\'s center is below the screen', [node({ text: 'Skip', bounds: '[0,2300][500,2600]' })]],
    ['the element has no area', [node({ text: 'Skip', bounds: '[100,100][100,200]' })]]
  ])('presses nothing when %s', (_why, nodes) => {
    expect(nextOnboardingTap(screen(PKG, ...nodes), PKG, [skip], true)).toBeNull()
  })

  it('learns only in learn mode, and only blockers it can name a tap for', () => {
    const intro = parseUiDump(fixture('camera-intro.txt'))
    expect(nextOnboardingTap(intro, 'com.android.camera2', [], false), 'no saved taps, not learning').toBeNull()
    expect(nextOnboardingTap(intro, 'com.android.camera2', [], true), 'the real Camera2 intro').toMatchObject({
      entry: { when: 'intro', tap: { resource_id: 'com.android.camera2:id/confirm_button' } },
      learned: true
    })
    const prompt = parseUiDump(fixture('camera-permission.txt'))
    expect(nextOnboardingTap(prompt, 'com.android.camera2', [], true)?.entry, 'the real location prompt: the narrowest allow').toEqual({
      when: 'permission_dialog',
      tap: { resource_id: 'com.android.permissioncontroller:id/permission_allow_foreground_only_button' }
    })
  })

  it('never learns a way past a sign-in form', () => {
    const s = screen(PKG, node({ class: 'android.widget.EditText', text: '' }), node({ class: 'android.widget.EditText', password: true }), node({ text: 'Sign in' }))
    expect(nextOnboardingTap(s, PKG, [], true)).toBeNull()
  })

  it('prefers a saved tap over a learned one', () => {
    const s = screen(PKG, node({ text: 'Skip' }), node({ text: 'Get started' }))
    const saved: OnboardingTap = { when: 'intro', tap: { text: 'Get started' } }
    expect(nextOnboardingTap(s, PKG, [saved], true)).toMatchObject({ entry: saved, learned: false })
  })
})

describe('screenKey and mergeOnboarding', () => {
  it('a moved, renamed, disabled, ticked or selected element changes the key; the same dump does not', () => {
    const base = screen(PKG, node({ text: 'Skip', bounds: '[0,0][10,10]' }))
    expect(screenKey(base)).toBe(screenKey(screen(PKG, node({ text: 'Skip', bounds: '[0,0][10,10]' }))))
    for (const changed of [{ bounds: '[0,1][10,10]' }, { text: 'Next' }, { enabled: false }, { checked: true }, { selected: true }] as Record<string, string | boolean>[]) {
      expect(screenKey(screen(PKG, node({ text: 'Skip', bounds: '[0,0][10,10]', ...changed }))), JSON.stringify(changed)).not.toBe(screenKey(base))
    }
  })

  it('appends new taps in order, skips ones already saved, and caps the list, counting what it dropped', () => {
    expect(mergeOnboarding([skip], [allow, { when: 'intro', tap: { text: 'Skip' } }, allow])).toEqual({ taps: [skip, allow], dropped: 0 })
    const many = Array.from({ length: MAX_ONBOARDING_ENTRIES + 5 }, (_, i): OnboardingTap => ({ when: 'intro', tap: { text: `Next ${i}` } }))
    const merged = mergeOnboarding([], many)
    expect(merged.taps).toHaveLength(MAX_ONBOARDING_ENTRIES)
    expect(merged.dropped).toBe(5)
    expect(mergeOnboarding([{ when: 'consent', tap: { text: 'Skip' } }], [skip]).taps, 'same locator, other kind: a different tap').toHaveLength(2)
  })
})
