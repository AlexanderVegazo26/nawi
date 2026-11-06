import { describe, expect, it } from 'vitest'
import {
  BASE_STABILITY,
  distinctStrategies,
  isGeneratedId,
  isHashedClassName,
  rankCandidates,
  scoreCandidate,
  type SelectorDescriptor
} from './selectors'

/**
 * The descriptor set `probe.js` produces for PRD §6.3's FR-STA.6 acceptance
 * element: `<button data-testid="submit" id="s1" class="btn btn-primary">Save</button>`.
 * Uniqueness values are what a live DOM containing only that button reports.
 */
const acceptanceButton: SelectorDescriptor[] = [
  { strategy: 'testid', selector: '[data-testid="submit"]', unique: true },
  { strategy: 'id', selector: '#s1', unique: true, id: 's1' },
  { strategy: 'role-name', selector: 'role=button[name="Save"]', unique: true, role: 'button', name: 'Save' },
  { strategy: 'css', selector: 'body > button.btn', unique: true, classNames: ['btn', 'btn-primary'] },
  { strategy: 'nth-child', selector: 'body:nth-of-type(1) > button:nth-of-type(1)', unique: true }
]

describe('FR-STA.6 acceptance', () => {
  const ranked = rankCandidates(acceptanceButton)

  it('ranks the data-testid candidate first', () => {
    expect(ranked[0]?.selector).toBe('[data-testid="submit"]')
  })

  it('emits at least three distinct candidate strategies', () => {
    expect(distinctStrategies(ranked).length).toBeGreaterThanOrEqual(3)
  })

  it('annotates every candidate with a stability score inside [0,1]', () => {
    for (const candidate of ranked) {
      expect(candidate.stability).toBeGreaterThanOrEqual(0)
      expect(candidate.stability).toBeLessThanOrEqual(1)
    }
  })

  it('emits all candidates, not just the winner', () => {
    expect(ranked).toHaveLength(acceptanceButton.length)
  })

  it('orders strictly descending by stability', () => {
    const scores = ranked.map((r) => r.stability)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('uses the FR-STA.6 base ordering for a clean element', () => {
    expect(ranked.map((r) => r.strategy)).toEqual(['testid', 'id', 'role-name', 'css', 'nth-child'])
  })
})

describe('generated-id detection', () => {
  it.each([':r1a:', ':R2ab:', 'ember1234', 'input-8821', '9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f', 'user12345', 'a1b2c3d4e5'])(
    'flags %s as generated',
    (id) => {
      expect(isGeneratedId(id)).toBe(true)
    }
  )

  it.each(['s1', 'submit', 'main-nav', 'email', 'login-form', 'step2'])('leaves %s alone', (id) => {
    expect(isGeneratedId(id)).toBe(false)
  })

  it('drops a generated id well below a hand-written one', () => {
    const generated = scoreCandidate({ strategy: 'id', selector: '#:r1a:', unique: true, id: ':r1a:' })
    const authored = scoreCandidate({ strategy: 'id', selector: '#s1', unique: true, id: 's1' })
    expect(generated.stability).toBeCloseTo(0.35)
    expect(authored.stability).toBeCloseTo(BASE_STABILITY.id)
    expect(generated.penalties).toContain('generated-id')
  })

  it('ranks a role+name candidate above a generated id', () => {
    const ranked = rankCandidates([
      { strategy: 'id', selector: '#:r1a:', unique: true, id: ':r1a:' },
      { strategy: 'role-name', selector: 'role=button[name="Save"]', unique: true }
    ])
    expect(ranked[0]?.strategy).toBe('role-name')
  })
})

describe('hashed class names', () => {
  it.each(['css-1q2w3e', 'Button_root__1a2b3', 'sc-bdVaJa', 'aXk29Lmq'])('flags %s', (cls) => {
    expect(isHashedClassName(cls)).toBe(true)
  })

  it.each(['btn', 'btn-primary', 'card', 'nav-item', 'is-active'])('leaves %s alone', (cls) => {
    expect(isHashedClassName(cls)).toBe(false)
  })

  it('penalizes a css selector resting on a hashed class', () => {
    const hashed = scoreCandidate({
      strategy: 'css',
      selector: 'div.css-1q2w3e > button',
      unique: true,
      classNames: ['css-1q2w3e']
    })
    const plain = scoreCandidate({
      strategy: 'css',
      selector: 'div.card > button',
      unique: true,
      classNames: ['card']
    })
    expect(hashed.stability).toBeLessThan(plain.stability)
    expect(hashed.penalties.some((p) => p.startsWith('hashed-class'))).toBe(true)
  })
})

describe('uniqueness', () => {
  it('halves a non-unique candidate', () => {
    const unique = scoreCandidate({ strategy: 'testid', selector: '[data-testid="row"]', unique: true })
    const shared = scoreCandidate({ strategy: 'testid', selector: '[data-testid="row"]', unique: false })
    expect(shared.stability).toBeCloseTo(unique.stability * 0.5)
    expect(shared.penalties).toContain('not-unique')
  })

  it('lets a unique id beat a non-unique testid', () => {
    const ranked = rankCandidates([
      { strategy: 'testid', selector: '[data-testid="row"]', unique: false },
      { strategy: 'id', selector: '#row-a', unique: true, id: 'row-a' }
    ])
    expect(ranked[0]?.strategy).toBe('id')
  })

  it('compounds with the hashed-class penalty and stays in range', () => {
    const worst = scoreCandidate({
      strategy: 'nth-child',
      selector: 'div:nth-of-type(3)',
      unique: false,
      classNames: ['css-1q2w3e']
    })
    expect(worst.stability).toBeGreaterThan(0)
    expect(worst.stability).toBeLessThan(BASE_STABILITY['nth-child'])
  })
})

describe('visible-text candidates (roadmap AI1)', () => {
  const withText: SelectorDescriptor[] = [
    ...acceptanceButton,
    { strategy: 'text', selector: 'Save', unique: true }
  ]

  it('ranks a unique text candidate below role+name and above css', () => {
    const order = rankCandidates(withText).map((r) => r.strategy)
    expect(order, 'FR-STA.6 order with the AI1 text layer').toEqual(['testid', 'id', 'role-name', 'text', 'css', 'nth-child'])
    expect(BASE_STABILITY.text).toBeLessThan(BASE_STABILITY['role-name'])
    expect(BASE_STABILITY.text).toBeGreaterThan(BASE_STABILITY.css)
  })

  it('keeps the text itself as the selector so the flow can carry it verbatim', () => {
    const text = rankCandidates(withText).find((r) => r.strategy === 'text')
    expect(text, 'text candidate survives ranking').toMatchObject({ selector: 'Save', unique: true, penalties: [] })
  })

  it('halves a text candidate that is not unique, like any other strategy', () => {
    const { stability, penalties } = scoreCandidate({ strategy: 'text', selector: 'Edit', unique: false })
    expect(stability).toBeCloseTo(BASE_STABILITY.text * 0.5)
    expect(penalties).toEqual(['not-unique'])
  })
})

describe('rankCandidates hygiene', () => {
  it('drops empty selectors and de-duplicates', () => {
    const ranked = rankCandidates([
      { strategy: 'id', selector: '', unique: true },
      { strategy: 'id', selector: '#a', unique: true, id: 'a' },
      { strategy: 'id', selector: '#a', unique: true, id: 'a' }
    ])
    expect(ranked).toHaveLength(1)
  })

  it('is deterministic when scores tie', () => {
    const input: SelectorDescriptor[] = [
      { strategy: 'nth-child', selector: 'a:nth-of-type(1)', unique: true },
      { strategy: 'testid', selector: '[data-testid="x"]', unique: true }
    ]
    expect(rankCandidates(input).map((r) => r.strategy)).toEqual(
      rankCandidates([...input].reverse()).map((r) => r.strategy)
    )
  })
})
