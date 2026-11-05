import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { parseUiDump } from './hierarchy'
import { clearLine, locateOnApp, MAX_SIGN_IN_VALUE, resolveSignIn, signInReference, typeLines, type SignInSpec } from './sign-in'

/**
 * The pure half of the profile's sign_in section (roadmap M2, last slice): which references it needs, how values are
 * resolved and refused, the exact `input` lines sent to the device's shell, and which element a locator may tap.
 */

const spec: SignInSpec = {
  fields: [
    { field: { resource_id: 'dev.nawi.sample:id/email' }, value: '${env.TEST_EMAIL}' },
    { field: { resource_id: 'dev.nawi.sample:id/password' }, value: '${ secret.app_pw }' }
  ],
  submit: { text: 'Sign in' }
}

/** Undo the device shell's single quoting and `input text`'s %s rule, as the device would. */
function typedBy(lines: string[]): string {
  return lines
    .map((l) => {
      const m = /^input text '((?:[^']|'\\'')*)'$/.exec(l)
      if (!m) throw new Error(`not one quoted argument: ${l}`)
      const arg = m[1].replace(/'\\''/g, "'")
      expect(arg.includes('%s'), `piece ${JSON.stringify(arg)} would turn %s into a space`).toBe(false)
      return arg
    })
    .join('')
}

describe('sign_in references and values', () => {
  it.each([
    ['${env.TEST_EMAIL}', { ns: 'env', name: 'TEST_EMAIL' }],
    ['${ secret.app_pw }', { ns: 'secret', name: 'app_pw' }],
    ['${vars.email}', null],
    ['qa+${env.RUN}@example.test', null],
    ['${env.A}${env.B}', null],
    ['hunter2', null]
  ])('reads %s as a sign-in reference: %j', (value, want) => {
    expect(signInReference(value)).toEqual(want)
  })

  it('resolves values from the call and lists the secret ones (to scrub from reports)', () => {
    expect(resolveSignIn(spec, { env: { TEST_EMAIL: 'qa@example.test' }, secrets: { app_pw: "p'w %s" } })).toEqual({ ok: true, values: ['qa@example.test', "p'w %s"], secrets: [['app_pw', "p'w %s"]] })
  })

  it('names every reference the call did not give, without the values it did', () => {
    const r = resolveSignIn(spec, { env: {}, secrets: { other: 'x' } })
    expect(r).toEqual({ ok: false, missing: ['env.TEST_EMAIL', 'secret.app_pw'], bad: [] })
  })

  it.each([
    ['an empty value', '', '${secret.app_pw} is empty'],
    ['a value input text cannot type', 'pässwört', "${secret.app_pw} has characters a device can't type with `input text` (only printable ASCII)"],
    ['a newline (it would end the shell line)', 'a\nb', "${secret.app_pw} has characters a device can't type with `input text` (only printable ASCII)"],
    ['a value over the length cap', 'x'.repeat(MAX_SIGN_IN_VALUE + 1), `\${secret.app_pw} is longer than ${MAX_SIGN_IN_VALUE} characters`]
  ])('refuses %s, naming the reference but never the value', (_, value, why) => {
    const r = resolveSignIn(spec, { env: { TEST_EMAIL: 'qa@example.test' }, secrets: { app_pw: value } })
    expect(r).toEqual({ ok: false, missing: [], bad: [why] })
  })

  it('refuses a literal value written into a profile by hand', () => {
    const r = resolveSignIn({ fields: [{ field: { text: 'Email' }, value: 'qa@example.test' }], submit: { text: 'Go' } }, {})
    expect(r.ok).toBe(false)
    expect(!r.ok && r.bad[0]).toMatch(/not a single \$\{secret.name\} or \$\{env.NAME\}/)
  })
})

describe('the shell lines that type a value', () => {
  it('quotes the value as one argument and cuts it between % and s', () => {
    expect(typeLines("it's %s 100%")).toEqual(["input text 'it'\\''s %'", "input text 's 100%'"])
    expect(typeLines('%%s%s')).toEqual(["input text '%%'", "input text 's%'", "input text 's'"])
    expect(typeLines('plain')).toEqual(["input text 'plain'"])
  })

  it('types any printable ASCII value exactly, never as shell syntax and never with %s in a piece', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[\x20-\x7e]{1,80}$/), (v) => {
        const lines = typeLines(v)
        expect(typedBy(lines), `typed ${JSON.stringify(v)}`).toBe(v)
      }),
      { seed: 20261105, numRuns: 500 }
    )
  })

  it('clears a field with one keyevent line: to the end, then a delete per character (capped)', () => {
    expect(clearLine(0)).toBeNull()
    expect(clearLine(3)).toBe('input keyevent KEYCODE_MOVE_END KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL')
    expect(clearLine(10_000)?.split(' KEYCODE_DEL')).toHaveLength(MAX_SIGN_IN_VALUE + 1)
  })
})

describe('locateOnApp', () => {
  const PKG = 'dev.nawi.sample'
  const screen = (inner: string, extra = '') =>
    parseUiDump(
      `<hierarchy rotation="0"><node package="${PKG}" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">${inner}</node>${extra}</hierarchy>`
    )
  const email = `<node resource-id="${PKG}:id/email" class="android.widget.EditText" package="${PKG}" text="Email" enabled="true" bounds="[100,500][980,600]"/>`

  it('finds one enabled text field of the app and its center', () => {
    const r = locateOnApp(screen(email), PKG, { resource_id: `${PKG}:id/email` }, 'sign-in field 1', true)
    expect(r.ok && r.at).toEqual({ x: 540, y: 550 })
  })

  it.each([
    ['missing', '', /^no sign-in field 1 matching resource_id "dev.nawi.sample:id\/email" on the screen$/],
    ['twice', email + email, /^2 elements match the sign-in field 1/],
    ['not a text field', email.replace('EditText', 'TextView'), /is a TextView, not a text field$/],
    ['disabled', email.replace('enabled="true"', 'enabled="false"'), /is disabled$/],
    ['without a size', email.replace('[100,500][980,600]', '[100,500][100,600]'), /has no size on screen$/]
  ])('refuses a field that is %s', (_, inner, why) => {
    const r = locateOnApp(screen(inner), PKG, { resource_id: `${PKG}:id/email` }, 'sign-in field 1', true)
    expect(r.ok ? 'found' : r.why).toMatch(why)
  })

  it('never taps an element of another app with the same locator, nor one under the on-screen keyboard', () => {
    const other = `<node package="com.evil" bounds="[0,0][1080,300]"><node resource-id="${PKG}:id/email" class="android.widget.EditText" package="com.evil" enabled="true" bounds="[0,0][1080,300]"/></node>`
    expect(locateOnApp(screen('', other), PKG, { resource_id: `${PKG}:id/email` }, 'field', true).ok).toBe(false)
    const keyboard = `<node package="com.google.android.inputmethod.latin" bounds="[0,1500][1080,2400]"/>`
    const button = `<node text="Sign in" class="android.widget.Button" package="${PKG}" clickable="true" enabled="true" bounds="[100,1800][980,1900]"/>`
    const r = locateOnApp(screen(button, keyboard), PKG, { text: 'Sign in' }, 'sign-in button')
    expect(r.ok ? 'tapped' : r.why).toBe('the sign-in button (text "Sign in") is covered by com.google.android.inputmethod.latin')
  })
})
