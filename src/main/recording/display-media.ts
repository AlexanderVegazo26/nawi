/**
 * The answer to the recorder window's `getDisplayMedia` call.
 *
 * Kept apart from `index.ts` (and free of an `electron` import) so the rules
 * below can be unit-tested with a fake source list and a fake callback.
 *
 * Electron's callback is one-shot and strict: it throws if it is called a
 * second time, and it throws on `{}` ("Video was requested, but no video stream
 * was provided"). The handler used to deny with `callback({})` and then call it
 * again from its catch, so a missing source surfaced as an unhandled rejection
 * in main and "Invalid capture constraints" in the renderer. A denial is
 * `callback(null)`, and the callback is reached exactly once.
 */

export interface SourceLike {
  id: string
  name: string
}

export interface DisplayMediaStreams<S> {
  video: S
  audio?: 'loopback'
}

export interface DisplayMediaRequest<S> {
  /** The id the user picked, armed by `startRecording`; null if nothing was armed. */
  wanted: string | null
  wantsAudio: boolean
  platform: NodeJS.Platform
  sources: () => Promise<S[]>
  callback: (streams: DisplayMediaStreams<S> | null) => void
  log?: Pick<Console, 'error' | 'warn'>
}

export async function answerDisplayMedia<S extends SourceLike>(req: DisplayMediaRequest<S>): Promise<void> {
  const log = req.log ?? console
  let answered = false
  const answer = (streams: DisplayMediaStreams<S> | null): void => {
    if (answered) return
    answered = true
    req.callback(streams)
  }

  try {
    const real = await req.sources()
    const match = real.find((s) => s.id === req.wanted)
    // Deliberately no `?? real[0]` fallback: silently recording a different
    // source than the user picked is a confidentiality problem. Denying the
    // request surfaces a real error in the renderer instead.
    if (!match) {
      // The ids say which failure this is: an empty list (the capturer had
      // nothing to offer) or a list that no longer holds the picked id.
      log.error(
        `[displayMedia] requested source is no longer available: wanted ${String(req.wanted)}, ` +
          `have ${real.length ? real.map((s) => s.id).join(', ') : 'no sources'}`
      )
      answer(null)
      return
    }
    // System audio needs an explicit `audio` key. Omitting it means the
    // renderer's `audio: true` request is answered video-only and every
    // recording is silent, with nothing anywhere reporting a problem.
    // `'loopback'` is Windows-only; on other platforms we degrade to video
    // rather than passing a value Electron does not support there.
    if (req.wantsAudio && req.platform === 'win32') {
      answer({ video: match, audio: 'loopback' })
    } else {
      if (req.wantsAudio) {
        log.warn(`[displayMedia] system audio is not supported on ${req.platform}; recording video only`)
      }
      answer({ video: match })
    }
  } catch (err) {
    log.error('[displayMedia]', err)
    // If the callback itself threw, it has been consumed: calling it again
    // only throws "One-time callback was called more than once".
    if (!answered) {
      answered = true
      try {
        req.callback(null)
      } catch (denyErr) {
        log.error('[displayMedia] could not deny the request', denyErr)
      }
    }
  }
}
