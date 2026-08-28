import { describe, expect, it } from 'vitest'
import { createDraft, markUnavailable, setSource } from '@shared/sidecar/draft'
import type { SidecarDraft } from '@shared/sidecar/draft'
import type { Surface } from '@shared/sidecar/types'
import { luhnValid, seal, targetForPath, TIER_A_LEAK_SENTINEL } from './seal'
import type { RevisionFile } from './store'

const SURFACE: Surface = {
  type: 'browser',
  app: 'Chromium',
  url: 'https://example.test/checkout',
  os: 'win32',
  locale: 'en-US',
  viewport: { w: 1280, h: 800, dpr: 1 },
  displays: []
}

function draftWithAllSources(): SidecarDraft {
  const draft = createDraft({
    capture_id: '11111111-2222-4333-8444-555555555555',
    kind: 'screenshot',
    surface: SURFACE,
    generator: 'test'
  })
  setSource(draft, 'dom_snapshot', { t_ms: 0, path: 'dom/snapshot.json' })
  setSource(draft, 'accessibility_tree', { t_ms: 0, path: 'ax/tree.json' })
  setSource(draft, 'console_log', { path: 'console.ndjson', count: 0 })
  setSource(draft, 'network_har', { path: 'network.har', truncated: false })
  setSource(draft, 'input_events', { path: 'input_events.ndjson', count: 0 })
  return draft
}

describe('luhnValid', () => {
  it('accepts real card check digits and rejects near misses', () => {
    expect(luhnValid('4111111111111111')).toBe(true)
    expect(luhnValid('5500 0000 0000 0004')).toBe(true)
    expect(luhnValid('4111111111111112')).toBe(false)
    // A long order number is the false positive the Luhn gate exists to stop.
    expect(luhnValid('1234567890123456')).toBe(false)
  })

  it('rejects lengths outside the card range', () => {
    expect(luhnValid('4111')).toBe(false)
    expect(luhnValid('41111111111111111111')).toBe(false)
  })
})

describe('seal() — Tier B pattern set (FR-AI.3)', () => {
  /** `[id, input, sentinel, the exact substring that must be gone]`. */
  const cases: Array<[string, string, string, string]> = [
    ['email', 'contact alice.smith@example.com now', '[REDACTED:email]', 'alice.smith@example.com'],
    ['phone', 'call +1 415-555-0132 today', '[REDACTED:phone]', '415-555-0132'],
    ['national_id', 'ssn 123-45-6789 on file', '[REDACTED:national_id]', '123-45-6789'],
    ['card_number', 'card 4111111111111111 charged', '[REDACTED:card_number]', '4111111111111111'],
    [
      'api_key',
      'key sk_live_abcdefghij1234567890 used',
      '[REDACTED:api_key]',
      'sk_live_abcdefghij1234567890'
    ],
    [
      'jwt',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      '[REDACTED:jwt]',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    ],
    [
      // The header *name* legitimately survives — it is the credential that must
      // not, and a reader still needs to see that the header was present.
      'authorization',
      'Authorization: Bearer abcdef1234567890',
      '[REDACTED:authorization]',
      'abcdef1234567890'
    ],
    [
      'private_key',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----',
      '[REDACTED:private_key]',
      'MIIEow=='
    ]
  ]

  for (const [id, input, sentinel, mustBeGone] of cases) {
    it(`detects and replaces ${id}`, () => {
      const file: RevisionFile = { path: 'console.ndjson', contents: input }
      const result = seal(draftWithAllSources(), [file])
      const sealedText = result.files[0]!.contents as string

      expect(sealedText).toContain(sentinel)
      expect(result.report.hits.some((h) => h.patternId === id)).toBe(true)
      // The secret itself must be gone, not merely annotated.
      expect(sealedText).not.toContain(mustBeGone)
    })
  }

  it('leaves an unremarkable string untouched', () => {
    const file: RevisionFile = { path: 'console.ndjson', contents: 'the build finished in 4200ms' }
    const result = seal(draftWithAllSources(), [file])
    expect(result.files[0]!.contents).toBe('the build finished in 4200ms')
    expect(result.report.hits).toHaveLength(0)
  })

  it('does not redact a long order number that fails Luhn', () => {
    const file: RevisionFile = { path: 'console.ndjson', contents: 'order 1234567890123456 shipped' }
    const result = seal(draftWithAllSources(), [file])
    expect(result.files[0]!.contents).toContain('1234567890123456')
  })

  it('scans the draft object itself, not only the files', () => {
    const draft = draftWithAllSources()
    draft.derived.summary = 'user signed in as bob@example.org'
    const result = seal(draft, [])
    expect(result.sidecar.derived.summary).toBe('user signed in as [REDACTED:email]')
  })

  it('leaves structural identifiers alone so paths still resolve', () => {
    const draft = draftWithAllSources()
    const result = seal(draft, [])
    expect(result.sidecar.capture_id).toBe('11111111-2222-4333-8444-555555555555')
    expect(result.sidecar.state_layer.dom_snapshot?.path).toBe('dom/snapshot.json')
  })
})

describe('seal() — Tier A failure signalling', () => {
  it('reports a leaked suppressed value as a Tier A failure, NOT an ordinary redaction', () => {
    const secret = 'hunter2-must-never-leave-the-page'
    const file: RevisionFile = { path: 'dom/snapshot.json', contents: `{"v":"${secret}"}` }
    const result = seal(draftWithAllSources(), [file], { suppressedValues: [secret] })

    expect(result.report.tierAFailures).toHaveLength(1)
    expect(result.report.tierAFailures[0]).toMatchObject({
      site: 'dom/snapshot.json',
      valueLength: secret.length,
      count: 1
    })
    // The report must not itself carry the secret it is reporting.
    expect(JSON.stringify(result.report)).not.toContain(secret)
    // And the value is still removed from the bytes.
    expect(result.files[0]!.contents).toContain(TIER_A_LEAK_SENTINEL)
    expect(result.files[0]!.contents).not.toContain(secret)
  })

  it('reports no Tier A failure when Tier A held', () => {
    const file: RevisionFile = { path: 'dom/snapshot.json', contents: '{"v":"[REDACTED:secret-field]"}' }
    const result = seal(draftWithAllSources(), [file], {
      suppressedValues: ['hunter2-must-never-leave-the-page']
    })
    expect(result.report.tierAFailures).toEqual([])
  })

  it('classifies a leaked secret as Tier A even when it also matches a pattern', () => {
    // An email-shaped secret would otherwise be filed as a routine PII hit and
    // the Tier A breach would go unnoticed.
    const secret = 'leaked.user@example.com'
    const file: RevisionFile = { path: 'input_events.ndjson', contents: secret }
    const result = seal(draftWithAllSources(), [file], { suppressedValues: [secret] })
    expect(result.report.tierAFailures).toHaveLength(1)
    expect(result.report.hits.some((h) => h.patternId === 'email')).toBe(false)
  })
})

describe('seal() — policy', () => {
  it('applies enabled workspace rules on top of the built-ins', () => {
    const file: RevisionFile = { path: 'console.ndjson', contents: 'internal ACME-9931 reference' }
    const result = seal(draftWithAllSources(), [file], {
      rules: [{ id: 'acme', label: 'ACME ref', pattern: 'ACME-\\d{4}', enabled: true }]
    })
    expect(result.files[0]!.contents).toContain('[REDACTED:acme]')
  })

  it('ignores a disabled rule', () => {
    const file: RevisionFile = { path: 'console.ndjson', contents: 'internal ACME-9931 reference' }
    const result = seal(draftWithAllSources(), [file], {
      rules: [{ id: 'acme', label: 'ACME ref', pattern: 'ACME-\\d{4}', enabled: false }]
    })
    expect(result.files[0]!.contents).toContain('ACME-9931')
  })

  it('reports an uncompilable rule instead of throwing or silently dropping it', () => {
    const file: RevisionFile = { path: 'console.ndjson', contents: 'bob@example.com' }
    const result = seal(draftWithAllSources(), [file], {
      rules: [{ id: 'bad', label: 'Bad', pattern: '([unclosed', enabled: true }]
    })
    expect(result.report.invalidRules).toHaveLength(1)
    expect(result.report.invalidRules[0]!.id).toBe('bad')
    // The rest of the policy still ran.
    expect(result.files[0]!.contents).toBe('[REDACTED:email]')
  })

  it('cannot be disabled: built-ins still fire with an empty rule set', () => {
    const file: RevisionFile = { path: 'console.ndjson', contents: 'bob@example.com' }
    const result = seal(draftWithAllSources(), [file], { rules: [] })
    expect(result.files[0]!.contents).toBe('[REDACTED:email]')
  })
})

describe('seal() — DC-2 and DC-3 bookkeeping', () => {
  it('refuses to seal a draft with an unexplained null source (DC-2)', () => {
    const draft = createDraft({
      capture_id: '11111111-2222-4333-8444-555555555555',
      kind: 'screenshot',
      surface: SURFACE,
      generator: 'test'
    })
    expect(() => seal(draft, [])).toThrow(/DC-2 violation/)
  })

  it('seals once every null source carries a reason', () => {
    const draft = createDraft({
      capture_id: '11111111-2222-4333-8444-555555555555',
      kind: 'screenshot',
      surface: SURFACE,
      generator: 'test'
    })
    for (const source of [
      'dom_snapshot',
      'accessibility_tree',
      'console_log',
      'network_har',
      'input_events'
    ] as const) {
      markUnavailable(draft, source, 'unsupported_surface')
    }
    expect(() => seal(draft, [])).not.toThrow()
  })

  it('emits a DC-3 redactions[] entry naming every layer a pattern touched', () => {
    const files: RevisionFile[] = [
      { path: 'dom/snapshot.json', contents: 'a@b.com' },
      { path: 'network.har', contents: 'c@d.com' }
    ]
    const result = seal(draftWithAllSources(), files)
    const entry = result.sidecar.redactions.find((r) => r.reason.includes('email'))
    expect(entry).toBeDefined()
    expect(entry!.applied_to.sort()).toEqual(['dom', 'har'])
  })

  it('maps revision paths to DC-4 redaction targets', () => {
    expect(targetForPath('dom/snapshot.json')).toBe('dom')
    expect(targetForPath('ax/tree.json')).toBe('ax')
    expect(targetForPath('network.har')).toBe('har')
    expect(targetForPath('input_events.ndjson')).toBe('input')
    // Documented gap: DC-4's RedactionTarget union has no console member.
    expect(targetForPath('console.ndjson')).toBeNull()
  })
})

describe('seal() — binary contents', () => {
  it('throws loudly rather than passing unscanned bytes through the chokepoint', () => {
    const file: RevisionFile = { path: 'dom/snapshot.json', contents: new Uint8Array([1, 2, 3]) }
    expect(() => seal(draftWithAllSources(), [file])).toThrow(/binary contents/)
  })
})
