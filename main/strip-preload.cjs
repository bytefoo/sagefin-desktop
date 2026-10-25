// The strip's only bridge to the main process: what it says, and Done. CommonJS because a
// sandboxed preload cannot be an ES module. The strip is the app's own page (renderer/strip.html),
// in a view of its own above the retailer's page, which has no preload at all.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("strip", {
  state: () => ipcRenderer.invoke("strip:state"),
  done: () => ipcRenderer.invoke("strip:done"),
  onChanged: (listener) => {
    ipcRenderer.on("strip:changed", () => listener());
  },
});
