// Minimal, safe bridge: lets the renderer open a native folder picker.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuse", {
  chooseFolder: () => ipcRenderer.invoke("fuse:choose-folder"),
});
