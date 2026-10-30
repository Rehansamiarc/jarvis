import { contextBridge, ipcRenderer } from "electron";
import type { AppConfig, DesktopApi, DeviceActionEvent, PrivacyState, VoiceSettings } from "./ipc";

/**
 * The only bridge between the page and Node.
 *
 * `contextIsolation` stays on and the renderer gets no `require`, so a script running in
 * the page — including anything loaded from the brain — cannot reach the filesystem,
 * spawn a process, or read the stored session cookies. Every capability is an explicit,
 * named channel below.
 */
const api: DesktopApi = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke("config:set", patch),

  sessionStatus: () => ipcRenderer.invoke("session:status"),
  signIn: () => ipcRenderer.invoke("session:signin"),
  signOut: () => ipcRenderer.invoke("session:signout"),

  saveVoice: (voice: VoiceSettings) => ipcRenderer.invoke("voice:save", voice),
  loadBrainPreferences: () => ipcRenderer.invoke("prefs:load"),

  wakeWordStatus: () => ipcRenderer.invoke("wakeword:status"),
  setWakeWordEnabled: (enabled: boolean) => ipcRenderer.invoke("wakeword:setEnabled", enabled),

  privacyState: () => ipcRenderer.invoke("privacy:get"),
  setMicMuted: (muted: boolean) => ipcRenderer.invoke("privacy:setMuted", muted),
  setCapturing: (value: boolean) => ipcRenderer.invoke("privacy:setCapturing", value),

  runAgent: (message: string) => ipcRenderer.invoke("agent:run", message),

  openApp: (name: string) => ipcRenderer.invoke("device:openApp", name),
  searchFiles: (query: string, limit?: number) => ipcRenderer.invoke("device:searchFiles", query, limit),
  notify: (title: string, body: string) => ipcRenderer.invoke("device:notify", title, body),
  copyText: (text: string) => ipcRenderer.invoke("device:copy", text),

  onDeviceAction: (handler: (event: DeviceActionEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DeviceActionEvent) => handler(payload);
    ipcRenderer.on("device:action", listener);
    return () => ipcRenderer.removeListener("device:action", listener);
  },

  pushAudioFrames: (frames: Int16Array) => ipcRenderer.send("wakeword:frame", frames),
  openExternal: (url: string) => ipcRenderer.invoke("external:open", url),

  onWakeWordDetected: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on("wakeword:detected", listener);
    return () => ipcRenderer.removeListener("wakeword:detected", listener);
  },
  onPrivacyChanged: (handler: (state: PrivacyState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: PrivacyState) => handler(state);
    ipcRenderer.on("privacy:changed", listener);
    return () => ipcRenderer.removeListener("privacy:changed", listener);
  },
};

contextBridge.exposeInMainWorld("jarvis", api);
