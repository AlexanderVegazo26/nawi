/**
 * Shared contract between main, preload and renderer.
 * Anything crossing the contextBridge is defined here so both sides stay in sync.
 */

import type { Settings, SettingsPatch } from './settings'
import { CONTAINERS, type RecordingContainer } from './recording'
import type {
  RecordingStatus,
  StartRecordingOptions,
  TrackSelection
} from './recording'

export type { Settings, SettingsPatch }

export type CaptureKind = 'fullscreen' | 'window' | 'region'
export type MediaKind = 'image' | 'video'

/**
 * What a library row represents. Deliberately wider than `MediaKind`: a guide is a
 * library item but is never something `library.save()` writes bytes for, and the
 * capture/export paths key their file extension and MIME off `MediaKind`.
 */
export type LibraryItemKind = MediaKind | 'guide'

/**
 * The single exhaustive read of `LibraryItemKind`.
 *
 * Widening `LibraryItemKind` made six sites non-exhaustive: each tested
 * `kind === 'video'` and treated everything else as an image, so a guide would be
 * handed back as `image/png` with a `.png` extension. Routing every read through
 * here means adding a kind is a *compile error* in one place instead of a
 * mislabelled file in five.
 */
export function mediaKindOf(kind: LibraryItemKind): MediaKind | null {
  switch (kind) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'guide':
      // A guide is a document, not media. Callers that need bytes must say so.
      return null
    default: {
      const unhandled: never = kind
      throw new Error(`unhandled library item kind: ${String(unhandled)}`)
    }
  }
}

export interface MediaFormat {
  ext: 'png' | 'webm' | 'mp4'
  mime: 'image/png' | 'video/webm' | 'video/mp4'
}

/**
 * File extension and MIME for an item that must have bytes.
 *
 * Throws for a guide rather than falling back to PNG. A fallback here is the
 * exact bug this function exists to remove — it would hand a caller a guide
 * labelled as an image and let it reach the clipboard or the filesystem.
 */
export function mediaFormat(kind: LibraryItemKind, container?: RecordingContainer): MediaFormat {
  const media = mediaKindOf(kind)
  if (media === null) {
    throw new Error(`a ${kind} has no media bytes; it cannot be exported or read as a file`)
  }
  if (media !== 'video') return { ext: 'png', mime: 'image/png' }
  // WebM is the fallback only because it is what every video written before the
  // MP4 switch actually is. New recordings always carry their container
  // explicitly; this branch exists for those older index records.
  return CONTAINERS[container ?? 'webm']
}

/**
 * The format of an item as it really exists on disk.
 *
 * Prefer this over `mediaFormat(item.kind)` anywhere an item is in hand: the
 * kind alone cannot tell MP4 from WebM, and assuming from it is how a recording
 * gets served, exported, and named as the wrong container.
 */
export function formatOf(item: Pick<LibraryItem, 'kind' | 'container'>): MediaFormat {
  return mediaFormat(item.kind, item.container)
}

/** A selectable capture source, as surfaced by desktopCapturer. */
export interface CaptureSource {
  id: string
  name: string
  /** data: URL of the source preview thumbnail. */
  thumbnail: string
  /** data: URL of the app/window icon, when the OS provides one. */
  appIcon: string | null
  /** Present for screens; maps a source back to a physical display. */
  displayId: string | null
}

export interface DisplayInfo {
  id: number
  /** DIP bounds as reported by the `screen` module. */
  bounds: Rect
  scaleFactor: number
  isPrimary: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A single stored item in the capture library. */
export interface LibraryItem {
  id: string
  /** User-editable display name. */
  name: string
  kind: LibraryItemKind
  captureKind: CaptureKind
  /** Absolute path on disk of the full-resolution asset. */
  filePath: string
  width: number
  height: number
  /** Bytes. */
  size: number
  /** Milliseconds, videos only. */
  durationMs: number | null
  /** ISO-8601. */
  createdAt: string
  /** Serialized annotation document, when the user has annotated this item. */
  annotations: AnnotationDoc | null

  /* --- Additive fields. Every one is optional, so an index.json written by an
     earlier build loads unchanged and needs no migration. --- */

  /** Absolute path of this item's sidecar directory, once one has been harvested. */
  sidecarDir?: string
  /** Revision marker of the current sidecar, e.g. `v2`. Sidecar files are never edited in place. */
  sidecarRevision?: string
  tags?: string[]
  /** Absolute path of a generated thumbnail, when one exists. */
  thumbnailPath?: string
  /** Who created this item. Absent means 'user' — the only producer before agents existed. */
  source?: 'user' | 'agent'
  /**
   * PRD-002 §1 P5 soft-delete marker. ISO-8601 timestamp of the delete request.
   *
   * Present means "hidden from the library and scheduled for removal", not
   * "gone": the bytes are still on disk until the 30-second undo window
   * expires. Absent is the normal state, so an index.json from an earlier build
   * needs no migration.
   */
  deletedAt?: string
  /**
   * Container of a video item's bytes. Absent means WebM — every recording
   * written before FR-REC.4 landed was WebM, so an old index record still
   * resolves correctly with no migration.
   */
  container?: RecordingContainer
  /** Milliseconds from the start of a recording, one per FR-REC.8 chapter marker. */
  chapters?: number[]
  /**
   * True when this item came out of the crash-recovery path (FR-REC.3). Its
   * duration is an estimate and its tail may be truncated, so the UI says so
   * rather than presenting it as an ordinary recording.
   */
  recovered?: boolean
}

/* ------------------------------------------------------------------ *
 * Annotation model
 * ------------------------------------------------------------------ */

export type ShapeKind =
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'text'
  | 'highlight'
  | 'freehand'
  | 'blur'
  | 'redact'
  | 'spotlight'
  | 'magnify'
  | 'step'

/** A point in image-pixel space. */
export interface Point {
  x: number
  y: number
}

/**
 * Shapes live in image-pixel space, so a document is independent of the zoom
 * level it was drawn at and exports at full resolution without rescaling.
 */
export interface BaseShape {
  id: string
  kind: ShapeKind
  x: number
  y: number
  width: number
  height: number
  color: string
  strokeWidth: number
}

export interface TextShape extends BaseShape {
  kind: 'text'
  text: string
  fontSize: number
  /**
   * FR-ANN.4 / UX-ANN.5. True while the fill is the one the contrast check
   * chose from the pixels underneath; false once the user has overridden it.
   * Stored so reopening a document shows the same "automatic vs. yours" state
   * rather than silently re-deriving and appearing to change the user's choice.
   */
  autoContrast?: boolean
  /** The measured ratio behind `color`, so the UI can show the number it acted on. */
  contrastRatio?: number
}

export interface StepShape extends BaseShape {
  kind: 'step'
}

/**
 * How a region is obscured.
 *
 * 'solid' is the redaction mode FR-ANN.3 requires alongside the two decorative
 * ones: it replaces the region outright rather than transforming it, so nothing
 * of the original survives the render.
 */
export type ObscureMode = 'blur' | 'pixelate' | 'solid'

/**
 * A DECORATIVE obscure. Aesthetic only — it carries no security claim, and
 * UX-ANN.4 requires it to look nothing like a redaction.
 */
export interface BlurShape extends BaseShape {
  kind: 'blur'
  /** 'blur' softens, 'pixelate' blocks. */
  mode: 'blur' | 'pixelate'
  intensity: number
}

/**
 * A REDACTION — the security-bearing sibling of `BlurShape` (FR-ANN.3, UX-ANN.4).
 *
 * Deliberately a separate `kind` rather than a flag on `BlurShape`. The two have
 * different meanings to the person reading the exported image, so a reader of
 * this model cannot accidentally treat one as the other, and `render.ts` cannot
 * paint one with the other's chrome.
 */
export interface RedactShape extends BaseShape {
  kind: 'redact'
  /**
   * Always 'solid', and modelled as a one-member union rather than dropped, so
   * the field still reads as "which obscure mode" alongside `BlurShape.mode`.
   *
   * FR-ANN.3 defines redaction as *destructive on export* — "the underlying
   * pixels must not exist in the exported artifact". Blur and pixelate are
   * transforms of the original values, so a redaction in either mode would be a
   * security affordance that does not do what its shield glyph promises. Those
   * two modes already exist, honestly labelled, on the decorative `BlurShape`.
   */
  mode: 'solid'
  /**
   * Present only when a detector placed this, not the user (UX-ANN.3).
   * `label` is the concrete noun phrase the revert confirmation names, per
   * PRD-002 §9: "This will expose an API key in the shared image."
   */
  auto?: { label: string; confidence: number }
}

/** FR-ANN.1 freehand / pen. The bbox in `BaseShape` is kept in sync with `points`. */
export interface FreehandShape extends BaseShape {
  kind: 'freehand'
  points: Point[]
}

/** FR-ANN.5 spotlight: everything OUTSIDE the rect is dimmed. */
export interface SpotlightShape extends BaseShape {
  kind: 'spotlight'
  /** Dim opacity applied outside the rect, 0..1. */
  dim: number
}

/** FR-ANN.5 magnifier inset: the rect's content redrawn enlarged, in place. */
export interface MagnifyShape extends BaseShape {
  kind: 'magnify'
  /** Enlargement factor, > 1. */
  factor: number
}

export type SimpleShape = BaseShape & {
  kind: 'arrow' | 'rect' | 'ellipse' | 'line' | 'highlight'
}

export type Shape =
  | SimpleShape
  | TextShape
  | StepShape
  | BlurShape
  | RedactShape
  | FreehandShape
  | SpotlightShape
  | MagnifyShape

export interface AnnotationDoc {
  version: 1
  shapes: Shape[]
  /** Crop rect in image-pixel space, or null when uncropped. A document-level transform, not a shape. */
  crop: Rect | null
}

/* ------------------------------------------------------------------ *
 * Agent access (UX-AGT.3)
 * ------------------------------------------------------------------ */

/**
 * What the renderer needs to show the kill switch honestly.
 *
 * `endpoint` is null when the MCP server failed to start � which is a different
 * state from "paused", and the UI must not conflate them: an agent cannot reach
 * a server that is not listening either, but resuming will not fix it.
 */
export interface AgentAccessState {
  /** True when every MCP tool call is being rejected with AGENT_ACCESS_PAUSED. */
  paused: boolean
  /** Loopback endpoint, or null when the server is not listening. */
  endpoint: { port: number; url: string } | null
}

/* ------------------------------------------------------------------ *
 * IPC payloads
 * ------------------------------------------------------------------ */

/**
 * Opens a crash-safe recording on disk (FR-REC.3).
 *
 * `mimeType` is whatever `MediaRecorder` actually negotiated, not what was
 * asked for — main derives the container and the file extension from it, so the
 * bytes and the name can never disagree.
 */
export interface BeginRecordingRequest {
  mimeType: string
  width: number
  height: number
  tracks: TrackSelection
}

/** Closes an open recording and hands the file to the library. */
export interface FinalizeRecordingRequest {
  recordingId: string
  width: number
  height: number
  durationMs: number
}

/** An interrupted recording found on disk at launch. */
export interface RecoverableRecordingInfo {
  id: string
  startedAt: string
  container: RecordingContainer
  /** Bytes written before the process died. */
  size: number
  /**
   * Inferred from the file's mtime, because an interrupted container has no
   * trailing index to read a real duration from. Presented as an estimate.
   */
  estimatedDurationMs: number
  chapters: number[]
}

export interface ExportRequest {
  itemId: string
  format: 'png' | 'jpg' | 'webm' | 'mp4'
  /** Flattened bytes rendered by the renderer, including annotations. */
  data: Uint8Array
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** The full surface exposed on `window.api` via contextBridge. */
export interface NawiApi {
  /* capture */
  listSources(kinds: Array<'screen' | 'window'>): Promise<IpcResult<CaptureSource[]>>
  listDisplays(): Promise<IpcResult<DisplayInfo[]>>
  captureFullscreen(displayId?: number): Promise<IpcResult<LibraryItem>>
  captureWindow(sourceId: string): Promise<IpcResult<LibraryItem>>
  /** Resolves with the saved item, or null when the user cancelled. */
  beginRegion(): Promise<IpcResult<LibraryItem | null>>

  /* overlay-only — used by the region-select overlay window */
  overlayInit(): Promise<IpcResult<{ displayId: number; freezeUrl: string; scaleFactor: number }>>
  commitRegion(displayId: number, rect: Rect): void
  cancelRegion(): void

  /* recording — control plane (main window / HUD) */
  /**
   * Asks main to run a recording: it shows the HUD, arms the display-media
   * handler, and tells the hidden recorder window to start. Resolves as soon as
   * the request is accepted, not when the recording ends — the outcome arrives
   * through `onRecordingStatus` and `onRecordingFinished`.
   */
  startRecording(options: StartRecordingOptions): Promise<IpcResult<null>>
  /** Sends a HUD/hotkey command (pause, resume, stop, chapter, …) to the recorder. */
  sendRecordCommand(command: string): Promise<IpcResult<null>>
  /** Latest status, for a window that just opened and missed the broadcasts. */
  getRecordingStatus(): Promise<IpcResult<RecordingStatus>>
  /** Live recorder state. Returns an unsubscribe function. */
  onRecordingStatus(cb: (status: RecordingStatus) => void): () => void
  /** Fires once a finished recording has landed in the library. */
  onRecordingFinished(cb: (item: LibraryItem) => void): () => void
  /** Fires when a recording ends without producing an item, with the reason. */
  onRecordingFailed(cb: (error: string) => void): () => void
  /** Available input devices for the mic switcher (UX-REC.5). */
  listAudioInputs(): Promise<IpcResult<Array<{ deviceId: string; label: string }>>>
  /** HUD geometry: move by a delta, snapping to the nearest screen edge (UX-REC.1). */
  moveHud(dx: number, dy: number): Promise<IpcResult<null>>

  /* recording — data plane (hidden recorder window only) */
  /**
   * Arms main's display-media handler. `withAudio` must match what the renderer is
   * about to ask `getDisplayMedia` for: main has to answer with an explicit audio
   * key, and a request whose audio the handler ignores yields a silent recording.
   */
  prepareRecording(sourceId: string, withAudio: boolean): Promise<IpcResult<null>>
  /** Opens the on-disk recording. Must succeed before MediaRecorder is started. */
  beginRecording(req: BeginRecordingRequest): Promise<IpcResult<{ recordingId: string }>>
  /**
   * Appends one MediaRecorder chunk.
   *
   * One of the three buffer-over-IPC exceptions ARCHITECTURE.md §1.3 sanctions:
   * only the renderer can produce these bytes, and holding them in memory until
   * stop is precisely the FR-REC.3 failure this replaces.
   */
  appendRecordingChunk(recordingId: string, chunk: Uint8Array): Promise<IpcResult<number>>
  /** Records a chapter marker at `atMs` into the manifest, so it survives a crash. */
  markChapter(recordingId: string, atMs: number): Promise<IpcResult<number[]>>
  /** Closes the file and creates the library item. */
  finalizeRecording(req: FinalizeRecordingRequest): Promise<IpcResult<LibraryItem>>
  /** Abandons an open recording and deletes its bytes. */
  abortRecording(recordingId: string): Promise<IpcResult<null>>
  /** Recorder → main: publishes the status the HUD and main window render. */
  publishRecordingStatus(status: RecordingStatus): Promise<IpcResult<null>>
  /**
   * Recorder → main: a failure that began in the recorder window, routed to the
   * same broadcast main-origin failures use so it reaches a visible surface.
   */
  reportRecordingFailure(message: string): Promise<IpcResult<null>>
  /** Recorder → main: the command queue it should act on. Returns an unsubscribe function. */
  onRecordCommand(cb: (command: string) => void): () => void
  /** Recorder → main: the request to begin, delivered when main is ready. */
  onRecordRequest(cb: (options: StartRecordingOptions) => void): () => void

  /* recording — recovery (FR-REC.3) */
  listRecoverableRecordings(): Promise<IpcResult<RecoverableRecordingInfo[]>>
  /** Adopts an interrupted recording into the library. */
  recoverRecording(id: string): Promise<IpcResult<LibraryItem>>
  discardRecoverableRecording(id: string): Promise<IpcResult<null>>

  /* library */
  listLibrary(): Promise<IpcResult<LibraryItem[]>>
  deleteLibraryItem(id: string): Promise<IpcResult<LibraryItem | null>>
  renameLibraryItem(id: string, name: string): Promise<IpcResult<LibraryItem>>
  /**
   * PRD-002 P5 soft-delete. Resolves with the marked item — hidden from the
   * library, still on disk for 30 seconds — or `null` if there was nothing to
   * delete. The renderer uses the returned item to name the undo toast.
   */
  restoreLibraryItem(id: string): Promise<IpcResult<LibraryItem | null>>
  saveAnnotations(id: string, doc: AnnotationDoc): Promise<IpcResult<LibraryItem>>
  /**
   * Raw bytes of a stored asset. The editor needs these rather than a
   * `capture://` URL: an image from a custom scheme is cross-origin to the
   * renderer, which taints the canvas and makes toBlob/getImageData throw —
   * breaking both export and copy-to-clipboard.
   */
  readItemBytes(id: string): Promise<IpcResult<{ data: Uint8Array; mime: string }>>

  /* export */
  exportAs(req: ExportRequest): Promise<IpcResult<string | null>>
  /** Saves the stored asset as-is. Main copies the file directly — no bytes cross IPC. */
  exportOriginal(itemId: string): Promise<IpcResult<string | null>>
  copyImageToClipboard(data: Uint8Array): Promise<IpcResult<null>>
  revealInFolder(id: string): Promise<IpcResult<null>>

  /* settings */
  getSettings(): Promise<IpcResult<Settings>>
  /** Applies a partial patch. Main validates and merges; the returned value is the new full state. */
  updateSettings(patch: SettingsPatch): Promise<IpcResult<Settings>>
  /** Fires after a settings write lands on disk. Returns an unsubscribe function. */
  onSettingsChanged(cb: (settings: Settings) => void): () => void

  /* agent access (UX-AGT.3) */
  getAgentAccess(): Promise<IpcResult<AgentAccessState>>
  /** Pauses or resumes MCP tool calls. Takes effect on the agent's next call. */
  setAgentAccessPaused(paused: boolean): Promise<IpcResult<AgentAccessState>>
  /** Fires when the pause state changes, including from another window. */
  onAgentAccessChanged(cb: (state: AgentAccessState) => void): () => void

  /* permissions & recovery (UX-PRM.1-3) */
  getScreenPermission(): Promise<IpcResult<PermissionState>>
  /** Deep-links to the OS pane named by `PermissionState.settingsPath`. */
  openScreenSettings(): Promise<IpcResult<null>>
  /** UX-PRM.3 — quits and restarts so a fresh grant is read at process start. */
  relaunchApp(): Promise<IpcResult<null>>

  /* disk pressure (UX-STA.5) */
  getDiskPressure(estimateMinutes?: number): Promise<IpcResult<DiskPressure>>

  /* app */
  onShortcut(cb: (action: string) => void): () => void
}

/** Screen-recording access as the OS reports it; `unknown` when it cannot be read. */
export type ScreenAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

export interface PermissionState {
  platform: string
  screen: ScreenAccess
  /** The OS path to show the user, in the OS's own vocabulary (UX-PRM.1). */
  settingsPath: string
  /** True only where a grant needs a relaunch to take effect (macOS). */
  relaunchMayBeRequired: boolean
}

export interface DiskPressure {
  /**
   * False when free space could not be read. Callers must not treat an unknown
   * as "fine" — `low` is false in that case only because there is nothing to
   * compare, and the UI says so rather than staying silent.
   */
  known: boolean
  freeBytes: number
  /** Expected size of the recording the user is about to start (UX-STA.5). */
  estimatedBytes: number
  estimateMinutes: number
  low: boolean
}
