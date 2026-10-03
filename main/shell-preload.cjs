// The main window's preload. It runs on every page that window shows, including a sign-in
// provider's, so it exposes nothing unless the page is SageFin itself — and the main process
// checks the caller's origin again before answering.
//
// CommonJS because a sandboxed preload cannot be an ES module, which is also why this list is a
// copy of lib/site.mjs's. lib/site.test.mjs fails if the two differ.
const { contextBridge, ipcRenderer } = require("electron");

const SAGEFIN_ORIGINS = ["https://my.sagefin.app", "https://my-test.sagefin.app", "http://localhost:3000"];

if (SAGEFIN_ORIGINS.includes(location.origin)) {
  contextBridge.exposeInMainWorld("sagefinDesktop", {
    // What this app is and what it can do, so a newer web app can ask an older shell.
    info: () => ipcRenderer.invoke("shell:info"),
    // What is saved on this computer, by store: names, counts and times. Never a page's contents.
    stores: () => ipcRenderer.invoke("shell:stores"),
    openStore: (code) => ipcRenderer.invoke("shell:open-store", code),
    // Starts a sync of a store: the app opens its orders list, then each order not yet read.
    syncStore: (code) => ipcRenderer.invoke("shell:sync-store", code),
    // Records the member's answer about one thing at one store: saving its pages, or syncing it.
    setConsent: (code, kind, answer) => ipcRenderer.invoke("shell:set-consent", code, kind, answer),
    // Takes the upload-only token the signed-in page minted. Nothing secret ever comes back.
    connect: (credential) => ipcRenderer.invoke("shell:connect", credential),
    disconnect: () => ipcRenderer.invoke("shell:disconnect"),
    onStoresChanged: (listener) => {
      const handler = () => listener();
      ipcRenderer.on("shell:stores-changed", handler);
      return () => ipcRenderer.removeListener("shell:stores-changed", handler);
    },
  });
}
