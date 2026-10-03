// @ts-check
// The main window: SageFin's own web app, loaded from the site, with the rules that keep the
// window on SageFin. lib/site.mjs decides; this file only carries the decisions out.

import { app, BrowserWindow, Menu, ipcMain, session, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SITES, decideNavigation, decideWindowOpen, isSite, mainWindowTitle } from "../lib/site.mjs";

const here = import.meta.dirname;
const UNREACHABLE = pathToFileURL(path.join(here, "..", "renderer", "unreachable.html")).href;

// Development only: with SAGEFIN_DESKTOP_LOG_EXTERNAL set, a link that would open in the member's
// browser is printed instead, so the rules can be exercised without opening anything.
const logExternal = !app.isPackaged && Boolean(process.env.SAGEFIN_DESKTOP_LOG_EXTERNAL);

/** @param {string} url */
function openInBrowser(url) {
  if (logExternal) console.log(`external: ${url}`);
  else void shell.openExternal(url);
}

/**
 * @param {object} options
 * @param {import("../lib/site.mjs").Site} options.site
 * @param {() => void} options.onRetailers  Opens the retailers window.
 * @param {{ status: () => unknown, open: (code: string) => boolean, sync: (code: string) => boolean, consent: (code: string, kind: unknown, answer: unknown) => boolean }} options.retailers
 *   What is saved on this computer, and opening a retailer's window. Counts and names only: a
 *   saved page's contents never cross the bridge.
 * @param {{ connect: (credential: unknown) => boolean, disconnect: () => string | null }} options.account
 *   Taking the upload-only token the signed-in page minted, and letting go of it.
 * @param {(site: import("../lib/site.mjs").Site) => void} options.onSite
 *   Called when a development run switches to another SageFin.
 * @param {string} options.version  The version the app reports about itself (lib/version.mjs).
 * @param {string} options.icon  The window icon, where the platform shows one.
 * @param {object} options.background  Running in the background (lib/background.mjs).
 * @param {boolean} options.background.hidden  Start without showing the window.
 * @param {() => "hide" | "close"} options.background.closeAction  What closing the window does now.
 * @param {() => void} options.background.onHidden  Called when a close hid the window instead.
 * @param {() => Electron.MenuItemConstructorOptions[]} options.background.menuItems
 *   The member's background choices, for the Retailers menu. Asked for each time the menu is built.
 * @returns {{ window: BrowserWindow, switchSite: (site: import("../lib/site.mjs").Site) => void, changed: () => void, show: () => void, refreshMenu: () => void }}
 */
export function openShell({ site: initialSite, version, onRetailers, retailers, account, onSite, icon, background }) {
  let site = initialSite;

  /** @param {import("../lib/site.mjs").Site} s */
  const sessionFor = (s) => {
    // One browser profile per site, so a sign-in to test is never a sign-in to production and
    // switching between them signs nobody out.
    const ses = session.fromPartition(`persist:sagefin-${s.key}`);
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    return ses;
  };

  /** @type {BrowserWindow} */
  let win = create(site, { show: !background.hidden });

  // The page asks what it is running in. Answered only to the top frame of the site itself: the
  // preload is present on a sign-in provider's page too, and that page gets nothing.
  /** @param {Electron.IpcMainInvokeEvent} event */
  const fromSite = (event) => {
    const frame = event.senderFrame;
    if (!frame || event.sender !== win.webContents || frame !== win.webContents.mainFrame) return false;
    return isSite(frame.url, site);
  };

  ipcMain.handle("shell:info", (event) =>
    fromSite(event)
      ? { app: "sagefin-desktop", version, platform: process.platform, capabilities: ["retailers", "stores", "upload", "sync", "consent"] }
      : null,
  );
  ipcMain.handle("shell:retailers", (event) => (fromSite(event) ? retailers.status() : null));
  ipcMain.handle("shell:open-retailer", (event, code) =>
    fromSite(event) && typeof code === "string" ? retailers.open(code) : false,
  );
  ipcMain.handle("shell:sync-retailer", (event, code) =>
    fromSite(event) && typeof code === "string" ? retailers.sync(code) : false,
  );
  ipcMain.handle("shell:set-consent", (event, code, kind, answer) =>
    fromSite(event) && typeof code === "string" ? retailers.consent(code, kind, answer) : false,
  );
  ipcMain.handle("shell:connect", (event, credential) => (fromSite(event) ? account.connect(credential) : false));
  ipcMain.handle("shell:disconnect", (event) => (fromSite(event) ? account.disconnect() : null));

  /** @param {import("../lib/site.mjs").Site} s @param {{ show?: boolean }} [options] */
  function create(s, { show = true } = {}) {
    const w = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 480,
      minHeight: 480,
      title: mainWindowTitle("SageFin", s),
      icon,
      show,
      // Windows and Linux draw the menu as a strip inside the window, in the system's colours,
      // above an app that has its own. Hidden until Alt is pressed; everything in it is also on
      // the tray icon. macOS keeps its menu at the top of the screen and ignores this.
      autoHideMenuBar: true,
      webPreferences: {
        session: sessionFor(s),
        preload: path.join(here, "shell-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // The page titles the window. Showing any SageFin but production, the title also says which.
    w.on("page-title-updated", (event, title) => {
      const wanted = mainWindowTitle(title, s);
      if (wanted === title) return;
      event.preventDefault();
      w.setTitle(wanted);
    });

    /** @param {Electron.Event} event @param {string} url */
    const guard = (event, url) => {
      // The local "could not be reached" page is the app's own.
      if (url.startsWith(UNREACHABLE)) return;
      const decision = decideNavigation(url, s);
      if (decision === "allow") return;
      event.preventDefault();
      if (decision === "external") openInBrowser(url);
    };
    w.webContents.on("will-navigate", guard);
    w.webContents.on("will-redirect", guard);

    w.webContents.setWindowOpenHandler(({ url, disposition }) => {
      const decision = decideWindowOpen({ url, disposition }, s);
      if (decision === "popup") {
        // A script's pop-up: a bank's sign-in during account linking, or a sign-in provider's. It
        // keeps its link to the page that opened it, and gets no preload and so no bridge.
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            parent: w,
            autoHideMenuBar: true,
            webPreferences: { session: sessionFor(s), contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      }
      if (decision === "main") void w.loadURL(url);
      else if (decision === "external") openInBrowser(url);
      return { action: "deny" };
    });

    // A pop-up may go wherever the sign-in it is showing takes it, but it opens nothing further.
    w.webContents.on("did-create-window", (child) => {
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) openInBrowser(url);
        return { action: "deny" };
      });
    });

    w.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
      // -3 is a navigation this window itself cancelled (the guard above), not a failure.
      if (!isMainFrame || code === -3 || url.startsWith(UNREACHABLE)) return;
      void w.loadURL(`${UNREACHABLE}?site=${encodeURIComponent(s.origin)}`);
    });

    // Closing the window leaves the app running where the member chose that, so a scheduled sync
    // still has something to run in. Quit, from a menu, closes it for real.
    w.on("close", (event) => {
      if (background.closeAction() !== "hide") return;
      event.preventDefault();
      w.hide();
      background.onHidden();
    });

    void w.loadURL(s.origin);
    return w;
  }

  /** @param {import("../lib/site.mjs").Site} next */
  function switchSite(next) {
    if (next.key === site.key) return;
    site = next;
    const old = win;
    win = create(next);
    old.destroy();
    Menu.setApplicationMenu(menu());
    onSite(next);
  }

  function menu() {
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [
      ...(process.platform === "darwin" ? [/** @type {Electron.MenuItemConstructorOptions} */ ({ role: "appMenu" })] : []),
      { role: "fileMenu" },
      // Without an Edit menu, copy and paste do nothing in a window on macOS.
      { role: "editMenu" },
      {
        label: "View",
        submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }],
      },
      {
        label: "Retailers",
        submenu: [
          { label: "Retailers on This Computer…", accelerator: "CmdOrCtrl+Shift+S", click: onRetailers },
          { type: "separator" },
          ...background.menuItems(),
        ],
      },
      { role: "windowMenu" },
    ];

    // Which SageFin to open is a development setting; a member's copy opens production.
    if (!app.isPackaged) {
      template.push({
        label: "Develop",
        submenu: [
          ...SITES.map((s) => /** @type {Electron.MenuItemConstructorOptions} */ ({
            label: `Open ${s.origin}`,
            type: "radio",
            checked: s.key === site.key,
            click: () => switchSite(s),
          })),
          { type: "separator" },
          { role: "toggleDevTools" },
        ],
      });
    }
    return Menu.buildFromTemplate(template);
  }

  Menu.setApplicationMenu(menu());
  return {
    get window() {
      return win;
    },
    switchSite,
    /** Brings the window back: from hidden, from minimized, or after it was closed for real. */
    show() {
      if (win.isDestroyed()) win = create(site);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    },
    /** Rebuilds the menu, so a choice changed from the tray shows as changed here too. */
    refreshMenu() {
      Menu.setApplicationMenu(menu());
    },
    /** Tells the page that what is saved here has changed, so it asks again. */
    changed() {
      if (!win.isDestroyed()) win.webContents.send("shell:retailers-changed");
    },
  };
}
