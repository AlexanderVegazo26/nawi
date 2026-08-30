import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FailureKind, RecorderBridge, RecorderCallbacks } from './recorder'
import type { RecordingStatus } from '@shared/recording'

/**
 * FR-REC.2 — pause/resume, and the chunk path that feeds FR-REC.3.
 *
 * The engine is exercised against stand-in web APIs rather than a DOM. That is
 * a deliberate choice: the properties being asserted are *the engine's* —
 * that pause keeps one recorder and one file rather than starting a second one,
 * that paused wall-clock time is excluded from the elapsed count, and that
 * every chunk is forwarded in order. Whether Chromium's own MediaRecorder
 * honours `pause()` is not something a test here could establish either way;
 * see the report for what was and was not verified against the real API.
 */

/** A MediaRecorder stand-in that records the calls made against it. */
class FakeMediaRecorder {
  static supported: (t: string) => boolean = () => true
  static isTypeSupported(t: string): boolean {
    return FakeMediaRecorder.supported(t)
  }
  static instances: FakeMediaRecorder[] = []

  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((e: { data: { size: number; arrayBuffer: () => Promise<ArrayBuffer> } }) => void) | null = null
  onerror: (() => void) | null = null
  onstop: (() => void) | null = null
  timeslice = 0
  readonly calls: string[] = []

  constructor(
    readonly stream: unknown,
    readonly options: { mimeType: string }
  ) {
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice: number): void {
    this.timeslice = timeslice
    this.state = 'recording'
    this.calls.push('start')
  }
  pause(): void {
    this.state = 'paused'
    this.calls.push('pause')
  }
  resume(): void {
    this.state = 'recording'
    this.calls.push('resume')
  }
  requestData(): void {
    this.calls.push('requestData')
  }
  stop(): void {
    this.state = 'inactive'
    this.calls.push('stop')
    this.onstop?.()
  }

  /** Delivers a chunk the way the real API does. */
  emit(bytes: number[]): void {
    this.ondataavailable?.({
      data: {
        size: bytes.length,
        arrayBuffer: async () => new Uint8Array(bytes).buffer
      }
    })
  }
}

class FakeAudioNode {
  connect(): void {}
  disconnect(): void {}
}
class FakeAudioContext {
  createMediaStreamDestination(): { stream: { getAudioTracks: () => unknown[] } } {
    return { stream: { getAudioTracks: () => [{ kind: 'audio' }] } }
  }
  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode()
  }
  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }
  }
  createAnalyser(): {
    fftSize: number
    connect: () => void
    getByteTimeDomainData: (a: Uint8Array) => void
  } {
    return {
      fftSize: 8,
      connect: () => {},
      // 128 is silence in the unsigned 8-bit time domain.
      getByteTimeDomainData: (a: Uint8Array) => a.fill(128)
    }
  }
  async close(): Promise<void> {}
}

/** A MediaStream stand-in with one video track. */
function fakeStream(): unknown {
  const track = {
    kind: 'video',
    getSettings: () => ({ width: 1920, height: 1080 }),
    addEventListener: () => {},
    stop: () => {}
  }
  return {
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track]
  }
}

let now = 0
const g = globalThis as unknown as Record<string, unknown>

function install(): void {
  now = 0
  FakeMediaRecorder.instances = []
  FakeMediaRecorder.supported = () => true
  g.MediaRecorder = FakeMediaRecorder
  g.AudioContext = FakeAudioContext
  g.MediaStream = class {
    private tracks: unknown[] = []
    addTrack(t: unknown): void {
      this.tracks.push(t)
    }
    getTracks(): unknown[] {
      return this.tracks
    }
  }
  g.performance = { now: () => now }
  // Node exposes `navigator` as a getter-only global, so it has to be redefined
  // rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      mediaDevices: {
        getDisplayMedia: async () => fakeStream(),
        getUserMedia: async () => fakeStream(),
        enumerateDevices: async () => []
      }
    }
  })
}

interface Harness {
  engine: InstanceType<typeof import('./recorder').ScreenRecorder>
  statuses: RecordingStatus[]
  chunks: Array<{ id: string; bytes: number[] }>
  finished: Array<{ id: string; durationMs: number }>
  failures: string[]
  /**
   * Every report with the kind the engine attached.
   *
   * `failures` alone cannot distinguish a broken capture from a refused
   * request, and the two have opposite consequences: one must reach the user's
   * recovery card and end the recording, the other must leave a healthy
   * recording alone. Asserting only the observable end state hides a mislabel,
   * because the engine self-terminates on the capture-broken paths regardless
   * of what it called the failure.
   */
  reports: Array<{ message: string; kind: FailureKind }>
  recorder: () => FakeMediaRecorder
}

async function harness(
  overrides: Partial<RecorderBridge> = {},
  chunkSink?: (id: string, chunk: Uint8Array) => Promise<void>,
  /**
   * Mirrors what main does with a report, closing the loop the engine's own
   * callbacks otherwise hide.
   *
   * Without this the harness makes `onFailed` a terminal sink, and every
   * assertion stops one hop before the feedback edge: report ->
   * `reportRecordingFailure` -> `fail()` -> `send(recordDispatch, 'stop')` ->
   * `command('stop')` -> `engine.stop()`. A bug that only exists on that edge
   * passes a green suite, which is exactly what happened.
   */
  mirrorMain = false
): Promise<Harness> {
  vi.resetModules()
  const { ScreenRecorder } = await import('./recorder')
  let engineRef: { command: (c: string) => void } | null = null

  const statuses: RecordingStatus[] = []
  const chunks: Array<{ id: string; bytes: number[] }> = []
  const finished: Array<{ id: string; durationMs: number }> = []
  const failures: string[] = []
  const reports: Array<{ message: string; kind: FailureKind }> = []

  const cb: RecorderCallbacks = {
    onStatus: (s) => statuses.push(s),
    onChunk: async (id, chunk) => {
      chunks.push({ id, bytes: [...chunk] })
      if (chunkSink) await chunkSink(id, chunk)
    },
    onFinished: async (id, info) => {
      finished.push({ id, durationMs: info.durationMs })
    },
    onFailed: (m, kind) => {
      failures.push(m)
      reports.push({ message: m, kind })
      // Models `src/renderer/recorder.tsx` plus main's response to a report:
      // only a capture-broken failure is forwarded, and main answers one by
      // dispatching 'stop' back to the engine. The kind is the engine's own
      // claim about what happened, so this still discriminates on engine
      // behaviour — mislabel the guard site and this loop ends a live recording.
      if (mirrorMain && kind === 'capture-failed') engineRef?.command('stop')
    }
  }

  const bridge: RecorderBridge = {
    prepareRecording: async () => ({ ok: true }),
    beginRecording: async () => ({ ok: true, value: { recordingId: 'rec-1' } }),
    markChapter: async () => [],
    ...overrides
  }

  const engine = new ScreenRecorder(cb, bridge)
  engineRef = engine as unknown as { command: (c: string) => void }

  return {
    engine,
    statuses,
    chunks,
    finished,
    failures,
    reports,
    recorder: () => FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]
  }
}

const NO_TRACKS = { system: false, mic: false, camera: false }

beforeEach(install)
afterEach(() => {
  vi.useRealTimers()
})

describe('pause and resume (FR-REC.2)', () => {
  it('pauses the same recorder rather than starting a second one', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    h.engine.pause()
    h.engine.resume()

    // One recorder, one file. Tearing the stream down and starting a second
    // recorder is exactly what produces the discontinuity artefact FR-REC.2
    // forbids, so "only one was ever constructed" is the property under test.
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(h.recorder().calls).toEqual(['start', 'pause', 'resume'])
    expect(h.chunks.every((c) => c.id === 'rec-1')).toBe(true)
  })

  it('excludes paused wall-clock time from the elapsed count', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    now = 5_000
    h.engine.pause()
    now = 60_000 // 55 seconds spent paused
    h.engine.resume()
    now = 63_000

    await h.engine.stop()
    // 5s before the pause plus 3s after the resume. Counting the paused window
    // would make the HUD's clock disagree with the file's real duration.
    expect(h.finished[0].durationMs).toBe(8_000)
  })

  it('ignores a resume that was never paused, and a pause while already paused', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    h.engine.resume() // no-op: not paused
    h.engine.pause()
    h.engine.pause() // no-op: already paused

    expect(h.recorder().calls).toEqual(['start', 'pause'])
  })

  it('reports the paused phase so the HUD and tray cannot disagree with the engine', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    h.engine.pause()
    expect(h.statuses.at(-1)?.phase).toBe('paused')
    h.engine.resume()
    expect(h.statuses.at(-1)?.phase).toBe('recording')
  })
})

describe('chunk delivery (FR-REC.3)', () => {
  it('forwards every chunk immediately and in order, holding none in memory', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    h.recorder().emit([1, 2])
    h.recorder().emit([3])
    h.recorder().emit([4, 5, 6])
    await h.engine.stop()

    expect(h.chunks.map((c) => c.bytes)).toEqual([[1, 2], [3], [4, 5, 6]])
  })

  it('asks MediaRecorder for a timeslice, so chunks arrive during the recording', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    // Without a timeslice, `ondataavailable` fires once at stop and a SIGKILL
    // loses everything — the exact failure FR-REC.3 names.
    expect(h.recorder().timeslice).toBe(1000)
  })

  it('requests the tail chunk before stopping', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    await h.engine.stop()
    expect(h.recorder().calls).toContain('requestData')
  })

  it('reports a failed chunk write instead of silently dropping the bytes', async () => {
    // A disk that filled up mid-recording. Swallowing this would leave the HUD
    // counting up against a file nothing is being written to — a recording that
    // reports success while losing the user's work.
    const h = await harness({}, async () => {
      throw new Error('ENOSPC: no space left on device')
    })
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    h.recorder().emit([1])
    await h.engine.stop()
    expect(h.failures.some((f) => f.includes('ENOSPC'))).toBe(true)
  })

  it('never opens a file it cannot write to', async () => {
    const h = await harness({
      beginRecording: async () => ({ ok: false, error: 'disk is full' })
    })
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    // A recording that cannot be persisted must not appear to be running.
    expect(h.failures).toEqual(['disk is full'])
    expect(h.statuses.at(-1)?.phase).toBe('idle')
    expect(h.engine.active).toBe(false)
  })
})

describe('container reporting', () => {
  it('reports MP4 when the runtime supports it', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    expect(h.recorder().options.mimeType).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
    expect(h.statuses.at(-1)?.container).toBe('mp4')
  })

  it('falls back to WebM and says so when MP4 is unavailable', async () => {
    FakeMediaRecorder.supported = (t) => t.startsWith('video/webm')
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    expect(h.statuses.at(-1)?.container).toBe('webm')
  })

  it('refuses to record at all when no container is supported', async () => {
    FakeMediaRecorder.supported = () => false
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    expect(h.failures[0]).toMatch(/no supported video encoder/)
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })
})

describe('countdown (PRD-002 Flow B)', () => {
  it('does not open a file until the countdown finishes', async () => {
    vi.useFakeTimers()
    const h = await harness()
    const started = h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: true })

    await vi.advanceTimersByTimeAsync(0)
    expect(h.statuses.at(-1)?.phase).toBe('countdown')
    expect(FakeMediaRecorder.instances).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(3000)
    await started
    expect(FakeMediaRecorder.instances).toHaveLength(1)
  })

  it('starts exactly once when the countdown is skipped mid-flight', async () => {
    vi.useFakeTimers()
    const h = await harness()
    const started = h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: true })
    await vi.advanceTimersByTimeAsync(1000)

    h.engine.command('skip-countdown')
    await started
    // A skip that raced the interval would construct a second recorder against
    // the same stream.
    await vi.advanceTimersByTimeAsync(5000)
    expect(FakeMediaRecorder.instances).toHaveLength(1)
  })

  it('cancelling during the countdown records nothing at all', async () => {
    vi.useFakeTimers()
    const h = await harness()
    const started = h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: true })
    await vi.advanceTimersByTimeAsync(1000)

    void h.engine.cancel()
    await started
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(h.finished).toEqual([])
    expect(h.statuses.at(-1)?.phase).toBe('idle')
  })
})

/**
 * A chunk-write failure is not a start-path failure, and the difference is the
 * whole point of this block.
 *
 * Every other failure site in the engine sets `phase = 'idle'` and emits before
 * reporting. `ondataavailable`'s `.catch` did neither: it reported and let the
 * recording carry on. That was survivable while `onFailed` was a bare
 * `console.error` in the recorder window, and stopped being survivable the
 * moment that report became a user-facing surface.
 */
describe('a chunk-write failure ends the recording (FR-REC.3 / UX-PRM.2)', () => {
  const ENOSPC = async (): Promise<void> => {
    throw new Error('ENOSPC: no space left on device')
  }

  it('never reports the same recording as both failed and saved', async () => {
    const h = await harness({}, ENOSPC)
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    h.recorder().emit([1])
    await h.engine.stop()

    // `finishInner` awaits the chunk queue with `.catch(() => undefined)`, which
    // swallows the very rejection that was just reported — so `error` stayed
    // null and the recording was ALSO finalized. Downstream that is one
    // recording broadcasting both `recordingFailed` and `recordingFinished`:
    // two contradictory toasts, two competing view transitions, and a library
    // item quietly missing its tail chunk.
    expect(h.failures.some((f) => f.includes('ENOSPC'))).toBe(true)
    expect(h.finished).toEqual([])
  })

  it('leaves the engine idle rather than still "recording" against a dead file', async () => {
    const h = await harness({}, ENOSPC)
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    h.recorder().emit([1])
    // Let the queue reject and the engine act on it, without stopping manually:
    // the point is that the engine ends itself.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // While `active` stays true the 250 ms tick keeps publishing
    // `phase: 'recording'`, which re-shows the HUD that main just hid and makes
    // main refuse the retry the recovery card offers.
    expect(h.engine.active).toBe(false)
    expect(h.statuses.at(-1)?.phase).toBe('idle')
  })

  it('counts the recorded interval once, not twice', async () => {
    const h = await harness({}, ENOSPC)
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    now = 4_000
    h.recorder().emit([1])
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // `sealSegment` guards only on `phase !== 'recording'` and does not advance
    // `segmentStartedAt`, so a caller that seals without moving the phase lets
    // `finishInner`'s own seal add the same interval again. Harmless while the
    // error branch skips `onFinished`, and a silently doubled duration the
    // moment any future change persists partial bytes on that path.
    expect(h.statuses.at(-1)?.elapsedMs).toBe(4_000)
  })

  it('reports once, not once per failing chunk', async () => {
    const h = await harness({}, ENOSPC)
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    h.recorder().emit([1])
    h.recorder().emit([2])
    h.recorder().emit([3])
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // Each report becomes a toast, a forced view switch and a card. Once per
    // second, for a full disk, is a user who cannot reach their library.
    expect(h.failures).toHaveLength(1)
  })

  it('lets the next recording start instead of throwing past a fire-and-forget caller', async () => {
    const h = await harness({}, ENOSPC)
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    h.recorder().emit([1])
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // This is the retry the recovery card's "check again" performs. The caller
    // is `void engine.start(...)` in recorder.tsx, so a throw here is an
    // unhandled rejection reported nowhere — the original dead end, relocated.
    await expect(
      h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    ).resolves.toBeUndefined()

    // Discriminating: `resolves.toBeUndefined()` alone is also satisfied by the
    // already-active guard, so a regression that left the engine active after a
    // chunk failure would keep this green. The retry must have genuinely
    // started a recording, not been refused as a duplicate.
    expect(h.failures.some((f) => /already in progress/i.test(f))).toBe(false)
    expect(FakeMediaRecorder.instances).toHaveLength(2)
  })
})

describe('the already-active guard reports rather than throws', () => {
  it('tells the caller through onFailed instead of rejecting into a void call', async () => {
    const h = await harness()
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })

    // recorder.tsx calls this as `void engine.start(options)`. A rejection has
    // nowhere to go; a report reaches the user.
    await expect(
      h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    ).resolves.toBeUndefined()
    expect(h.failures.some((f) => /already in progress/i.test(f))).toBe(true)
  })
})

/**
 * A duplicated start must refuse the *request* without disturbing the capture.
 *
 * Main's already-in-progress gate reads `status.phase`, a mirror of what the
 * recorder last published, so it is stale for one IPC round trip after the
 * engine goes active — and that window is exactly and only when the engine's
 * own guard is reachable. A double hotkey, an agent tool, or the recovery
 * card's retry racing a still-starting capture all land here.
 *
 * These run with `mirrorMain`, because the bug lives on the edge where main
 * turns a report into a stop.
 */
describe('a refused duplicate start does not end the live recording', () => {
  it('does not finalize a healthy recording when a second start is refused', async () => {
    const h = await harness({}, undefined, true)
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    h.recorder().emit([1])

    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    await new Promise((r) => setTimeout(r, 0))

    // "Your request was refused" is not "your capture is broken". Treating it
    // as the latter truncates and finalizes a recording that was fine — and
    // emits both a failure and a saved-recording for it, the very pair the
    // chunk-failure fix exists to prevent.
    expect(h.finished).toEqual([])
    expect(h.engine.active).toBe(true)
    expect(h.recorder().calls).not.toContain('stop')

    // The label is what `recorder.tsx` filters on, so pin it directly rather
    // than only its consequence: this is the report that must NOT reach main.
    const report = h.reports.find((r) => /already in progress/i.test(r.message))
    expect(report).toBeDefined()
    expect(report?.kind).toBe('start-refused')
  })

  it('labels a broken capture capture-failed, so it reaches the recovery card', async () => {
    /*
     * The kind is the assertion, deliberately.
     *
     * Asserting the end state here proves nothing about the label:
     * `endBecauseChunkFailed` seals, moves the phase and stops the recorder on
     * its own before any report leaves the engine, so `active === false` and
     * `finished === []` hold even if this path were mislabelled
     * 'start-refused' — and a mislabel is exactly the regression that matters,
     * because `recorder.tsx` drops a 'start-refused' report and the user's
     * broken recording would then reach no surface at all.
     */
    const h = await harness(
      {},
      async () => {
        throw new Error('ENOSPC: no space left on device')
      },
      true
    )
    await h.engine.start({ sourceId: 'screen:0', tracks: NO_TRACKS, countdown: false })
    h.recorder().emit([1])
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const report = h.reports.find((r) => r.message.includes('ENOSPC'))
    expect(report).toBeDefined()
    expect(report?.kind).toBe('capture-failed')
  })
})
