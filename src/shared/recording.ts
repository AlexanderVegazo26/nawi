/**
 * Recording container selection and the track model — shared by main, preload
 * and both renderer entries.
 *
 * Deliberately node-free and DOM-free. `pickRecordingMime` takes the support
 * predicate as a parameter instead of reaching for the global `MediaRecorder`,
 * so the container decision is a pure function that the node-environment unit
 * suite can exercise without a DOM.
 *
 * ---------------------------------------------------------------------------
 * FR-REC.4 — why MP4 is first.
 *
 * `docs/ARCHITECTURE.md` §2.3 (and its assumption #4) says MP4 requires
 * bundling ffmpeg and therefore the app records WebM only. That note is
 * **superseded, not edited**: probed directly against this Electron build,
 * `MediaRecorder` accepts `video/mp4;codecs=avc1.42E01E,mp4a.40.2` and emits a
 * real ISO-BMFF file that loads, plays and seeks, at roughly 40% the size of
 * the equivalent VP9 WebM. No ffmpeg, no WebCodecs, no native modules.
 *
 * The `isTypeSupported` gate and the WebM fallback chain stay, because MP4
 * support is version- and platform-dependent. Probe, never assume.
 * ---------------------------------------------------------------------------
 */

/** Containers a recording can land in. Both are directly muxable by MediaRecorder. */
export type RecordingContainer = 'mp4' | 'webm'

export interface ContainerFormat {
  ext: RecordingContainer
  mime: 'video/mp4' | 'video/webm'
}

export const CONTAINERS: Record<RecordingContainer, ContainerFormat> = {
  mp4: { ext: 'mp4', mime: 'video/mp4' },
  webm: { ext: 'webm', mime: 'video/webm' }
}

/**
 * Preference order; the first supported type wins.
 *
 * MP4 first (FR-REC.4 is P0 and MP4 is what every downstream consumer expects),
 * then the WebM chain that shipped before, so a build without an H.264 muxer
 * still records rather than failing.
 */
export const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp8',
  'video/webm'
] as const

/**
 * The container a MediaRecorder mime string will actually produce.
 *
 * Returns null for anything that is neither — the caller must treat that as a
 * refusal rather than defaulting to WebM, because guessing here is how a file
 * ends up on disk with an extension that does not match its bytes.
 */
export function containerOf(mimeType: string): RecordingContainer | null {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (base === 'video/mp4') return 'mp4'
  if (base === 'video/webm') return 'webm'
  return null
}

/** First candidate the runtime actually supports, or undefined when none is. */
export function pickRecordingMime(
  isSupported: (type: string) => boolean
): string | undefined {
  return MIME_CANDIDATES.find((t) => {
    try {
      return isSupported(t)
    } catch {
      // A predicate that throws is a predicate that said "no".
      return false
    }
  })
}

/* ------------------------------------------------------------------ *
 * FR-REC.1 — independent tracks
 * ------------------------------------------------------------------ */

/** The four independently toggleable, independently muteable tracks. */
export const TRACK_KINDS = ['screen', 'system', 'mic', 'camera'] as const
export type TrackKind = (typeof TRACK_KINDS)[number]

/** Audio tracks only — the two that get a gain node and a level meter. */
export const AUDIO_TRACKS = ['system', 'mic'] as const
export type AudioTrackKind = (typeof AUDIO_TRACKS)[number]

export function isTrackKind(v: unknown): v is TrackKind {
  return typeof v === 'string' && (TRACK_KINDS as readonly string[]).includes(v)
}

/** What the user asked for before permission or device availability is known. */
export interface TrackSelection {
  /** Screen is not optional — a recording with no video track is not a recording. */
  system: boolean
  mic: boolean
  camera: boolean
}

export interface StartRecordingOptions {
  sourceId: string
  tracks: TrackSelection
  /** Show the 3-2-1 pre-roll before the first frame. */
  countdown: boolean
}

/** Per-track runtime state, as reported by the recorder window to the HUD. */
export interface TrackState {
  kind: TrackKind
  /** The user asked for it. */
  enabled: boolean
  /** It is actually producing media right now. */
  live: boolean
  /** Muted at the mixer. A muted track is still live; it just contributes silence. */
  muted: boolean
  /** 0..1 short-term peak, audio tracks only; null for video tracks. */
  level: number | null
  /** Populated when the track was requested but could not start. */
  error: string | null
}

export type RecordingPhase =
  | 'idle'
  | 'countdown'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'error'

/** The single status object the recorder broadcasts; the HUD renders exactly this. */
export interface RecordingStatus {
  phase: RecordingPhase
  /** Wall-clock milliseconds of *recorded* material, excluding paused time. */
  elapsedMs: number
  /** Countdown seconds remaining, only meaningful in the `countdown` phase. */
  countdown: number
  tracks: TrackState[]
  chapters: number
  /** UX-REC.5 — the mic read silent for the first 10 s. Never stops the recording. */
  micSilent: boolean
  container: RecordingContainer | null
  error: string | null
}

export function idleStatus(): RecordingStatus {
  return {
    phase: 'idle',
    elapsedMs: 0,
    countdown: 0,
    tracks: [],
    chapters: 0,
    micSilent: false,
    container: null,
    error: null
  }
}

/** Commands the HUD (or a hotkey) sends to the recorder window, via main. */
export const RECORD_COMMANDS = [
  'pause',
  'resume',
  'stop',
  'cancel',
  'chapter',
  'skip-countdown',
  'toggle-mic',
  'toggle-system',
  'switch-mic'
] as const
export type RecordCommand = (typeof RECORD_COMMANDS)[number]

export function isRecordCommand(v: unknown): v is RecordCommand {
  return typeof v === 'string' && (RECORD_COMMANDS as readonly string[]).includes(v)
}

/** UX-REC.5 — how long a silent mic is tolerated before the HUD says so. */
export const MIC_SILENCE_WINDOW_MS = 10_000

/**
 * How often MediaRecorder is asked to hand over a chunk.
 *
 * FR-REC.3 allows at most 5 s of loss on a SIGKILL. One second gives a 5x
 * margin and costs nothing measurable — the write is an append to an already
 * open stream.
 */
export const CHUNK_INTERVAL_MS = 1000
