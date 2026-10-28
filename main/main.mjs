// @ts-check
// SageFin Desktop. Its main window is SageFin's own web app (main/shell.mjs). Beside it, a window
// the member signs in to a retailer in, by hand, saves what the retailer's own orders pages
// already contain.
//
// It reads a retailer's page after that page has loaded, and only the pages lib/retailers.mjs
// names. The member opens those pages, or a sync opens them for the member (runSync below): a
// sync loads pages and does nothing else. The user agent is Electron's own and is not changed.

import { app, BaseWindow, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, session, Tray, WebContentsView } from "electron";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HIDDEN_ARG, canOpenAtLogin, closeAction, createPreferences, startsHidden, trayClickOpensWindow } from "../lib/background.mjs";
import { createCaptureStore } from "../lib/capture-store.mjs";
import { CONSENT_KINDS, allowed, createConsents, maySync, needsChoice, standingAnswer } from "../lib/consent.mjs";
import { asCredential, createCredentialStore } from "../lib/credential-store.mjs";
import { MAX_CAPTURE_BYTES, stripHtml } from "../lib/html.mjs";
import { createAccountNames } from "../lib/account-names.mjs";
import { RETAILERS, gatherListed, retailerByCode, windowTitle } from "../lib/retailers.mjs";
import { LIST_KINDS, dropOlderThan, dropRead, enqueue, howFarBackDate, nextToOpen, noteCharges, noteSetup, reachedReadCharge, readsBackTo, settledListing, startOver, stripText } from "../lib/history.mjs";
import { resolveSite } from "../lib/site.mjs";
import { NO_OWNER, canComeBack, createOwners, ownerOf, takeOwnership } from "../lib/owner.mjs";
import { adoptRead, askHeld, orderKey, ordersToAskAbout, readKeys, sageFinLostReading, shareRead } from "../lib/read-orders.mjs";
import { MAX_LIST_PAGES_PER_RUN, MAX_ORDERS_PER_RUN, PAUSE_BETWEEN_ORDERS_MS, TROUBLE_RETRY_AFTER_MS, createSyncStates, nextScheduledRunAt, noteOrderPage, notePause, orderPageVerdict, scheduleEveryMs, scheduleStopped, scheduledRunDue, showWindowForMemberSync, troubleStatus } from "../lib/sync-plan.mjs";
import { CHECK_IN_EVERY_MS, checkIn, refusalLifted, report, scheduleAllowedBy, shouldStartRequested, standingAnswerFor, waitingSentence } from "../lib/check-in.mjs";
import { keyPaths, keyPattern } from "../lib/key-paths.mjs";
import { checkMenuItem, updateMenuItem } from "../lib/updates.mjs";
import { UPDATE_SENTENCE, belowMinimum, runningVersion, versionLabel } from "../lib/version.mjs";
import { addSent, sentSummary, uploadPending } from "../lib/uploader.mjs";
import { awaitRelist, setAsideCount, stillToOpen, waitingCount } from "../lib/history.mjs";
import { startPrivateMode } from "./private-mode.mjs";
import { openShell } from "./shell.mjs";
import { readMacRequirement, startUpdates } from "./updates.mjs";

const here = import.meta.dirname;
const HOME = pathToFileURL(path.join(here, "..", "renderer", "index.html")).href;
/** The strip above a retailer's page while the member sets up their history: the app's own page. */
const STRIP = pathToFileURL(path.join(here, "..", "renderer", "strip.html")).href;
/** How tall the strip is. Below it, the retailer's page, which nothing is drawn over. */
const STRIP_HEIGHT = 88;
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
/**
 * Pages let go when the household changed, because nobody who can connect owns them: said until the
 * household changes again, beneath anything sending has to say (lib/owner.mjs).
 * @type {string | null}
 */
let letGoNotice = null;
let uploading = false;
let uploadAgain = false;
/** The member's choices about each retailer (lib/consent.mjs). @type {ReturnType<typeof createConsents> | null} */
let consents = null;
/** What the member calls their account at a retailer whose pages do not say (lib/account-names.mjs). @type {ReturnType<typeof createAccountNames> | null} */
let accountNames = null;
/** What each sync has already read. @type {ReturnType<typeof createSyncStates> | null} */
let syncStates = null;
/** Whose memory each site's is: which household, and which person (lib/owner.mjs). @type {ReturnType<typeof createOwners> | null} */
let owners = null;
/** The household each running sync reads for, by retailer: where the pages it saves are filed. @type {Map<string, string>} */
const runOwners = new Map();
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
/**
 * A retailer's window: the window, the retailer's page filling it, and above the page, while the
 * member sets up their history, the app's own strip. Two separate views, so the strip is never on
 * the retailer's page and nothing of the page is changed to make room for it. `webContents` is the
 * retailer's page.
 * @typedef {Electron.BaseWindow & { webContents: Electron.WebContents, strip: Electron.WebContentsView, showStrip: (on: boolean) => void }} RetailerWindow
 */
/** One open window per retailer. @type {Map<string, RetailerWindow>} */
const windows = new Map();
/** Retailers whose history the member is setting up in an open window now. @type {Set<string>} */
const settingUp = new Set();
/** Retailers whose window shows the robot check now: the strip says so, and it is the member's. @type {Set<string>} */
const checking = new Set();
/**
 * What the member's own browsing has listed in each retailer's window since it opened, so an order
 * whose charges arrive in two answers is fingerprinted from both (`gatherListed`).
 * @type {Map<string, import("../lib/retailers.mjs").ListedOrder[]>}
 */
const browsed = new Map();
/**
 * Where the household's bank history starts, per site, as the signed-in web page last said
 * (lib/history.mjs, BankHistory). Never asked of SageFin by the app: the page reads it with the
 * member's own sign-in and hands it over the bridge.
 * @type {Map<string, import("../lib/history.mjs").BankHistory>}
 */
const bankHistories = new Map();
/** Whether the last check-in said the household is in private mode and locked, per site. @type {Map<string, boolean>} */
const lockedSites = new Map();
/** The last thing worth telling the member about each retailer. @type {Map<string, string>} */
const notices = new Map();

/**
 * SageFin's last answer about which scheduled syncs this computer may run (lib/check-in.mjs).
 * @type {{ at: number, siteKey: string, answers: Record<string, import("../lib/check-in.mjs").Answer> } | null}
 */
let lastCheckIn = null;
/**
 * The oldest app each SageFin lets sync by itself, by site, as its last check-in answer said. Kept
 * for as long as the app runs: unlike an answer about whose turn it is, it does not go stale.
 * @type {Map<string, string>}
 */
const minimumVersions = new Map();
/**
 * What the member chose for when each retailer syncs by itself, by site and retailer, as SageFin
 * last said. Kept past the answer it came with: a choice does not lapse because SageFin has been
 * out of reach for a quarter of an hour, though a "no" does.
 * @type {Map<string, import("../lib/sync-plan.mjs").ChosenSchedule | null>}
 */
const chosenSchedules = new Map();
/** The check-in under way, if one is. @type {Promise<void> | null} */
let checkingIn = null;
/** Something changed while one was under way, so another follows it. */
let checkInAgain = false;
let checkInEveryMs = CHECK_IN_EVERY_MS;
/**
 * Private mode on this computer (main/private-mode.mjs): unlocking its own window, and Sync and
 * lock when the member says so, with the key in the computer's security chip.
 * @type {ReturnType<typeof startPrivateMode> | null}
 */
let privateMode = null;

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
    accountNames = createAccountNames({ dir: path.join(dir, "..", "account-names"), ...sealing });
    owners = createOwners({ dir: path.join(dir, "..", "sync"), ...sealing });
  }

  ipcMain.handle("desktop:status", (event) => (fromHome(event) ? status() : null));
  ipcMain.handle("desktop:open", (event, code) => {
    if (!fromHome(event) || typeof code !== "string") return false;
    const retailer = retailerByCode(code);
    if (!retailer) return false;
    openRetailer(retailer);
    return true;
  });
  // Setting up a retailer's history, and the two ways of setting it up again.
  ipcMain.handle("desktop:set-up-history", (event, code) => fromHome(event) && typeof code === "string" && setUpHistory(code));
  ipcMain.handle("desktop:change-how-far-back", (event, code, from) =>
    fromHome(event) && typeof code === "string" ? changeHowFarBack(code, from) : null,
  );
  ipcMain.handle("desktop:start-over", (event, code) => fromHome(event) && typeof code === "string" && startHistoryOver(code));
  // The strip above a retailer's page: what it says, and its Done button.
  ipcMain.handle("strip:state", (event) => {
    const code = stripOwner(event);
    return code ? stripState(code) : null;
  });
  ipcMain.handle("strip:done", (event) => {
    const code = stripOwner(event);
    return code ? finishSetup(code) : false;
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
  // Whose memory this site's is, before anything reads it: on the first start after an update, what
  // was kept before households were is weighed here (lib/owner.mjs).
  settleOwner();
  // A development run otherwise shows Electron's own icon in the Dock. A packaged app takes its
  // icon from the bundle.
  if (process.platform === "darwin") app.dock?.setIcon(nativeImage.createFromPath(DOCK_ICON));

  preferences = createPreferences({ dir: path.join(dir, "..") });
  // Before the tray: its menu asks whether this copy can update itself, and is built once here.
  updates = startUpdates({
    macRequirement: await readMacRequirement(),
    syncing: () => syncing.size,
    onChanged: refreshUpdateMenus,
    beforeRestart: () => {
      quitting = true;
    },
  });
  tray = openTray();
  applyLoginItem();

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
    updateMenuItems,
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
        // Not while the member is setting the history up in its window.
        if (settingUp.has(code)) return false;
        const visible = showWindowForMemberSync(syncStates.get(site.key, household(), retailer.code));
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
        consents.set(person(), retailer, which, answer);
        changed();
        return true;
      },
      // The member asked, from the Retail sync page, to set up this retailer's history.
      setUpHistory: (code) => setUpHistory(code),
      // The two other ways of setting it up again, from the same page, as the retailers window has
      // them. The page sends a retailer's code and a date; both are checked here.
      changeHowFarBack: (code, from) => changeHowFarBack(code, from),
      startOver: (code) => startHistoryOver(code),
      // Where the household's bank history starts, as the signed-in page read it: a date, or that
      // the household is locked and SageFin cannot say. Only the strip uses it.
      bankHistory(value) {
        const given = /** @type {any} */ (value);
        if (!given || typeof given !== "object") return false;
        const start = typeof given.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(given.start) ? given.start : null;
        bankHistories.set(site.key, { start, locked: given.locked === true });
        refreshStrips();
        return true;
      },
      // What the member calls the account they are signed in to here, where the retailer's pages
      // do not say. Nothing given takes the name away.
      accountName(code, name) {
        const retailer = retailerByCode(code);
        if (!retailer?.memberNamesAccount || !accountNames) return false;
        if (name !== null && typeof name !== "string") return false;
        accountNames.set(site.key, retailer.code, name);
        changed();
        // SageFin hears now, so the next page saved is filed under the right account.
        void checkInNow();
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
        // A credential for another household, or another person, starts them with nothing of the
        // last one's (lib/owner.mjs).
        settleOwner();
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
    // What the page may ask of private mode, which starts just below, once its window exists.
    privateMode: {
      holdsKeyFor: (householdId) => privateMode?.pageAsksWhetherItHoldsKey(householdId) ?? false,
      canHoldKey: () => privateMode?.canHoldKey() ?? false,
      unlockHere: async (/** @type {unknown} */ householdId) => (await privateMode?.pageAsksToUnlockHere(householdId)) ?? "not-now",
      showUnlock: async () => (await privateMode?.pageAsksToUnlock()) ?? false,
      startAdding: async () => (await privateMode?.pageAsksToAdd()) ?? false,
      pageLoaded: () => privateMode?.pageLoaded(),
    },
    onSite(next) {
      site = next;
      uploadNotice = null;
      lastSent.clear();
      settleOwner();
      changed();
      void upload();
    },
  });

  // A private household's own window, unlocked here with Touch ID once this computer holds a key.
  // Offered from the menu, and when the window is shown on a page that offers no way in itself.
  privateMode = startPrivateMode({ site: () => site, window: () => main?.window ?? null, showWindow: () => main?.show(), dir: path.join(dir, "..", "private-mode") });
  main.window.on("show", () => void privateMode?.onWindowShown());
  main.window.webContents.once("did-finish-load", () => {
    if (main?.window.isVisible()) void privateMode?.onWindowShown();
  });
  main.refreshMenu();

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
  // Unlocking with this computer, or adding it: only where it can hold a key.
  const unlocking = privateMode?.menuItems() ?? [];
  return unlocking.length ? [...items, { type: "separator" }, ...unlocking] : items;
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

/**
 * What the menus say about updates: an update that is downloaded, or the offer to look for one.
 * Never both, and nothing where the app cannot update itself. One list for the Retailers menu and
 * the tray, as with the background choices: a desktop with no tray has only the first.
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function updateMenuItems() {
  // A downloaded update: offered because the app may otherwise run for weeks without quitting.
  const update = updateMenuItem({ version: updates?.downloaded() ?? null, syncing: syncing.size });
  if (update) return [{ label: update.label, enabled: update.enabled, click: () => void updates?.restart() }];
  const check = checkMenuItem({
    canUpdate: updates?.canUpdate ?? false,
    version: updates?.downloaded() ?? null,
    checking: updates?.checking() ?? false,
  });
  return check ? [{ label: check.label, enabled: check.enabled, click: () => void updates?.checkNow() }] : [];
}

/** Rebuilds both menus that carry the update lines, so neither keeps saying what was true before. */
function refreshUpdateMenus() {
  tray?.setContextMenu(trayMenu());
  main?.refreshMenu();
}

function trayMenu() {
  const update = updateMenuItems();
  return Menu.buildFromTemplate([
    // Which version is running: the one place to read it when the window is closed.
    { label: versionLabel(RUNNING_VERSION), enabled: false },
    { type: "separator" },
    { label: "Open SageFin", click: () => main?.show() },
    { label: "Retailers on This Computer…", click: () => void openRetailersWindow() },
    ...(update.length ? /** @type {Electron.MenuItemConstructorOptions[]} */ ([{ type: "separator" }, ...update]) : []),
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
    // A double click arrives as a click first, so the one handler answers both.
    if (trayClickOpensWindow(process.platform)) icon.on("click", () => main?.show());
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
 * Whose memory the site being shown has: the household of the credential held, or, with none, of
 * the last one held, so that a computer that has lost its connection keeps the last household's
 * memory for it rather than handing it to whoever connects next (lib/owner.mjs).
 */
const memoryOwner = () => owners?.get(site.key) ?? NO_OWNER;
/** The household this site's sync memory and waiting pages are kept for. */
const household = () => memoryOwner().household;
/** The person whose choices about retailers' terms apply. */
const person = () => memoryOwner().person;

/**
 * Records whose memory the site being shown has, from the credential held now, and carries out
 * what a change means (`takeOwnership`, lib/owner.mjs). A change forgets what this run of the app
 * learnt for the last household: SageFin's answers, what was sent, the last notices.
 */
function settleOwner() {
  if (!owners || !syncStates || !store || !consents) return;
  const settled = takeOwnership({
    siteKey: site.key,
    siteOrigin: site.origin,
    credential: credentials?.get(site.key) ?? null,
    retailers: RETAILERS.map((r) => r.code),
    owners,
    syncStates,
    captures: store,
    consents,
  });
  if (!settled.changed) return;
  letGoNotice = null;
  if (lastCheckIn?.siteKey === site.key) lastCheckIn = null;
  for (const key of [...chosenSchedules.keys()]) if (key.startsWith(`${site.key}:`)) chosenSchedules.delete(key);
  lastSent.clear();
  notices.clear();
  browsed.clear();
  if (settled.discarded > 0) {
    letGoNotice = `${settled.discarded} page${settled.discarded === 1 ? "" : "s"} saved here earlier could not be shown to be this household's, so ${settled.discarded === 1 ? "it was" : "they were"} let go and not sent.`;
  }
  refreshStrips();
}

/**
 * Whether the member has agreed to this at this retailer, where its terms make it theirs to agree
 * to (lib/consent.mjs). The one exception is the development smoke run, which saves one page of
 * a local file and quits.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {import("../lib/consent.mjs").ConsentKind} kind
 */
const mayDo = (retailer, kind) => Boolean(smokeFixture) || allowed(retailer, kind, consents?.get(person(), retailer.code));
/** @param {import("../lib/retailers.mjs").Retailer} retailer */
const maySyncNow = (retailer) => Boolean(smokeFixture) || maySync(retailer, consents?.get(person(), retailer.code));

/**
 * Keeps a page, if the member has agreed to its being kept. Every page the app saves goes through
 * here, whoever opened it: the member, or a sync.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {string} kind
 * @param {string} payload
 * @returns {{ added: boolean, kept: boolean }}  `kept` false: not saved, because the member has not
 *   chosen to, or because it is an order's page with no order on it (`keepsPage`, lib/retailers.mjs).
 */
function keep(retailer, kind, payload) {
  if (!store) return { added: false, kept: false };
  // The retailer's error page, or an order's page it could not fill: nothing to read, so nothing
  // to send. SageFin would only refuse it.
  if (retailer.keepsPage && !retailer.keepsPage(kind, payload)) {
    tell(retailer.code, `${retailer.name} showed no order on this page, so it was not saved.`);
    return { added: false, kept: false };
  }
  if (!mayDo(retailer, "saving")) {
    tell(retailer.code, `Not saved. Choose whether to save ${retailer.name}'s pages in Settings → Retail sync.`);
    return { added: false, kept: false };
  }
  if (logKeys) {
    const paths = keyPaths(payload, logKeys);
    console.log(`keys: ${retailer.code} ${kind}, ${paths.length} matching`);
    for (const line of paths) console.log(`keys:   ${line}`);
  }
  // A sync's pages are filed under the household it reads for; the member's own browsing, under the
  // household whose memory the site has now. Never under one whose memory has been let go.
  const owner = (syncing.has(retailer.code) ? runOwners.get(retailer.code) : undefined) ?? household();
  if (owner !== household() && !canComeBack(owner)) return { added: false, kept: false };
  const { added } = store.add({ site: site.origin, owner, retailer: retailer.code, kind, payload });
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
    // Not while the member is setting its history up.
    if (settingUp.has(retailer.code)) continue;
    // Too old to share the daily sync as SageFin now runs it.
    if (updateRequired()) continue;
    if (scheduledRunDue(syncStates.get(site.key, household(), retailer.code), Date.now(), SCHEDULE_EVERY, chosenSchedule(retailer.code))) {
      void runSync(retailer, { visible: false });
    }
  }
}

/**
 * Whether this copy is older than the SageFin being shown lets sync by itself. Scheduled and
 * requested syncs stop; Sync now, which the member starts and watches, does not.
 */
function updateRequired() {
  return belowMinimum(RUNNING_VERSION, minimumVersions.get(site.key));
}

/** When the member wants a retailer to sync by itself, for the site being shown. @param {string} code */
function chosenSchedule(code) {
  return chosenSchedules.get(`${site.key}:${code}`) ?? null;
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
  // What is reported is the memory of the household this credential is for, and nobody else's.
  const owner = ownerOf(credential).household;

  const result = await checkIn({
    site: asked.origin,
    secret: credential.secret,
    version: RUNNING_VERSION,
    reports: RETAILERS.filter((r) => r.syncs).map((r) =>
      report(r.code, states.get(asked.key, owner, r.code), maySyncNow(r), r.memberNamesAccount ? (accountNames?.get(asked.key, r.code) ?? null) : null),
    ),
    fetch,
  });
  checkInEveryMs = result.againInMs;
  if (result.status !== "answered") return;
  // A private household's lock, and whether its bank has new activity: a reason to ask, counted here.
  if (asked.key === site.key) privateMode?.onCheckIn(result.privateMode ?? null);
  // The strip says it cannot show where the bank history starts while the household is locked.
  lockedSites.set(asked.key, result.privateMode?.locked === true);
  refreshStrips();

  lastCheckIn = { at: Date.now(), siteKey: asked.key, answers: result.answers };
  if (result.minimumVersion) minimumVersions.set(asked.key, result.minimumVersion);
  for (const [code, answer] of Object.entries(result.answers)) chosenSchedules.set(`${asked.key}:${code}`, answer.schedule ?? null);
  for (const retailer of RETAILERS) {
    // Only the retailers this app syncs, whatever the answer names. And not one that is syncing:
    // the run holds its own copy of this memory and writes it back.
    const answer = result.answers[retailer.code];
    if (!retailer.syncs || !answer || syncing.has(retailer.code)) continue;
    // The member ran Sync now on another computer and it finished: the refusal remembered here
    // is over there too.
    const state = states.get(asked.key, owner, retailer.code);
    if (refusalLifted(state, answer)) states.set(asked.key, owner, retailer.code, { ...state, refusedAt: null });

    // A sync the member asked for from the web. It runs as a scheduled one does, out of the way,
    // and is theirs: they started it, though not from here. Only for the SageFin still on screen.
    if (asked.key === site.key && !updateRequired() && shouldStartRequested(states.get(asked.key, owner, retailer.code), answer, Date.now())) {
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
 * @param {RetailerWindow} win
 * @param {string} url
 * @returns {Promise<boolean>} False when the page did not load.
 */
function load(win, url) {
  return navigate(win, () => void win.webContents.loadURL(url).catch(() => {}));
}

/**
 * Runs a script in the page that moves it to another page, such as submitting the page's own
 * form, and waits for that page as `load` does. False when the script did not move it.
 * @param {RetailerWindow} win
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
 * @param {RetailerWindow} win
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

/** The HTTP status of the page each retailer window last navigated to. @type {WeakMap<RetailerWindow, number>} */
const lastStatus = new WeakMap();

/** Each retailer window's wait for its response reader to start. @type {WeakMap<RetailerWindow, Promise<void>>} */
const listening = new WeakMap();

/**
 * What a sync is waiting for the page to fetch, per window: a capture kind, and who to tell. The
 * answer is the response's text, or the status the retailer refused it with.
 * @typedef {{ payload: string | null, status: number | null }} PageAnswer
 * @type {WeakMap<RetailerWindow, { kind: string, tell: (answer: PageAnswer) => void }>}
 */
const awaited = new WeakMap();

/** @param {RetailerWindow} win @param {string} kind @param {PageAnswer} answer */
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
 * @param {RetailerWindow} win
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

/** The data a retailer's page embeds, or null. @param {RetailerWindow} win @returns {Promise<string | null>} */
/**
 * What a sync reads from the page it has loaded, to know what to open next. Never what is saved,
 * which is read the way the member's own browsing is. A retailer saved from its HTML is read as the
 * page shows it.
 * @param {RetailerWindow} win
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 */
const pageData = (win, retailer) =>
  win.webContents.executeJavaScript(
    retailer.saves === "document"
      ? "document.documentElement.outerHTML"
      : "(() => { const el = document.getElementById('__NEXT_DATA__'); return el ? el.textContent : null; })()",
  );

/**
 * What a page says, for a page with no data of its own to read: its title and the start of its text,
 * which is where a retailer's error page says it is one. Read, never changed, and never saved.
 * @param {RetailerWindow} win
 * @returns {Promise<string | null>}
 */
const pageText = (win) =>
  win.isDestroyed()
    ? Promise.resolve(null)
    : win.webContents
        .executeJavaScript("`${document.title}\n${(document.body?.innerText ?? '').slice(0, 4000)}`")
        .then((text) => (typeof text === "string" ? text : null), () => null);

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
  const { listedOrders, hasNextListPage, listPageUrl, orderIdIn, nextPageScript, nextPageKind, listPagesPerRun } = retailer;
  if (!listedOrders || !hasNextListPage || !listPageUrl || !orderIdIn) return;
  const states = syncStates;
  const siteKey = site.key;
  const siteOrigin = site.origin;
  // The household this run reads for, from start to end: a credential connected for another one
  // while it runs does not move its memory, or the pages it saves, to that one.
  const owner = household();
  const state = states.get(siteKey, owner, retailer.code);
  runOwners.set(retailer.code, owner);

  const progress = (/** @type {string} */ text) => {
    syncing.set(retailer.code, text);
    changed();
  };
  // A sync is a fresh account of what is sent, and the last page's message means nothing to it.
  lastSent.delete(retailer.code);
  notices.delete(retailer.code);
  progress("Opening your orders…");

  // Before anything is opened or said: has SageFin lost what this computer read (a household
  // restored from a backup, or reset)? Then this computer's record goes too, as Start over does,
  // and the run ends without touching the retailer: only the member's setup reaches older orders.
  // A stand-in page is not an order, so a fixture run asks nothing.
  const weighing = retailerFixture && siteKey !== "local" ? null : credentials?.get(siteKey);
  if (weighing) {
    const held = await askHeld({ site: siteOrigin, secret: weighing.secret, retailer: retailer.code, fetch });
    if (sageFinLostReading(state, held, weighing.tokenId)) {
      startOver(state);
      state.readFor = null;
      state.lastRunAt = new Date().toISOString();
      state.lastRunBy = by ?? (visible ? "member" : "schedule");
      state.lastResult = `SageFin no longer has the ${retailer.name} orders this computer read, so this computer has forgotten them too. Set up your ${retailer.name} history again to send them.`;
      state.lastOutcome = "stopped";
      state.lastOrders = null;
      states.set(siteKey, owner, retailer.code, state);
      syncing.delete(retailer.code);
      runOwners.delete(retailer.code);
      browsed.delete(retailer.code);
      changed();
      void checkInNow();
      return;
    }
  }

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
   * Sync now finishes. `paused` is the retailer having trouble: the run stopped asking it, and is
   * tried again by itself a little later (`notePause`, lib/sync-plan.mjs).
   */
  const finish = (
    /** @type {string} */ result,
    { finished = false, needsMember = false, refused = false, signedOut = false, paused = false, orders = /** @type {number | null} */ (null) } = {},
  ) => {
    const now = new Date().toISOString();
    const retryAt = notePause(state, paused ? "paused" : finished ? "finished" : "other", Date.now());
    // Looked for when it is due, not at the next hourly look.
    if (retryAt) setTimeout(() => void runScheduled(), Math.max(0, Date.parse(retryAt) - Date.now()) + 1000);
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
    states.set(siteKey, owner, retailer.code, state);
    syncing.delete(retailer.code);
    runOwners.delete(retailer.code);
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
   * or a refusal status (Walmart's 412 and 418, Amazon's 503). Any of them ends the run. On an order
   * page, a 5xx the retailer does not refuse with is its trouble, not a refusal (`troubleStatus`),
   * and is left for the run to weigh.
   * @param {string | null} [data]  The page's data, when it has been read.
   * @param {{ orderPage?: boolean }} [options]
   * @returns {{ text: string, check: boolean } | null}
   */
  const turnedAway = (data = null, { orderPage = false } = {}) => {
    const url = win.webContents.getURL();
    const status = lastStatus.get(win) ?? 200;
    if (retailer.isChallenge(url, { anyHost: Boolean(retailerFixture) }) || (data && retailer.isChallengePayload?.(data))) {
      // A run never answers a robot check, and does not wait for anybody to: a person answering one
      // so that a run can carry on would be answering it for the run, which Amazon's terms rule out
      // for an agent and no retailer's check is there for. So the run stops at once and says so,
      // and its window is not brought forward to ask.
      return { text: `${retailer.name} showed its robot check, so the sync stopped. It will not run again by itself.`, check: true };
    }
    if (orderPage && troubleStatus(retailer, status)) return null;
    if (status >= 400) return { text: `${retailer.name} turned the sync away (${status}). It will not run again by itself.`, check: false };
    return null;
  };
  /** Ends a run the retailer turned away. @param {{ text: string, check: boolean }} why */
  const stopTurnedAway = (why) => finish(why.text, { needsMember: !why.check, refused: true });

  try {
    const firstUrl = listPageUrl(1);
    if (!(await load(win, retailerFixture ? onFixture(firstUrl, retailerFixture) : firstUrl))) {
      return finish(`${retailer.name} could not be reached.`);
    }
    if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
    let list = await pageData(win, retailer);
    const stop = turnedAway(list);
    if (stop) return stopTurnedAway(stop);

    const listKind = retailer.captureKind(firstUrl) ?? "";
    if (!list || retailer.isSignedOut(listKind, list)) {
      return finish(`Sign in to ${retailer.name} in its window, then sync again.`, { needsMember: true, signedOut: true });
    }

    // List until caught up (lib/history.mjs), putting what is new or changed on the to-do list. A
    // page after the first is reached as a person reaches it, and is saved by the same code that
    // saves what a person opens.
    /** @type {import("../lib/retailers.mjs").ListedOrder[]} */
    let listed = [];
    // What this computer has read is told to SageFin once a run, with the first question.
    let toldSageFin = false;
    /**
     * Asks SageFin which of these orders another of the member's computers has read, and
     * remembers those as read here (lib/read-orders.mjs). With no answer, nothing changes.
     * @param {{ id: string, fingerprint: string }[]} orders
     */
    const learnWhatWasRead = async (orders) => {
      // A stand-in page is not an order.
      if (retailerFixture && siteKey !== "local") return;
      const credential = credentials?.get(siteKey);
      if (!credential) return;
      const asking = ordersToAskAbout(orders, state.seen);
      if (asking.length === 0 && toldSageFin) return;
      const known = await shareRead({
        site: siteOrigin,
        secret: credential.secret,
        retailer: retailer.code,
        asked: asking.map((o) => orderKey(retailer.code, o.id, o.fingerprint)),
        read: toldSageFin ? [] : readKeys(retailer.code, state.seen),
        fetch,
        // SageFin holds this computer's reading under this credential: what the next run weighs.
        onHeld: (held) => {
          if (held.here > 0 && state.readFor !== credential.tokenId) {
            state.readFor = credential.tokenId;
            states.set(siteKey, owner, retailer.code, state);
          }
        },
      });
      if (known) toldSageFin = true;
      if (adoptRead(retailer.code, orders, state.seen, known) > 0) {
        dropRead(state);
        states.set(siteKey, owner, retailer.code, state);
      }
    };
    const maxPages = listPagesPerRun ?? MAX_LIST_PAGES_PER_RUN;
    let reachedKnown = false;
    let caughtUp = false;
    for (let pagesRead = 1; ; pagesRead += 1) {
      // Each order fingerprinted from every row of it the run has seen, not only this page's.
      const gathered = gatherListed(listed, listedOrders(list));
      listed = gathered.listed;
      const pageOrders = gathered.page;
      const already = new Set(listed.map((o) => o.id));
      const fresh = pageOrders.filter((o) => !already.has(o.id));
      listed.push(...fresh);
      await learnWhatWasRead(pageOrders);
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");

      // Caught up? Asked of what was known before this page, so the page's own orders and charges
      // do not count as known.
      const charges = retailer.listedCharges?.(list) ?? [];
      if (retailer.caughtUpWhen === "first_read_charge") {
        caughtUp = reachedReadCharge(charges, state.charges);
      } else {
        const settled = settledListing({ pageOrders, state, reachedKnown, now: new Date() });
        reachedKnown = settled.reachedKnown;
        caughtUp = settled.settled;
      }
      enqueue(state, pageOrders);
      noteCharges(state, charges);
      states.set(siteKey, owner, retailer.code, state);

      // The retailer showed the same page again: nothing new and nothing more of what was. Not an
      // end, only a reason to stop asking.
      if (pagesRead > 1 && fresh.length === 0 && gathered.grew === 0) break;
      if (caughtUp || !hasNextListPage(list) || pagesRead >= maxPages) break;

      progress(`Reading your orders, page ${pagesRead + 1}…`);
      await pause(pauseBetweenOrders);
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");

      // A list with no address for its next page is moved on by the page's own Next control,
      // pressed as a person presses it (or, at Amazon, scrolled to its end as a person scrolls):
      // the request the page itself makes, under the run's user agent. Where the page fetches the
      // next orders by itself, they are read from the answer to that request.
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
        if (stoppedOnPress) return stopTurnedAway(stoppedOnPress);
        // Nothing to press, or nothing came back: the list ends here for this run.
        if (!answer.payload) break;
        list = answer.payload;
        continue;
      }

      const url = nextPageScript ? null : listPageUrl(pagesRead + 1);
      const loadedPage = nextPageScript
        ? await follow(win, nextPageScript)
        : await load(win, retailerFixture ? onFixture(/** @type {string} */ (url), retailerFixture) : /** @type {string} */ (url));
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
      const next = loadedPage ? await pageData(win, retailer) : null;
      const stoppedOnList = turnedAway(next);
      if (stoppedOnList) return stopTurnedAway(stoppedOnList);

      // The next page could not be reached: nothing to press, or pressing loaded no page. That is
      // not a sign-in and not a refusal, so the run keeps what it has listed and opens those.
      // (On 2026-10-03 a real Amazon run ended here with "Sign in to Amazon", having listed 19
      // orders and opened none.)
      if (!next) break;
      if (retailer.isSignedOut(listKind, next)) {
        return finish(`Sign in to ${retailer.name} in its window, then sync again.`, { needsMember: true, signedOut: true });
      }
      list = next;
    }

    // The next twenty on the to-do list, newest first, whichever run or setup put them there. Asked
    // about first: another computer may have read some since they were listed.
    await learnWhatWasRead(nextToOpen(state.queue, MAX_ORDERS_PER_RUN));
    if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
    const todo = nextToOpen(state.queue, MAX_ORDERS_PER_RUN);
    if (logPages) {
      // Counts only: never an order number, a date or a fingerprint.
      console.log(`sync: listed ${listed.length} orders${caughtUp ? ", caught up" : ""}; ${state.queue.length} to read; opening ${todo.length}`);
    }
    let read = 0;
    let troubled = 0;
    /** @type {import("../lib/sync-plan.mjs").OrderPageStreak} */
    const streak = { missed: 0, trouble: 0 };
    for (const [index, order] of todo.entries()) {
      // Built now, from what the list said of the order, by the code that builds the list's own
      // addresses: never an address the to-do list kept (lib/history.mjs). None means what is kept
      // does not say where its page is, and it waits for the list to show it again.
      const url = retailer.orderUrl?.(order) ?? null;
      if (!url) {
        awaitRelist(state, order);
        states.set(siteKey, owner, retailer.code, state);
        continue;
      }
      progress(`Reading order ${index + 1} of ${todo.length}…`);
      await pause(pauseBetweenOrders);
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");

      const loaded = await load(win, retailerFixture ? onFixture(url, retailerFixture) : url);
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
      const data = loaded ? await pageData(win, retailer) : null;
      const stopped = turnedAway(data, { orderPage: true });
      if (stopped) return stopTurnedAway(stopped);

      // What the page was (lib/sync-plan.mjs). The order's page: the page was saved by the same code
      // that saves it when the member opens it, and this only takes it off the to-do list, read in
      // the state the list showed. Not the order's page, or one with no order on it: the order stays
      // on the to-do list with a miss against it, which the next run opens after the others and sets
      // aside after MAX_MISSES runs (lib/history.mjs), so it cannot end every run before the orders
      // behind it are reached; two in a row is the retailer saying no, or addresses it cannot fill.
      // The retailer's error page, or its 5xx: it is having trouble, no miss is counted, and two in
      // a row pause the run, to be tried again by itself a little later. The order stays on the
      // to-do list with this run's trouble against it, and is set aside after MAX_TROUBLES runs.
      const verdict = loaded
        ? orderPageVerdict(retailer, {
            url: win.webContents.getURL(),
            status: lastStatus.get(win) ?? 200,
            payload: data ?? (await pageText(win)),
            orderId: order.id,
            anyHost: Boolean(retailerFixture),
          })
        : "missed";
      if (win.isDestroyed()) return finish("The window was closed before the sync finished.");
      const stopsOn = noteOrderPage(state, order, verdict, streak);
      states.set(siteKey, owner, retailer.code, state);
      if (verdict === "read") read += 1;
      if (verdict === "trouble") troubled += 1;
      if (stopsOn === "trouble") {
        const retries = Boolean(state.lastFinishedAt) && (state.troubledRuns ?? 0) < TROUBLE_RETRY_AFTER_MS.length;
        return finish(
          `${retailer.name} is having technical issues, so the sync has paused. ` +
            (retries ? "SageFin will try again later." : "Press Sync now to try again later.") +
            ` ${stillToOpen(state.queue).length} still to read.`,
          { paused: true, orders: read },
        );
      }
      if (stopsOn === "missed") {
        return finish(
          `${retailer.name} showed ${streak.missed} order pages in a row with no order on them, so the sync has stopped for now. Those orders are still to read.`,
          { needsMember: true },
        );
      }
    }

    // What this run read, told now rather than at the next run's first question, so another
    // computer that syncs before then does not read it again. Not waited for: it is never the
    // reason a sync is slow to finish, and the next run says it all again.
    const credential = read > 0 && !(retailerFixture && siteKey !== "local") ? credentials?.get(siteKey) : null;
    if (credential) {
      void shareRead({ site: siteOrigin, secret: credential.secret, retailer: retailer.code, asked: [], read: readKeys(retailer.code, state.seen), fetch });
    }

    const left = stillToOpen(state.queue).length;
    const aside = setAsideCount(state.queue);
    const waiting = waitingCount(state.queue);
    finish(
      (todo.length === 0
        ? "Nothing new to read."
        : `Read ${read} order${read === 1 ? "" : "s"}${read < todo.length ? ` of ${todo.length}` : ""}.`) +
        (left > 0 ? ` ${left} still to read.` : "") +
        (troubled > 0 ? ` ${troubled} could not be read while ${retailer.name} was having technical issues, and ${troubled === 1 ? "is" : "are"} read next time.` : "") +
        (aside > 0 ? ` ${aside} set aside: ${retailer.name} showed no order on ${aside === 1 ? "its page" : "their pages"}.` : "") +
        (waiting > 0 ? ` ${waiting} waiting for the list to show ${waiting === 1 ? "it" : "them"} again: set up history again past ${waiting === 1 ? "it" : "them"}.` : ""),
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
    // Only the pages saved for the household this credential is for: SageFin files what it is sent
    // under the credential's household, whoever's the page was.
    const summary = await uploadPending({ store, site: sendingTo.origin, owner: ownerOf(credential).household, secret: credential.secret, fetch });
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
  // Nor one saved for another household: it is not waiting to be sent to this one.
  const owner = household();
  const records = (store ? store.list() : []).filter((c) => c.site === site.origin && c.owner === owner);
  return {
    canSave: Boolean(store),
    connected: Boolean(credentials?.get(site.key)),
    // Which of the member's connected computers this one is. The credential's id, never its secret:
    // SageFin lists the id in Settings, and the page needs it to mark this computer in that list.
    tokenId: credentials?.get(site.key)?.tokenId ?? null,
    sending: uploading,
    uploadNotice: uploadNotice ?? letGoNotice,
    retailers: RETAILERS.map((r) => {
      const mine = records.filter((c) => c.retailer === r.code);
      return {
        code: r.code,
        name: r.name,
        open: windows.has(r.code),
        captures: mine.length,
        lastCapturedAt: mine.at(-1)?.capturedAt ?? null,
        // With nothing of its own to say: why the daily sync is not running on this computer.
        notice: notices.get(r.code) ?? (updateRequired() ? UPDATE_SENTENCE : waitingSentence(sagefinAnswer(r.code), r.name)),
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
  const choices = consents?.get(person(), retailer.code);
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
  const state = syncStates?.get(site.key, household(), code);
  return {
    syncable: Boolean(retailerByCode(code)?.syncs),
    // Whether this retailer's account is one the member names, and the name they gave it here.
    namesAccount: Boolean(retailerByCode(code)?.memberNamesAccount),
    accountName: retailerByCode(code)?.memberNamesAccount ? (accountNames?.get(site.key, code) ?? null) : null,
    syncing: syncing.has(code),
    syncProgress: syncing.get(code) ?? null,
    // The member's setup of the history, and the to-do list it left: counts and dates, nothing
    // more. `toRead` is how many orders' own pages a run will still open; `setAside`, how many it
    // will not, because their pages showed no order on MAX_MISSES runs (lib/history.mjs); `waiting`,
    // how many it will not until the list shows them again.
    history: state
      ? {
          setup: state.setup.status,
          settingUp: settingUp.has(code),
          reachedDate: state.setup.reachedDate,
          // How far back it reads now: a date only, for the date box to start at.
          readsBackTo: readsBackTo(state.setup),
          orders: state.setup.listedIds.length,
          toRead: stillToOpen(state.queue).length,
          setAside: setAsideCount(state.queue),
          // How many no run opens until the list shows them again: kept by an older version without
          // what their address depends on (`relist`, lib/history.mjs).
          waiting: waitingCount(state.queue),
        }
      : null,
    lastSyncAt: state?.lastRunAt ?? null,
    lastSyncBy: state?.lastRunBy ?? null,
    lastSync: state?.lastResult ?? null,
    nextSyncAt: state && scheduleAllowed(code) && scheduleAllowedBy(sagefinAnswer(code)) && !updateRequired() ? nextScheduledRunAt(state, SCHEDULE_EVERY, chosenSchedule(code)) : null,
    // A scheduled run only ever follows one the member started and saw finish, and never one the
    // retailer turned away. Saying "daily" then would promise a run that will not happen.
    // Nor is it promised while the member's choice is missing or withdrawn.
    // Nor while another of the member's computers has it, or a retailer turned one of them away.
    scheduled:
      Boolean(state?.lastFinishedAt) && !(state && scheduleStopped(state)) && scheduleAllowed(code) && scheduleAllowedBy(sagefinAnswer(code)) && !updateRequired(),
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

/**
 * What a list page the member's own browsing loaded adds to the to-do list, and, while they set up
 * the history, to the setup. Not during a run, which reads the same pages itself and holds its own
 * copy of this memory.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {string} kind
 * @param {string} payload
 */
function noteListed(retailer, kind, payload) {
  if (!syncStates || !retailer.listedOrders || syncing.has(retailer.code) || !LIST_KINDS.includes(kind)) return;
  const orders = retailer.listedOrders(payload);
  const charges = retailer.listedCharges?.(payload) ?? [];
  if (orders.length === 0 && charges.length === 0) return;
  const gathered = gatherListed(browsed.get(retailer.code) ?? [], orders);
  const known = new Set(gathered.listed.map((o) => o.id));
  browsed.set(retailer.code, [...gathered.listed, ...gathered.page.filter((o) => !known.has(o.id))]);

  const state = syncStates.get(site.key, household(), retailer.code);
  // The member's own browsing past an order set aside, while setting up, gives it another chance.
  const { alreadyRead } = enqueue(state, gathered.page, { retry: settingUp.has(retailer.code) });
  noteCharges(state, charges);
  if (settingUp.has(retailer.code)) noteSetup(state.setup, gathered.page, alreadyRead, charges.map((c) => c.date));
  syncStates.set(site.key, household(), retailer.code, state);
  refreshStrips();
  changed();
}

/**
 * Opens a retailer's history page for the member to scroll back through, with the strip above it.
 * Carries on from where an earlier setup got to. Not during a run, and not before the member has
 * chosen to let the app save the retailer's pages, where that is their choice.
 * @param {string} code
 */
function setUpHistory(code) {
  const retailer = retailerByCode(code);
  if (!retailer?.syncs || !retailer.listPageUrl || !syncStates || syncing.has(code)) return false;
  if (!mayDo(retailer, "saving")) {
    tell(code, `Choose whether to save ${retailer.name}'s pages in Settings → Retail sync, then set up its history.`);
    return false;
  }
  const state = syncStates.get(site.key, household(), code);
  if (state.setup.status !== "started") {
    state.setup = { ...state.setup, status: "started", startedAt: new Date().toISOString(), doneAt: null };
    syncStates.set(site.key, household(), code, state);
  }
  settingUp.add(code);
  const win = openRetailer(retailer, { navigate: false });
  win.showStrip(true);
  const first = retailer.listPageUrl(1);
  void load(win, retailerFixture ? onFixture(first, retailerFixture) : first);
  changed();
  return true;
}

/**
 * Done, from the strip: the setup is finished and its window closes. What it saw stays on the
 * to-do list for the runs that follow.
 * @param {string} code
 */
function finishSetup(code) {
  if (!syncStates || !settingUp.has(code)) return false;
  const state = syncStates.get(site.key, household(), code);
  state.setup = { ...state.setup, status: "done", doneAt: new Date().toISOString() };
  syncStates.set(site.key, household(), code, state);
  settingUp.delete(code);
  const win = windows.get(code);
  if (win && !win.isDestroyed()) win.close();
  changed();
  return true;
}

/**
 * "Change how far back": the to-do list's orders older than `from` are dropped and never opened.
 * @param {string} code
 * @param {unknown} given  YYYY-MM-DD, from the retailers window or the web page: checked here.
 * @returns {number | null}  How many were dropped, or null when it could not be done now.
 */
function changeHowFarBack(code, given) {
  const retailer = retailerByCode(code);
  const from = howFarBackDate(given);
  if (!retailer?.syncs || !syncStates || syncing.has(code) || !from) return null;
  const state = syncStates.get(site.key, household(), code);
  const dropped = dropOlderThan(state, from);
  syncStates.set(site.key, household(), code, state);
  tell(code, dropped === 0 ? "Nothing on the to-do list was older than that." : `${dropped} older order${dropped === 1 ? "" : "s"} taken off the to-do list.`);
  return dropped;
}

/**
 * "Start over": forgets the to-do list and everything read here, then opens setup. What SageFin
 * already holds stays there; it is removed only from SageFin.
 * @param {string} code
 */
function startHistoryOver(code) {
  const retailer = retailerByCode(code);
  if (!retailer?.syncs || !syncStates || syncing.has(code)) return false;
  const state = syncStates.get(site.key, household(), code);
  startOver(state);
  syncStates.set(site.key, household(), code, state);
  browsed.delete(code);
  return setUpHistory(code);
}

/** Which retailer's strip a call came from, or null. @param {Electron.IpcMainInvokeEvent} event */
function stripOwner(event) {
  for (const [code, win] of windows) {
    if (!win.isDestroyed() && event.sender === win.strip.webContents && event.senderFrame?.url === STRIP) return code;
  }
  return null;
}

/** What a retailer's strip shows now. @param {string} code */
function stripState(code) {
  const retailer = retailerByCode(code);
  if (!retailer || !syncStates || !settingUp.has(code)) return null;
  const given = bankHistories.get(site.key) ?? null;
  // A date SageFin's page gave is shown; with none, a locked household is said to be locked.
  const bank = given?.start ? given : lockedSites.get(site.key) ? { start: null, locked: true } : given;
  return stripText({ name: retailer.name, setup: syncStates.get(site.key, household(), code).setup, bank, checking: checking.has(code) });
}

/** Tells each open strip to ask again. */
function refreshStrips() {
  for (const [code, win] of windows) {
    if (!win.isDestroyed() && settingUp.has(code) && !win.strip.webContents.isDestroyed()) win.strip.webContents.send("strip:changed");
  }
}

/** Both windows that list the retailers ask again when something here changes. */
function changed() {
  home?.webContents.send("desktop:changed");
  main?.changed();
  // The update line says whether a sync is in the way, so it follows syncs too.
  if (updates?.downloaded()) refreshUpdateMenus();
}

/**
 * Opens a retailer's window, or brings the one already open forward.
 * @param {import("../lib/retailers.mjs").Retailer} retailer
 * @param {{ show?: boolean, navigate?: boolean }} [options]
 *   `show: false` for a scheduled sync, which keeps its window out of the way. `navigate: false`
 *   when the caller is about to load a page itself.
 * @returns {RetailerWindow}
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

  const win = /** @type {RetailerWindow} */ (new BaseWindow({ width: 1280, height: 900, title: retailer.name, show, autoHideMenuBar: true }));
  // The retailer's page. A window out of sight still has to load its pages at full speed.
  const page = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  // The strip: the app's own page, from its own files, with a bridge of two calls (main/strip-preload.cjs).
  const strip = new WebContentsView({
    webPreferences: { preload: path.join(here, "strip-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  strip.webContents.on("will-navigate", (event) => event.preventDefault());
  strip.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(page);
  win.contentView.addChildView(strip);
  let stripShown = false;
  const layout = () => {
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    const top = stripShown ? STRIP_HEIGHT : 0;
    strip.setBounds({ x: 0, y: 0, width, height: top });
    page.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  };
  for (const event of /** @type {const} */ (["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"])) {
    win.on(/** @type {any} */ (event), layout);
  }
  Object.assign(win, {
    webContents: page.webContents,
    strip,
    showStrip(/** @type {boolean} */ on) {
      if (on && !stripShown && strip.webContents.getURL() !== STRIP) void strip.webContents.loadURL(STRIP).catch(() => {});
      stripShown = on;
      layout();
    },
  });
  layout();
  windows.set(retailer.code, win);
  // A window with nothing loaded has no page for the response reader to attach to, and its start
  // waits for one. A blank page gives it one before the retailer's first page is asked for.
  void win.webContents.loadURL("about:blank").catch(() => {});
  tell(retailer.code, null);

  // The retailer's own links stay in this window; nothing else opens from it.
  const startHost = new URL(retailer.startUrl).hostname.replace(/^www\./, "");
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const host = new URL(url).hostname;
      if (host === startHost || host.endsWith(`.${startHost}`)) void win.webContents.loadURL(url);
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
  // A window of views takes no title from its page: the title is only ever the address above.
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
    browsed.delete(retailer.code);
    checking.delete(retailer.code);
    // Closing the window during setup keeps what it saw and how far it got; the setup is still
    // started, and setting up again carries on from there.
    settingUp.delete(retailer.code);
    // A window of views does not close its pages by itself.
    if (!page.webContents.isDestroyed()) page.webContents.close();
    if (!strip.webContents.isDestroyed()) strip.webContents.close();
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
 * @param {RetailerWindow} win
 * @returns {() => boolean}
 */
function readResponses(retailer, win) {
  const dbg = win.webContents.debugger;
  let attached = false;
  /** Requests whose bodies are wanted once they finish, and whether each is a page's HTML. @type {Map<string, { kind: string, html: boolean }>} */
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
      const anyHost = Boolean(retailerFixture);
      // A retailer whose data is its HTML: the page as it was sent, before any script ran on it,
      // and the page's own data requests the retailer names (Amazon's get-transactions).
      const isDocument = params.type === "Document";
      const kind =
        retailer.saves === "document"
          ? isDocument
            ? retailer.captureKind(params.response.url, { anyHost })
            : params.type === "XHR" || params.type === "Fetch" ? retailer.responseKind(params.response.url, { anyHost }) : null
          : retailer.responseKind(params.response.url, { anyHost });
      if (logPages && params.type === "Document") {
        const r = params.response;
        console.log(
          `page: ${pathOf(r.url)} status=${r.status} kind=${kind ?? "-"} serviceWorker=${Boolean(r.fromServiceWorker)} cache=${Boolean(r.fromDiskCache)} prefetch=${Boolean(r.fromPrefetchCache)}`,
        );
      }
      // Only an answer. A refusal's body is not an order, and is the retailer's to show.
      if (kind && params.response.status === 200) wanted.set(params.requestId, { kind, html: retailer.saves === "document" && isDocument });
      // A sync waiting on this request is told the retailer refused it, so it stops there.
      else if (kind && params.response.status >= 400) answerAwaited(win, kind, { payload: null, status: params.response.status });
      return;
    }
    if (method !== "Network.loadingFinished") return;
    const want = wanted.get(params.requestId);
    if (!want) return;
    wanted.delete(params.requestId);
    const { kind } = want;

    void dbg
      .sendCommand("Network.getResponseBody", { requestId: params.requestId })
      .then(({ body, base64Encoded }) => {
        if (!store || win.isDestroyed()) return;
        const raw = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
        if (logPages) console.log(`page: read ${kind}, ${raw.length} chars`);
        const payload = want.html ? stripHtml(raw) : raw;
        // A sync that pressed the page's Next control reads the next orders from this.
        answerAwaited(win, kind, { payload: payload || null, status: null });
        if (!payload) return;
        if (retailer.isChallengePayload?.(payload)) {
          checking.add(retailer.code);
          refreshStrips();
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
        noteListed(retailer, kind, payload);
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
 * @param {RetailerWindow} win
 */
async function readPage(retailer, win) {
  const url = win.webContents.getURL();

  if (retailer.isChallenge(url, { anyHost: Boolean(retailerFixture) })) {
    win.setTitle(`${retailer.name} is checking this browser`);
    tell(retailer.code, `${retailer.name} is checking this browser. Complete its check in the window, then stop for today.`);
    checking.add(retailer.code);
    refreshStrips();
    return;
  }
  if (checking.delete(retailer.code)) refreshStrips();

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
  noteListed(retailer, kind, payload);
  win.setTitle(windowTitle(retailer, win.webContents.getURL()));
  tell(retailer.code, added ? "Saved this page." : "This page was already saved.");

  if (smokeFixture) {
    console.log(`smoke: saved ${kind}, ${store.list().length} capture(s)`);
    app.quit();
  }
}
