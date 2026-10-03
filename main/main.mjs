// @ts-check
// SageFin Desktop. Its main window is SageFin's own web app (main/shell.mjs). Beside it, a window
// the member signs in to a retailer in, by hand, saves what the retailer's own orders pages
// already contain.
//
// It reads a retailer's page after that page has loaded, and only the pages lib/retailers.mjs
// names. The member opens those pages, or a sync opens them for the member (runSync below): a
// sync loads pages and does nothing else. The user agent is Electron's own and is not changed.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, session, Tray } from "electron";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HIDDEN_ARG, canOpenAtLogin, closeAction, createPreferences, startsHidden } from "../lib/background.mjs";
import { createCaptureStore } from "../lib/capture-store.mjs";
import { CONSENT_KINDS, allowed, createConsents, maySync, needsChoice, standingAnswer } from "../lib/consent.mjs";
import { asCredential, createCredentialStore } from "../lib/credential-store.mjs";
import { MAX_CAPTURE_BYTES, stripHtml } from "../lib/html.mjs";
import { RETAILERS, listSignature, retailerByCode, windowTitle } from "../lib/retailers.mjs";
import { resolveSite } from "../lib/site.mjs";
import { PAUSE_BETWEEN_ORDERS_MS, createSyncStates, nextScheduledRunAt, ordersToOpen, readListPage, scheduleEveryMs, scheduledRunDue, showWindowForMemberSync } from "../lib/sync-plan.mjs";
import { CHECK_IN_EVERY_MS, checkIn, refusalLifted, report, scheduleAllowedBy, shouldStartRequested, standingAnswerFor, waitingSentence } from "../lib/check-in.mjs";
import { keyPaths, keyPattern } from "../lib/key-paths.mjs";
import { updateMenuItem } from "../lib/updates.mjs";
import { runningVersion, versionLabel } from "../lib/version.mjs";
import { addSent, sentSummary, uploadPending } from "../lib/uploader.mjs";
import { openShell } from "./shell.mjs";
import { startUpdates } from "./updates.mjs";

const here = import.meta.dirname;
const HOME = pathToFileURL(path.join(here, "..", "renderer", "index.html")).href;
const ICON = path.join(here, "..", "build", "icon.png");

/**
 * How many commits the source the app is run from has: what a release cut from it would be
 * numbered. Asked of git only in a run from source; undefined where git cannot say.
 */
function sourceCommitCount() {
  try {
    return execFileSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: path.join(here, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
  } catch {
    return undefined;
  }
}

/** The version this app reports about itself (lib/version.mjs). */
const RUNNING_VERSION = runningVersion(app.getVersion(), app.isPackaged, app.isPackaged ? undefined : sourceCommitCount());
// macOS draws a Dock icon exactly as given, so its icon carries its own rounded shape and margin.
const DOCK_ICON = path.join(here, "..", "build", "icon-mac.png");

// Development only: `--smoke-fixture=<file.html>` opens that file in place of the retailer, saves
// one capture and quits. Ignored in a packaged app.
const smokeFixture = app.isPackaged
  ? undefined
  : process.argv.find((a) => a.startsWith("--smoke-fixture="))?.slice("--smoke-fixture=".length);

// Development only: a local page that stands in for every retailer, so opening one from the web app
// can be exercised end to end without loading a retailer. The smoke run uses the same stand-in.
const retailerFixture = app.isPackaged ? undefined : (smokeFixture ?? process.env.SAGEFIN_DESKTOP_RETAILER_FIXTURE);

/** The main window: the web app. @type {ReturnType<typeof openShell> | null} */
let main = null;
/** The retailers window: this computer's saved pages. @type {BrowserWindow | null} */
let home = null;
/** @type {ReturnType<typeof createCaptureStore> | null} */
let store = null;
/** The upload-only token for each site. @type {ReturnType<typeof createCredentialStore> | null} */
let credentials = null;
/** The SageFin the app is showing; saved pages are filed under it and sent only to it. */
let site = resolveSite(undefined);
/**
 * What has been sent for each retailer since its last sync began, or since the app started.
 * @type {Map<string, import("../lib/uploader.mjs").SentTally>}
 */
const lastSent = new Map();
/** Why sending is not happening, when the member can do something about it. @type {string | null} */
let uploadNotice = null;
let uploading = false;
let uploadAgain = false;
/** The member's choices about each retailer (lib/consent.mjs). @type {ReturnType<typeof createConsents> | null} */
let consents = null;
/** What each sync has already read. @type {ReturnType<typeof createSyncStates> | null} */
let syncStates = null;
/** The syncs running now, and what each is doing. @type {Map<string, string>} */
const syncing = new Map();
/** The member's choices about running in the background. @type {ReturnType<typeof createPreferences> | null} */
let preferences = null;
/** The menu bar or system tray icon, where the desktop has one. @type {Tray | null} */
let tray = null;
/** Looking for, and installing, a newer version. @type {ReturnType<typeof startUpdates> | null} */
let updates = null;
/** Set once the member has asked to quit, so closing the window closes it. */
let quitting = false;
/** One open window per retailer. @type {Map<string, BrowserWindow>} */
const windows = new Map();
/** The last thing worth telling the member about each retailer. @type {Map<string, string>} */
const notices = new Map();

/**
 * SageFin's last answer about which scheduled syncs this computer may run (lib/check-in.mjs).
 * @type {{ at: number, siteKey: string, answers: Record<string, import("../lib/check-in.mjs").Answer> } | null}
 */
let lastCheckIn = null;
/** The check-in under way, if one is. @type {Promise<void> | null} */
let checkingIn = null;
/** Something changed while one was under way, so another follows it. */
let checkInAgain = false;
let checkInEveryMs = CHECK_IN_EVERY_MS;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Starting the app again is also how a hidden window comes back on a desktop with no tray.
  app.on("second-instance", () => {
    if (main) main.show();
    else home?.focus();
  });
  void app.whenReady().then(start);
}

// A hidden window is still a window, so this fires only when the last one closed for real.
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
});
// macOS: a click on the Dock icon.
app.on("activate", () => main?.show());

async function start() {
  const dir = process.env.SAGEFIN_DESKTOP_CAPTURES || path.join(app.getPath("userData"), "captures");

  // Captures are sealed with the operating system's own secret store, or not kept at all. A
  // payload is the member's purchases and address verbatim; writing that in the clear because
  // the keychain was unavailable would be the wrong default to discover later.
  if (safeStorage.isEncryptionAvailable()) {
    const sealing = {
      seal: (/** @type {string} */ plaintext) => safeStorage.encryptString(plaintext),
      open: (/** @type {Uint8Array} */ sealed) => safeStorage.decryptString(Buffer.from(sealed)),
    };
    store = createCaptureStore({ dir, ...sealing });
    // The token is sealed the same way, beside the captures rather than among them.
    credentials = createCredentialStore({ dir: path.join(dir, "..", "account"), ...sealing });
    syncStates = createSyncStates({ dir: path.join(dir, "..", "sync"), ...sealing });
    consents = createConsents({ dir: path.join(dir, "..", "consent"), ...sealing });
  }

  ipcMain.handle("desktop:status", (event) => (fromHome(event) ? status() : null));
  ipcMain.handle("desktop:open", (event, code) => {
    if (!fromHome(event) || typeof code !== "string") return false;
    const retailer = retailerByCode(code);
    if (!retailer) return false;
    openRetailer(retailer);
    return true;
  });

  if (smokeFixture) {
    setTimeout(() => {
      console.error("smoke: nothing was captured in 15 s");
      app.exit(1);
    }, 15_000);
    openRetailer(RETAILERS[0]);
    return;
  }

  // Which SageFin to open: production, unless a development run names test or local.
  site = resolveSite(app.isPackaged ? undefined : process.env.SAGEFIN_DESKTOP_SITE);
  // A development run otherwise shows Electron's own icon in the Dock. A packaged app takes its
  // icon from the bundle.
  if (process.platform === "darwin") app.dock?.setIcon(nativeImage.createFromPath(DOCK_ICON));

  preferences = createPreferences({ dir: path.join(dir, "..") });
  tray = openTray();
  applyLoginItem();
  updates = startUpdates({
    syncing: () => syncing.size,
    onChanged: () => tray?.setContextMenu(trayMenu()),
    beforeRestart: () => {
      quitting = true;
    },
  });

  main = openShell({
    site,
    version: RUNNING_VERSION,
    icon: ICON,
    background: {
      hidden: startsHidden({
        openedAtLogin: canOpenAtLogin(platformState()) && app.getLoginItemSettings().wasOpenedAtLogin,
        argv: process.argv,
        platform: process.platform,
        hasTray: tray !== null,
      }),
      closeAction: () =>
        closeAction({
          quitting,
          keepRunning: preferences?.get().keepRunning ?? false,
          platform: process.platform,
          hasTray: tray !== null,
        }),
      onHidden: tellAboutBackground,
      menuItems: backgroundMenuItems,
    },
    onRetailers: () => void openRetailersWindow(),
    retailers: {
      status,
      open(code) {
        const retailer = retailerByCode(code);
        if (!retailer) return false;
        openRetailer(retailer);
        return true;
      },
      // The member asked for a sync. Its window shows when they may be needed at it, and stays out
      // of the way otherwise (lib/sync-plan.mjs); Open, beside it, shows the window to anyone who
      // wants to watch. It is theirs either way.
      sync(code) {
        const retailer = retailerByCode(code);
        if (!retailer || !retailer.syncs || syncing.has(code) || !syncStates) return false;
        // Not before the member has chosen, where the retailer's terms make it their choice.
        if (!maySyncNow(retailer)) return false;
        const visible = showWindowForMemberSync(syncStates.get(site.key, retailer.code));
        void runSync(retailer, { visible, by: "member" });
        return true;
      },
      // The member's answer, from the Retail sync page, about one thing at one retailer.
      consent(code, kind, answer) {
        const retailer = retailerByCode(code);
        if (!retailer || !consents || !CONSENT_KINDS.includes(/** @type {any} */ (kind)) || typeof answer !== "boolean") return false;
        const which = /** @type {import("../lib/consent.mjs").ConsentKind} */ (kind);
        // Nothing to answer where the terms allow it: recording a yes there would read as a choice
        // nobody was asked to make.
        if (!needsChoice(retailer, which)) return false;
        consents.set(retailer, which, answer);
        changed();
        return true;
      },
    },
    account: {
      // The signed-in page minted an upload-only token and is handing it over.
      connect(value) {
        const credential = asCredential(value);
        if (!credential || !credentials) return false;
        credentials.set(site.key, credential);
        uploadNotice = null;
        changed();
        void upload();
        return true;
      },
      // Returns the token's id, which is not a secret, so the page can revoke it at SageFin too:
      // letting go of our copy would otherwise leave a live credential nothing here still holds.
      disconnect() {
        const tokenId = credentials?.get(site.key)?.tokenId ?? null;
        credentials?.clear(site.key);
        uploadNotice = null;
        changed();
        return tokenId;
      },
    },
    onSite(next) {
      site = next;
      uploadNotice = null;
      lastSent.clear();
      changed();
      void upload();
    },
  });

  // Whatever was saved and not sent before the app last closed.
  void upload();

  // Version 0.1.19 registered itself to open `sagefin-desktop://` links, a feature that was taken
  // out again. An update from it lets go of that, so no page on the web can start this app.
  if (app.isPackaged) app.removeAsDefaultProtocolClient("sagefin-desktop");

  // Scheduled runs: looked at a minute after start and hourly after that, while the app is running,
  // with or without its window (lib/background.mjs).
  // A retailer is only ever run this way once the member has run it themselves (lib/sync-plan.mjs).
  if (!retailerFixture) {
    setTimeout(() => void runScheduled(), 60_000);
    setInterval(() => void runScheduled(), 60 * 60 * 1000);
    // The regular check-in: how SageFin knows this computer is running, and what its syncs came to.
    setTimeout(() => void checkInRegularly(), 20_000);
  }
}

const platformState = () => ({ platform: process.platform, packaged: app.isPackaged });

/**
 * The member's two background choices, as menu items. One list for the Retailers menu and the tray,
 * so the two cannot offer different things.
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function backgroundMenuItems() {
  const current = preferences?.get();
  if (!preferences || !current) return [];
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [
    {
      label: "Keep Running When the Window Is Closed",
      type: "checkbox",
      checked: current.keepRunning,
      click: (item) => setPreference({ keepRunning: item.checked }),
    },
  ];
  if (canOpenAtLogin(platformState())) {
    items.push({
      label: process.platform === "darwin" ? "Open at Login" : "Start with Windows",
      type: "checkbox",
      checked: current.openAtLogin,
      click: (item) => setPreference({ openAtLogin: item.checked }),
    });
  }
  return items;
}

/** @param {Partial<import("../lib/background.mjs").Preferences>} changes */
function setPreference(changes) {
  preferences?.set(changes);
  applyLoginItem();
  main?.refreshMenu();
  tray?.setContextMenu(trayMenu());
}

/** Makes the operating system's login item agree with the member's choice, where there is one. */
function applyLoginItem() {
  if (!preferences || !canOpenAtLogin(platformState())) return;
  // The argument reaches the app on Windows only; it is how a login start is told from a click.
  app.setLoginItemSettings({ openAtLogin: preferences.get().openAtLogin, args: [HIDDEN_ARG] });
}

function trayMenu() {
  // A downloaded update: offered here because the app may otherwise run for weeks without quitting.
  const update = updateMenuItem({ version: updates?.downloaded() ?? null, syncing: syncing.size });
  return Menu.buildFromTemplate([
    // Which version is running: the one place to read it when the window is closed.
    { label: versionLabel(RUNNING_VERSION), enabled: false },
    { type: "separator" },
    { label: "Open SageFin", click: () => main?.show() },
    { label: "Retailers on This Computer…", click: () => void openRetailersWindow() },
    ...(update
      ? /** @type {Electron.MenuItemConstructorOptions[]} */ ([
          { type: "separator" },
          { label: update.label, enabled: update.enabled, click: () => void updates?.restart() },
        ])
      : []),
    { type: "separator" },
    ...backgroundMenuItems(),
    { type: "separator" },
    { label: "Quit SageFin Desktop", click: () => app.quit() },
  ]);
}

/**
 * The menu bar or system tray icon: how the window comes back, and how the app is quit, once
 * closing the window no longer does that. Null where the desktop cannot show one.
 * @returns {Tray | null}
 */
function openTray() {
  try {
    const size = process.platform === "darwin" ? 18 : 16;
    const icon = new Tray(nativeImage.createFromPath(ICON).resize({ width: size, height: size }));
    icon.setToolTip(versionLabel(RUNNING_VERSION));
    icon.setContextMenu(trayMenu());
    return icon;
  } catch {
    return null;
  }
}

/** Said once, the first time closing the window leaves the app running. */
function tellAboutBackground() {
  if (!preferences || preferences.get().toldAboutBackground) return;
  preferences.set({ toldAboutBackground: true });
  if (!Notification.isSupported()) return;
  const where = process.platform === "darwin" ? "the menu bar icon" : "the tray icon";
  new Notification({
    title: "SageFin Desktop is still running",
    body: `It keeps running so your retailers can sync each day. Open or quit it from ${where}.`,
  }).show();
}

/**
 * Whether the member has agreed to this at this retailer, where its terms make it theirs to agree
 * to (lib/consent.mjs). The one exception is the development smoke run, which saves one page of
 * a local file and quits.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {import("../lib/consent.mjs").ConsentKind} kind
 */
const mayDo = (retailer, kind) => Boolean(smokeFixture) || allowed(retailer, kind, consents?.get(retailer.code));
/** @param {import("../lib/retailers.mjs").Retailer} retailer */
const maySyncNow = (retailer) => Boolean(smokeFixture) || maySync(retailer, consents?.get(retailer.code));

/**
 * Keeps a page, if the member has agreed to its being kept. Every page the app saves goes through
 * here, whoever opened it: the member, or a sync.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {string} kind
 * @param {string} payload
 * @returns {{ added: boolean, kept: boolean }}  `kept` false: not saved, because the member has not chosen to.
 */
function keep(retailer, kind, payload) {
  if (!store) return { added: false, kept: false };
  if (!mayDo(retailer, "saving")) {
    tell(retailer.code, `Not saved. Choose whether to save ${retailer.name}'s pages in Settings → Retail sync.`);
    return { added: false, kept: false };
  }
  if (logKeys) {
    const paths = keyPaths(payload, logKeys);
    console.log(`keys: ${retailer.code} ${kind}, ${paths.length} matching`);
    for (const line of paths) console.log(`keys:   ${line}`);
  }
  const { added } = store.add({ site: site.origin, retailer: retailer.code, kind, payload });
  if (added) void upload();
  return { added, kept: true };
}

async function runScheduled() {
  if (!syncStates) return;
  // Asked first: the member may run the app on another computer that has this retailer's daily
  // sync, or a retailer may have turned one of them away (lib/check-in.mjs).
  await checkInNow();
  for (const retailer of RETAILERS) {
    if (!retailer.syncs || syncing.has(retailer.code)) continue;
    // A schedule waits for the member's choice, and stops when the choice is withdrawn or the
    // retailer's terms have changed since it was made.
    if (!maySyncNow(retailer)) continue;
    // With no answer, the app runs as it would with nobody to ask.
    if (!scheduleAllowedBy(sagefinAnswer(retailer.code))) continue;
    if (scheduledRunDue(syncStates.get(site.key, retailer.code), Date.now(), SCHEDULE_EVERY)) {
      void runSync(retailer, { visible: false });
    }
  }
}

/**
 * What SageFin last said about a retailer's scheduled sync, for the site being shown, if it said
 * it recently enough to act on. Null is nobody to ask.
 * @param {string} code
 */
function sagefinAnswer(code) {
  return lastCheckIn && lastCheckIn.siteKey === site.key ? standingAnswerFor(lastCheckIn, code, Date.now()) : null;
}

/**
 * Tells SageFin what each retailer's last sync on this computer came to, and keeps its answer.
 * Does nothing until the computer is connected. One at a time: a call during one is answered by
 * a second check-in that follows it, so what it reports is never older than the call.
 * @returns {Promise<void>}
 */
function checkInNow() {
  if (checkingIn) {
    checkInAgain = true;
    return checkingIn;
  }
  const run = (async () => {
    do {
      checkInAgain = false;
      // Never the reason a sync does not run: a check-in that fails is one with no answer.
      await checkInOnce().catch(() => {});
    } while (checkInAgain);
  })().finally(() => {
    if (checkingIn === run) checkingIn = null;
  });
  checkingIn = run;
  return run;
}

async function checkInOnce() {
  if (!syncStates || !credentials) return;
  // A stand-in page is not an order, and a run over one is not a sync to report.
  if (retailerFixture && site.key !== "local") return;
  const asked = site;
  const credential = credentials.get(asked.key);
  if (!credential) return;
  const states = syncStates;

  const result = await checkIn({
    site: asked.origin,
    secret: credential.secret,
    version: RUNNING_VERSION,
    reports: RETAILERS.filter((r) => r.syncs).map((r) => report(r.code, states.get(asked.key, r.code), maySyncNow(r))),
    fetch,
  });
  checkInEveryMs = result.againInMs;
  if (result.status !== "answered") return;

  lastCheckIn = { at: Date.now(), siteKey: asked.key, answers: result.answers };
  for (const retailer of RETAILERS) {
    // Only the retailers this app syncs, whatever the answer names. And not one that is syncing:
    // the run holds its own copy of this memory and writes it back.
    const answer = result.answers[retailer.code];
    if (!retailer.syncs || !answer || syncing.has(retailer.code)) continue;
    // The member ran Sync now on another computer and it finished: the refusal remembered here
    // is over there too.
    const state = states.get(asked.key, retailer.code);
    if (refusalLifted(state, answer)) states.set(asked.key, retailer.code, { ...state, refusedAt: null });

    // A sync the member asked for from the web. It runs as a scheduled one does, out of the way,
    // and is theirs: they started it, though not from here. Only for the SageFin still on screen.
    if (asked.key === site.key && shouldStartRequested(states.get(asked.key, retailer.code), answer, Date.now())) {
      void runSync(retailer, { visible: false, by: "member" });
    }
  }
  changed();
}

/** Checks in, then again after however long SageFin asked for. */
async function checkInRegularly() {
  await checkInNow();
  setTimeout(() => void checkInRegularly(), checkInEveryMs);
}

const pause = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Development only, and only against a stand-in: a shorter wait between orders, so a test of the
// run does not take minutes. A real retailer is always given the full pause.
const pauseBetweenOrders =
  retailerFixture && Number(process.env.SAGEFIN_DESKTOP_SYNC_PAUSE_MS) >= 0
    ? Number(process.env.SAGEFIN_DESKTOP_SYNC_PAUSE_MS)
    : PAUSE_BETWEEN_ORDERS_MS;

/**
 * Loads a page in a retailer's window and waits for it to finish.
 * @param {BrowserWindow} win
 * @param {string} url
 * @returns {Promise<boolean>} False when the page did not load.
 */
function load(win, url) {
  return navigate(win, () => void win.loadURL(url).catch(() => {}));
}

/**
 * Runs a script in the page that moves it to another page, such as submitting the page's own
 * form, and waits for that page as `load` does. False when the script did not move it.
 * @param {BrowserWindow} win
 * @param {string} script  An expression that navigates and returns true, or returns false.
 */
function follow(win, script) {
  return navigate(win, (fail) =>
    void win.webContents.executeJavaScript(script).then(
      (moved) => moved === true || fail(),
      () => fail(),
    ),
  );
}

/**
 * Starts a navigation and waits for its page to finish loading.
 * @param {BrowserWindow} win
 * @param {(fail: () => void) => void} begin
 * @returns {Promise<boolean>}
 */
function navigate(win, begin) {
  return new Promise((resolve) => {
    // After the window is reading its responses, or the page this load is for is not saved.
    void (listening.get(win) ?? Promise.resolve()).then(() => start(resolve));
  });

  /** @param {(ok: boolean) => void} resolve */
  function start(resolve) {
    if (win.isDestroyed()) return resolve(false);
    const wc = win.webContents;
    const done = (/** @type {boolean} */ ok) => {
      clearTimeout(timer);
      wc.off("did-finish-load", onFinish);
      wc.off("did-fail-load", onFail);
      resolve(ok);
    };
    const onFinish = () => done(true);
    const onFail = (/** @type {Electron.Event} */ _e, /** @type {number} */ code, /** @type {string} */ _d, /** @type {string} */ _u, /** @type {boolean} */ isMainFrame) => {
      // -3 is a load this window replaced with another, such as a redirect; the next event decides.
      if (isMainFrame && code !== -3) done(false);
    };
    const timer = setTimeout(() => done(false), 45_000);
    wc.on("did-finish-load", onFinish);
    wc.on("did-fail-load", onFail);
    begin(() => done(false));
  }
}

// Development only: with SAGEFIN_DESKTOP_LOG_PAGES set, every page a retailer window receives is
// described on the terminal — its path, how it arrived, and whether it was saved. Never its query
// string or its contents, which hold order numbers.
const logPages = !app.isPackaged && Boolean(process.env.SAGEFIN_DESKTOP_LOG_PAGES);

// Development only: with SAGEFIN_DESKTOP_LOG_KEYS set to a pattern, each page as it is saved has
// the paths to its matching keys printed, with the shape of what is there and never a value
// (lib/key-paths.mjs). How a reader for a retailer's page learns where the page says something.
const logKeys = app.isPackaged ? null : keyPattern(process.env.SAGEFIN_DESKTOP_LOG_KEYS);

// Development only: with SAGEFIN_DESKTOP_SCHEDULE_EVERY_MINUTES set, a scheduled sync is due that
// many minutes after the last finished one, so one can be watched without waiting a day. An
// installed app ignores it and schedules daily (lib/sync-plan.mjs).
const SCHEDULE_EVERY = scheduleEveryMs(process.env.SAGEFIN_DESKTOP_SCHEDULE_EVERY_MINUTES, app.isPackaged);
/** @param {string} url */
const pathOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search ? " ?…" : ""}`;
  } catch {
    return "(not a URL)";
  }
};

/** The HTTP status of the page each retailer window last navigated to. @type {WeakMap<BrowserWindow, number>} */
const lastStatus = new WeakMap();

/** Each retailer window's wait for its response reader to start. @type {WeakMap<BrowserWindow, Promise<void>>} */
const listening = new WeakMap();

/**
 * What a sync is waiting for the page to fetch, per window: a capture kind, and who to tell. The
 * answer is the response's text, or the status the retailer refused it with.
 * @typedef {{ payload: string | null, status: number | null }} PageAnswer
 * @type {WeakMap<BrowserWindow, { kind: string, tell: (answer: PageAnswer) => void }>}
 */
const awaited = new WeakMap();

/**
 * While a sync waits for a list to change in place, the refusal the page's own request met, if it
 * met one. There is no page load to carry the status and no response the app can name, so the
 * statuses a retailer refuses with are watched for on anything the page fetches from the retailer.
 * @type {WeakMap<BrowserWindow, { host: string, status: number | null }>}
 */
const watchedInPlace = new WeakMap();
/** What a retailer answers when it is turning software away: Walmart's 412 and 418, Amazon's 503, and 429. */
const REFUSALS = new Set([412, 418, 429, 503]);

/** @param {BrowserWindow} win @param {string} kind @param {PageAnswer} answer */
function answerAwaited(win, kind, answer) {
  const waiting = awaited.get(win);
  if (!waiting || waiting.kind !== kind) return;
  awaited.delete(win);
  waiting.tell(answer);
}

/**
 * Presses something in the page that makes the page fetch more, and waits for what it fetches.
 * `pressed` is false when there was nothing to press. A press that is answered with a refusal comes
 * back as its status; one that is never answered comes back with neither.
 * @param {BrowserWindow} win
 * @param {string} script  An expression that presses and returns true, or returns false.
 * @param {string} kind    The capture kind of the response to wait for.
 * @returns {Promise<PageAnswer & { pressed: boolean }>}
 */
function pressAndRead(win, script, kind) {
  return new Promise((resolve) => {
    if (win.isDestroyed()) return resolve({ pressed: false, payload: null, status: null });
    const timer = setTimeout(() => {
      awaited.delete(win);
      resolve({ pressed: true, payload: null, status: null });
    }, 45_000);
    const settle = (/** @type {PageAnswer & { pressed: boolean }} */ answer) => {
      clearTimeout(timer);
      awaited.delete(win);
      resolve(answer);
    };
    // Waiting before pressing: the answer can arrive before the press has reported back.
    awaited.set(win, { kind, tell: (answer) => settle({ pressed: true, ...answer }) });
    win.webContents.executeJavaScript(script).then(
      (pressed) => pressed === true || settle({ pressed: false, payload: null, status: null }),
      () => settle({ pressed: false, payload: null, status: null }),
    );
  });
}

/** The data a retailer's page embeds, or null. @param {BrowserWindow} win @returns {Promise<string | null>} */
/**
 * What a sync reads from the page it has loaded, to know what to open next. Never what is saved,
 * which is read the way the member's own browsing is. A retailer saved from its HTML is read as the
 * page shows it.
 * @param {BrowserWindow} win
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 */
const pageData = (win, retailer) =>
  win.webContents.executeJavaScript(
    retailer.saves === "document"
      ? "document.documentElement.outerHTML"
      : "(() => { const el = document.getElementById('__NEXT_DATA__'); return el ? el.textContent : null; })()",
  );

/**
 * A sync: opens a retailer's orders list, then the page of each order not yet read in its present
 * state, one at a time and slowly. The pages are saved the way they are when the member opens them
 * — this only does the opening.
 *
 * It stops, and shows the window, the moment the retailer wants the member: its robot check, or a
 * sign-in. It never retries through either.
 *
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {{ visible: boolean, by?: "member" | "schedule" }} options
 *   `visible` is false for a run nobody at this computer started, whose window stays out of the
 *   way unless the retailer needs the member. `by` says who started it when that is not who
 *   `visible` implies: a sync the member asked for from the web is theirs, and runs out of the way.
 */
async function runSync(retailer, { visible, by }) {
  if (!store || !syncStates || !retailer.syncs || syncing.has(retailer.code)) return;
  // Every way a sync starts comes through here, so this is the gate that cannot be walked round.
  if (!maySyncNow(retailer)) return;
  const { listedOrders, hasNextListPage, listPageUrl, orderIdIn, nextPageScript, nextPageKind, nextPageInPlace } = retailer;
  if (!listedOrders || !hasNextListPage || !listPageUrl || !orderIdIn) return;
  const states = syncStates;
  const siteKey = site.key;
  const state = states.get(siteKey, retailer.code);

  const progress = (/** @type {string} */ text) => {
    syncing.set(retailer.code, text);
    changed();
  };
  // A sync is a fresh account of what is sent, and the last page's message means nothing to it.
  lastSent.delete(retailer.code);
  notices.delete(retailer.code);
  progress("Opening your orders…");

  const hadWindow = windows.has(retailer.code);
  const win = openRetailer(retailer, { show: visible, navigate: false });

  // A retailer whose terms ask software acting by itself to say so (Amazon's Agent Terms) is told, on
  // every request of the run: the page's own requests go out under the window's user agent too. Put
  // back when the run ends, so the member's own browsing in the window is never marked.
  const plainAgent = win.webContents.getUserAgent();
  if (retailer.agent) win.webContents.setUserAgent(`${plainAgent} Agent/${retailer.agent}`);

  /**
   * Ends the run. `needsMember` shows the window: the retailer is asking for a person. `refused` is
   * the retailer turning the run away, after which no scheduled run starts until the member's own
   * Sync now finishes.
   */
  const finish = (
    /** @type {string} */ result,
    { finished = false, needsMember = false, refused = false, signedOut = false, orders = /** @type {number | null} */ (null) } = {},
  ) => {
    const now = new Date().toISOString();
    state.lastRunAt = now;
    // Unless told otherwise, a run with its window out of the way is the schedule's.
    state.lastRunBy = by ?? (visible ? "member" : "schedule");
    state.lastResult = result;
    state.lastOutcome = finished ? "finished" : refused ? "refused" : signedOut ? "signed_out" : "stopped";
    state.lastOrders = finished ? orders : null;
    if (finished) {
      state.lastFinishedAt = now;
      state.refusedAt = null;
    }
    if (refused) state.refusedAt = now;
    states.set(siteKey, retailer.code, state);
    syncing.delete(retailer.code);
    // The pages' own messages ("Saved this page.") were the run's working; its result says what it came to.
    notices.delete(retailer.code);
    if (!win.isDestroyed()) {
      if (retailer.agent) win.webContents.setUserAgent(plainAgent);
      if (needsMember) {
        win.show();
        win.focus();
      } else if (!visible && !hadWindow) {
        // A scheduled run's own window, with nothing left to show.
        win.close();
      }
    }
    changed();
    // SageFin hears how it ended now, not at the next check-in: a Sync now makes this computer
    // the one that has the daily sync, and a refusal stops the member's other computers too.
    void checkInNow();
  };

  /**
   * Whether the retailer turned the page just loaded away: its robot check, by address or by content,
   * or a refusal status (Walmart's 412 and 418, Amazon's 503). Any of them ends the run.
   * @param {string | null} [data]  The page's data, when it has been read.
   */
  const turnedAway = (data = null) => {
    const url = win.webContents.getURL();
    const status = lastStatus.get(win) ?? 200;
    if (retailer.isChallenge(url, { anyHost: Boolean(retailerFixture) }) || (data && retailer.isChallengePayload?.(data))) {
      // An agent never answers a CAPTCHA, by Amazon's terms, and a person answering one so that a
      // run can carry on would be answering it for the agent. So the run says what happened, and
      // does not ask the member to complete the check.
      return retailer.agent
        ? `${retailer.name} asked whether a person is there, and the sync stopped. It will not run again by itself.`
        : `${retailer.name} is checking this browser. Complete its check in the window; the sync has stopped for now.`;
    }
    if (status >= 400) return `${retailer.name} turned the sync away (${status}). It will not run again by itself.`;
    return null;
  };

  try {
    const firstUrl = listPageUrl(1);
    if (!(await load(win, retailerFixture ? onFixture(firstUrl, retailerFixture) : firstUrl))) {
      return finish(`${retailer.name} could not be reached.`);
    }
    if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
    let list = await pageData(win, retailer);
    const stop = turnedAway(list);
    if (stop) return finish(stop, { needsMember: true, refused: true });

    const listKind = retailer.captureKind(firstUrl) ?? "";
    if (!list || retailer.isSignedOut(listKind, list)) {
      return finish(`Sign in to ${retailer.name} in its window, then sync again.`, { needsMember: true, signedOut: true });
    }

    // Page through the orders list until readListPage says stop. A page after the first is reached
    // as a person reaches it, and is saved by the same code that saves what a person opens.
    /** @type {import("../lib/retailers.mjs").ListedOrder[]} */
    const listed = [];
    let pageNumber = 1;
    let reachedEnd = false;
    for (let pagesRead = 1; ; pagesRead += 1) {
      const step = readListPage({
        pageOrders: listedOrders(list),
        listed,
        seen: state.seen,
        caughtUp: state.caughtUp,
        hasNextPage: hasNextListPage(list),
        pagesRead,
        now: new Date(),
      });
      listed.push(...step.fresh);
      if (step.end) reachedEnd = true;
      if (!step.more) break;

      // Not yet caught up: after page 1, which is where new orders are, carry on from where the
      // last finished run stopped rather than listing again what it already opened. Only a list
      // whose pages have addresses can be resumed; one paged by its own form starts from page 1.
      pageNumber = !nextPageScript && pageNumber === 1 && !state.caughtUp && state.listedThroughPage
        ? state.listedThroughPage
        : pageNumber + 1;
      progress(`Reading your orders, page ${pageNumber}…`);
      await pause(pauseBetweenOrders);
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");

      // A list with no address for its next page is moved on by the page's own Next control,
      // pressed as a person presses it: the request the page itself makes, under the run's user
      // agent. Where the page fetches the next orders by itself, they are read from that request.
      if (nextPageScript && nextPageKind) {
        const answer = await pressAndRead(win, nextPageScript, nextPageKind);
        if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
        if (answer.status) {
          return finish(`${retailer.name} turned the sync away (${answer.status}). It will not run again by itself.`, {
            needsMember: true,
            refused: true,
          });
        }
        // Pressing may have landed on the retailer's robot check instead of fetching anything.
        const stoppedOnPress = turnedAway();
        if (stoppedOnPress) return finish(stoppedOnPress, { needsMember: true, refused: true });
        // Nothing to press, or nothing came back: the list ends here for this run. Not the end of
        // the history, so the run does not claim to have caught up.
        if (!answer.payload) break;
        list = answer.payload;
        continue;
      }

      // Where the page's own script replaces the list where it stands, there is no page to wait
      // for and no response the app can name. The run presses, then watches the list on the page
      // until it shows other orders, and saves the page as it then is: for these pages what is
      // sent is the page as its script left it, not as the retailer first sent it.
      if (nextPageScript && nextPageInPlace) {
        const before = listSignature(retailer, list);
        let navigated = false;
        const onLoad = () => {
          navigated = true;
        };
        win.webContents.on("did-finish-load", onLoad);
        const watch = { host: new URL(win.webContents.getURL()).host, status: /** @type {number | null} */ (null) };
        watchedInPlace.set(win, watch);
        /** @type {string | null} */
        let moved = null;
        try {
          const pressed = await win.webContents.executeJavaScript(nextPageScript).catch(() => false);
          for (let waited = 0; pressed === true && waited < 45_000 && !win.isDestroyed(); waited += 500) {
            await pause(500);
            if (win.isDestroyed() || watch.status) break;
            const now = await pageData(win, retailer).catch(() => null);
            if (!now) continue;
            // A sign-in page or the robot check has no list either; both are looked at below.
            if (retailer.isSignedOut(listKind, now) || retailer.isChallengePayload?.(now) || retailer.isChallenge(win.webContents.getURL(), { anyHost: Boolean(retailerFixture) })) {
              moved = now;
              break;
            }
            const signature = listSignature(retailer, now);
            if (signature && signature !== before) {
              moved = now;
              break;
            }
          }
        } finally {
          watchedInPlace.delete(win);
          if (!win.isDestroyed()) win.webContents.off("did-finish-load", onLoad);
        }
        if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
        if (watch.status) {
          return finish(`${retailer.name} turned the sync away (${watch.status}). It will not run again by itself.`, {
            needsMember: true,
            refused: true,
          });
        }
        const stoppedInPlace = turnedAway(moved);
        if (stoppedInPlace) return finish(stoppedInPlace, { needsMember: true, refused: true });
        // Nothing to press, or the list never changed: the list ends here for this run.
        if (!moved) break;
        if (retailer.isSignedOut(listKind, moved)) {
          return finish(`Sign in to ${retailer.name} in its window, then sync again.`, { needsMember: true, signedOut: true });
        }
        // If pressing loaded a new page after all, that page was saved as it arrived. Otherwise
        // nothing has saved these orders yet, so the page is saved here, stripped like the first.
        if (!navigated) {
          const payload = stripHtml(moved);
          if (payload && Buffer.byteLength(payload) <= MAX_CAPTURE_BYTES) {
            keep(retailer, listKind, payload);
          }
        }
        list = moved;
        continue;
      }

      const url = nextPageScript ? null : listPageUrl(pageNumber);
      const loadedPage = nextPageScript
        ? await follow(win, nextPageScript)
        : await load(win, retailerFixture ? onFixture(/** @type {string} */ (url), retailerFixture) : /** @type {string} */ (url));
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
      const next = loadedPage ? await pageData(win, retailer) : null;
      const stoppedOnList = turnedAway(next);
      if (stoppedOnList) return finish(stoppedOnList, { needsMember: true, refused: true });

      // The next page could not be reached: nothing to press, or pressing loaded no page. That is
      // not a sign-in and not a refusal, so the run keeps what it has listed and opens those. It
      // does not claim the history was read to its end. (On 2026-10-03 a real Amazon run ended
      // here with "Sign in to Amazon", having listed 19 orders and opened none.)
      if (!next) break;
      if (retailer.isSignedOut(listKind, next)) {
        return finish(`Sign in to ${retailer.name} in its window, then sync again.`, { needsMember: true, signedOut: true });
      }
      list = next;
    }

    const todo = ordersToOpen(listed, state.seen);
    let read = 0;
    let missed = 0;
    for (const [index, order] of todo.entries()) {
      progress(`Reading order ${index + 1} of ${todo.length}…`);
      await pause(pauseBetweenOrders);
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");

      const loaded = await load(win, retailerFixture ? onFixture(order.url, retailerFixture) : order.url);
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
      const data = loaded ? await pageData(win, retailer) : null;
      const stopped = turnedAway(data);
      if (stopped) return finish(stopped, { needsMember: true, refused: true });

      if (data && orderIdIn(data) === order.id) {
        // The page was saved by the same code that saves it when the member opens it. This only
        // remembers that it has been, in the state the list showed.
        state.seen[order.id] = order.fingerprint;
        states.set(siteKey, retailer.code, state);
        read += 1;
        missed = 0;
        continue;
      }

      // Not the order's page. One may be a slow load; two in a row is the retailer saying no.
      missed += 1;
      if (missed >= 2) {
        return finish(`${retailer.name} stopped showing orders partway through. The sync has stopped for now.`, { needsMember: true });
      }
    }

    // Only now, with every listed order opened: a run that stopped partway must not move the
    // place the next one resumes from past orders it never reached.
    if (reachedEnd) {
      state.caughtUp = true;
      state.listedThroughPage = null;
    } else if (!state.caughtUp && !nextPageScript) {
      state.listedThroughPage = pageNumber > 1 ? pageNumber : null;
    }

    finish(
      todo.length === 0
        ? "Everything listed was already read."
        : `Read ${read} order${read === 1 ? "" : "s"}${read < todo.length ? ` of ${todo.length}` : ""}.`,
      { finished: true, orders: read },
    );
  } catch (error) {
    finish(`The sync stopped: ${error instanceof Error ? error.message : "an unexpected error"}.`);
  }
}

/**
 * Sends what is saved for the site being shown. One run at a time; a page saved during a run is
 * picked up by the run that follows it.
 */
async function upload() {
  if (!store || !credentials) return;
  // A stand-in page is not an order. It may be sent to a local SageFin and to nothing else, so a
  // development run can never post a fixture to a real household.
  if (retailerFixture && site.key !== "local") return;
  if (uploading) {
    uploadAgain = true;
    return;
  }
  const credential = credentials.get(site.key);
  if (!credential) return;

  uploading = true;
  const sendingTo = site;
  changed();
  try {
    const summary = await uploadPending({ store, site: sendingTo.origin, secret: credential.secret, fetch });
    for (const sent of summary.sent) {
      lastSent.set(sent.retailer, addSent(lastSent.get(sent.retailer), sent, new Date()));
    }
    if (summary.stopped === "signed-out") {
      // The token was revoked or has gone. Keeping it would retry it against every saved page.
      credentials.clear(sendingTo.key);
      uploadNotice = "SageFin no longer accepts this computer's connection. Connect it again.";
    } else if (summary.stopped === "offline") {
      uploadNotice = "SageFin could not be reached. Saved pages will be sent when it can be.";
    } else if (summary.stopped === "busy" || summary.stopped === "server") {
      uploadNotice = "SageFin is busy. Saved pages will be sent shortly.";
    } else {
      uploadNotice = summary.refused > 0 ? "SageFin would not take some saved pages as they are." : null;
    }
    // Try again shortly when the wait is the server's, not the member's.
    if (summary.stopped === "busy" || summary.stopped === "server") setTimeout(() => void upload(), 90_000);
  } finally {
    uploading = false;
    changed();
    if (uploadAgain) {
      uploadAgain = false;
      void upload();
    }
  }
}

/** The retailers window: what is saved on this computer, and a button to open each retailer. */
async function openRetailersWindow() {
  if (home) {
    home.focus();
    return;
  }

  home = new BrowserWindow({
    width: 560,
    height: 520,
    title: "SageFin Desktop",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The home window shows the app's own page and nothing else.
  home.webContents.on("will-navigate", (event) => event.preventDefault());
  home.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  home.on("closed", () => {
    home = null;
    for (const win of windows.values()) win.close();
  });
  await home.loadURL(HOME);
}

/** Only the app's own page may call the handlers. @param {Electron.IpcMainInvokeEvent} event */
function fromHome(event) {
  return Boolean(home && event.sender === home.webContents && event.senderFrame?.url === HOME);
}

function status() {
  // Only what was saved under the SageFin being shown: a page saved on test is not waiting here.
  const records = (store ? store.list() : []).filter((c) => c.site === site.origin);
  return {
    canSave: Boolean(store),
    connected: Boolean(credentials?.get(site.key)),
    // Which of the member's connected computers this one is. The credential's id, never its secret:
    // SageFin lists the id in Settings, and the page needs it to mark this computer in that list.
    tokenId: credentials?.get(site.key)?.tokenId ?? null,
    sending: uploading,
    uploadNotice,
    retailers: RETAILERS.map((r) => {
      const mine = records.filter((c) => c.retailer === r.code);
      return {
        code: r.code,
        name: r.name,
        open: windows.has(r.code),
        captures: mine.length,
        lastCapturedAt: mine.at(-1)?.capturedAt ?? null,
        // With nothing of its own to say: why the daily sync is not running on this computer.
        notice: notices.get(r.code) ?? waitingSentence(sagefinAnswer(r.code), r.name),
        lastSentAt: lastSent.get(r.code)?.at ?? null,
        lastSent: lastSent.has(r.code) ? sentSummary(/** @type {import("../lib/uploader.mjs").SentTally} */ (lastSent.get(r.code))) : null,
        ...syncStatus(r.code),
        ...termsStatus(r),
      };
    }),
  };
}

/**
 * What a retailer's terms say, and what the member has chosen about them. The words are the
 * retailer's, quoted; the page shows them as given.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 */
function termsStatus(retailer) {
  const choices = consents?.get(retailer.code);
  /** @param {import("../lib/consent.mjs").ConsentKind} kind */
  const about = (kind) => ({
    // Whether this is the member's to choose, and their standing answer: null is "not asked, or
    // asked about terms that have since changed", which is not a no.
    needsChoice: needsChoice(retailer, kind),
    answer: standingAnswer(retailer, kind, choices),
    answeredAt: standingAnswer(retailer, kind, choices) === null ? null : (choices?.[kind]?.at ?? null),
  });
  return {
    terms: {
      url: retailer.terms.url,
      updated: retailer.terms.updated,
      quotes: retailer.terms.quotes,
      withinTermsBecause: retailer.terms.withinTermsBecause ?? null,
    },
    saving: about("saving"),
    automation: about("automation"),
  };
}

/** What a retailer's sync is doing, and what its last run came to. @param {string} code */
function syncStatus(code) {
  const state = syncStates?.get(site.key, code);
  return {
    syncable: Boolean(retailerByCode(code)?.syncs),
    syncing: syncing.has(code),
    syncProgress: syncing.get(code) ?? null,
    lastSyncAt: state?.lastRunAt ?? null,
    lastSyncBy: state?.lastRunBy ?? null,
    lastSync: state?.lastResult ?? null,
    nextSyncAt: state && scheduleAllowed(code) && scheduleAllowedBy(sagefinAnswer(code)) ? nextScheduledRunAt(state, SCHEDULE_EVERY) : null,
    // A scheduled run only ever follows one the member started and saw finish, and never one the
    // retailer turned away. Saying "daily" then would promise a run that will not happen.
    // Nor is it promised while the member's choice is missing or withdrawn.
    // Nor while another of the member's computers has it, or a retailer turned one of them away.
    scheduled:
      Boolean(state?.lastFinishedAt) && !state?.refusedAt && scheduleAllowed(code) && scheduleAllowedBy(sagefinAnswer(code)),
  };
}

/** @param {string} code */
function scheduleAllowed(code) {
  const retailer = retailerByCode(code);
  return Boolean(retailer) && maySyncNow(/** @type {import("../lib/retailers.mjs").Retailer} */ (retailer));
}

/** @param {string} code @param {string | null} notice */
function tell(code, notice) {
  if (notice === null) notices.delete(code);
  else notices.set(code, notice);
  changed();
}

/** Both windows that list the retailers ask again when something here changes. */
function changed() {
  home?.webContents.send("desktop:changed");
  main?.changed();
  // The update line in the tray says whether a sync is in the way, so it follows syncs too.
  if (updates?.downloaded()) tray?.setContextMenu(trayMenu());
}

/**
 * Opens a retailer's window, or brings the one already open forward.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {{ show?: boolean, navigate?: boolean }} [options]
 *   `show: false` for a scheduled sync, which keeps its window out of the way. `navigate: false`
 *   when the caller is about to load a page itself.
 * @returns {BrowserWindow}
 */
function openRetailer(retailer, { show = true, navigate = true } = {}) {
  const existing = windows.get(retailer.code);
  if (existing) {
    if (show) {
      existing.show();
      existing.focus();
    }
    return existing;
  }

  // Its own persistent profile per retailer: a sign-in survives a restart, and nothing is shared
  // with any other browser on this computer or with another retailer's window.
  const ses = session.fromPartition(`persist:retailer-${retailer.code}`);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: retailer.name,
    show,
    autoHideMenuBar: true,
    // A window out of sight still has to load its pages at full speed.
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  windows.set(retailer.code, win);
  // A window with nothing loaded has no page for the response reader to attach to, and its start
  // waits for one. A blank page gives it one before the retailer's first page is asked for.
  void win.loadURL("about:blank").catch(() => {});
  tell(retailer.code, null);

  // The retailer's own links stay in this window; nothing else opens from it.
  const startHost = new URL(retailer.startUrl).hostname.replace(/^www\./, "");
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const host = new URL(url).hostname;
      if (host === startHost || host.endsWith(`.${startHost}`)) void win.loadURL(url);
    } catch {
      // Not a URL; nothing to open.
    }
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => void readPage(retailer, win));

  // The window has no address bar, so its title says where it is: the retailer's page titles are
  // replaced by the address, query and all, which is what tells page 2 of Purchase history from
  // page 1. Registered before the reload warning below, which therefore still wins when it applies.
  const showAddress = (/** @type {string} */ url) => {
    if (!win.isDestroyed()) win.setTitle(windowTitle(retailer, url));
  };
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.on("did-navigate", (_event, url, httpResponseCode) => {
    lastStatus.set(win, httpResponseCode);
    showAddress(url);
    if (logPages) console.log(`page: arrived at ${pathOf(url)}`);
  });
  win.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) showAddress(url);
  });

  // With the page's own responses being read, an order opened from the list is saved as it
  // arrives. Without them, it is only saved after a reload, and the member is told so.
  const readingResponses = readResponses(retailer, win);
  win.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame && retailer.needsReload(url) && !readingResponses()) {
      win.setTitle(`${retailer.name}: reload this page to save the order`);
      tell(retailer.code, "That order is not saved yet. Reload its page (Cmd+R or Ctrl+R) to save it.");
    }
  });
  win.on("closed", () => {
    windows.delete(retailer.code);
    changed();
  });

  if (navigate) void load(win, retailerFixture ? fixtureUrl(retailerFixture) : retailer.startUrl);
  return win;
}

/**
 * An order's address moved onto the stand-in's server, so a development run can never follow a
 * listed order to the real retailer.
 * @param {string} url @param {string} fixture
 */
function onFixture(url, fixture) {
  const order = new URL(url);
  return new URL(order.pathname + order.search, fixtureUrl(fixture)).href;
}

/** A stand-in for a retailer: a local file, or a page a local server is serving. @param {string} fixture */
function fixtureUrl(fixture) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(fixture) ? fixture : pathToFileURL(path.resolve(fixture)).href;
}

/**
 * Saves the orders responses the retailer's own page requests, as they arrive.
 *
 * Read through the DevTools protocol, which watches the window's network traffic from outside the
 * page: nothing on the page is wrapped or changed, and the app still makes no request of its own.
 * It sees only what the member's browsing caused the page to ask for.
 *
 * Returns a function saying whether responses are being read. They may not be: the protocol allows
 * one client, so opening DevTools on the window takes it away.
 *
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {BrowserWindow} win
 * @returns {() => boolean}
 */
function readResponses(retailer, win) {
  const dbg = win.webContents.debugger;
  let attached = false;
  /** Requests whose bodies are wanted once they finish. @type {Map<string, string>} */
  const wanted = new Map();

  try {
    dbg.attach("1.3");
    attached = true;
  } catch {
    return () => false;
  }
  dbg.on("detach", (_event, reason) => {
    if (logPages) console.log(`page: stopped reading responses (${reason})`);
    attached = false;
    wanted.clear();
  });
  // Nothing loads in the window until this has answered: a response that arrives before it is not
  // seen at all, and for a retailer saved from its HTML that was the first page, every time.
  listening.set(
    win,
    dbg.sendCommand("Network.enable").then(
      () => undefined,
      () => {
        attached = false;
      },
    ),
  );

  dbg.on("message", (_event, method, params) => {
    if (method === "Network.responseReceived") {
      const watched = watchedInPlace.get(win);
      if (watched && !watched.status && (params.type === "XHR" || params.type === "Fetch") && REFUSALS.has(params.response.status)) {
        try {
          if (new URL(params.response.url).host === watched.host) watched.status = params.response.status;
        } catch {
          // Not a URL the page could have asked the retailer for.
        }
      }
      const anyHost = Boolean(retailerFixture);
      // A retailer whose data is its HTML: the page as it was sent, before any script ran on it.
      const kind =
        retailer.saves === "document"
          ? params.type === "Document" ? retailer.captureKind(params.response.url, { anyHost }) : null
          : retailer.responseKind(params.response.url, { anyHost });
      if (logPages && params.type === "Document") {
        const r = params.response;
        console.log(
          `page: ${pathOf(r.url)} status=${r.status} kind=${kind ?? "-"} serviceWorker=${Boolean(r.fromServiceWorker)} cache=${Boolean(r.fromDiskCache)} prefetch=${Boolean(r.fromPrefetchCache)}`,
        );
      }
      // Only an answer. A refusal's body is not an order, and is the retailer's to show.
      if (kind && params.response.status === 200) wanted.set(params.requestId, kind);
      // A sync waiting on this request is told the retailer refused it, so it stops there.
      else if (kind && params.response.status >= 400) answerAwaited(win, kind, { payload: null, status: params.response.status });
      return;
    }
    if (method !== "Network.loadingFinished") return;
    const kind = wanted.get(params.requestId);
    if (!kind) return;
    wanted.delete(params.requestId);

    void dbg
      .sendCommand("Network.getResponseBody", { requestId: params.requestId })
      .then(({ body, base64Encoded }) => {
        if (!store || win.isDestroyed()) return;
        const raw = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
        if (logPages) console.log(`page: read ${kind}, ${raw.length} chars`);
        const payload = retailer.saves === "document" ? stripHtml(raw) : raw;
        // A sync that pressed the page's Next control reads the next orders from this.
        answerAwaited(win, kind, { payload: payload || null, status: null });
        if (!payload) return;
        if (retailer.isChallengePayload?.(payload)) {
          win.setTitle(`${retailer.name} is checking this browser`);
          tell(retailer.code, `${retailer.name} is checking this browser. Complete its check in the window, then stop for today.`);
          return;
        }
        if (retailer.isSignedOut(kind, payload)) {
          tell(retailer.code, `Sign in to ${retailer.name} in its window to see your orders.`);
          return;
        }
        // Refused here rather than by SageFin, which would refuse it on every attempt to send it.
        const bytes = Buffer.byteLength(payload);
        if (bytes > MAX_CAPTURE_BYTES) {
          tell(retailer.code, `That page is ${(bytes / 1024 / 1024).toFixed(1)} MB, more than SageFin accepts, so it was not saved.`);
          return;
        }
        const { added, kept } = keep(retailer, kind, payload);
        if (!kept) return;
        win.setTitle(windowTitle(retailer, win.webContents.getURL()));
        tell(retailer.code, added ? "Saved this page." : "This page was already saved.");
      })
      .catch((/** @type {unknown} */ error) => {
        // The body was gone by the time it was asked for. The page still has it; a reload of the
        // page saves it the other way.
        if (logPages) console.log(`page: could not read ${kind}: ${error instanceof Error ? error.message : String(error)}`);
      });
  });

  return () => attached;
}

/**
 * Reads the page the member just loaded, if it is one worth saving.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {BrowserWindow} win
 */
async function readPage(retailer, win) {
  const url = win.webContents.getURL();

  if (retailer.isChallenge(url, { anyHost: Boolean(retailerFixture) })) {
    win.setTitle(`${retailer.name} is checking this browser`);
    tell(retailer.code, `${retailer.name} is checking this browser. Complete its check in the window, then stop for today.`);
    return;
  }

  // The page's HTML was read as it arrived, by readResponses. Nothing more to do once it has loaded.
  if (retailer.saves === "document") return;

  // A stand-in served by a local server is read by its path, as the retailer's pages are. A stand-in
  // that is a single local file has no such path and is taken to be an order page.
  const kind = retailerFixture
    ? (retailer.captureKind(url, { anyHost: true }) ?? "order_detail_next_data")
    : retailer.captureKind(url);
  if (!kind) return;

  if (!store) {
    tell(retailer.code, "This computer cannot protect saved data, so nothing is being saved.");
    return;
  }

  // Reads a script tag the page already contains. Nothing on the page is wrapped or changed.
  /** @type {string | null} */
  const payload = await win.webContents.executeJavaScript(
    "(() => { const el = document.getElementById('__NEXT_DATA__'); return el ? el.textContent : null; })()",
  );
  if (!payload) return;

  if (retailer.isSignedOut(kind, payload)) {
    tell(retailer.code, `Sign in to ${retailer.name} in its window to see your orders.`);
    return;
  }

  const { added, kept } = keep(retailer, kind, payload);
  if (!kept) return;
  win.setTitle(windowTitle(retailer, win.webContents.getURL()));
  tell(retailer.code, added ? "Saved this page." : "This page was already saved.");

  if (smokeFixture) {
    console.log(`smoke: saved ${kind}, ${store.list().length} capture(s)`);
    app.quit();
  }
}
