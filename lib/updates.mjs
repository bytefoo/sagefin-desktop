// @ts-check
// Updating the app: where it can update itself, when it looks, and when it may restart.
//
// The update comes from this repository's latest published release on GitHub. Looking for one is a
// request the app makes by itself, to github.com and nowhere else, and it says nothing about the
// member: it fetches a small public file naming the newest version. The readme says so, because
// "no request of its own" is otherwise this app's rule.

/**
 * Whether this copy of the app can replace itself.
 *
 * - Not a development run: there is no installed app to replace.
 * - Windows: yes. The installer runs silently when the app quits.
 * - Linux: only as an AppImage, which the system says by setting APPIMAGE. A copy unpacked or
 *   repackaged some other way has no single file to swap.
 * - macOS: not yet. The system refuses to update an app that is not signed with a Developer ID,
 *   and these builds are not. Asking would only fail on every check.
 *
 * @param {{ platform: string, packaged: boolean, appImage: boolean }} state
 */
export function canSelfUpdate({ platform, packaged, appImage }) {
  if (!packaged) return false;
  if (platform === "win32") return true;
  if (platform === "linux") return appImage;
  return false;
}

/** A first look, once the app has settled, and then once an hour while it keeps running. */
export const FIRST_CHECK_AFTER_MS = 30_000;
export const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Whether the app may restart into a downloaded update now.
 *
 * Never during a sync: a run cut off mid-order has to start over, and a retailer sees a session
 * that stops and starts for no reason. The update waits; it is installed when the app next quits
 * in any case.
 * @param {{ downloaded: boolean, syncing: number }} state
 */
export function mayRestartToUpdate({ downloaded, syncing }) {
  return downloaded && syncing === 0;
}

/**
 * The tray menu's line for an update, or null when there is nothing to say.
 * @param {{ version: string | null, syncing: number }} state  `version` is the downloaded update's.
 * @returns {{ label: string, enabled: boolean } | null}
 */
export function updateMenuItem({ version, syncing }) {
  if (!version) return null;
  return mayRestartToUpdate({ downloaded: true, syncing })
    ? { label: `Restart to Update to ${version}`, enabled: true }
    : { label: `Update ${version} installs after the sync`, enabled: false };
}

/**
 * The tray menu's line for looking now, or null where it has no place: a copy that cannot update
 * itself, or one with an update already downloaded, which has nothing newer to learn until it
 * restarts. The app looks by itself only once an hour, so this is how a member who knows a
 * version is out gets it without waiting or quitting.
 * @param {{ canUpdate: boolean, version: string | null, checking: boolean }} state  `version` is the downloaded update's.
 * @returns {{ label: string, enabled: boolean } | null}
 */
export function checkMenuItem({ canUpdate, version, checking }) {
  if (!canUpdate || version) return null;
  return checking ? { label: "Checking for Updates…", enabled: false } : { label: "Check for Updates", enabled: true };
}

/**
 * What to tell a member who asked for a check. A check the app made by itself says nothing unless
 * it downloads something; one the member asked for always gets an answer.
 * @param {{ outcome: "current" | "found" | "failed", running: string, found?: string }} state
 * @returns {{ title: string, body: string }}
 */
export function checkAnswer({ outcome, running, found }) {
  if (outcome === "found") {
    return { title: `SageFin Desktop ${found} is downloading`, body: "You will be told when it is ready to install." };
  }
  if (outcome === "failed") {
    return { title: "Could not check for updates", body: "GitHub could not be reached. The app will look again by itself." };
  }
  return { title: "SageFin Desktop is up to date", body: `${running} is the newest version.` };
}
