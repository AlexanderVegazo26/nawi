/**
 * Screen recording via getDisplayMedia + MediaRecorder.
 *
 * Main installs a display-media request handler that answers with the source the
 * user already picked, so the OS picker never appears.
 */

export interface RecordingResult {
  blob: Blob
  width: number
  height: number
  durationMs: number
}

/** Preference order; the first supported type wins. */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm'
]

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t))
}

export class ScreenRecorder {
  /**
   * Fired when the recording stopped without anyone calling `stop()` — the user
   * hit the OS's own "stop sharing" bar, or the source went away. Consumers must
   * handle this or the recording is lost and the UI stays stuck showing
   * "recording in progress".
   */
  onAutoStop: (() => void) | null = null

  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  /**
   * Created at `start()`, not at `stop()`. Resolving a promise that only exists
   * once someone asks to stop means an unsolicited stop has nowhere to deliver
   * its result, and the finished recording is silently dropped.
   */
  private done: Promise<RecordingResult> | null = null
  private settle: ((r: RecordingResult) => void) | null = null
  private fail: ((e: Error) => void) | null = null
  private stopRequested = false

  get active(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording'
  }

  /** The in-flight recording's eventual result, or null if none was started. */
  get result(): Promise<RecordingResult> | null {
    return this.done
  }

  async start(sourceId: string, withAudio: boolean): Promise<void> {
    if (this.active) throw new Error('A recording is already in progress')

    // Tell main which source to answer the upcoming request with.
    const prep = await window.api.prepareRecording(sourceId)
    if (!prep.ok) throw new Error(prep.error)

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: withAudio
      })
    } catch (err) {
      // The user cancelling and the OS denying permission surface the same way.
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError') {
        throw new Error(
          'Screen recording permission was denied. Grant this app screen-recording access in your system settings, then try again.'
        )
      }
      throw new Error(err instanceof Error ? err.message : String(err))
    }

    const mimeType = pickMimeType()
    if (!mimeType) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('This build has no supported video encoder for recording.')
    }

    this.stream = stream
    this.chunks = []
    this.startedAt = performance.now()
    this.stopRequested = false
    this.done = new Promise<RecordingResult>((resolve, reject) => {
      this.settle = resolve
      this.fail = reject
    })

    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 })
    this.recorder = recorder

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    recorder.onerror = () => {
      this.cleanup()
      this.fail?.(new Error('Recording failed unexpectedly.'))
    }
    recorder.onstop = () => {
      const track = stream.getVideoTracks()[0]
      const settings = track?.getSettings() ?? {}
      const result: RecordingResult = {
        blob: new Blob(this.chunks, { type: mimeType }),
        width: Math.round(settings.width ?? 0),
        height: Math.round(settings.height ?? 0),
        durationMs: Math.round(performance.now() - this.startedAt)
      }
      const wasUnsolicited = !this.stopRequested
      this.cleanup()
      this.settle?.(result)
      // Let the app persist the blob and clear its "recording" state; otherwise
      // an OS-initiated stop loses the recording and wedges the UI.
      if (wasUnsolicited) this.onAutoStop?.()
    }

    // The user can also stop from the OS's own "stop sharing" affordance.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.recorder?.state === 'recording') this.recorder.stop()
    })

    // Timeslice keeps chunks flowing so a crash doesn't lose everything.
    recorder.start(1000)
  }

  stop(): Promise<RecordingResult> {
    if (!this.recorder || this.recorder.state === 'inactive' || !this.done) {
      return Promise.reject(new Error('No recording in progress'))
    }
    this.stopRequested = true
    this.recorder.stop()
    return this.done
  }

  /** Abandons the recording without producing a result. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null
      this.recorder.stop()
    }
    this.cleanup()
  }

  private cleanup(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.recorder = null
  }
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}
