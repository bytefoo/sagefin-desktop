// @ts-check
// Which orders a sync opens, and what it remembers between runs.
//
// A sync loads the orders list, then opens the page of each order it has not already read in its
// present state. What it has read is remembered as an order number and a fingerprint, so a daily
// run opens only what is new or has changed — the same economy the server connector's
// `known_orders` buys, kept on the member's computer.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** How many order pages one run opens at most. A first run meets a full list; this bounds it. */
export const MAX_ORDERS_PER_RUN = 20;

/** Between one order page and the next. The server connector waits 2 s; this is slower. */
export const PAUSE_BETWEEN_ORDERS_MS = 5_000;

/** How many pages of the orders list one run reads at most, the first included. */
export const MAX_LIST_PAGES_PER_RUN = 10;

/**
 * How far back a sync reads. An order older than the bank transactions SageFin holds has nothing
 * to match, and a Plaid connection starts with about three months of them.
 */
export const HISTORY_DAYS = 90;

/** A run starts by itself this long after the last one that finished. */
export const SCHEDULE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a finished run the next scheduled one is due, for this run of the app.
 *
 * A day, always, in an app that was installed. A run from source may shorten it with a number of
 * minutes, so that a scheduled sync can be watched happening without waiting a day for it. Never
 * under a minute, and anything that is not a number is a day: a typo must not make the app sync
 * a retailer in a loop.
 * @param {string | undefined} minutes  The development setting, as text.
 * @param {boolean} packaged            `app.isPackaged`.
 */
export function scheduleEveryMs(minutes, packaged) {
  if (packaged || minutes === undefined) return SCHEDULE_EVERY_MS;
  const n = Number(minutes);
  return Number.isFinite(n) && n >= 1 ? Math.round(n * 60 * 1000) : SCHEDULE_EVERY_MS;
}

/**
 * The listed orders worth opening: those never read, and those whose fingerprint has changed.
 * In the list's own order, which is newest first, and no more than `limit`.
 *
 * @param {import("./retailers.mjs").ListedOrder[]} listed
 * @param {Record<string, string>} seen  Order number to the fingerprint it had when last read.
 * @param {number} [limit]
 */
export function ordersToOpen(listed, seen, limit = MAX_ORDERS_PER_RUN) {
  return listed.filter((order) => seen[order.id] !== order.fingerprint).slice(0, limit);
}

/**
 * What one page of the orders list adds to a run, and whether to read the page after it.
 *
 * The list is newest first, five to a page. A run reads pages until one of these:
 *
 * - The retailer says there is no next page, or a page reaches past HISTORY_DAYS. Either way the
 *   history worth reading has all been listed, and `end` says so.
 * - A page lists nothing this run has not already seen: the retailer showed the same page again,
 *   which is not an end, only a reason to stop asking.
 * - Enough orders are waiting to fill MAX_ORDERS_PER_RUN, or MAX_LIST_PAGES_PER_RUN pages have been
 *   read. The next run carries on from the page this one stopped at (SyncState.listedThroughPage),
 *   so a long history is caught up over several days rather than re-listed from the top each time.
 * - The history has been read to its end before (`caughtUp`) and this page has nothing to open.
 *   The pages after it were read then, so a daily run reads one page, or more only on a day with
 *   more than a page of new orders.
 *
 * The last costs something, and on purpose: once caught up, a change to an order past the first
 * page with nothing new on it — a late refund — is not seen by a scheduled run. Paging through
 * three months of orders every day to look for one would be ten page loads a day to find nothing.
 *
 * @param {object} options
 * @param {import("./retailers.mjs").ListedOrder[]} options.pageOrders  This page's orders.
 * @param {import("./retailers.mjs").ListedOrder[]} options.listed      Orders earlier pages listed this run.
 * @param {Record<string, string>} options.seen
 * @param {boolean} options.caughtUp   A run has listed the history to its end before.
 * @param {boolean} options.hasNextPage
 * @param {number} options.pagesRead   Pages this run has read, this one included.
 * @param {Date} options.now
 * @returns {{ fresh: import("./retailers.mjs").ListedOrder[], more: boolean, end: boolean }}
 *   `fresh`: this page's orders to add to the run's list. `more`: read the next page. `end`: the
 *   history worth reading has been listed to its end.
 */
export function readListPage({ pageOrders, listed, seen, caughtUp, hasNextPage, pagesRead, now }) {
  const known = new Set(listed.map((o) => o.id));
  const unseen = pageOrders.filter((o) => !known.has(o.id));
  if (pagesRead > 1 && unseen.length === 0) return { fresh: [], more: false, end: false };

  const horizon = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // An undated order is kept: leaving out an order is worse than reading one too old to match.
  const fresh = unseen.filter((o) => o.date === null || o.date >= horizon);
  const pastHorizon = fresh.length < unseen.length;

  const end = pastHorizon || !hasNextPage;
  const full = ordersToOpen([...listed, ...fresh], seen).length >= MAX_ORDERS_PER_RUN;
  const nothingNew = caughtUp && ordersToOpen(fresh, seen).length === 0;
  const more = !end && !full && !nothingNew && pagesRead < MAX_LIST_PAGES_PER_RUN;
  return { fresh, more, end };
}

/**
 * Whether a scheduled run is due.
 *
 * Only after a run the member started has finished at least once, and never after the retailer turned
 * a run away. A schedule that began on its own
 * would open a retailer's pages for somebody who has never asked for that, and would do it signed out.
 *
 * @param {SyncState} state
 * @param {number} now  Milliseconds since the epoch.
 * @param {number} [every]  How long after a finished run the next is due (`scheduleEveryMs`).
 */
export function scheduledRunDue(state, now, every = SCHEDULE_EVERY_MS) {
  if (!state.lastFinishedAt) return false;
  // Turned away, a retailer is not asked again by a schedule. Only the member, with Sync now, tries
  // once more; a run of theirs that finishes clears it.
  if (state.refusedAt) return false;
  const last = Date.parse(state.lastFinishedAt);
  return Number.isFinite(last) && now - last >= every;
}

/**
 * When the next scheduled run falls due, or null when none will start: no sync the member started
 * has finished, or the retailer turned the last one away. The app looks hourly, so a run starts up to
 * an hour after this; a time already past means "at the next look".
 * @param {SyncState} state
 * @param {number} [every]  How long after a finished run the next is due (`scheduleEveryMs`).
 * @returns {string | null}  An ISO time.
 */
export function nextScheduledRunAt(state, every = SCHEDULE_EVERY_MS) {
  if (!state.lastFinishedAt || state.refusedAt) return null;
  const last = Date.parse(state.lastFinishedAt);
  return Number.isFinite(last) ? new Date(last + every).toISOString() : null;
}

/**
 * Whether a sync the member starts here should show the retailer's window while it runs.
 *
 * It does whenever a person may be needed: the first sync of a retailer on this computer, where
 * they will have to sign in, and any sync after a run that did not reach its end, where the
 * retailer said something they should see (a sign-in page, a check, a refusal, an error). After a
 * run that finished, the next one works out of the way, as the daily sync does: the card says what
 * it is doing, and the window still appears by itself if the retailer asks for a person.
 * @param {SyncState} state
 */
export function showWindowForMemberSync(state) {
  if (state.refusedAt) return true;
  if (state.lastOutcome) return state.lastOutcome !== "finished";
  // A memory from before outcomes were kept: the last run finished if its end is the last finish.
  return !(state.lastFinishedAt && state.lastFinishedAt === state.lastRunAt);
}

/**
 * @typedef {object} SyncState
 * @property {Record<string, string>} seen
 * @property {string | null} lastFinishedAt  When a run last reached the end of its list.
 * @property {string | null} lastResult      What the last run came to, in a sentence.
 * @property {string | null} lastRunAt       When a run last ended, however it ended.
 * @property {"finished" | "refused" | "signed_out" | "stopped" | null} lastOutcome
 *   Which of four ways that run ended: what `lastResult` says in a sentence, as something SageFin
 *   can be told (lib/check-in.mjs). Null for a memory from before this was kept.
 * @property {number | null} lastOrders
 *   How many orders that run opened, when it finished. Null when it did not finish or nobody
 *   counted, which is not zero.
 * @property {"member" | "schedule" | null} lastRunBy
 *   Who started that run: the member, with Sync now, or the daily schedule. Null for a memory from
 *   before this was kept, which is neither: nobody recorded it, and nothing should guess.
 * @property {boolean} caughtUp  A run has listed the orders to the end of the history worth reading.
 * @property {string | null} refusedAt
 *   When the retailer last turned a run away: its robot check, a refusal status, a sign-in it asked
 *   for. Set, no scheduled run starts.
 * @property {number | null} listedThroughPage
 *   Until caught up: the list page the last finished run stopped at, where the next one resumes
 *   after reading page 1. Recorded only by a run that opened everything it listed, so an order a
 *   stopped run never reached is never skipped. Pages only grow older as new orders arrive, so
 *   resuming at the same number re-reads a few orders rather than missing any.
 */

/** The ways a run ends, as SageFin is told them. */
const OUTCOMES = ["finished", "refused", "signed_out", "stopped"];

/** @returns {SyncState} */
const empty = () => ({
  seen: {},
  lastFinishedAt: null,
  lastResult: null,
  lastRunAt: null,
  lastRunBy: null,
  lastOutcome: null,
  lastOrders: null,
  caughtUp: false,
  listedThroughPage: null,
  refusedAt: null,
});

/**
 * A sync's memory, sealed like everything else the app keeps: it holds the member's order numbers.
 * One file per site and retailer, so what was read for the test site is not taken as read for
 * production.
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {(plaintext: string) => Uint8Array} options.seal
 * @param {(sealed: Uint8Array) => string} options.open
 */
export function createSyncStates({ dir, seal, open }) {
  mkdirSync(dir, { recursive: true });

  /** @param {string} siteKey @param {string} retailer */
  const file = (siteKey, retailer) => {
    if (!/^[a-z]+$/.test(siteKey) || !/^[a-z0-9-]+$/.test(retailer)) throw new Error("Not a sync state key.");
    return path.join(dir, `sync-${siteKey}-${retailer}.bin`);
  };

  return {
    /**
     * @param {string} siteKey
     * @param {string} retailer
     * @returns {SyncState}
     */
    get(siteKey, retailer) {
      // Outside the try: a bad key is a mistake in the caller, not a memory that cannot be read.
      const source = file(siteKey, retailer);
      try {
        const raw = JSON.parse(open(readFileSync(source)));
        const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : null);
        /** @type {Record<string, string>} */
        const seen = {};
        if (raw.seen && typeof raw.seen === "object") {
          for (const [id, fingerprint] of Object.entries(raw.seen)) {
            if (typeof fingerprint === "string") seen[id] = fingerprint;
          }
        }
        return {
          seen,
          lastFinishedAt: str(raw.lastFinishedAt),
          lastResult: str(raw.lastResult),
          lastRunAt: str(raw.lastRunAt),
          lastRunBy: raw.lastRunBy === "member" || raw.lastRunBy === "schedule" ? raw.lastRunBy : null,
          lastOutcome: OUTCOMES.includes(raw.lastOutcome) ? raw.lastOutcome : null,
          lastOrders: Number.isInteger(raw.lastOrders) && raw.lastOrders >= 0 ? raw.lastOrders : null,
          // Only a stored true counts. A memory from before paging has none, and its run read one page.
          caughtUp: raw.caughtUp === true,
          listedThroughPage: Number.isInteger(raw.listedThroughPage) && raw.listedThroughPage > 1 ? raw.listedThroughPage : null,
          refusedAt: str(raw.refusedAt),
        };
      } catch {
        // Missing or unreadable is "nothing remembered": the next run reads everything again,
        // which costs page loads and loses nothing.
        return empty();
      }
    },

    /** @param {string} siteKey @param {string} retailer @param {SyncState} state */
    set(siteKey, retailer, state) {
      const target = file(siteKey, retailer);
      writeFileSync(`${target}.partial`, seal(JSON.stringify(state)), { mode: 0o600 });
      renameSync(`${target}.partial`, target);
    },
  };
}
