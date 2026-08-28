import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecorderBridge, RecorderCallbacks } from './recorder'
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
  recorder: () => FakeMediaRecorder
}

async function harness(
  overrides: Partial<RecorderBridge> = {},
  chunkSink?: (id: string, chunk: Uint8Array) => Promise<void>
): Promise<Harness> {
  vi.resetModules()
  const { ScreenRecorder } = await import('./recorder')

  const statuses: RecordingStatus[] = []
  const chunks: Array<{ id: string; bytes: number[] }> = []
  const finished: Array<{ id: string; durationMs: number }> = []
  const failures: string[] = []

  const cb: RecorderCallbacks = {
    onStatus: (s) => statuses.push(s),
    onChunk: async (id, chunk) => {
      chunks.push({ id, bytes: [...chunk] })
      if (chunkSink) await chunkSink(id, chunk)
    },
    onFinished: async (id, info) => {
      finished.push({ id, durationMs: info.durationMs })
    },
    onFailed: (m) => failures.push(m)
  }

  const bridge: RecorderBridge = {
    prepareRecording: async () => ({ ok: true }),
    beginRecording: async () => ({ ok: true, value: { recordingId: 'rec-1' } }),
    markChapter: async () => [],
    ...overrides
  }

  return {
    engine: new ScreenRecorder(cb, bridge),
    statuses,
    chunks,
    finished,
    failures,
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
