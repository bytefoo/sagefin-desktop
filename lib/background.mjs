// @ts-check
// Running in the background: what happens when the main window is closed, whether the app
// starts with the computer, and whether it starts without a window.
//
// A scheduled sync only runs while the app is running (lib/sync-plan.mjs), so an app that quits
// with its window syncs only on the days somebody happens to leave it open. These are the member's
// two choices about that, kept in a plain file: neither is a secret.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} Preferences
 * @property {boolean} keepRunning  Closing the main window hides it and leaves the app running.
 * @property {boolean} openAtLogin  The app starts when the member signs in to the computer.
 * @property {boolean} toldAboutBackground  The member has been told, once, that closing the window
 *   left the app running. Not a choice: it only stops the same notice appearing on every close.
 */

/**
 * Keeping running is on, because it is what makes a daily sync daily, and the first close says so.
 * Starting with the computer is off: an app that adds itself to login without being asked is the
 * thing people uninstall.
 * @type {Readonly<Preferences>}
 */
export const DEFAULT_PREFERENCES = Object.freeze({ keepRunning: true, openAtLogin: false, toldAboutBackground: false });

/**
 * Preferences as read from disk: each key taken only if it is a boolean, else its default. A file
 * that is missing, unreadable or written by a newer version yields the defaults, never a throw.
 * @param {unknown} value
 * @returns {Preferences}
 */
export function asPreferences(value) {
  const v = value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
  /** @param {keyof Preferences} key */
  const pick = (key) => (typeof v[key] === "boolean" ? /** @type {boolean} */ (v[key]) : DEFAULT_PREFERENCES[key]);
  return { keepRunning: pick("keepRunning"), openAtLogin: pick("openAtLogin"), toldAboutBackground: pick("toldAboutBackground") };
}

/** @param {{ dir: string }} options */
export function createPreferences({ dir }) {
  const file = path.join(dir, "preferences.json");
  /** @type {Preferences} */
  let current;
  try {
    current = asPreferences(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    current = { ...DEFAULT_PREFERENCES };
  }

  return {
    get: () => ({ ...current }),
    /** @param {Partial<Preferences>} changes */
    set(changes) {
      current = asPreferences({ ...current, ...changes });
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.partial`, JSON.stringify(current));
      renameSync(`${file}.partial`, file);
      return { ...current };
    },
  };
}

/**
 * What closing the main window does.
 *
 * `hide` only when the member can get the window back: on macOS the Dock icon does that, and
 * elsewhere it takes the tray icon, which not every Linux desktop has. Hiding a window nothing can
 * show again would leave the app running where nobody can see or quit it.
 * @param {{ quitting: boolean, keepRunning: boolean, platform: string, hasTray: boolean }} state
 * @returns {"hide" | "close"}
 */
export function closeAction({ quitting, keepRunning, platform, hasTray }) {
  if (quitting || !keepRunning) return "close";
  return platform === "darwin" || hasTray ? "hide" : "close";
}

/**
 * Whether the app can be set to start with the computer. Only a packaged app: a development run
 * would register Electron itself, which starts as an empty window. Linux has no login-item API in
 * Electron; there it is the package's job (an autostart entry), not the app's.
 * @param {{ platform: string, packaged: boolean }} state
 */
export function canOpenAtLogin({ platform, packaged }) {
  return packaged && (platform === "darwin" || platform === "win32");
}

/** The argument a login start carries on Windows, where nothing else says how the app was started. */
export const HIDDEN_ARG = "--hidden";

/**
 * Whether to start without showing the main window: when the computer started the app, not the
 * member. And only where the window can be brought back (see `closeAction`).
 * @param {{ openedAtLogin: boolean, argv: readonly string[], platform: string, hasTray: boolean }} state
 */
export function startsHidden({ openedAtLogin, argv, platform, hasTray }) {
  if (!(openedAtLogin || argv.includes(HIDDEN_ARG))) return false;
  return platform === "darwin" || hasTray;
}

/**
 * Whether clicking the tray icon itself opens the window. On Windows and Linux the menu is the
 * right click, so without this the left click, and the double click people try first, do nothing.
 * On macOS a click on the menu bar icon already opens the menu, and opening a window as well
 * would be two answers to one click.
 * @param {string} platform
 */
export function trayClickOpensWindow(platform) {
  return platform !== "darwin";
}
