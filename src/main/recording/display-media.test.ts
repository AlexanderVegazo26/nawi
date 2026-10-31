import { describe, expect, it } from 'vitest'
import { answerDisplayMedia, type DisplayMediaStreams, type SourceLike } from './display-media'

/**
 * The display-media answer, against a callback that behaves like Electron 45's:
 * one-shot (a second call throws) and strict (`{}` throws, because the renderer
 * asked for video). `null` is how a request is denied.
 */
type Streams = DisplayMediaStreams<SourceLike> | null

function electronLikeCallback(): { calls: Streams[]; callback: (s: Streams) => void } {
  const calls: Streams[] = []
  const callback = (streams: Streams): void => {
    calls.push(streams)
    if (calls.length > 1) throw new TypeError('One-time callback was called more than once')
    if (streams !== null && !streams.video) {
      throw new TypeError('Video was requested, but no video stream was provided')
    }
  }
  return { calls, callback }
}

function quietLog(): { errors: string[]; warnings: string[]; log: Pick<Console, 'error' | 'warn'> } {
  const errors: string[] = []
  const warnings: string[] = []
  return {
    errors,
    warnings,
    log: {
      error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')),
      warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' '))
    }
  }
}

const SCREEN = { id: 'screen:0:0', name: 'Entire screen' }
const WINDOW = { id: 'window:42:0', name: 'Editor' }

describe('answerDisplayMedia', () => {
  it('grants the picked source', async () => {
    const { calls, callback } = electronLikeCallback()
    await answerDisplayMedia({
      wanted: WINDOW.id,
      wantsAudio: false,
      platform: 'linux',
      sources: async () => [SCREEN, WINDOW],
      callback
    })
    expect(calls, 'the picked window should be granted, once').toEqual([{ video: WINDOW }])
  })

  it('denies with null, exactly once, when the picked source is gone, and names the ids it had', async () => {
    const { calls, callback } = electronLikeCallback()
    const { errors, log } = quietLog()
    await answerDisplayMedia({
      wanted: 'screen:9:0',
      wantsAudio: false,
      platform: 'linux',
      sources: async () => [SCREEN],
      callback,
      log
    })
    expect(calls, 'a missing source must be denied with null (Electron throws on {}), never retried').toEqual([null])
    expect(errors.join('\n'), 'the log should say what was wanted and what was available').toContain(
      'wanted screen:9:0, have screen:0:0'
    )
  })

  it('denies once and says "no sources" when the capturer returns an empty list', async () => {
    const { calls, callback } = electronLikeCallback()
    const { errors, log } = quietLog()
    await answerDisplayMedia({
      wanted: SCREEN.id,
      wantsAudio: false,
      platform: 'linux',
      sources: async () => [],
      callback,
      log
    })
    expect(calls, 'an empty source list should be one denial').toEqual([null])
    expect(errors.join('\n')).toContain('have no sources')
  })

  it('never falls back to another source when nothing was armed', async () => {
    const { calls, callback } = electronLikeCallback()
    await answerDisplayMedia({
      wanted: null,
      wantsAudio: false,
      platform: 'linux',
      sources: async () => [SCREEN, WINDOW],
      callback,
      log: quietLog().log
    })
    expect(calls, 'recording an unpicked source is a confidentiality problem').toEqual([null])
  })

  it('denies once when listing sources fails', async () => {
    const { calls, callback } = electronLikeCallback()
    const { errors, log } = quietLog()
    await answerDisplayMedia({
      wanted: SCREEN.id,
      wantsAudio: false,
      platform: 'linux',
      sources: async () => {
        throw new Error('Failed to initialize pixel buffer')
      },
      callback,
      log
    })
    expect(calls, 'a capturer error should be one denial').toEqual([null])
    expect(errors.join('\n')).toContain('Failed to initialize pixel buffer')
  })

  it('does not call the callback a second time when granting throws', async () => {
    const calls: Streams[] = []
    const { errors, log } = quietLog()
    await expect(
      answerDisplayMedia({
        wanted: SCREEN.id,
        wantsAudio: false,
        platform: 'linux',
        sources: async () => [SCREEN],
        callback: (s) => {
          calls.push(s)
          throw new TypeError('frame destroyed')
        },
        log
      }),
      'the handler runs fire-and-forget: it must never reject (that was an unhandled rejection in main)'
    ).resolves.toBeUndefined()
    expect(calls, 'a consumed callback must not be called again').toEqual([{ video: SCREEN }])
    expect(errors.join('\n')).toContain('frame destroyed')
  })

  it('asks for loopback audio on Windows only, and warns elsewhere', async () => {
    const win = electronLikeCallback()
    await answerDisplayMedia({
      wanted: SCREEN.id,
      wantsAudio: true,
      platform: 'win32',
      sources: async () => [SCREEN],
      callback: win.callback
    })
    expect(win.calls).toEqual([{ video: SCREEN, audio: 'loopback' }])

    const linux = electronLikeCallback()
    const { warnings, log } = quietLog()
    await answerDisplayMedia({
      wanted: SCREEN.id,
      wantsAudio: true,
      platform: 'linux',
      sources: async () => [SCREEN],
      callback: linux.callback,
      log
    })
    expect(linux.calls, 'non-Windows degrades to video only').toEqual([{ video: SCREEN }])
    expect(warnings.join('\n')).toContain('system audio is not supported on linux')
  })
})
