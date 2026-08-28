import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { Settings, NawiApi } from '@shared/types'

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

  prepareRecording: (sourceId, withAudio) =>
    ipcRenderer.invoke(IPC.prepareRecording, sourceId, withAudio),
  saveRecording: (req) => ipcRenderer.invoke(IPC.saveRecording, req),

  listLibrary: () => ipcRenderer.invoke(IPC.listLibrary),
  deleteLibraryItem: (id) => ipcRenderer.invoke(IPC.deleteLibraryItem, id),
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
