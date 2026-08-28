/**
 * Entry point for the hidden recorder window.
 *
 * No React and no DOM: this window is never shown. It exists only so
 * `MediaRecorder` runs in a renderer that main creates with
 * `backgroundThrottling: false`, which is what stops a recording stuttering or
 * stalling when the main window is minimised or unfocused.
 *
 * Everything it does is a reaction to a message from main, and every outcome —
 * success, failure, or an engine that died — is reported back. There is no path
 * out of this file that ends silently.
 */

import { ScreenRecorder } from './lib/recorder'
import type { RecordCommand, StartRecordingOptions } from '@shared/recording'

const engine = new ScreenRecorder(
  {
    onStatus: (status) => {
      void window.api.publishRecordingStatus(status)
    },
    onChunk: async (recordingId, chunk) => {
      const res = await window.api.appendRecordingChunk(recordingId, chunk)
      // Throwing propagates into the engine's chunk queue, which reports it as
      // a failed recording. Swallowing it here would leave the HUD counting up
      // against a file nothing is being written to.
      if (!res.ok) throw new Error(res.error)
    },
    onFinished: async (recordingId, info) => {
      const res = await window.api.finalizeRecording({ recordingId, ...info })
      if (!res.ok) throw new Error(res.error)
    },
    onFailed: (message) => {
      console.error('[recorder]', message)
    }
  },
  {
    prepareRecording: async (sourceId, withAudio) => {
      const res = await window.api.prepareRecording(sourceId, withAudio)
      return res.ok ? { ok: true } : { ok: false, error: res.error }
    },
    beginRecording: (req) => window.api.beginRecording(req),
    markChapter: (recordingId, atMs) => window.api.markChapter(recordingId, atMs)
  }
)

window.api.onRecordRequest((options: StartRecordingOptions) => {
  void engine.start(options)
})

window.api.onRecordCommand((command: string) => {
  engine.command(command as RecordCommand)
})

// A window that goes away mid-recording must not leave the capture stream
// running; the bytes already on disk stay recoverable either way.
window.addEventListener('beforeunload', () => engine.dispose())
