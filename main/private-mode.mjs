// @ts-check
// Private mode on this computer: carries out lib/private-mode.mjs's decisions.
//
// - **Unlock this window.** When SageFin's window is shown and its household is locked, and this
//   computer holds a key of it, the app's own unlock window opens over it. Its button, not the
//   page, starts the unlock; macOS's Touch ID sheet asks the person; the window's own sign-in
//   asks and approves. The page can do nothing here but be covered.
// - **Sync and lock.** When the check-in says your bank has new activity, a notification asks,
//   at most once a locked period and never twice in six hours. Clicking it shows the window and the
//   same unlock window, for a Sync and lock, asked the same way.
// - **Adding this computer.** From the menu: the app makes two keys in the security chip, asks to
//   be added, and shows a code to type into your phone, then the twelve characters both screens
//   show. Your phone adds it; this computer then unlocks once to prove it.
// - **A record of every use**, kept on this computer, which SageFin cannot erase.

import { BrowserWindow, Notification, ipcMain, powerMonitor } from "electron";
import { hostname } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  NO_NOTICES,
  SYNC_NOTICE,
  beginEnrolment,
  holderTokens,
  holdingOf,
  logged,
  lookAtEnrolment,
  syncNotice,
  typedCode,
  unlockHere,
  whyNotNow,
} from "../lib/private-mode.mjs";
import { openKeyStore } from "./key-store.mjs";

const here = import.meta.dirname;
const PAGE = pathToFileURL(path.join(here, "..", "renderer", "unlock.html")).href;

/** What SageFin said when it refused, in words for the person here. Codes only; never a raw one. */
const REFUSED = /** @type {Record<string, string>} */ ({
  unknown_holder: "This computer is no longer one of your household's devices. Your phone can add it again.",
  nothing_to_sync: "There is nothing new to sync.",
  already_unlocked: "Your household is already unlocked somewhere.",
  key_protection_not_accepted: "This computer cannot hold a key. Unlock with your phone instead.",
  household_file_locked: "Unlock with your phone first, then try again.",
});

/**
 * @param {object} options
 * @param {() => import("../lib/site.mjs").Site} options.site
 * @param {() => BrowserWindow | null} options.window  SageFin's main window, if it exists.
 * @param {() => void} options.showWindow
 * @param {string} options.dir  Where this app keeps its own state.
 */
export function startPrivateMode({ site, window, showWindow, dir }) {
  const file = path.join(dir, "private-mode.json");
  /** @type {{ holdings: Record<string, import("../lib/private-mode.mjs").Holding>, notices: Record<string, import("../lib/private-mode.mjs").NoticeState>, log: import("../lib/private-mode.mjs").LogEntry[] }} */
  let state = { holdings: {}, notices: {}, log: [] };
  try {
    state = { ...state, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    // Nothing kept yet.
  }
  // Not secrets: which household this computer holds a key of, and its own notices and log.
  const save = () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
    renameSync(`${file}.tmp`, file);
  };

  let screenLocked = false;
  powerMonitor.on("lock-screen", () => (screenLocked = true));
  powerMonitor.on("unlock-screen", () => (screenLocked = false));

  const keys = () => openKeyStore(site().key);

  /**
   * SageFin's API on the window's own sign-in: the session cookie the page's sign-in keeps, read
   * here and sent by the main process. Nothing the page says is in a request.
   * @param {BrowserWindow} win
   * @returns {import("../lib/private-mode.mjs").Api}
   */
  function api(win) {
    const origin = site().origin;
    const ses = win.webContents.session;
    /** @param {string} method @param {string} p @param {unknown} [body] */
    const call = async (method, p, body) => {
      const [cookie] = await ses.cookies.get({ url: origin, name: "__session" });
      if (!cookie?.value) return { status: 401, body: null };
      const response = await ses.fetch(`${origin}/api/v1${p}`, {
        method,
        headers: { Authorization: `Bearer ${cookie.value}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return { post: (p, body) => call("POST", p, body ?? {}), get: (p) => call("GET", p) };
  }

  // ── The unlock window ─────────────────────────────────────────────────────────────────────

  /** @type {BrowserWindow | null} */
  let overlay = null;
  /** @type {(() => Promise<void>) | null} */
  let onGo = null;
  let prompting = false;

  /** @param {Record<string, unknown>} view */
  const show = (view) => overlay?.webContents.send("unlock:view", view);

  /** @param {BrowserWindow} parent */
  function openOverlay(parent) {
    if (overlay && !overlay.isDestroyed()) return overlay;
    overlay = new BrowserWindow({
      parent,
      modal: true,
      width: 460,
      height: 360,
      resizable: false,
      minimizable: false,
      title: "SageFin Desktop",
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(here, "unlock-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    overlay.webContents.on("will-navigate", (event) => event.preventDefault());
    overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay.on("closed", () => {
      overlay = null;
      onGo = null;
    });
    void overlay.loadURL(PAGE);
    return overlay;
  }

  /** Only the unlock window's own page may press its buttons. @param {Electron.IpcMainInvokeEvent} event */
  const fromOverlay = (event) => Boolean(overlay && event.sender === overlay.webContents && event.senderFrame?.url === PAGE);

  ipcMain.handle("unlock:go", async (event) => {
    if (!fromOverlay(event) || !onGo) return;
    await onGo();
  });
  ipcMain.handle("unlock:cancel", (event) => {
    if (fromOverlay(event)) overlay?.close();
  });

  /** Whether the key may be used now. Always called from a press in the unlock window, never the page. */
  function blocked() {
    const win = window();
    return whyNotNow({
      fromPage: false,
      screenLocked,
      windowShown: Boolean(win && win.isVisible() && !win.isMinimized()),
      windowFocused: Boolean((win && win.isFocused()) || (overlay && overlay.isFocused())),
      prompting,
    });
  }

  /**
   * @param {"unlock" | "sync" | "enrol"} what
   * @param {import("../lib/private-mode.mjs").LogEntry["outcome"]} outcome
   * @param {string | null} code
   */
  function record(what, outcome, code) {
    state.log = logged(state.log, { at: new Date().toISOString(), what, outcome, code });
    save();
  }

  /** @param {"full" | "sync"} purpose */
  async function offerUnlock(purpose) {
    const win = window();
    const holding = state.holdings[site().key];
    if (!win || !holding) return;
    openOverlay(win);
    const what = purpose === "sync" ? "sync" : "unlock";
    const view = {
      title: purpose === "sync" ? "Your bank has new activity" : "SageFin is locked",
      lead:
        purpose === "sync"
          ? "Sync your banks and keep your household locked. You'll be asked to confirm with Touch ID."
          : "Unlock SageFin in this window. You'll be asked to confirm with Touch ID.",
      button: purpose === "sync" ? "Sync and lock" : "Unlock",
      fine: "This computer asks you each time. It never unlocks a browser; your phone does that.",
    };
    show(view);
    overlay?.webContents.once("did-finish-load", () => show(view));
    onGo = async () => {
      const why = blocked();
      if (why) {
        show({ ...view, said: "Bring SageFin's window to the front, with the screen unlocked, and try again." });
        return;
      }
      prompting = true;
      try {
        const done = await unlockHere({ api: api(win), keys: keys(), holding, purpose });
        record(what, done.outcome, done.code);
        if (done.code === "unknown_holder") {
          // Removed from another device: this computer forgets that it held a key.
          delete state.holdings[site().key];
          save();
        }
        if (done.outcome === "done") {
          overlay?.close();
          if (purpose === "full") win.webContents.reload();
        } else if (done.outcome !== "cancelled") {
          show({ ...view, said: (done.code && REFUSED[done.code]) || "That didn't work. Nothing was unlocked. Try again." });
        }
      } finally {
        prompting = false;
      }
    };
  }

  // ── Adding this computer ──────────────────────────────────────────────────────────────────

  async function offerEnrolment() {
    const win = window();
    const store = keys();
    const tokens = holderTokens(process.platform, store);
    if (!win || !tokens) return;
    openOverlay(win);
    const intro = {
      title: "Use this computer to unlock SageFin",
      lead: "Its key stays in this computer's security chip, and it asks you with Touch ID each time. Your phone has to add it.",
      button: "Continue",
      fine: "It unlocks this window and syncs your banks when you say so. It never unlocks a browser.",
    };
    show(intro);
    overlay?.webContents.once("did-finish-load", () => show(intro));
    onGo = async () => {
      if (blocked()) return;
      prompting = true;
      let begun;
      try {
        begun = await beginEnrolment({ api: api(win), keys: store, name: hostname(), tokens });
      } finally {
        prompting = false;
      }
      if (!("enrolment" in begun)) {
        record("enrol", begun.refused === "cancelled" ? "cancelled" : "refused", begun.refused);
        if (begun.refused !== "cancelled") show({ ...intro, said: (begun.refused && REFUSED[begun.refused]) || "That didn't work. Try again." });
        return;
      }
      let enrolment = begun.enrolment;
      onGo = null;
      show({
        title: "Add this computer on your phone",
        lead: "On your iPhone: Settings → Security → Devices → Add a device, then type this code under the camera.",
        button: null,
        code: typedCode(enrolment.addId),
      });
      const poll = setInterval(async () => {
        if (!overlay) return clearInterval(poll);
        const looked = await lookAtEnrolment(api(win), enrolment).catch(() => null);
        if (!looked) return;
        enrolment = looked.enrolment;
        if (looked.show === "check") {
          show({ title: "Compare on your phone", lead: "Your phone shows these twelve characters too. Add this computer only if they match.", button: null, check: enrolment.check });
        } else if (looked.show === "added") {
          clearInterval(poll);
          // Kept once the phone has added it; the first unlock is what proves it.
          state.holdings[site().key] = holdingOf(enrolment);
          save();
          record("enrol", "done", null);
          await offerUnlock("full");
        } else if (looked.show === "ended" || looked.show === "mismatch") {
          clearInterval(poll);
          record("enrol", "failed", null);
          show({ ...intro, said: "This computer was not added. Nothing was changed. Start again." });
        }
      }, 2000);
    };
  }

  return {
    /** Whether this computer holds a key of the household on the site shown. */
    holdsAKey: () => Boolean(state.holdings[site().key]),

    /** For the app's menu: unlock here, or add this computer. Never offered where it cannot hold a key. */
    menuItems() {
      /** @type {Electron.MenuItemConstructorOptions[]} */
      const items = [];
      if (state.holdings[site().key]) items.push({ label: "Unlock SageFin…", click: () => void offerUnlock("full") });
      else if (holderTokens(process.platform, keys())) items.push({ label: "Use This Computer to Unlock SageFin…", click: () => void offerEnrolment() });
      return items;
    },

    /** The window was shown: if its household is locked and this computer holds a key, offer to unlock. */
    async onWindowShown() {
      const win = window();
      if (!win || !state.holdings[site().key]) return;
      const status = await api(win).get("/private/status").catch(() => null);
      const s = status?.body;
      if (status?.status === 200 && (s?.state === "locked" || (s?.state === "unlocked" && s?.forThisSession === false))) void offerUnlock("full");
    },

    /**
     * The check-in's answer about private mode. A notification at most once a locked period, never
     * twice in six hours, counted here. A click only opens the unlock window; Touch ID unlocks.
     * @param {{ locked: boolean, syncWaiting: boolean } | null} privateMode
     */
    onCheckIn(privateMode) {
      const key = site().key;
      const { notify, state: next } = syncNotice(state.notices[key] ?? NO_NOTICES, privateMode, Date.now(), { holdsAKey: Boolean(state.holdings[key]) });
      state.notices[key] = next;
      save();
      if (!notify || !Notification.isSupported()) return;
      const notice = new Notification({ title: SYNC_NOTICE.title, body: SYNC_NOTICE.body });
      notice.on("click", () => {
        showWindow();
        void offerUnlock("sync");
      });
      notice.show();
    },

    /** This computer's record of every use of its key, newest last. */
    log: () => state.log,
  };
}
