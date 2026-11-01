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
  /**
   * How long the source list may take before the request is denied. Listing
   * has been seen to never answer on a Linux CI X server; without a bound the
   * renderer's `getDisplayMedia` waits forever and the user's recording neither
   * starts nor fails (no card, no message: a dead end, UX-PRM.2).
   */
  sourcesTimeoutMs?: number
}

export type SourceKind = 'screen' | 'window'

/**
 * Which capturer to ask for a picked id. Ids are `screen:<n>:<n>` or
 * `window:<n>:<n>`; anything else is asked of both.
 *
 * Per kind, because the kinds behave differently under X11 with no window
 * manager (CI): a window listing takes ~3 s and is always empty, and a combined
 * listing waits for it and is sometimes empty even with a screen present. A
 * screen-only listing answers in milliseconds.
 */
export function sourceKindsFor(wanted: string | null): SourceKind[] {
  if (wanted?.startsWith('screen:')) return ['screen']
  if (wanted?.startsWith('window:')) return ['window']
  return ['screen', 'window']
}

/**
 * Lists the sources for `wanted`. An empty *screen* listing is retried briefly
 * (Chromium intermittently answers [] with "Failed to initialize pixel buffer"
 * while a display exists, which cannot be a real answer). An empty *window*
 * listing is a real answer (the window closed, or there is no window manager)
 * and is final: retrying it only spent ~3 s per attempt before denying.
 */
export async function listSourcesFor<S>(
  wanted: string | null,
  list: (kinds: SourceKind[]) => Promise<S[]>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 8
): Promise<S[]> {
  const kinds = sourceKindsFor(wanted)
  const retryEmpty = kinds.length === 1 && kinds[0] === 'screen'
  for (let attempt = 1; ; attempt += 1) {
    const sources = await list(kinds)
    if (sources.length > 0 || !retryEmpty || attempt >= attempts) return sources
    await sleep(100 * attempt)
  }
}

/** Generous: a healthy listing takes well under a second, including its empty-list retries. */
export const SOURCES_TIMEOUT_MS = 8_000

class SourcesTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SourcesTimeout(`listing capture sources did not answer within ${ms} ms`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
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
    const real = await withTimeout(req.sources(), req.sourcesTimeoutMs ?? SOURCES_TIMEOUT_MS)
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
    if (err instanceof SourcesTimeout) {
      log.error(`[displayMedia] ${err.message}; denying the request for ${String(req.wanted)}`)
    } else {
      log.error('[displayMedia]', err)
    }
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
