// @ts-check
// Back and Forward in the main window: which gesture or key means which, decided without Electron.
// main/shell.mjs carries the decisions out against webContents.navigationHistory.

/** @typedef {"back" | "forward"} Direction */

/**
 * The keyboard shortcut for each direction. macOS uses the browser-and-Finder pair; Windows and
 * Linux use Alt with the arrows, as browsers do.
 * @param {string} platform  process.platform
 * @returns {Record<Direction, string>}
 */
export function accelerators(platform) {
  return platform === "darwin"
    ? { back: "Cmd+[", forward: "Cmd+]" }
    : { back: "Alt+Left", forward: "Alt+Right" };
}

/**
 * What an 'app-command' event asks for: the mouse's back and forward buttons on Windows, and the
 * same keys on a keyboard that has them. Anything else (volume, play, print) is not ours.
 * @param {unknown} command
 * @returns {Direction | null}
 */
export function fromAppCommand(command) {
  if (command === "browser-backward") return "back";
  if (command === "browser-forward") return "forward";
  return null;
}

/**
 * What a macOS trackpad 'swipe' event asks for. A swipe to the left goes back and to the right goes
 * forward, which is the direction Electron reports it in; up and down are not navigation.
 * @param {unknown} direction
 * @returns {Direction | null}
 */
export function fromSwipe(direction) {
  if (direction === "left") return "back";
  if (direction === "right") return "forward";
  return null;
}

/**
 * Whether a direction has anywhere to go, from the window's navigation history.
 * @param {{ canGoBack: () => boolean, canGoForward: () => boolean } | null | undefined} history
 * @param {Direction} direction
 */
export function canGo(history, direction) {
  if (!history) return false;
  return direction === "back" ? history.canGoBack() : history.canGoForward();
}
