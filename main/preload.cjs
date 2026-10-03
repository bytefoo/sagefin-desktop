// The home window's only bridge to the main process. CommonJS because a sandboxed preload cannot
// be an ES module. It exposes three calls and no Node or Electron object.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  status: () => ipcRenderer.invoke("desktop:status"),
  open: (code) => ipcRenderer.invoke("desktop:open", code),
  onChanged: (listener) => {
    ipcRenderer.on("desktop:changed", () => listener());
  },
});
