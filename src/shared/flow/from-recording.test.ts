import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { flowFromRecording, toFlowSelector, type FlowFromRecordingOptions } from './from-recording'
import { formatFlowErrors, parseFlow, stringifyFlow } from './yaml'

const OPTIONS: FlowFromRecordingOptions = {
  name: 'Log in',
  target: { kind: 'browser', url: 'https://app.example.com/login' }
}

/** Candidate lists in the exact form the page probe + harvest write them. */
const EMAIL = {
  role: 'textbox',
  accessible_name: 'Email',
  bounds: null,
  selectors: [
    { strategy: 'testid', value: '[data-testid="login-email"]', stability: 1 },
    { strategy: 'role_name', value: 'role=textbox[name="Email"]', stability: 0.8 },
    { strategy: 'css', value: 'form.login > input.field', stability: 0.4 },
    { strategy: 'nth_child', value: 'html:nth-of-type(1) > body:nth-of-type(1) > input:nth-of-type(1)', stability: 0.1 }
  ]
}
const PASSWORD = {
  role: 'textbox',
  accessible_name: null,
  bounds: null,
  selectors: [
    { strategy: 'id', value: '#password', stability: 0.9 },
    { strategy: 'css', value: '#password > input', stability: 0.4 }
  ]
}
const SUBMIT = {
  role: 'button',
  accessible_name: 'Sign in',
  bounds: [10, 20, 100, 32],
  selectors: [{ strategy: 'role_name', value: 'role=button[name="Sign in"]', stability: 0.8 }]
}
const COUNTRY = {
  role: 'combobox',
  accessible_name: 'Country',
  bounds: null,
  selectors: [
    { strategy: 'id', value: '#country', stability: 0.9 },
    { strategy: 'css', value: '#country > select', stability: 0.4 }
  ]
}
const TERMS = {
  role: 'checkbox',
  accessible_name: 'I agree',
  bounds: null,
  selectors: [{ strategy: 'id', value: '#terms', stability: 0.9 }]
}

let clock = 0
function ev(type: string, target: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  clock += 10
  return { t_ms: clock, type, coordinates: null, target, value_redacted: false, ...extra }
}
const typed = (target: Record<string, unknown>, text: string) => ev('input', { ...target, text })
const secret = (target: Record<string, unknown>) => ev('input', { ...target, text: null }, { value_redacted: true })

describe('flowFromRecording: a recorded login', () => {
  clock = 0
  const events = [
    ev('click', EMAIL, { coordinates: { x: 5, y: 5 } }),
    typed(EMAIL, 'a'),
    typed(EMAIL, 'al'),
    ev('keydown', EMAIL, { key: 'Backspace' }),
    typed(EMAIL, 'alice@example.com'),
    ev('keydown', EMAIL, { key: 'Shift' }),
    ev('scroll', null, { coordinates: { x: 0, y: 120 } }),
    ev('click', PASSWORD),
    secret(PASSWORD),
    secret(PASSWORD),
    ev('keydown', PASSWORD, { key: 'Enter' }),
    ev('resize', null, { coordinates: { x: 800, y: 600 } }),
    ev('click', SUBMIT)
  ]
  const result = flowFromRecording(events, OPTIONS)

  it('turns typing into one fill per field, keeps Enter and the button click, drops the noise', () => {
    expect(result.flow.steps, `steps were:\n${stringifyFlow(result.flow)}`).toEqual([
      {
        id: 's1',
        action: 'fill',
        target: {
          selectors: [
            { testid: 'login-email' },
            { role: 'textbox', name: 'Email' },
            { css: 'form.login > input.field' },
            { css: 'html:nth-of-type(1) > body:nth-of-type(1) > input:nth-of-type(1)' }
          ]
        },
        value: 'alice@example.com',
        note: 'Fill "Email"'
      },
      {
        id: 's2',
        action: 'fill',
        target: { selectors: [{ id: 'password' }, { css: '#password > input' }] },
        value: '${secret.password}',
        note: 'Fill the textbox (secret, supplied at run time)'
      },
      {
        id: 's3',
        action: 'press',
        target: { selectors: [{ id: 'password' }, { css: '#password > input' }] },
        key: 'Enter',
        note: 'Press Enter in the textbox'
      },
      {
        id: 's4',
        action: 'click',
        target: { selectors: [{ role: 'button', name: 'Sign in' }], bbox: [10, 20, 100, 32] },
        note: 'Click "Sign in"'
      }
    ])
  })

  it('counts every event it left out, by reason', () => {
    expect(result.skipped).toEqual({
      focus_click: 2,
      editing_key: 1,
      modifier_key: 1,
      scroll: 1,
      resize: 1
    })
    expect(result.merged, 'two extra email inputs and one extra password input fold into their fills').toBe(3)
  })

  it('names the secrets the run needs', () => {
    expect(result.warnings).toEqual(['Supply these secrets at run time: secret.password.'])
  })

  it('writes YAML that parses back to the same flow', () => {
    const text = stringifyFlow(result.flow)
    const back = parseFlow(text)
    expect(back.ok, back.ok ? '' : formatFlowErrors(back.errors)).toBe(true)
    if (back.ok) expect(back.flow).toEqual(result.flow)
  })
})

describe('flowFromRecording: secrets', () => {
  it('ignores a value on an event marked redacted (a hand-edited or forged line)', () => {
    const forged = { t_ms: 1, type: 'input', target: { ...PASSWORD, text: 'hunter2' }, value_redacted: true }
    const { flow } = flowFromRecording([forged], OPTIONS)
    const yaml = stringifyFlow(flow)
    expect(yaml.includes('hunter2'), `the redacted value leaked into the flow:\n${yaml}`).toBe(false)
    expect(flow.steps[0]).toMatchObject({ action: 'fill', value: '${secret.password}' })
  })

  it('gives two different secret fields with the same label different names, and one field one name', () => {
    const pinA = { ...PASSWORD, selectors: [{ strategy: 'role_name', value: 'role=textbox[name="PIN"]' }] }
    const pinB = { ...PASSWORD, selectors: [{ strategy: 'role_name', value: 'role=textbox[name="PIN"]' }, { strategy: 'css', value: 'div > input.b' }] }
    clock = 0
    const { flow, warnings } = flowFromRecording([secret(pinA), secret(pinB), ev('click', SUBMIT), secret(pinA)], OPTIONS)
    const values = flow.steps.flatMap((s) => ('value' in s ? [s.value] : []))
    expect(values).toEqual(['${secret.pin}', '${secret.pin_2}', '${secret.pin}'])
    expect(warnings).toContain('Supply these secrets at run time: secret.pin, secret.pin_2.')
  })

  it('falls back to "secret" when the field has no readable locator, and avoids reserved names', () => {
    const cssOnly = { ...PASSWORD, selectors: [{ strategy: 'css', value: 'div > input' }] }
    const reserved = { ...PASSWORD, selectors: [{ strategy: 'id', value: '#constructor' }] }
    clock = 0
    const { flow } = flowFromRecording([secret(cssOnly), secret(reserved)], OPTIONS)
    expect(flow.steps.map((s) => ('value' in s ? s.value : null))).toEqual(['${secret.secret}', '${secret.constructor_value}'])
  })
})

describe('flowFromRecording: other controls', () => {
  it('records a <select> as a select step holding the final option', () => {
    clock = 0
    const { flow, merged } = flowFromRecording(
      [ev('click', COUNTRY), typed(COUNTRY, 'pe'), ev('keydown', COUNTRY, { key: 'ArrowDown' }), typed(COUNTRY, 'cl')],
      OPTIONS
    )
    expect(flow.steps).toEqual([
      {
        id: 's1',
        action: 'select',
        target: { selectors: [{ id: 'country' }, { css: '#country > select' }] },
        value: 'cl',
        note: 'Choose an option in "Country"'
      }
    ])
    expect(merged).toBe(1)
  })

  it('keeps the click on a checkbox and drops the input event it fires', () => {
    clock = 0
    const { flow, skipped } = flowFromRecording([ev('click', TERMS), typed(TERMS, 'on')], OPTIONS)
    expect(flow.steps.map((s) => s.action)).toEqual(['click'])
    expect(skipped).toEqual({ toggle_input: 1 })
  })

  it('keeps a key pressed outside any field as a press without a target', () => {
    const { flow } = flowFromRecording([{ t_ms: 1, type: 'keydown', target: null, key: 'Escape', value_redacted: false }], OPTIONS)
    expect(flow.steps).toEqual([{ id: 's1', action: 'press', key: 'Escape', note: 'Press Escape' }])
  })

  it('starts a new fill when the user comes back to a field after doing something else', () => {
    clock = 0
    const { flow } = flowFromRecording([typed(EMAIL, 'a'), ev('click', SUBMIT), typed(EMAIL, 'b')], OPTIONS)
    expect(flow.steps.map((s) => [s.action, 'value' in s ? s.value : null])).toEqual([
      ['fill', 'a'],
      ['click', null],
      ['fill', 'b']
    ])
  })
})

describe('flowFromRecording: untrusted input', () => {
  it('skips malformed lines instead of throwing', () => {
    const { flow, skipped } = flowFromRecording(
      [
        null,
        'click',
        { type: 'click', target: SUBMIT },
        { t_ms: Number.NaN, type: 'click', target: SUBMIT },
        { t_ms: 1, type: 'keydown', target: null, key: 'a' },
        { t_ms: 2, type: 'keydown', target: null, key: '${env.HOME}' },
        { t_ms: 3, type: 'keydown', target: null },
        { t_ms: 4, type: 'click', target: { selectors: 'nope' } },
        { t_ms: 5, type: 'click', target: { selectors: [{ strategy: 'xpath', value: '//a' }, 7] } },
        { t_ms: 6, type: 'navigate', target: null },
        { t_ms: 7, type: 'click', target: SUBMIT }
      ],
      OPTIONS
    )
    expect(flow.steps.map((s) => s.action)).toEqual(['click'])
    expect(skipped).toEqual({ malformed: 8, no_target: 1, unsupported: 1 })
  })

  it('orders steps by time, not by file order', () => {
    const { flow } = flowFromRecording(
      [
        { t_ms: 20, type: 'click', target: SUBMIT },
        { t_ms: 10, type: 'input', target: { ...EMAIL, text: 'x' }, value_redacted: false }
      ],
      OPTIONS
    )
    expect(flow.steps.map((s) => s.action)).toEqual(['fill', 'click'])
  })

  it('leaves out a typed value containing "${" with a warning, since it would read as a placeholder', () => {
    const { flow, skipped, warnings } = flowFromRecording(
      [{ t_ms: 1, type: 'input', target: { ...EMAIL, text: 'cost ${price}' }, value_redacted: false }],
      OPTIONS
    )
    expect(flow.steps).toEqual([])
    expect(skipped).toEqual({ placeholder_text: 1 })
    expect(warnings[0]).toMatch(/contains "\$\{".*left out/)
  })

  it('percent-encodes "$" in a start URL that would read as a placeholder', () => {
    const { flow, warnings } = flowFromRecording([], { name: 'x', target: { kind: 'browser', url: 'https://x.test/?q=${a}' } })
    expect(flow.target).toEqual({ kind: 'browser', url: 'https://x.test/?q=%24{a}' })
    expect(warnings).toContain('No replayable steps were found in this recording.')
  })
})

describe('toFlowSelector', () => {
  it.each([
    ['testid', '[data-testid="save"]', { testid: 'save' }],
    ['testid', '[data-testid="say \\"hi\\""]', { testid: 'say "hi"' }],
    ['testid', '[data-qa="save"]', { css: '[data-qa="save"]' }],
    ['id', '#email', { id: 'email' }],
    ['id', '#\\31 23', { css: '#\\31 23' }],
    ['role_name', 'role=button[name="Save \\"draft\\""]', { role: 'button', name: 'Save "draft"' }],
    ['role-name', 'role=link[name="Home"]', { role: 'link', name: 'Home' }],
    ['css', 'main > button.primary', { css: 'main > button.primary' }],
    ['nth_child', 'body:nth-of-type(1) > a:nth-of-type(2)', { css: 'body:nth-of-type(1) > a:nth-of-type(2)' }]
  ])('maps %s %s', (strategy, value, expected) => {
    expect(toFlowSelector(strategy, value)).toEqual(expected)
  })

  it.each([
    ['role_name', 'button "Save"'],
    ['xpath', '//button'],
    ['css', '   ']
  ])('refuses %s %s', (strategy, value) => {
    expect(toFlowSelector(strategy, value)).toBeNull()
  })
})

describe('flowFromRecording: properties', () => {
  const text = fc.string({ maxLength: 12 })
  const candidate = fc.oneof(
    fc.record({ strategy: fc.constant('testid'), value: text.map((t) => `[data-testid="${t}"]`) }),
    fc.record({ strategy: fc.constant('id'), value: text.map((t) => `#${t}`) }),
    fc.record({ strategy: fc.constant('role_name'), value: fc.tuple(fc.constantFrom('button', 'textbox', 'link'), text).map(([r, n]) => `role=${r}[name="${n}"]`) }),
    fc.record({ strategy: fc.constantFrom('css', 'nth_child', 'xpath'), value: text })
  )
  const target = fc.option(
    fc.record({
      role: fc.option(fc.constantFrom('textbox', 'button', 'checkbox', 'combobox', 'link', ''), { nil: null }),
      accessible_name: fc.option(text, { nil: null }),
      text: fc.option(text, { nil: null }),
      bounds: fc.option(fc.array(fc.integer({ min: -50, max: 2000 }), { minLength: 4, maxLength: 4 }), { nil: null }),
      selectors: fc.array(candidate, { maxLength: 4 })
    }),
    { nil: null }
  )
  const event = fc.record({
    t_ms: fc.integer({ min: 0, max: 1000 }),
    type: fc.constantFrom('click', 'input', 'keydown', 'scroll', 'resize', 'navigate'),
    target,
    value_redacted: fc.boolean(),
    key: fc.constantFrom('Enter', 'Tab', 'Escape', 'Shift', 'Backspace', 'ArrowDown', 'a')
  })

  it('always yields a flow that writes and parses back unchanged, and never contains a redacted value', () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), (events) => {
        const { flow } = flowFromRecording(events, OPTIONS)
        const yaml = stringifyFlow(flow)
        const back = parseFlow(yaml)
        if (!back.ok) throw new Error(`written flow does not parse:\n${formatFlowErrors(back.errors)}\n${yaml}`)
        expect(back.flow).toEqual(flow)
        for (const e of events) {
          const leaked = e.value_redacted && e.type === 'input' && e.target?.text && e.target.text.length >= 4
            ? flow.steps.some((s) => 'value' in s && s.value === e.target?.text)
            : false
          expect(leaked, `redacted value ${JSON.stringify(e.target?.text)} became a step value`).toBe(false)
        }
      }),
      { numRuns: 300, seed: 20261101 }
    )
  })
})
