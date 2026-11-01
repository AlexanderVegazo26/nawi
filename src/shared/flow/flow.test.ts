import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FLOW_ACTIONS, type Flow, type FlowStep, type Selector } from './schema'
import { formatFlowDocument, formatFlowErrors, parseFlow, stringifyFlow, type FlowError } from './yaml'

const LOGIN = `# login flow
version: 1
name: Log in
target: { kind: browser, url: "https://app.example.com/login" } # start here
vars:
  email: "\${env.TEST_EMAIL}"
steps:
  - id: s1
    action: fill
    target:
      selectors: [ { testid: login-email }, { role: textbox, name: Email } ]
    value: "\${vars.email}" # from the environment
  # submit
  - { id: s2, action: press, key: Enter }
`

function errorsOf(text: string): FlowError[] {
  const r = parseFlow(text)
  expect(r.ok, `expected this flow to be rejected:\n${text}`).toBe(false)
  return r.ok ? [] : r.errors
}

/** The single error a broken flow should produce, with a readable failure if it doesn't. */
function onlyError(text: string): FlowError {
  const errors = errorsOf(text)
  expect(errors, `expected exactly one error, got:\n${formatFlowErrors(errors)}`).toHaveLength(1)
  return errors[0]
}

/** LOGIN with one line replaced, so each case states only what it breaks. */
function loginWith(find: string, replace: string): string {
  expect(LOGIN.includes(find), `LOGIN fixture no longer contains ${JSON.stringify(find)}`).toBe(true)
  return LOGIN.replace(find, replace)
}

describe('flow files — parse', () => {
  it('parses a valid flow into typed steps', () => {
    const r = parseFlow(LOGIN)
    if (!r.ok) throw new Error(`LOGIN should parse:\n${formatFlowErrors(r.errors)}`)
    expect(r.flow.target).toEqual({ kind: 'browser', url: 'https://app.example.com/login' })
    expect(r.flow.steps.map((s) => s.action)).toEqual(['fill', 'press'])
    expect(r.flow.steps[0]).toMatchObject({
      value: '${vars.email}',
      target: { selectors: [{ testid: 'login-email' }, { role: 'textbox', name: 'Email' }] }
    })
  })

  it('writes an unedited document back byte for byte, comments included', () => {
    const r = parseFlow(LOGIN)
    if (!r.ok) throw new Error(formatFlowErrors(r.errors))
    expect(formatFlowDocument(r.document)).toBe(LOGIN)
  })

  it('keeps comments, quoting and inline style when one value is edited through the document', () => {
    const r = parseFlow(LOGIN)
    if (!r.ok) throw new Error(formatFlowErrors(r.errors))
    r.document.setIn(['steps', 1, 'key'], 'Tab')
    const edited = formatFlowDocument(r.document)
    expect(edited).toBe(LOGIN.replace('key: Enter', 'key: Tab'))
    const again = parseFlow(edited)
    expect(again.ok && again.flow.steps[1]).toMatchObject({ action: 'press', key: 'Tab' })
  })
})

describe('flow files — validation errors carry path and line:col', () => {
  it('names an unknown key at the key itself (a typo is not silently ignored)', () => {
    const text = loginWith('      selectors: [', '      selector: [')
    const errors = errorsOf(text)
    expect(errors).toContainEqual({ path: 'steps[0].target.selector', message: 'unknown key "selector"', line: 11, col: 7 })
  })

  it('points an unknown key that is not first in its map at that key, and still reports what it should have been', () => {
    const errors = errorsOf(loginWith('    value: "${vars.email}"', '    valeu: "${vars.email}"'))
    expect(errors, formatFlowErrors(errors)).toEqual([
      { path: 'steps[0].value', message: expect.stringContaining('expected string'), line: 8, col: 5 },
      { path: 'steps[0].valeu', message: 'unknown key "valeu"', line: 12, col: 5 }
    ])
  })

  it('rejects a fill step without a value, pointing at the step', () => {
    const e = onlyError(loginWith('    value: "${vars.email}" # from the environment\n', ''))
    expect(e).toMatchObject({ path: 'steps[0].value', line: 8, col: 5 })
  })

  it('rejects a duplicate step id, naming the first use', () => {
    const e = onlyError(loginWith('{ id: s2,', '{ id: s1,'))
    expect(e).toEqual({
      path: 'steps[1].id',
      message: 'duplicate step id "s1" (first used by steps[0])',
      line: 14,
      col: 11
    })
  })

  it('rejects a reference to an undeclared var', () => {
    const e = onlyError(loginWith('"${vars.email}" #', '"${vars.mail}" #'))
    expect(e).toMatchObject({ path: 'steps[0].value', line: 12, col: 12 })
    expect(e.message).toContain('declare "mail" under vars')
  })

  it('rejects an unknown placeholder namespace and a var that references another var', () => {
    const errors = errorsOf(
      loginWith('  email: "${env.TEST_EMAIL}"', '  email: "${vars.other}"\n  other: "${secrets.x}"')
    )
    expect(errors.map((e) => [e.path, e.line])).toEqual([
      ['vars.email', 6],
      ['vars.other', 7]
    ])
    expect(errors[0].message).toContain('may only reference env or secret')
    expect(errors[1].message).toContain('unknown namespace "secrets"')
  })

  it('rejects a version this build cannot read', () => {
    const e = onlyError(loginWith('version: 1', 'version: 2'))
    expect(e).toMatchObject({ path: 'version', line: 2, col: 10 })
    expect(e.message).toContain('must be 1')
  })

  it('rejects an unknown action at its step', () => {
    const e = onlyError(loginWith('action: press', 'action: tap'))
    expect(e.path).toBe('steps[1].action')
    expect(e.line).toBe(14)
  })

  it('rejects an element assertion without a target', () => {
    const e = onlyError(LOGIN + '  - { id: s3, action: assert, expect: { visible: true } }\n')
    expect(e).toMatchObject({ path: 'steps[2]', line: 15, col: 5 })
    expect(e.message).toContain('needs a target')
  })

  it('accepts a URL assertion without a target', () => {
    const r = parseFlow(LOGIN + '  - { id: s3, action: assert, expect: { url: "https://app.example.com/home" } }\n')
    expect(r.ok, r.ok ? '' : formatFlowErrors(r.errors)).toBe(true)
  })

  it('checks placeholders in assertion expectations too', () => {
    const errors = errorsOf(
      LOGIN +
        '  - { id: s3, action: assert, expect: { url: "${vars.bse}/home" } }\n' +
        '  - id: s4\n    action: assert\n    target: { selectors: [ { role: status } ] }\n    expect: { text: "Hi ${user.name}" }\n'
    )
    expect(errors.map((e) => [e.path, e.line]), formatFlowErrors(errors)).toEqual([
      ['steps[2].expect.url', 15],
      ['steps[3].expect.text', 19]
    ])
    expect(errors[0].message).toContain('declare "bse" under vars')
    expect(errors[1].message).toContain('unknown namespace "user"')
  })

  it('refuses __proto__ (and other reserved names) as a key instead of silently dropping it', () => {
    const e = onlyError(loginWith('  email: "${env.TEST_EMAIL}"', '  email: "${env.TEST_EMAIL}"\n  __proto__: "${env.X}"'))
    expect(e).toMatchObject({ path: '(yaml)', line: 7, col: 3 })
    expect(e.message).toContain('"__proto__" is a reserved name')
    expect(onlyError(loginWith('  email: "${env.TEST_EMAIL}"', '  constructor: x\n  email: "${env.TEST_EMAIL}"')).line).toBe(6)
  })

  it('refuses a reserved var name on write, so nothing it writes fails to read', () => {
    const flow: Flow = { version: 1, name: 'x', target: { kind: 'desktop', app: 'A' }, vars: { constructor: 'x' }, steps: [] }
    expect(() => stringifyFlow(flow)).toThrow(/reserved name/)
  })

  it('refuses __proto__ reached through an alias key', () => {
    const errors = errorsOf(loginWith('  email: "${env.TEST_EMAIL}"', '  email: "${env.TEST_EMAIL}"\n  *k : x').replace('# login flow', '# login flow\nx-anchor: &k __proto__'))
    expect(errors.map((e) => e.message).join('\n')).toContain('"__proto__" is a reserved name')
  })

  it.each([
    ['../outside.png'],
    ['steps/../../etc/passwd'],
    ['/etc/passwd'],
    ['C:\\Users\\me\\x.png'],
    ['\\\\server\\share\\x.png'],
    ['file:///etc/passwd'],
    ['https://example.com/x.png'],
    ['%2e%2e/outside.png'],
    ['steps/%2E%2E%2Fx.png'],
    ['steps/x\u0000.png']
  ])('rejects a reference image path outside the flow folder: %s', (image) => {
    const text = loginWith(
      '      selectors: [ { testid: login-email }, { role: textbox, name: Email } ]',
      `      selectors: [ { testid: login-email }, { role: textbox, name: Email } ]\n      image: ${JSON.stringify(image)}`
    )
    const e = onlyError(text)
    expect(e).toMatchObject({ path: 'steps[0].target.image', line: 12 })
    expect(e.message).toContain('relative path inside the flow')
  })

  it('accepts a reference image path inside the flow folder', () => {
    const text = loginWith(
      '      selectors: [ { testid: login-email }, { role: textbox, name: Email } ]',
      '      selectors: [ { testid: login-email }, { role: textbox, name: Email } ]\n      image: steps/s1..v2.png'
    )
    const r = parseFlow(text)
    expect(r.ok, r.ok ? '' : formatFlowErrors(r.errors)).toBe(true)
  })

  it('rejects a blank selector value', () => {
    const e = onlyError(loginWith('{ testid: login-email }', '{ testid: " " }'))
    expect(e).toMatchObject({ path: 'steps[0].target.selectors[0].testid', line: 11, col: 30 })
  })

  it('reports YAML syntax errors and duplicate keys with their position', () => {
    expect(onlyError(loginWith('name: Log in', 'name: Log in\nname: Again'))).toMatchObject({ path: '(yaml)', line: 4 })
    expect(errorsOf(loginWith('  - { id: s2, action: press, key: Enter }', '  - { id: s2, action: press')).length).toBeGreaterThan(0)
  })

  it('rejects an empty file and a file with several documents', () => {
    expect(onlyError('')).toMatchObject({ path: '(root)', line: 1, col: 1 })
    expect(errorsOf(LOGIN + '---\nversion: 1\n')[0].path).toBe('(yaml)')
  })

  it('formats errors as file:line:col path: message', () => {
    const errors = errorsOf(loginWith('version: 1', 'version: 2'))
    expect(formatFlowErrors(errors, 'login.nawi.yaml')).toMatch(/^login\.nawi\.yaml:2:10 version: /)
  })
})

describe('flow files — stringify', () => {
  it('writes selectors and boxes inline and long values unfolded', () => {
    const flow: Flow = {
      version: 1,
      name: 'Box',
      target: { kind: 'desktop', app: 'Notes' },
      steps: [
        {
          id: 'a',
          action: 'click',
          target: { selectors: [{ role: 'button', name: 'Save' }], bbox: [1, 2, 3, 4] },
          note: 'x'.repeat(200)
        }
      ]
    }
    const text = stringifyFlow(flow)
    expect(text).toContain('- { role: button, name: Save }')
    expect(text).toContain('bbox: [ 1, 2, 3, 4 ]')
    expect(text).toContain(`note: ${'x'.repeat(200)}\n`)
  })

  it('refuses to write an invalid flow', () => {
    const bad = { version: 1, name: 'x', target: { kind: 'desktop', app: 'A' }, steps: [{ id: 'a', action: 'fill' }] }
    expect(() => stringifyFlow(bad as unknown as Flow)).toThrow()
  })
})

/* ------------------------------------------------------------------ *
 * Property: any valid flow survives stringify → parse unchanged.
 * ------------------------------------------------------------------ */

// Text that YAML must quote or escape: colons, hashes, quotes, leading
// indicators, unicode, newlines, things that look like numbers/booleans.
const tricky = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom('yes', 'no', 'null', '~', '1.0', '0x1F', '- a', ': b', '# c', "'q'", '"dq"', 'a\nb', ' lead', 'trail ', '@x', '*y', '&z', '%', '{}', '[]', 'ñandú 雪'),
  fc.string({ unit: 'grapheme', maxLength: 10 })
)
const visible = tricky.filter((s) => /\S/.test(s))
const noPlaceholder = tricky.filter((s) => !s.includes('${'))
// Reserved names are deliberately NOT filtered out: the arbitrary includes them
// (stringify must refuse them, see the property below), so nothing here hides a
// flow that writes but does not read back.
const name = fc.oneof(
  { weight: 9, arbitrary: fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/) },
  { weight: 1, arbitrary: fc.constantFrom('__proto__', 'constructor', 'prototype') }
)
const assetPath = fc
  .array(fc.stringMatching(/^[A-Za-z0-9_ -][A-Za-z0-9_. -]{0,8}$/).filter((seg) => seg !== '..'), { minLength: 1, maxLength: 3 })
  .map((segs) => segs.join('/'))
  .filter((p) => /\S/.test(p) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p))

const selector: fc.Arbitrary<Selector> = fc.oneof(
  visible.map((v) => ({ testid: v })),
  visible.map((v) => ({ id: v })),
  fc.record({ role: visible, name: tricky }, { requiredKeys: ['role'] }),
  visible.map((v) => ({ css: v }))
)

const px = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 })
const size = fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1e6 })
const target = fc.record(
  {
    selectors: fc.array(selector, { minLength: 1, maxLength: 3 }),
    bbox: fc.tuple(px, px, size, size),
    image: assetPath
  },
  { requiredKeys: ['selectors'] }
)

function stepFor(id: string, action: (typeof FLOW_ACTIONS)[number]): fc.Arbitrary<FlowStep> {
  const common = fc.record(
    { note: tricky, disabled: fc.boolean(), timeout_ms: fc.integer({ min: 1, max: 600_000 }) },
    { requiredKeys: [] }
  )
  const value = fc.oneof(tricky.filter((s) => !s.includes('${')), fc.constant('${vars.v0}'), fc.constant('pre ${secret.pw} post'))
  const extra: fc.Arbitrary<Record<string, unknown>> = (() => {
    switch (action) {
      case 'click':
      case 'hover':
        return fc.record({ target })
      case 'fill':
      case 'select':
        return fc.record({ target, value })
      case 'press':
        return fc.record({ target, key: visible.filter((s) => !s.includes('${')) }, { requiredKeys: ['key'] })
      case 'scroll':
        return fc.record({ target, delta: fc.tuple(px, px) }, { requiredKeys: [] })
      case 'navigate':
        return fc.record({ url: fc.constantFrom('https://example.com/a?b=c#d', '${env.BASE_URL}/x') })
      case 'wait':
        return fc.oneof(fc.record({ target }), fc.record({ ms: fc.integer({ min: 1, max: 600_000 }) }))
      case 'assert':
        return fc.oneof(
          fc.record({ target, expect: fc.record({ visible: fc.boolean(), text: noPlaceholder }, { requiredKeys: ['visible'] }) }),
          fc.record({ expect: fc.record({ url: fc.oneof(noPlaceholder, fc.constant('${env.BASE_URL}/done')) }) })
        )
      case 'screenshot':
        return fc.record({ target }, { requiredKeys: [] })
    }
  })()
  return fc.tuple(common, extra).map(([c, e]) => ({ id, action, ...c, ...e }) as FlowStep)
}

const flowArb: fc.Arbitrary<Flow> = fc
  .tuple(
    visible,
    fc.option(tricky, { nil: undefined }),
    fc.oneof(
      fc.record({ kind: fc.constant('browser' as const), url: visible.filter((s) => !s.includes('${')) }),
      fc.record({ kind: fc.constant('desktop' as const), app: visible })
    ),
    fc.dictionary(name, fc.oneof(tricky.filter((s) => !s.includes('${')), fc.constant('${env.X}')), { maxKeys: 3 }),
    fc.array(fc.constantFrom(...FLOW_ACTIONS), { maxLength: 8 })
  )
  .chain(([flowName, description, flowTarget, vars, actions]) =>
    fc.tuple(...actions.map((a, i) => stepFor(`s${i + 1}`, a))).map((steps) => {
      const flow: Flow = {
        version: 1,
        name: flowName,
        target: flowTarget,
        vars: { v0: 'default', ...vars },
        steps
      }
      if (description !== undefined) flow.description = description
      return flow
    })
  )

describe('flow files — round trip (property)', () => {
  it('stringify either refuses the flow or writes text that parses back to it, stably', () => {
    let refused = 0
    fc.assert(
      fc.property(flowArb, (flow) => {
        const reserved = Object.keys(flow.vars ?? {}).filter((k) => ['__proto__', 'constructor', 'prototype'].includes(k))
        if (reserved.length > 0) {
          refused += 1
          expect(() => stringifyFlow(flow), `vars ${reserved.join(', ')} must be refused on write`).toThrow(/reserved name/)
          return
        }
        const text = stringifyFlow(flow)
        const r = parseFlow(text)
        if (!r.ok) throw new Error(`stringified flow did not parse:\n${formatFlowErrors(r.errors)}\n---\n${text}`)
        expect(r.flow, `round trip changed the flow; text was:\n${text}`).toEqual(flow)
        expect(stringifyFlow(r.flow)).toBe(text)
        expect(formatFlowDocument(r.document)).toBe(text)
      }),
      { seed: 20261031, numRuns: 300 }
    )
    expect(refused, 'the arbitrary should exercise reserved var names').toBeGreaterThan(0)
  })
})
