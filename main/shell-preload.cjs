// The main window's preload. It runs on every page that window shows, including a sign-in
// provider's, so it exposes nothing unless the page is SageFin itself — and the main process
// checks the caller's origin again before answering.
//
// CommonJS because a sandboxed preload cannot be an ES module, which is also why this list is a
// copy of lib/site.mjs's. lib/site.test.mjs fails if the two differ.
const { contextBridge, ipcRenderer } = require("electron");

const SAGEFIN_ORIGINS = ["https://my.sagefin.app", "https://my-test.sagefin.app", "http://localhost:3000"];

/** @param {() => void} listener */
const onRetailersChanged = (listener) => {
  const handler = () => listener();
  ipcRenderer.on("shell:retailers-changed", handler);
  return () => ipcRenderer.removeListener("shell:retailers-changed", handler);
};

if (SAGEFIN_ORIGINS.includes(location.origin)) {
  contextBridge.exposeInMainWorld("sagefinDesktop", {
    // What this app is and what it can do, so a newer web app can ask an older shell.
    info: () => ipcRenderer.invoke("shell:info"),
    // What is saved on this computer, by retailer: names, counts and times. Never a page's contents.
    retailers: () => ipcRenderer.invoke("shell:retailers"),
    openRetailer: (code) => ipcRenderer.invoke("shell:open-retailer", code),
    // Starts a sync of a retailer: the app opens its orders list, then each order not yet read.
    syncRetailer: (code) => ipcRenderer.invoke("shell:sync-retailer", code),
    // Records the member's answer about one thing at one retailer: saving its pages, or syncing it.
    setConsent: (code, kind, answer) => ipcRenderer.invoke("shell:set-consent", code, kind, answer),
    // Names the account the member is signed in to at a retailer whose pages do not say. A label
    // they chose; nothing read from a page. Null takes it away.
    setAccountName: (code, name) => ipcRenderer.invoke("shell:set-account-name", code, name),
    // Takes the upload-only token the signed-in page minted. Nothing secret ever comes back.
    connect: (credential) => ipcRenderer.invoke("shell:connect", credential),
    disconnect: () => ipcRenderer.invoke("shell:disconnect"),
    onRetailersChanged,

    // The same four under the names they had while the app said "store" for a retailer. The web app
    // is always the newest and an installed app may not be, so the web app asks for the new names
    // (the "retailers" capability says they are here) and a web app that has not changed yet still
    // finds these. Remove them once it no longer looks.
    stores: () => ipcRenderer.invoke("shell:retailers"),
    openStore: (code) => ipcRenderer.invoke("shell:open-retailer", code),
    syncStore: (code) => ipcRenderer.invoke("shell:sync-retailer", code),
    onStoresChanged: onRetailersChanged,
  });
}
