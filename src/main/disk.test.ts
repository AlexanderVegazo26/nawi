import { describe, expect, it } from 'vitest'
import { LOW_SPACE_BYTES, VIDEO_BITS_PER_SECOND, estimateRecordingBytes } from './disk'

describe('UX-STA.5 — disk-pressure threshold and size estimate', () => {
  it('uses PRD-002’s 2 GB threshold', () => {
    expect(LOW_SPACE_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })

  it('estimates from the encoder’s real bitrate, not a guess', () => {
    // 8 Mbit/s for 60 s = 60 MB. If this drifts from the MediaRecorder setting
    // in src/renderer/lib/recorder.ts, the number shown to the user is fiction
    // and the warning stops being actionable.
    expect(VIDEO_BITS_PER_SECOND).toBe(8_000_000)
    expect(estimateRecordingBytes(1)).toBe(60_000_000)
    expect(estimateRecordingBytes(5)).toBe(300_000_000)
  })

  it('scales linearly with duration', () => {
    expect(estimateRecordingBytes(10)).toBe(estimateRecordingBytes(5) * 2)
  })
})
