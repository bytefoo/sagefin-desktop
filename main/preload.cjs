// The home window's only bridge to the main process. CommonJS because a sandboxed preload cannot
// be an ES module. It exposes six calls and no Node or Electron object.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  status: () => ipcRenderer.invoke("desktop:status"),
  open: (code) => ipcRenderer.invoke("desktop:open", code),
  setUpHistory: (code) => ipcRenderer.invoke("desktop:set-up-history", code),
  changeHowFarBack: (code, from) => ipcRenderer.invoke("desktop:change-how-far-back", code, from),
  startOver: (code) => ipcRenderer.invoke("desktop:start-over", code),
  onChanged: (listener) => {
    ipcRenderer.on("desktop:changed", () => listener());
  },
});
