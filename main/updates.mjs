// @ts-check
// Carries out lib/updates.mjs: looks for a newer release, downloads it, and installs it when the
// app quits or when the member chooses Restart to Update.

import { app, Notification } from "electron";
import electronUpdater from "electron-updater";
import { execFile } from "node:child_process";
import path from "node:path";
import { CHECK_EVERY_MS, FIRST_CHECK_AFTER_MS, canSelfUpdate, checkAnswer, mayRestartToUpdate } from "../lib/updates.mjs";

// electron-updater is CommonJS; its named exports are not visible to an ES import.
const { autoUpdater } = electronUpdater;

/**
 * What `codesign -d -r-` says the running app's designated requirement is: the rule Squirrel.Mac
 * holds every update to (lib/updates.mjs). Read from this copy's own signature, on this Mac, with
 * the system's own tool; nothing leaves the computer. Null on any other system, in a development
 * run, or when it cannot be read, which leaves the updater off.
 * @returns {Promise<string | null>}
 */
export function readMacRequirement() {
  if (process.platform !== "darwin" || !app.isPackaged) return Promise.resolve(null);
  // …/SageFin Desktop.app/Contents/MacOS/SageFin Desktop
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  return new Promise((resolve) => {
    execFile("/usr/bin/codesign", ["-d", "-r-", bundle], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`update: could not read this app's signature: ${error.message}`);
        resolve(null);
      } else resolve(`${stdout}\n${stderr}`);
    });
  });
}

/**
 * @param {object} options
 * @param {() => number} options.syncing  How many syncs are running now.
 * @param {() => void} options.onChanged  Called when what the menus say about updates has changed, so they are rebuilt.
 * @param {() => void} options.beforeRestart  Called just before the app restarts to install.
 * @param {string | null} options.macRequirement  On macOS, the running app's designated requirement
 *   (`readMacRequirement`); null elsewhere.
 * @returns {{ canUpdate: boolean, downloaded: () => string | null, checking: () => boolean, checkNow: () => Promise<void>, restart: () => boolean }}
 */
export function startUpdates({ syncing, onChanged, beforeRestart, macRequirement }) {
  /** The version that is downloaded and waiting, or null. @type {string | null} */
  let downloaded = null;

  /** Whether a check the member asked for is out. */
  let checking = false;

  const idle = { canUpdate: false, downloaded: () => null, checking: () => false, checkNow: async () => {}, restart: () => false };
  if (
    !canSelfUpdate({ platform: process.platform, packaged: app.isPackaged, appImage: Boolean(process.env.APPIMAGE), macRequirement })
  ) {
    return idle;
  }

  autoUpdater.autoDownload = true;
  // The ordinary way an update lands: the next time the app quits, for any reason.
  autoUpdater.autoInstallOnAppQuit = true;

  // A failed check is not the member's problem and not worth a dialog: no connection, GitHub
  // unreachable, a release still uploading. The next check tries again.
  autoUpdater.on("error", (error) => console.error(`update: ${error?.message ?? error}`));

  autoUpdater.on("update-downloaded", (info) => {
    downloaded = info.version;
    onChanged();
    if (!Notification.isSupported()) return;
    const where = process.platform === "darwin" ? "the menu bar icon" : "the tray icon";
    new Notification({
      title: `SageFin Desktop ${info.version} is ready`,
      body: `It installs the next time the app quits. To update now, choose Restart to Update from ${where}.`,
    }).show();
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, FIRST_CHECK_AFTER_MS);
  setInterval(check, CHECK_EVERY_MS);

  /** @param {Parameters<typeof checkAnswer>[0]} state */
  const answer = (state) => {
    if (Notification.isSupported()) new Notification(checkAnswer(state)).show();
  };

  return {
    canUpdate: true,
    downloaded: () => downloaded,
    checking: () => checking,
    /** The same look the timer takes, asked for by the member, and answered whatever it finds. */
    async checkNow() {
      if (checking) return;
      checking = true;
      onChanged();
      const running = app.getVersion();
      try {
        const result = await autoUpdater.checkForUpdates();
        if (result?.isUpdateAvailable) answer({ outcome: "found", running, found: result.updateInfo.version });
        else answer({ outcome: "current", running });
      } catch {
        answer({ outcome: "failed", running });
      } finally {
        checking = false;
        onChanged();
      }
    },
    restart() {
      if (!mayRestartToUpdate({ downloaded: downloaded !== null, syncing: syncing() })) return false;
      // Closing the window normally only hides it; this close has to be a real one.
      beforeRestart();
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}
