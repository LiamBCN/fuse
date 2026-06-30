// Minimal, safe bridge for the renderer: native folder picker + on-device voice.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuse", {
  chooseFolder: () => ipcRenderer.invoke("fuse:choose-folder"),
  openPath: (p) => ipcRenderer.invoke("fuse:open-path", p),
  revealPath: (p) => ipcRenderer.invoke("fuse:reveal-path", p),

  // Voice (on-device speech-to-text).
  voiceStart: () => ipcRenderer.invoke("fuse:voice-start"),
  voiceStop: () => ipcRenderer.invoke("fuse:voice-stop"),
  onVoiceText: (cb) => {
    const h = (_e, text) => cb(text);
    ipcRenderer.on("fuse:voice-text", h);
    return () => ipcRenderer.removeListener("fuse:voice-text", h);
  },
  onVoiceError: (cb) => {
    const h = (_e, err) => cb(err);
    ipcRenderer.on("fuse:voice-error", h);
    return () => ipcRenderer.removeListener("fuse:voice-error", h);
  },
});
