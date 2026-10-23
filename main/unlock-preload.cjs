// The unlock window's only bridge. CommonJS because a sandboxed preload cannot be an ES module.
// Two presses and one way to be told what to show: no key, no request, no Node or Electron object.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("unlock", {
  go: () => ipcRenderer.invoke("unlock:go"),
  cancel: () => ipcRenderer.invoke("unlock:cancel"),
  onView: (listener) => {
    ipcRenderer.on("unlock:view", (_event, view) => listener(view));
  },
});
