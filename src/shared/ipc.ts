/** Canonical IPC channel names. Importing these on both sides prevents typo drift. */
export const IPC = {
  listSources: 'capture:list-sources',
  listDisplays: 'capture:list-displays',
  captureFullscreen: 'capture:fullscreen',
  captureWindow: 'capture:window',
  beginRegion: 'capture:begin-region',

  overlayInit: 'overlay:init',
  commitRegion: 'overlay:commit-region',
  cancelRegion: 'overlay:cancel-region',

  prepareRecording: 'record:prepare',
  saveRecording: 'record:save',

  listLibrary: 'library:list',
  deleteLibraryItem: 'library:delete',
  renameLibraryItem: 'library:rename',
  saveAnnotations: 'library:save-annotations',
  readItemBytes: 'library:read-bytes',

  exportAs: 'export:as',
  exportOriginal: 'export:original',
  copyImageToClipboard: 'export:clipboard',
  revealInFolder: 'export:reveal',

  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  /** main -> renderer broadcast, fired after a settings write lands on disk. */
  settingsChanged: 'settings:changed',

  shortcut: 'app:shortcut'
} as const

/** Custom scheme used to serve library assets and freeze frames to the renderer. */
export const CAPTURE_SCHEME = 'capture'
