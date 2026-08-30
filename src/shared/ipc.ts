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

  /* --- recording control plane (main window / HUD -> main) --- */
  startRecording: 'record:start',
  recordCommand: 'record:command',
  getRecordingStatus: 'record:get-status',
  /** main -> every window, so the HUD, the rail and the tray never disagree. */
  recordingStatus: 'record:status',
  recordingFinished: 'record:finished',
  recordingFailed: 'record:failed',
  listAudioInputs: 'record:list-inputs',
  moveHud: 'record:move-hud',

  /* --- recording data plane (hidden recorder window <-> main) --- */
  prepareRecording: 'record:prepare',
  beginRecording: 'record:begin',
  /** The sanctioned buffer-over-IPC exception; see ARCHITECTURE.md §1.3. */
  recordChunk: 'record:chunk',
  markChapter: 'record:chapter',
  finalizeRecording: 'record:finalize',
  abortRecording: 'record:abort',
  publishRecordingStatus: 'record:publish-status',
  /**
   * Recorder → main, for a failure that originated *in the recorder window*.
   *
   * A status publish is not enough: `publish()` only broadcasts `recordingStatus`,
   * so a denied `getDisplayMedia` used to end at a `console.error` with no user-
   * visible surface at all (UX-PRM.2 forbids exactly that dead end). This routes
   * it into the same `fail()` path main-origin failures already take.
   */
  reportRecordingFailure: 'record:report-failure',
  /** main -> recorder window. */
  recordRequest: 'record:request',
  recordDispatch: 'record:dispatch',

  /* --- recording recovery (FR-REC.3) --- */
  listRecoverableRecordings: 'record:list-recoverable',
  recoverRecording: 'record:recover',
  discardRecoverableRecording: 'record:discard-recoverable',

  listLibrary: 'library:list',
  deleteLibraryItem: 'library:delete',
  /** PRD-002 P5 — cancels a delete inside its 30-second undo window. */
  restoreLibraryItem: 'library:restore',
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

  /** UX-AGT.3 kill switch, plus the loopback endpoint the rail displays. */
  getAgentAccess: 'agent:get-access',
  setAgentAccess: 'agent:set-access',
  /** main -> renderer broadcast, so a pause made elsewhere is reflected everywhere. */
  agentAccessChanged: 'agent:access-changed',

  /** UX-PRM.1-3 screen-recording permission state and its two recovery actions. */
  getScreenPermission: 'permission:get-screen',
  openScreenSettings: 'permission:open-settings',
  relaunchApp: 'permission:relaunch',

  /** UX-STA.5 disk-pressure precheck. */
  getDiskPressure: 'disk:pressure',

  shortcut: 'app:shortcut'
} as const

/** Custom scheme used to serve library assets and freeze frames to the renderer. */
export const CAPTURE_SCHEME = 'capture'
