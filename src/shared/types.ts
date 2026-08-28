/**
 * Shared contract between main, preload and renderer.
 * Anything crossing the contextBridge is defined here so both sides stay in sync.
 */

export type CaptureKind = 'fullscreen' | 'window' | 'region'
export type MediaKind = 'image' | 'video'

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
  kind: MediaKind
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
  prepareRecording(sourceId: string): Promise<IpcResult<null>>
  saveRecording(req: SaveRecordingRequest): Promise<IpcResult<LibraryItem>>

  /* library */
  listLibrary(): Promise<IpcResult<LibraryItem[]>>
  deleteLibraryItem(id: string): Promise<IpcResult<null>>
  renameLibraryItem(id: string, name: string): Promise<IpcResult<LibraryItem>>
  saveAnnotations(id: string, doc: AnnotationDoc): Promise<IpcResult<LibraryItem>>

  /* export */
  exportAs(req: ExportRequest): Promise<IpcResult<string | null>>
  /** Saves the stored asset as-is. Main copies the file directly — no bytes cross IPC. */
  exportOriginal(itemId: string): Promise<IpcResult<string | null>>
  copyImageToClipboard(data: Uint8Array): Promise<IpcResult<null>>
  revealInFolder(id: string): Promise<IpcResult<null>>

  /* app */
  onShortcut(cb: (action: string) => void): () => void
}
