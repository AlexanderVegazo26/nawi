import { describe, expect, it } from 'vitest'
import {
  CONTAINERS,
  MIME_CANDIDATES,
  containerOf,
  isRecordCommand,
  pickRecordingMime
} from './recording'
import { formatOf, mediaFormat } from './types'

/**
 * FR-REC.4 — the container decision.
 *
 * The point of these tests is that MP4 is *preferred* but never *assumed*: the
 * runtime gate has to still work, because MP4 support is version- and
 * platform-dependent. A regression here is either "we silently went back to
 * WebM everywhere" or "we hand MediaRecorder a type this build cannot mux".
 */
describe('pickRecordingMime', () => {
  it('prefers H.264 + AAC MP4 when the runtime supports it', () => {
    const chosen = pickRecordingMime(() => true)
    expect(chosen).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
    expect(containerOf(chosen!)).toBe('mp4')
  })

  it('falls back through the WebM chain when no MP4 type is supported', () => {
    const chosen = pickRecordingMime((t) => t.startsWith('video/webm'))
    expect(chosen).toBe('video/webm;codecs=vp9,opus')
    expect(containerOf(chosen!)).toBe('webm')
  })

  it('degrades within MP4 before leaving the container', () => {
    // A build that muxes MP4 but not AAC must still record MP4.
    const chosen = pickRecordingMime((t) => t === 'video/mp4')
    expect(chosen).toBe('video/mp4')
  })

  it('returns undefined rather than a guess when nothing is supported', () => {
    expect(pickRecordingMime(() => false)).toBeUndefined()
  })

  it('treats a throwing support predicate as a refusal', () => {
    // Some builds throw on an unparseable codec string instead of returning
    // false. That must not abort the whole probe.
    const chosen = pickRecordingMime((t) => {
      if (t.includes('mp4')) throw new TypeError('bad codec string')
      return t === 'video/webm'
    })
    expect(chosen).toBe('video/webm')
  })

  it('only offers candidates whose container is recognised', () => {
    for (const candidate of MIME_CANDIDATES) {
      expect(containerOf(candidate)).not.toBeNull()
    }
  })
})

describe('containerOf', () => {
  it('reads the container from the base type, ignoring codec parameters', () => {
    expect(containerOf('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('mp4')
    expect(containerOf('VIDEO/WEBM; codecs=vp9')).toBe('webm')
  })

  it('refuses anything it does not recognise instead of defaulting to WebM', () => {
    // Defaulting here is how MP4 bytes end up in a `.webm` file.
    expect(containerOf('video/x-matroska')).toBeNull()
    expect(containerOf('')).toBeNull()
  })
})

describe('mediaFormat / formatOf', () => {
  it('names an MP4 recording as MP4 end to end', () => {
    const item = { kind: 'video' as const, container: 'mp4' as const }
    expect(formatOf(item)).toEqual(CONTAINERS.mp4)
    expect(formatOf(item).ext).toBe('mp4')
    expect(formatOf(item).mime).toBe('video/mp4')
  })

  it('treats a video with no recorded container as WebM, for records written before the switch', () => {
    expect(formatOf({ kind: 'video' })).toEqual(CONTAINERS.webm)
  })

  it('ignores a container on an image, which never has one', () => {
    expect(formatOf({ kind: 'image', container: 'mp4' }).ext).toBe('png')
  })

  it('still refuses to give a guide a media format', () => {
    expect(() => mediaFormat('guide')).toThrow(/no media bytes/)
  })
})

describe('isRecordCommand', () => {
  it('accepts only the closed command set', () => {
    expect(isRecordCommand('pause')).toBe(true)
    expect(isRecordCommand('chapter')).toBe(true)
    // The HUD's payload is untrusted like any other renderer payload.
    expect(isRecordCommand('__proto__')).toBe(false)
    expect(isRecordCommand({ toString: () => 'stop' })).toBe(false)
    expect(isRecordCommand(undefined)).toBe(false)
  })
})
