// @ts-check
// Carries out lib/updates.mjs: looks for a newer release, downloads it, and installs it when the
// app quits or when the member chooses Restart to Update.

import { app, Notification } from "electron";
import electronUpdater from "electron-updater";
import { CHECK_EVERY_MS, FIRST_CHECK_AFTER_MS, canSelfUpdate, mayRestartToUpdate } from "../lib/updates.mjs";

// electron-updater is CommonJS; its named exports are not visible to an ES import.
const { autoUpdater } = electronUpdater;

/**
 * @param {object} options
 * @param {() => number} options.syncing  How many syncs are running now.
 * @param {() => void} options.onChanged  Called when an update has been downloaded, so menus are rebuilt.
 * @param {() => void} options.beforeRestart  Called just before the app restarts to install.
 * @returns {{ downloaded: () => string | null, restart: () => boolean }}
 */
export function startUpdates({ syncing, onChanged, beforeRestart }) {
  /** The version that is downloaded and waiting, or null. @type {string | null} */
  let downloaded = null;

  const idle = { downloaded: () => null, restart: () => false };
  if (!canSelfUpdate({ platform: process.platform, packaged: app.isPackaged, appImage: Boolean(process.env.APPIMAGE) })) {
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

  return {
    downloaded: () => downloaded,
    restart() {
      if (!mayRestartToUpdate({ downloaded: downloaded !== null, syncing: syncing() })) return false;
      // Closing the window normally only hides it; this close has to be a real one.
      beforeRestart();
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}
