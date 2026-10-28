// The unlock window's only bridge. CommonJS because a sandboxed preload cannot be an ES module.
// Three presses, what the person typed when a view asks for it, and one way to be told what to
// show: no key, no request, no Node or Electron object.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("unlock", {
  go: (typed) => ipcRenderer.invoke("unlock:go", typeof typed === "string" ? typed.slice(0, 200) : undefined),
  other: () => ipcRenderer.invoke("unlock:other"),
  copyCodes: () => ipcRenderer.invoke("unlock:copy"),
  saveCodes: () => ipcRenderer.invoke("unlock:save"),
  cancel: () => ipcRenderer.invoke("unlock:cancel"),
  onView: (listener) => {
    ipcRenderer.on("unlock:view", (_event, view) => listener(view));
  },
});
