import { describe, expect, it } from 'vitest'
import { anchorCandidates, MAX_ANCHOR_CANDIDATES } from './anchor-candidates'

/** What probe.describeSelectors answers for a renamed Save button (#store-note, "Store"). */
const BUTTON = [
  { strategy: 'id', selector: '#store-note', unique: true, id: 'store-note' },
  { strategy: 'role-name', selector: 'role=button[name="Store"]', unique: true, role: 'button', name: 'Store' },
  { strategy: 'css', selector: 'form > button.primary', unique: true, classNames: ['primary'] },
  { strategy: 'nth-child', selector: 'body > form:nth-child(1) > button:nth-child(2)', unique: true },
  { strategy: 'testid', selector: '[data-testid="store"]', unique: true }
]

describe('anchorCandidates', () => {
  it('ranks the element\'s locators like a recording and keeps the best MAX_ANCHOR_CANDIDATES as flow locators', () => {
    expect(MAX_ANCHOR_CANDIDATES).toBe(3)
    expect(anchorCandidates(BUTTON)).toEqual([{ testid: 'store' }, { id: 'store-note' }, { role: 'button', name: 'Store' }])
  })

  it('keeps only locators that matched that one element, and never an nth-child path', () => {
    const shared = BUTTON.map((c) => (c.strategy === 'css' || c.strategy === 'nth-child' ? c : { ...c, unique: false }))
    expect(anchorCandidates(shared), 'a non-unique id/role/testid would find another element').toEqual([{ css: 'form > button.primary' }])
    expect(anchorCandidates([BUTTON[3]]), 'nth-child alone gives nothing').toEqual([])
  })

  it('leaves out a generated id and CSS on build-hashed class names (they change on the next render or build)', () => {
    const unstable = [
      { strategy: 'id', selector: '#\\:r1a\\:', unique: true, id: ':r1a:' },
      { strategy: 'id', selector: '#ember1234', unique: true, id: 'ember1234' },
      { strategy: 'css', selector: 'button.css-1q2w3e', unique: true, classNames: ['css-1q2w3e'] },
      BUTTON[1],
      { strategy: 'css', selector: 'form > button.primary', unique: true, classNames: ['primary'] }
    ]
    expect(anchorCandidates(unstable)).toEqual([{ role: 'button', name: 'Store' }, { css: 'form > button.primary' }])
  })

  it('leaves out page text holding ${ (a flow would read it as a placeholder)', () => {
    const page = [
      { strategy: 'text', selector: 'Pay ${amount}', unique: true },
      { strategy: 'role-name', selector: 'role=button[name="Use ${env.X}"]', unique: true, role: 'button', name: 'Use ${env.X}' },
      BUTTON[0]
    ]
    expect(anchorCandidates(page)).toEqual([{ id: 'store-note' }])
  })

  it('drops a candidate holding one of the run\'s secret values instead of scrubbing it (a scrubbed locator would not match)', () => {
    const page = [
      { strategy: 'text', selector: 'Signed in as ada@example.com', unique: true },
      { strategy: 'role-name', selector: 'role=button[name="Account"]', unique: true, role: 'button', name: 'Account' }
    ]
    const redact = (t: string): string => t.replaceAll('ada@example.com', '***')
    expect(anchorCandidates(page, redact)).toEqual([{ role: 'button', name: 'Account' }])
  })

  it('answers [] for anything that is not a list of probe descriptors, and skips malformed entries', () => {
    for (const raw of [null, undefined, 'x', { found: true }, 42]) expect(anchorCandidates(raw), String(raw)).toEqual([])
    const mixed = [null, { strategy: 'xpath', selector: '//button', unique: true }, { strategy: 'id', selector: 3, unique: true }, { strategy: 'css', selector: '   ', unique: true }, BUTTON[0]]
    expect(anchorCandidates(mixed)).toEqual([{ id: 'store-note' }])
  })

  it('does not list the same locator twice (a data-testid also written as CSS)', () => {
    const twice = [BUTTON[4], { strategy: 'css', selector: '[data-testid="store"]', unique: true }, BUTTON[4]]
    expect(anchorCandidates(twice)).toEqual([{ testid: 'store' }, { css: '[data-testid="store"]' }])
  })
})
