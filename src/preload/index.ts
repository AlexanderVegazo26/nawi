import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { AgentAccessState, LibraryItem, Settings, NawiApi } from '@shared/types'
import type { RecordingStatus, StartRecordingOptions } from '@shared/recording'

/**
 * One place that turns a main→renderer broadcast into a subscription.
 *
 * The listener receives the payload only, never the `IpcRendererEvent` — that
 * object carries `sender`, and handing it to renderer code would leak a live
 * IPC handle straight through the contextBridge the rest of this file exists to
 * keep closed.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * The entire privileged surface available to the renderer.
 *
 * Named methods only — `ipcRenderer` itself is never exposed, and there is no
 * generic `invoke(channel, ...)` escape hatch. Under `sandbox: true` this file
 * may only use `electron`; all filesystem work belongs in main.
 */
const api: NawiApi = {
  listSources: (kinds) => ipcRenderer.invoke(IPC.listSources, kinds),
  listDisplays: () => ipcRenderer.invoke(IPC.listDisplays),
  captureFullscreen: (displayId) => ipcRenderer.invoke(IPC.captureFullscreen, displayId),
  captureWindow: (sourceId) => ipcRenderer.invoke(IPC.captureWindow, sourceId),
  beginRegion: () => ipcRenderer.invoke(IPC.beginRegion),

  overlayInit: () => ipcRenderer.invoke(IPC.overlayInit),
  commitRegion: (displayId, rect) => ipcRenderer.send(IPC.commitRegion, displayId, rect),
  cancelRegion: () => ipcRenderer.send(IPC.cancelRegion),

  /* recording — control plane */
  startRecording: (options) => ipcRenderer.invoke(IPC.startRecording, options),
  sendRecordCommand: (command) => ipcRenderer.invoke(IPC.recordCommand, command),
  getRecordingStatus: () => ipcRenderer.invoke(IPC.getRecordingStatus),
  onRecordingStatus: (cb) => subscribe<RecordingStatus>(IPC.recordingStatus, cb),
  onRecordingFinished: (cb) => subscribe<LibraryItem>(IPC.recordingFinished, cb),
  onRecordingFailed: (cb) => subscribe<string>(IPC.recordingFailed, cb),
  listAudioInputs: () => ipcRenderer.invoke(IPC.listAudioInputs),
  moveHud: (dx, dy) => ipcRenderer.invoke(IPC.moveHud, dx, dy),

  /* recording — data plane, answered by main only for the recorder window */
  prepareRecording: (sourceId, withAudio) =>
    ipcRenderer.invoke(IPC.prepareRecording, sourceId, withAudio),
  beginRecording: (req) => ipcRenderer.invoke(IPC.beginRecording, req),
  appendRecordingChunk: (recordingId, chunk) =>
    ipcRenderer.invoke(IPC.recordChunk, recordingId, chunk),
  markChapter: (recordingId, atMs) => ipcRenderer.invoke(IPC.markChapter, recordingId, atMs),
  finalizeRecording: (req) => ipcRenderer.invoke(IPC.finalizeRecording, req),
  abortRecording: (recordingId) => ipcRenderer.invoke(IPC.abortRecording, recordingId),
  publishRecordingStatus: (status) => ipcRenderer.invoke(IPC.publishRecordingStatus, status),
  onRecordCommand: (cb) => subscribe<string>(IPC.recordDispatch, cb),
  onRecordRequest: (cb) => subscribe<StartRecordingOptions>(IPC.recordRequest, cb),

  /* recording — recovery */
  listRecoverableRecordings: () => ipcRenderer.invoke(IPC.listRecoverableRecordings),
  recoverRecording: (id) => ipcRenderer.invoke(IPC.recoverRecording, id),
  discardRecoverableRecording: (id) => ipcRenderer.invoke(IPC.discardRecoverableRecording, id),

  listLibrary: () => ipcRenderer.invoke(IPC.listLibrary),
  deleteLibraryItem: (id) => ipcRenderer.invoke(IPC.deleteLibraryItem, id),
  restoreLibraryItem: (id) => ipcRenderer.invoke(IPC.restoreLibraryItem, id),
  renameLibraryItem: (id, name) => ipcRenderer.invoke(IPC.renameLibraryItem, id, name),
  saveAnnotations: (id, doc) => ipcRenderer.invoke(IPC.saveAnnotations, id, doc),
  readItemBytes: (id) => ipcRenderer.invoke(IPC.readItemBytes, id),

  exportAs: (req) => ipcRenderer.invoke(IPC.exportAs, req),
  exportOriginal: (itemId) => ipcRenderer.invoke(IPC.exportOriginal, itemId),
  copyImageToClipboard: (data) => ipcRenderer.invoke(IPC.copyImageToClipboard, data),
  revealInFolder: (id) => ipcRenderer.invoke(IPC.revealInFolder, id),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  onSettingsChanged: (cb) => {
    const listener = (_e: unknown, settings: Settings): void => cb(settings)
    ipcRenderer.on(IPC.settingsChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.settingsChanged, listener)
    }
  },

  getAgentAccess: () => ipcRenderer.invoke(IPC.getAgentAccess),
  setAgentAccessPaused: (paused) => ipcRenderer.invoke(IPC.setAgentAccess, paused),
  onAgentAccessChanged: (cb) => {
    const listener = (_e: unknown, state: AgentAccessState): void => cb(state)
    ipcRenderer.on(IPC.agentAccessChanged, listener)
    return () => {
      ipcRenderer.removeListener(IPC.agentAccessChanged, listener)
    }
  },

  getScreenPermission: () => ipcRenderer.invoke(IPC.getScreenPermission),
  openScreenSettings: () => ipcRenderer.invoke(IPC.openScreenSettings),
  relaunchApp: () => ipcRenderer.invoke(IPC.relaunchApp),

  getDiskPressure: (estimateMinutes) => ipcRenderer.invoke(IPC.getDiskPressure, estimateMinutes),

  onShortcut: (cb) => {
    // The listener receives the payload only, never the IpcRendererEvent.
    const listener = (_e: unknown, action: string): void => cb(action)
    ipcRenderer.on(IPC.shortcut, listener)
    return () => {
      ipcRenderer.removeListener(IPC.shortcut, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
