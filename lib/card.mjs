// @ts-check
// A retailer's row in the retailers window, said in one line: where things stand, and the one thing
// to do when there is one. Everything else the row knows (pages saved, the last run's result, how
// far back the history goes) is under its Details. SageFin's Settings → Retail sync builds its own
// row the same way, from the same status (`lib/desktop-app.ts` there).
//
// Pure: no Electron, so `node --test` runs it.

import { longDate } from "./history.mjs";

/**
 * What the row needs of a retailer's status (`syncStatus` in main/main.mjs).
 * @typedef {object} CardInput
 * @property {boolean} syncable
 * @property {boolean} syncing
 * @property {string | null} syncProgress
 * @property {number} captures
 * @property {string | null} lastSync
 * @property {string | null} lastSyncAt
 * @property {"finished" | "refused" | "signed_out" | "stopped" | null} lastOutcome
 * @property {null | {
 *   setup: "never" | "started" | "done",
 *   settingUp: boolean,
 *   reachedDate: string | null,
 *   goal: string | null,
 *   toRead: number,
 *   outdated: boolean,
 * }} history
 */

/**
 * The one thing the row offers, when one is needed:
 * - `set-up`: Set up history, for a history never set up here.
 * - `carry-on`: Carry on setting up, for one begun and not finished.
 * - `set-up-again`: Set up history again, for one an older version listed (`setupOutdated`).
 * @typedef {"set-up" | "carry-on" | "set-up-again" | null} CardAction
 */

/** "Aug 12, 2026" as the row writes a day. @param {string} day */
const shortDate = (day) => longDate(day).replace(/^(\w{3})\w*/, "$1");

/**
 * How long ago, in words: "just now", "5 min ago", "3 hours ago", "2 days ago".
 * @param {string} iso
 * @param {Date} now
 * @returns {string | null}  Null for a time that cannot be read.
 */
export function ago(iso, now) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The row's line and its one action.
 *
 * "Up to date" only after a run that finished with nothing left to read: a run that met a robot
 * check or a sign-in says so instead, in its own words. Setting up says how far back it has got of
 * how far it is going.
 * @param {CardInput} retailer
 * @param {Date} [now]
 * @returns {{ line: string, action: CardAction }}
 */
export function cardSummary(retailer, now = new Date()) {
  if (retailer.syncing) return { line: retailer.syncProgress ?? "Syncing…", action: null };
  const h = retailer.history;
  if (!retailer.syncable || !h) {
    return { line: retailer.captures > 0 ? `${retailer.captures} page${retailer.captures === 1 ? "" : "s"} saved` : "Nothing saved yet", action: null };
  }

  const reached = h.reachedDate ? (h.goal ? `reached ${shortDate(h.reachedDate)} of ${shortDate(h.goal)}` : `back to ${shortDate(h.reachedDate)}`) : null;
  if (h.settingUp) return { line: `Setting up in its window${reached ? `: ${reached}` : ""}`, action: null };
  if (h.setup === "never") return { line: "History not set up yet", action: "set-up" };
  if (h.setup === "started") return { line: `History partly set up${reached ? `: ${reached}` : ""}`, action: "carry-on" };
  if (h.outdated) return { line: "History needs setting up again, to send orders an older version missed", action: "set-up-again" };

  if (!retailer.lastSync) return { line: "History set up · not synced yet", action: null };
  const when = retailer.lastSyncAt ? ago(retailer.lastSyncAt, now) : null;
  const synced = when ? `last synced ${when}` : "synced";
  // A memory from before outcomes were kept says nothing about how it ended: its own words, then.
  if (retailer.lastOutcome !== "finished") return { line: `Last sync${when ? ` ${when}` : ""}: ${retailer.lastSync}`, action: null };
  if (h.toRead > 0) return { line: `Catching up: ${h.toRead} order${h.toRead === 1 ? "" : "s"} still to read · ${synced}`, action: null };
  return { line: `Up to date · ${synced}`, action: null };
}
