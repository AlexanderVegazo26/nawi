import { describe, expect, it } from 'vitest'
import {
  DETECTOR_AVAILABLE,
  detectSensitiveRegions,
  redactionChipLabel,
  revertWarning,
  toRedactions,
  type SensitiveRegion
} from './detect'

/**
 * UX-ANN.3. The detector itself (FR-AI.2/3) is not built; what is testable
 * today is the seam's contract and the copy the UI is required to produce.
 */

const region = (over: Partial<SensitiveRegion> = {}): SensitiveRegion => ({
  id: 'r1',
  rect: { x: 10, y: 20, width: 100, height: 30 },
  label: 'an API key',
  confidence: 0.92,
  ...over
})

describe('the seam', () => {
  it('reports honestly that there is no detector behind it', () => {
    expect(DETECTOR_AVAILABLE).toBe(false)
  })

  it('returns nothing rather than fabricating findings', () => {
    // A stub that invented regions would black out the user's image for no
    // reason and teach them to distrust the feature.
    return expect(
      detectSensitiveRegions({ itemId: 'x', width: 100, height: 100 })
    ).resolves.toEqual([])
  })
})

describe('toRedactions', () => {
  it('produces solid redactions carrying the detector label', () => {
    const [s] = toRedactions([region()])
    expect(s.kind).toBe('redact')
    // Solid, not blur: an automatic redaction the user has not inspected is the
    // last place for a reversible transform.
    expect(s.mode).toBe('solid')
    expect(s.auto).toEqual({ label: 'an API key', confidence: 0.92 })
  })

  it('keeps the region id, so reopening a saved document does not duplicate it', () => {
    expect(toRedactions([region({ id: 'stable-id' })])[0].id).toBe('stable-id')
  })

  it('copies the rect into image-pixel geometry unchanged', () => {
    const [s] = toRedactions([region()])
    expect({ x: s.x, y: s.y, width: s.width, height: s.height }).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 30
    })
  })

  it('maps an empty detection to an empty document change', () => {
    expect(toRedactions([])).toEqual([])
  })
})

describe('copy required by the acceptance criteria', () => {
  it('renders the chip exactly as UX-ANN.3 quotes it', () => {
    expect(redactionChipLabel(2)).toBe('2 items redacted automatically')
    expect(redactionChipLabel(3)).toBe('3 items redacted automatically')
  })

  it('uses the singular for one item', () => {
    expect(redactionChipLabel(1)).toBe('1 item redacted automatically')
  })

  it('names the concrete risk instead of asking "are you sure?"', () => {
    // PRD-002 §9 quotes this sentence verbatim.
    expect(revertWarning('an API key')).toBe('This will expose an API key in the shared image.')
    expect(revertWarning('an email address')).toBe(
      'This will expose an email address in the shared image.'
    )
    expect(revertWarning('an API key')).not.toMatch(/are you sure/i)
  })
})
