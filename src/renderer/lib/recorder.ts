/**
 * The recording engine. Runs in the hidden `recorder` window only.
 *
 * Owns `getDisplayMedia`, `getUserMedia` and `MediaRecorder` — web APIs that
 * exist nowhere but a renderer. Everything durable (the file, the manifest, the
 * library item) is main's; this module produces bytes and hands them over a
 * chunk at a time.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 * 1. **Chunks go straight to main** (FR-REC.3). They are never accumulated in
 *    an array. A SIGKILL then costs at most one chunk interval instead of the
 *    entire recording.
 * 2. **All audio goes through one Web Audio graph.** `MediaRecorder` encodes a
 *    single audio track; handing it a stream with both a loopback track and a
 *    microphone track silently drops one of them, with nothing reporting a
 *    problem. Mixing to one `MediaStreamAudioDestinationNode` is what makes
 *    FR-REC.1 actually work — and the per-source `GainNode` is the per-track
 *    mute while the per-source `AnalyserNode` is the per-track level meter, so
 *    one graph satisfies all three requirements.
 * 3. **Mic and camera permission are requested independently**, at the moment
 *    that track is first enabled (UX-PRM.4) — never up front, and never
 *    together.
 */

import {
  CHUNK_INTERVAL_MS,
  MIC_SILENCE_WINDOW_MS,
  containerOf,
  idleStatus,
  pickRecordingMime,
  type RecordCommand,
  type RecordingStatus,
  type StartRecordingOptions,
  type TrackKind,
  type TrackState
} from '@shared/recording'

const COUNTDOWN_SECONDS = 3

/** One captured source, plus whatever the mixer needs to mute and meter it. */
interface AudioSource {
  stream: MediaStream
  gain: GainNode
  analyser: AnalyserNode
  data: Uint8Array<ArrayBuffer>
}

interface TrackRuntime {
  enabled: boolean
  live: boolean
  muted: boolean
  error: string | null
}

function emptyTrack(enabled: boolean): TrackRuntime {
  return { enabled, live: false, muted: false, error: null }
}

/**
 * Turns a getUserMedia rejection into something a person can act on.
 *
 * The distinction matters: "denied" needs a trip to system settings, "no
 * device" needs hardware, and "in use" needs another app closed. Collapsing
 * them into one message sends the user to the wrong place.
 */
function describeMediaError(err: unknown, what: string): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
      return `${what} permission was denied. Grant access in your system settings, then enable this track again.`
    case 'NotFoundError':
      return `No ${what.toLowerCase()} was found on this machine.`
    case 'NotReadableError':
      return `Your ${what.toLowerCase()} is in use by another application.`
    case 'OverconstrainedError':
      return `The selected ${what.toLowerCase()} is no longer available.`
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

export interface RecorderCallbacks {
  onStatus: (status: RecordingStatus) => void
  /** Called with the recording id and its chunk; must resolve before the next chunk. */
  onChunk: (recordingId: string, chunk: Uint8Array) => Promise<void>
  onFinished: (recordingId: string, info: { width: number; height: number; durationMs: number }) => Promise<void>
  onFailed: (message: string) => void
}

/**
 * Bridges to main. Kept as an interface rather than reaching for `window.api`
 * directly so the engine is testable and its dependencies are visible.
 */
export interface RecorderBridge {
  prepareRecording(sourceId: string, withAudio: boolean): Promise<{ ok: boolean; error?: string }>
  beginRecording(req: {
    mimeType: string
    width: number
    height: number
    tracks: { system: boolean; mic: boolean; camera: boolean }
  }): Promise<{ ok: true; value: { recordingId: string } } | { ok: false; error: string }>
  markChapter(recordingId: string, atMs: number): Promise<unknown>
}

export class ScreenRecorder {
  private recorder: MediaRecorder | null = null
  private recordingId: string | null = null
  private mimeType = ''

  private screenStream: MediaStream | null = null
  private cameraStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private mixDestination: MediaStreamAudioDestinationNode | null = null
  private audioSources = new Map<'system' | 'mic', AudioSource>()

  private tracks: Record<TrackKind, TrackRuntime> = {
    screen: emptyTrack(true),
    system: emptyTrack(false),
    mic: emptyTrack(false),
    camera: emptyTrack(false)
  }

  private phase: RecordingStatus['phase'] = 'idle'
  private countdown = 0
  private chapters = 0
  private micSilent = false
  private micPeak = 0
  /** Accumulated recorded milliseconds, excluding time spent paused. */
  private accumulatedMs = 0
  private segmentStartedAt = 0
  private width = 0
  private height = 0
  private tick: ReturnType<typeof setInterval> | null = null
  private countdownTimer: ReturnType<typeof setInterval> | null = null
  /** Settles the in-flight countdown. Held so "skip" and "cancel" can end it early. */
  private countdownSettle: ((r: 'done' | 'cancelled') => void) | null = null
  private micDeviceId: string | null = null
  private lastOptions: StartRecordingOptions | null = null
  /**
   * Serialises chunk delivery. `ondataavailable` is not async-aware, so without
   * a queue two chunks can be in flight at once and land out of order — which
   * in a fragmented container is a file that will not play.
   */
  private chunkQueue: Promise<void> = Promise.resolve()
  /**
   * Resolves when the recording has fully finished — every chunk flushed and
   * main told to close the file.
   *
   * Created at start, not at stop. `MediaRecorder.onstop` also fires for an
   * OS-initiated stop, and a promise that only exists once someone asked to
   * stop leaves that path with nowhere to deliver its outcome.
   */
  private done: Promise<void> = Promise.resolve()
  private settleDone: (() => void) | null = null

  constructor(
    private readonly cb: RecorderCallbacks,
    private readonly bridge: RecorderBridge
  ) {}

  get active(): boolean {
    return this.phase === 'countdown' || this.phase === 'recording' || this.phase === 'paused'
  }

  /* ---------------- status ---------------- */

  private trackStates(): TrackState[] {
    return (Object.keys(this.tracks) as TrackKind[]).map((kind) => {
      const t = this.tracks[kind]
      const source = kind === 'mic' || kind === 'system' ? this.audioSources.get(kind) : undefined
      return {
        kind,
        enabled: t.enabled,
        live: t.live,
        muted: t.muted,
        level: source ? this.levelOf(source) : null,
        error: t.error
      }
    })
  }

  private levelOf(source: AudioSource): number {
    source.analyser.getByteTimeDomainData(source.data)
    let peak = 0
    for (let i = 0; i < source.data.length; i++) {
      // 128 is silence in the unsigned 8-bit time domain.
      const v = Math.abs(source.data[i] - 128) / 128
      if (v > peak) peak = v
    }
    return Math.min(peak, 1)
  }

  private elapsedMs(): number {
    if (this.phase !== 'recording') return Math.round(this.accumulatedMs)
    return Math.round(this.accumulatedMs + (performance.now() - this.segmentStartedAt))
  }

  private emit(error: string | null = null): void {
    const status: RecordingStatus = {
      phase: this.phase,
      elapsedMs: this.elapsedMs(),
      countdown: this.countdown,
      tracks: this.trackStates(),
      chapters: this.chapters,
      micSilent: this.micSilent,
      container: this.mimeType ? containerOf(this.mimeType) : null,
      error
    }
    this.cb.onStatus(status)
  }

  /* ---------------- start ---------------- */

  async start(options: StartRecordingOptions): Promise<void> {
    if (this.active) throw new Error('A recording is already in progress')
    this.lastOptions = options
    this.reset()
    this.tracks.system.enabled = options.tracks.system
    this.tracks.mic.enabled = options.tracks.mic
    this.tracks.camera.enabled = options.tracks.camera

    try {
      await this.openScreen(options.sourceId, options.tracks.system)
      // Requested one at a time, and only when asked for: enabling a microphone
      // must never also prompt for a camera (UX-PRM.4).
      if (options.tracks.mic) await this.openMic()
      if (options.tracks.camera) await this.openCamera()
    } catch (err) {
      this.teardown()
      const message = err instanceof Error ? err.message : String(err)
      this.phase = 'idle'
      this.emit(message)
      this.cb.onFailed(message)
      return
    }

    if (options.countdown) {
      const skipped = await this.runCountdown()
      if (skipped === 'cancelled') {
        this.teardown()
        this.phase = 'idle'
        this.emit()
        return
      }
    }

    await this.beginRecorder()
  }

  private reset(): void {
    this.chapters = 0
    this.micSilent = false
    this.micPeak = 0
    this.accumulatedMs = 0
    this.recordingId = null
    this.mimeType = ''
    this.chunkQueue = Promise.resolve()
    for (const kind of Object.keys(this.tracks) as TrackKind[]) {
      this.tracks[kind] = emptyTrack(kind === 'screen')
    }
  }

  private async openScreen(sourceId: string, withSystemAudio: boolean): Promise<void> {
    const prep = await this.bridge.prepareRecording(sourceId, withSystemAudio)
    if (!prep.ok) throw new Error(prep.error ?? 'Could not prepare the capture source.')

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: withSystemAudio })
    } catch (err) {
      throw new Error(describeMediaError(err, 'Screen recording'))
    }
    this.screenStream = stream
    this.tracks.screen.live = true

    const video = stream.getVideoTracks()[0]
    const settings = video?.getSettings() ?? {}
    this.width = Math.round(settings.width ?? 0)
    this.height = Math.round(settings.height ?? 0)

    // The user can also stop from the OS's own "stop sharing" bar.
    video?.addEventListener('ended', () => {
      if (this.active) void this.stop()
    })

    const systemTrack = stream.getAudioTracks()[0]
    if (withSystemAudio) {
      if (systemTrack) this.addAudioSource('system', new MediaStream([systemTrack]))
      else {
        // Requested and not delivered is a real, reportable state — a silent
        // recording that nobody warned about is the bug this replaces.
        this.tracks.system.error = 'System audio is not available on this platform.'
      }
    }
  }

  private async openMic(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: this.micDeviceId ? { deviceId: { exact: this.micDeviceId } } : true
      })
      this.addAudioSource('mic', stream)
    } catch (err) {
      // A denied microphone must not abort the recording — the screen track is
      // still worth having, and the HUD says the mic failed.
      this.tracks.mic.error = describeMediaError(err, 'Microphone')
      this.tracks.mic.live = false
    }
  }

  private async openCamera(): Promise<void> {
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 } }
      })
      this.tracks.camera.live = true
    } catch (err) {
      this.tracks.camera.error = describeMediaError(err, 'Camera')
      this.tracks.camera.live = false
    }
  }

  private addAudioSource(kind: 'system' | 'mic', stream: MediaStream): void {
    this.audioContext ??= new AudioContext()
    this.mixDestination ??= this.audioContext.createMediaStreamDestination()

    const node = this.audioContext.createMediaStreamSource(stream)
    const gain = this.audioContext.createGain()
    const analyser = this.audioContext.createAnalyser()
    analyser.fftSize = 1024
    // Metered *before* the gain node on purpose: a muted track still shows its
    // real level, so the user can see the mic is working while it is muted.
    node.connect(analyser)
    node.connect(gain)
    gain.connect(this.mixDestination)

    this.audioSources.set(kind, {
      stream,
      gain,
      analyser,
      data: new Uint8Array(new ArrayBuffer(analyser.fftSize))
    })
    this.tracks[kind].live = true
    this.tracks[kind].error = null
  }

  /** The stream handed to MediaRecorder: one video track, one mixed audio track. */
  private buildOutputStream(): MediaStream {
    const out = new MediaStream()
    const video = this.screenStream?.getVideoTracks()[0]
    if (!video) throw new Error('The screen track went away before recording could start.')
    out.addTrack(video)
    const mixed = this.mixDestination?.stream.getAudioTracks()[0]
    if (mixed) out.addTrack(mixed)
    return out
  }

  private async runCountdown(): Promise<'done' | 'cancelled'> {
    this.phase = 'countdown'
    this.countdown = COUNTDOWN_SECONDS
    this.emit()
    return new Promise<'done' | 'cancelled'>((resolve) => {
      this.countdownSettle = resolve
      this.countdownTimer = setInterval(() => {
        this.countdown -= 1
        if (this.countdown <= 0) {
          this.settleCountdown('done')
          return
        }
        this.emit()
      }, 1000)
    })
  }

  /**
   * Ends the countdown exactly once.
   *
   * Skip and cancel both arrive asynchronously while the interval is still
   * running; without a single settle point they race it and the recorder is
   * started twice against one stream.
   */
  private settleCountdown(result: 'done' | 'cancelled'): void {
    const settle = this.countdownSettle
    this.countdownSettle = null
    this.clearCountdown()
    settle?.(result)
  }

  private clearCountdown(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = null
    this.countdown = 0
  }

  private async beginRecorder(): Promise<void> {
    const mimeType = pickRecordingMime((t) => MediaRecorder.isTypeSupported(t))
    if (!mimeType) {
      this.teardown()
      this.phase = 'idle'
      const message = 'This build has no supported video encoder for recording.'
      this.emit(message)
      this.cb.onFailed(message)
      return
    }
    this.mimeType = mimeType

    let stream: MediaStream
    try {
      stream = this.buildOutputStream()
    } catch (err) {
      this.teardown()
      this.phase = 'idle'
      const message = err instanceof Error ? err.message : String(err)
      this.emit(message)
      this.cb.onFailed(message)
      return
    }

    // The file is opened before a single frame is encoded. A recording that
    // cannot be persisted must never appear to the user as running.
    const opened = await this.bridge.beginRecording({
      mimeType,
      width: this.width,
      height: this.height,
      tracks: {
        system: this.tracks.system.enabled,
        mic: this.tracks.mic.enabled,
        camera: this.tracks.camera.enabled
      }
    })
    if (!opened.ok) {
      this.teardown()
      this.phase = 'idle'
      this.emit(opened.error)
      this.cb.onFailed(opened.error)
      return
    }
    this.recordingId = opened.value.recordingId
    this.done = new Promise<void>((resolve) => {
      this.settleDone = resolve
    })

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 })
    this.recorder = recorder

    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return
      const id = this.recordingId
      if (!id) return
      // Queued, so chunks reach main in the order the muxer produced them.
      this.chunkQueue = this.chunkQueue
        .then(async () => {
          const bytes = new Uint8Array(await e.data.arrayBuffer())
          await this.cb.onChunk(id, bytes)
        })
        .catch((err: unknown) => {
          // A failed write means the recording is no longer being persisted.
          // Saying so beats continuing to look like it is recording.
          console.error('[recorder] chunk write failed', err)
          this.cb.onFailed(
            `Could not write the recording to disk: ${err instanceof Error ? err.message : String(err)}`
          )
        })
    }

    recorder.onerror = () => {
      const message = 'Recording failed unexpectedly.'
      void this.finish(message)
    }

    recorder.onstop = () => {
      void this.finish(null)
    }

    this.segmentStartedAt = performance.now()
    this.accumulatedMs = 0
    this.phase = 'recording'
    recorder.start(CHUNK_INTERVAL_MS)

    this.tick = setInterval(() => {
      this.checkMicSilence()
      this.emit()
    }, 250)
    this.emit()
  }

  /** UX-REC.5 — warn, never stop. */
  private checkMicSilence(): void {
    const mic = this.audioSources.get('mic')
    if (!mic || this.micSilent) return
    this.micPeak = Math.max(this.micPeak, this.levelOf(mic))
    if (this.elapsedMs() >= MIC_SILENCE_WINDOW_MS && this.micPeak < 0.01) {
      this.micSilent = true
    }
  }

  /* ---------------- commands ---------------- */

  command(cmd: RecordCommand): void {
    switch (cmd) {
      case 'pause':
        this.pause()
        break
      case 'resume':
        this.resume()
        break
      case 'stop':
        void this.stop()
        break
      case 'cancel':
        void this.cancel()
        break
      case 'chapter':
        void this.chapter()
        break
      case 'skip-countdown':
        // Settled through the same single path a natural expiry takes, so
        // `start()` continues into `beginRecorder` exactly once.
        if (this.phase === 'countdown') this.settleCountdown('done')
        break
      case 'toggle-mic':
        this.toggleMute('mic')
        break
      case 'toggle-system':
        this.toggleMute('system')
        break
      case 'switch-mic':
        void this.switchMic()
        break
    }
  }

  /**
   * FR-REC.2 — pause without a discontinuity artefact.
   *
   * `MediaRecorder.pause()` stops requesting frames and, crucially, stops
   * advancing the media timeline: on resume the muxer continues from where it
   * left off rather than emitting a gap. Tearing the stream down and starting a
   * second recorder is what produces the artefact, so we deliberately keep the
   * same recorder, the same stream and the same file.
   */
  pause(): void {
    if (this.phase !== 'recording' || !this.recorder) return
    this.recorder.pause()
    this.sealSegment()
    this.phase = 'paused'
    this.emit()
  }

  resume(): void {
    if (this.phase !== 'paused' || !this.recorder) return
    this.recorder.resume()
    this.segmentStartedAt = performance.now()
    this.phase = 'recording'
    this.emit()
  }

  /** FR-REC.8 — a marker, recorded into the manifest so it survives a crash. */
  async chapter(): Promise<void> {
    if (!this.recordingId || !this.active) return
    this.chapters += 1
    this.emit()
    await this.bridge.markChapter(this.recordingId, this.elapsedMs())
  }

  private toggleMute(kind: 'mic' | 'system'): void {
    const source = this.audioSources.get(kind)
    if (!source) return
    const next = !this.tracks[kind].muted
    this.tracks[kind].muted = next
    // A gain of 0 rather than disabling the track: a disabled track stops
    // producing samples, which the muxer sees as a discontinuity.
    source.gain.gain.value = next ? 0 : 1
    this.emit()
  }

  /**
   * UX-REC.5's one-click source switch: drop the current mic and open the next
   * device in the list. Done live, without touching the recorder — the mixed
   * output track is unchanged, so the recording continues uninterrupted.
   */
  private async switchMic(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
    if (inputs.length === 0) return
    const currentIndex = inputs.findIndex((d) => d.deviceId === this.micDeviceId)
    const next = inputs[(currentIndex + 1) % inputs.length]
    this.micDeviceId = next.deviceId

    const existing = this.audioSources.get('mic')
    if (existing) {
      existing.gain.disconnect()
      existing.stream.getTracks().forEach((t) => t.stop())
      this.audioSources.delete('mic')
    }
    this.tracks.mic.error = null
    await this.openMic()
    // Give the new device a fresh 10 s window rather than inheriting the old
    // device's verdict.
    this.micSilent = false
    this.micPeak = 0
    this.emit()
  }

  async stop(): Promise<void> {
    if (!this.active) return
    if (this.phase === 'countdown') {
      // Stopping during the pre-roll is a cancel: nothing has been recorded yet.
      this.settleCountdown('cancelled')
      return
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      // Sealed before the phase moves off `recording`, or the final segment is
      // never counted.
      this.sealSegment()
      this.phase = 'stopping'
      this.emit()
      // `onstop` drives `finish`; requestData first so the tail chunk is not lost.
      this.recorder.requestData()
      this.recorder.stop()
      // `onstop` drives the rest; awaiting it here means a caller that awaits
      // `stop()` knows the file is closed and the library item exists.
      await this.done
    } else {
      await this.finish(null)
    }
  }

  /** Abandons a recording and deletes its bytes. Used for a cancelled countdown. */
  async cancel(): Promise<void> {
    if (this.phase === 'countdown') {
      this.settleCountdown('cancelled')
      return
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop()
      return
    }
    this.teardown()
    this.phase = 'idle'
    this.emit()
  }

  /** Every ending routes through here, so no path can finish silently. */
  private async finish(error: string | null): Promise<void> {
    try {
      await this.finishInner(error)
    } finally {
      // Settled in a `finally` so a throw anywhere above cannot leave `stop()`
      // awaiting a promise that never resolves.
      const settle = this.settleDone
      this.settleDone = null
      settle?.()
    }
  }

  /**
   * Folds the current recording segment into the accumulated total.
   *
   * Called by every transition out of `recording` — pause and stop alike.
   * Doing it only in `finish` silently lost the last segment, because `stop()`
   * moves the phase to `stopping` before `onstop` fires: the elapsed time the
   * HUD had been showing did not match the duration the library recorded.
   */
  private sealSegment(): void {
    if (this.phase !== 'recording') return
    this.accumulatedMs += performance.now() - this.segmentStartedAt
  }

  private async finishInner(error: string | null): Promise<void> {
    this.sealSegment()
    const id = this.recordingId
    const durationMs = Math.round(this.accumulatedMs)
    const width = this.width
    const height = this.height

    this.phase = 'stopping'
    this.emit(error)

    // Wait for every queued chunk to land before telling main to close the file.
    await this.chunkQueue.catch(() => undefined)
    this.teardown()

    this.recordingId = null
    this.phase = 'idle'

    if (error) {
      this.emit(error)
      this.cb.onFailed(error)
      return
    }
    if (!id) {
      this.emit()
      return
    }
    try {
      await this.cb.onFinished(id, { width, height, durationMs })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit(message)
      this.cb.onFailed(message)
      return
    }
    this.emit()
  }

  private teardown(): void {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    this.clearCountdown()
    this.recorder = null
    for (const source of this.audioSources.values()) {
      source.stream.getTracks().forEach((t) => t.stop())
    }
    this.audioSources.clear()
    this.mixDestination = null
    void this.audioContext?.close().catch(() => undefined)
    this.audioContext = null
    this.screenStream?.getTracks().forEach((t) => t.stop())
    this.screenStream = null
    this.cameraStream?.getTracks().forEach((t) => t.stop())
    this.cameraStream = null
    for (const kind of Object.keys(this.tracks) as TrackKind[]) {
      this.tracks[kind].live = false
    }
  }

  /** For a window teardown: stop everything without producing a library item. */
  dispose(): void {
    this.teardown()
    this.phase = 'idle'
  }

  /** Last options, so a retry after a permission grant does not need re-picking. */
  get lastRequest(): StartRecordingOptions | null {
    return this.lastOptions
  }
}

export { idleStatus }
