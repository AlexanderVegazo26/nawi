import { describe, expect, it } from 'vitest'
import { failureFrom, failureMessage } from './failure'

describe('UX-STA.3 — failures name what failed, what still worked, and what to do', () => {
  const f = {
    failed: 'Transcription failed',
    intact: 'Your video and screenshots are safe',
    next: 'Retry or continue without a transcript'
  }

  it('produces all three clauses in order', () => {
    expect(failureMessage(f)).toBe(
      'Transcription failed. Your video and screenshots are safe. Retry or continue without a transcript.'
    )
  })

  it('keeps the underlying cause available without leading with it', () => {
    const msg = failureFrom('EACCES: permission denied', f)
    expect(msg.startsWith('Transcription failed.')).toBe(true)
    expect(msg).toContain('EACCES: permission denied')
  })

  it('does not double-punctuate a clause that already ends in a stop', () => {
    expect(failureMessage({ failed: 'A.', intact: 'B!', next: 'C?' })).toBe('A. B! C?')
  })

  it('omits the parenthetical when there is no cause to report', () => {
    expect(failureFrom('   ', f)).toBe(failureMessage(f))
    expect(failureFrom('   ', f)).not.toContain('(')
  })
})
