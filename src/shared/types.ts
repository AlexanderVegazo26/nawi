/**
 * Shared contract between main, preload and renderer.
 * Anything crossing the contextBridge is defined here so both sides stay in sync.
 */

import type { Settings, SettingsPatch } from './settings'

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
  ext: 'png' | 'webm'
  mime: 'image/png' | 'video/webm'
}

/**
 * File extension and MIME for an item that must have bytes.
 *
 * Throws for a guide rather than falling back to PNG. A fallback here is the
 * exact bug this function exists to remove — it would hand a caller a guide
 * labelled as an image and let it reach the clipboard or the filesystem.
 */
export function mediaFormat(kind: LibraryItemKind): MediaFormat {
  const media = mediaKindOf(kind)
  if (media === null) {
    throw new Error(`a ${kind} has no media bytes; it cannot be exported or read as a file`)
  }
  return media === 'video'
    ? { ext: 'webm', mime: 'video/webm' }
    : { ext: 'png', mime: 'image/png' }
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
  | 'blur'
  | 'step'

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
}

export interface StepShape extends BaseShape {
  kind: 'step'
}

export interface BlurShape extends BaseShape {
  kind: 'blur'
  /** 'blur' softens, 'pixelate' blocks. */
  mode: 'blur' | 'pixelate'
  intensity: number
}

export type SimpleShape = BaseShape & {
  kind: 'arrow' | 'rect' | 'ellipse' | 'line' | 'highlight'
}

export type Shape = SimpleShape | TextShape | StepShape | BlurShape

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

export interface SaveRecordingRequest {
  data: Uint8Array
  width: number
  height: number
  durationMs: number
}

export interface ExportRequest {
  itemId: string
  format: 'png' | 'jpg' | 'webm'
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

  /* recording */
  /**
   * Arms main's display-media handler. `withAudio` must match what the renderer is
   * about to ask `getDisplayMedia` for: main has to answer with an explicit audio
   * key, and a request whose audio the handler ignores yields a silent recording.
   */
  prepareRecording(sourceId: string, withAudio: boolean): Promise<IpcResult<null>>
  saveRecording(req: SaveRecordingRequest): Promise<IpcResult<LibraryItem>>

  /* library */
  listLibrary(): Promise<IpcResult<LibraryItem[]>>
  deleteLibraryItem(id: string): Promise<IpcResult<null>>
  renameLibraryItem(id: string, name: string): Promise<IpcResult<LibraryItem>>
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

  /* app */
  onShortcut(cb: (action: string) => void): () => void
}
