import { describe, expect, it } from 'vitest'
import { PRD_UX_ANN_1, RESERVED_KEYS, TOOLS, toolById, toolForKey } from './tools'

/**
 * The key map is a requirement (PRD-002 UX-ANN.1) that the shipped editor
 * diverged from — recorded as an open item in COMPETITOR-A-26-CAPABILITY-MATRIX.md
 * §4.3. These tests are what stop it diverging again silently.
 */

describe('UX-ANN.1 conformance', () => {
  it('binds every key the PRD assigns, to the tool the PRD assigns it to', () => {
    for (const [key, expected] of Object.entries(PRD_UX_ANN_1)) {
      expect(toolForKey(key), `key ${key}`).toBe(expected)
    }
  })

  it('separates decorative pixelate from decorative blur', () => {
    // The divergence §4.3 recorded: one `B` tool served both, and `P` was
    // unbound. They are now distinct tools with distinct keys.
    expect(toolForKey('B')).toBe('blur')
    expect(toolForKey('P')).toBe('pixelate')
    expect(toolForKey('B')).not.toBe(toolForKey('P'))
  })

  it('binds spotlight, which the shipped editor did not have at all', () => {
    expect(toolForKey('S')).toBe('spotlight')
  })
})

describe('tools the PRD requires but does not key', () => {
  it('gives redaction its own tool and its own key, distinct from blur', () => {
    // FR-ANN.3 requires solid redaction alongside blur and pixelate;
    // UX-ANN.1's list has no key for it. See the reasoning block in tools.ts.
    expect(toolForKey('X')).toBe('redact')
    expect(toolForKey('X')).not.toBe(toolForKey('B'))
    expect(Object.values(PRD_UX_ANN_1)).not.toContain('redact')
  })

  it('keys freehand, the missing FR-ANN.1 P0 tool', () => {
    expect(toolForKey('F')).toBe('freehand')
  })

  it('keys the FR-ANN.5 magnifier', () => {
    expect(toolForKey('M')).toBe('magnify')
  })
})

describe('the map as a whole', () => {
  it('binds no key twice', () => {
    const keys = TOOLS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('uses only single uppercase letters', () => {
    for (const t of TOOLS) expect(t.key).toMatch(/^[A-Z]$/)
  })

  it('never claims a key the editor reserves for colours or stroke width', () => {
    for (const key of RESERVED_KEYS) expect(toolForKey(key)).toBeNull()
  })

  it('keeps the bindings the PRD leaves unassigned', () => {
    // V and H are additions, not contradictions — the PRD assigns neither.
    expect(toolForKey('V')).toBe('select')
    expect(toolForKey('H')).toBe('highlight')
    expect(PRD_UX_ANN_1).not.toHaveProperty('V')
    expect(PRD_UX_ANN_1).not.toHaveProperty('H')
  })

  it('is case-insensitive and rejects non-keys', () => {
    expect(toolForKey('a')).toBe('arrow')
    expect(toolForKey('A')).toBe('arrow')
    expect(toolForKey('Escape')).toBeNull()
    expect(toolForKey('')).toBeNull()
    expect(toolForKey('Q')).toBeNull()
  })

  it('gives every tool a label and a hint, since both reach the a11y name', () => {
    for (const t of TOOLS) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.hint.length).toBeGreaterThan(0)
      expect(toolById(t.id)).toBe(t)
    }
  })

  it('describes blur and pixelate as decorative and redact as removal', () => {
    // UX-ANN.4: the copy itself must not let a decorative blur read as a
    // security guarantee.
    expect(toolById('blur').hint).toMatch(/not a redaction/i)
    expect(toolById('pixelate').hint).toMatch(/not a redaction/i)
    expect(toolById('redact').hint).toMatch(/remove/i)
  })
})
