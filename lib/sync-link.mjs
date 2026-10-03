// @ts-check
// The link a web page can use to open the app and ask for a sync:
//
//     sagefin-desktop://sync?retailer=walmart
//
// SageFin's Retail sync page uses it in an ordinary browser, where the page cannot reach the app
// any other way. But a link is a thing any page on the web can send, and the operating system hands
// it over without saying who did. So a link is never proof that the member asked. Everything here
// follows from that: what a link may carry, and what the app will do because of one.

export const LINK_SCHEME = "sagefin-desktop";

/**
 * What a link asks for: a sync of one retailer, or nothing more than the app.
 *
 * It carries a retailer's code and nothing else. No address, no token, no account: there is no
 * part of a link that could point the app anywhere or hand it anything. Whatever else a link
 * holds is ignored, and anything that is not one of ours is not read at all.
 *
 * @param {string} url
 * @param {readonly string[]} syncable  The codes of the retailers the app can sync.
 * @returns {{ retailer: string | null } | null}
 *   Null: not our link. `retailer: null`: ours, asking for nothing the app will do, so it only
 *   brings the app forward.
 */
export function readSyncLink(url, syncable) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${LINK_SCHEME}:`) return null;
  // `sagefin-desktop://sync?…`: the action is where a web address has its host.
  if (u.hostname !== "sync" || (u.pathname !== "" && u.pathname !== "/")) return { retailer: null };
  const code = u.searchParams.get("retailer") ?? "";
  return { retailer: syncable.includes(code) ? code : null };
}

/** The first of our links among a launch's arguments, which is how Windows and Linux deliver one. */
export function linkAmong(/** @type {readonly string[]} */ argv) {
  return argv.find((a) => a.startsWith(`${LINK_SCHEME}:`)) ?? null;
}

/** How long after one link-started sync of a retailer another link may start the next. */
export const LINK_SYNC_EVERY_MS = 15 * 60 * 1000;

/**
 * Whether a link may start a sync, or only bring the app forward.
 *
 * - **Only a retailer the member has synced here themselves.** Their own Sync now, finished at
 *   least once, in this copy of the app. A page on the web must not be able to make the app open
 *   a retailer the member never asked it to: for that retailer the link shows the app and stops.
 * - **Not while one is running**, and **not again within a quarter of an hour.** The member's own
 *   Sync now inside the app has no such wait; a link has one because a page could send it in a loop.
 * - **Not after the retailer turned a run away.** Starting again then is the member's decision,
 *   made in the app where the result is in front of them, not a link's.
 *
 * @param {object} state
 * @param {string | null} state.retailer        From `readSyncLink`.
 * @param {string | null} state.lastFinishedAt  When a member-started sync of it last finished here.
 * @param {string | null} state.refusedAt       When the retailer last turned a run away, if it has since the last finished one.
 * @param {boolean} state.syncing
 * @param {number | null} state.lastLinkSyncAt  When a link last started a sync of it, in milliseconds.
 * @param {number} state.now
 * @returns {"sync" | "show"}
 */
export function linkAction({ retailer, lastFinishedAt, refusedAt, syncing, lastLinkSyncAt, now }) {
  if (!retailer || !lastFinishedAt || refusedAt || syncing) return "show";
  if (lastLinkSyncAt !== null && now - lastLinkSyncAt < LINK_SYNC_EVERY_MS) return "show";
  return "sync";
}
