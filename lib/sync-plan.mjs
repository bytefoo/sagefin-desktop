// @ts-check
// Which orders a sync opens, and what it remembers between runs.
//
// A sync lists a retailer's orders until it is caught up, then opens the next orders on its to-do
// list (lib/history.mjs). What it has read is remembered as an order number and a fingerprint, so
// an order is opened again only when it has changed.

import { markRead, noteMissed, readCharges, readQueue, readSetup, emptySetup, stillToOpen } from "./history.mjs";
import { retailerByCode } from "./retailers.mjs";
import { isHouseholdKey } from "./owner.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** How many order pages one run opens at most. A first run meets a full list; this bounds it. */
export const MAX_ORDERS_PER_RUN = 20;

/** Between one order page and the next. The server connector waits 2 s; this is slower. */
export const PAUSE_BETWEEN_ORDERS_MS = 5_000;

/** How many pages of the orders list one run reads at most, the first included. */
export const MAX_LIST_PAGES_PER_RUN = 10;

/** A run starts by itself this long after the last one that finished. */
export const SCHEDULE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * How soon the next run starts after one that stopped at MAX_ORDERS_PER_RUN, which may have left
 * orders unopened. Each run is the same run, at the same pace and under the same cap; only the gap
 * between runs is shorter while a backlog lasts.
 */
export const CATCH_UP_EVERY_MS = 60 * 60 * 1000;

/**
 * Whether the last run stopped at the cap with orders still on the to-do list, so the next should
 * come soon. A run that opened fewer than MAX_ORDERS_PER_RUN opened everything there was, and the
 * schedule goes back to the member's. Only a run that finished: one cut short says nothing about
 * what is left.
 * @param {SyncState} state
 */
export function catchingUp(state) {
  // An order set aside is not left for the next run: no run opens it (lib/history.mjs).
  return state.lastOutcome === "finished" && state.lastOrders === MAX_ORDERS_PER_RUN && stillToOpen(state.queue ?? []).length > 0;
}

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
 * When the member wants a retailer's scheduled sync to run, as SageFin hands it over with the
 * check-in answer (lib/check-in.mjs). One setting per retailer, kept by SageFin and not by each
 * computer, because the daily sync belongs to whichever computer synced last.
 *
 * @typedef {object} ChosenSchedule
 * @property {number | null} preferredHour
 *   The hour, 0 to 23, on this computer's own clock. Null means no preference.
 * @property {number} everyDays  Days between scheduled syncs, one to seven.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * The least time between a sync that finished and the next scheduled one, when a preferred hour
 * is set. Without it, a sync finishing at 6:30 with a preferred hour of 7 would run again half an
 * hour later. Six hours is short enough that "daily at 6" still means the next morning after a Sync
 * now as late as midnight, and long enough that it never means the same morning's. It was half a
 * day until a 10:35 PM Sync now pushed a 6 AM retailer past the next morning entirely.
 */
const SETTLE_MS = 6 * HOUR_MS;

/**
 * When the next scheduled run falls due after one that finished at `lastFinishedMs`, on this
 * computer's clock.
 *
 * With nothing chosen, `every` after the last finish: a day, which is what the app did before
 * there was a choice. With a number of days and no hour, that many days after. With an hour, the
 * first time the clock shows it at least that many days less eighteen hours after the last finish.
 *
 * SageFin's web app applies the same rule to say when the next sync is due
 * (`lib/desktop-schedule.ts` there), and the two are pinned to the same examples in their tests.
 *
 * A development run that shortens `every` is obeyed over any choice: it exists to watch a
 * scheduled sync happen now.
 *
 * While catching up (`catchingUp`), an hour after the last finish, whatever was chosen: the choice
 * is when to look for new orders, and a backlog is orders already waiting.
 * @param {number} lastFinishedMs
 * @param {number} every            `scheduleEveryMs`: a day, unless a run from source shortened it.
 * @param {ChosenSchedule | null} schedule
 * @param {boolean} [catchUp]       The last run stopped at the cap.
 * @returns {number}  Milliseconds since the epoch.
 */
export function scheduledRunAtMs(lastFinishedMs, every = SCHEDULE_EVERY_MS, schedule = null, catchUp = false) {
  if (every !== SCHEDULE_EVERY_MS) return lastFinishedMs + every;
  if (catchUp) return lastFinishedMs + CATCH_UP_EVERY_MS;
  if (!schedule) return lastFinishedMs + every;
  const everyDays = Math.min(7, Math.max(1, Math.round(schedule.everyDays) || 1));
  if (schedule.preferredHour === null) return lastFinishedMs + everyDays * SCHEDULE_EVERY_MS;

  const earliest = lastFinishedMs + (everyDays - 1) * SCHEDULE_EVERY_MS + SETTLE_MS;
  const due = new Date(earliest);
  due.setHours(schedule.preferredHour, 0, 0, 0);
  if (due.getTime() < earliest) due.setDate(due.getDate() + 1);
  return due.getTime();
}

/**
 * How many order pages in a row may be the retailer having trouble (its error page, or a 5xx) before
 * a run stops asking it for more and pauses (`noteOrderPage`).
 */
export const TROUBLE_PAGES_IN_A_ROW = 2;

/**
 * When a run that paused for the retailer's trouble is tried again by itself, after the first, second
 * and third such pause in a row. After that the schedule goes back to the member's: a retailer
 * having trouble all day is not asked every few minutes.
 */
export const TROUBLE_RETRY_AFTER_MS = [20 * 60 * 1000, 60 * 60 * 1000, 3 * 60 * 60 * 1000];

/**
 * Whether a status answering an order page is the retailer having trouble rather than turning the
 * run away: any 5xx it does not use as a refusal (`refusalStatuses`, lib/retailers.mjs). Only an
 * order page: the orders list answered with any refusal status still ends the run as turned away.
 * @param {import("./retailers.mjs").Retailer} retailer
 * @param {number} status
 */
export function troubleStatus(retailer, status) {
  return status >= 500 && status <= 599 && !(retailer.refusalStatuses ?? []).includes(status);
}

/**
 * What an order page a run loaded was, once a robot check and a refusal have been ruled out:
 *
 * - `read`: the order, with its order on it.
 * - `trouble`: the retailer having trouble: its error page, or a 5xx it does not refuse with. Try
 *   later; nothing about the order is learnt.
 * - `missed`: anything else. The order's page did not show it.
 *
 * @param {import("./retailers.mjs").Retailer} retailer
 * @param {object} page
 * @param {string} page.url             Where the window is.
 * @param {number} page.status          The document's status.
 * @param {string | null} page.payload  What the run read from it: its data, or its text where it has none.
 * @param {string} page.orderId         The order the run opened.
 * @param {boolean} [page.anyHost]      A development stand-in.
 * @returns {"read" | "trouble" | "missed"}
 */
export function orderPageVerdict(retailer, { url, status, payload, orderId, anyHost = false }) {
  if (troubleStatus(retailer, status)) return "trouble";
  if (retailer.isErrorPage?.(url, payload, status, { anyHost })) return "trouble";
  if (payload !== null && retailer.orderIdIn?.(payload) === orderId) return "read";
  return "missed";
}

/**
 * @typedef {object} OrderPageStreak
 * @property {number} missed   Order pages in a row with no order on them.
 * @property {number} trouble  Order pages in a row that were the retailer having trouble.
 */

/**
 * Carries out what an order page was, on the run's memory, and says whether the run stops there.
 *
 * Read, the order comes off the to-do list. Missed, it stays and the miss counts against it
 * (`noteMissed`); two in a row is the retailer saying no, or addresses it cannot fill, and the run
 * stops. Trouble, it stays exactly as it was, no miss counted: the page said nothing about the
 * order. TROUBLE_PAGES_IN_A_ROW of those and the run pauses (`notePause`).
 *
 * @param {import("./history.mjs").HistoryState} state  Changed in place.
 * @param {import("./history.mjs").QueuedOrder} order
 * @param {"read" | "trouble" | "missed"} verdict
 * @param {OrderPageStreak} streak  Changed in place.
 * @returns {"missed" | "trouble" | null}  Why the run stops now, or null to go on.
 */
export function noteOrderPage(state, order, verdict, streak) {
  if (verdict === "read") {
    markRead(state, order);
    streak.missed = 0;
    streak.trouble = 0;
    return null;
  }
  if (verdict === "trouble") {
    streak.trouble += 1;
    streak.missed = 0;
    return streak.trouble >= TROUBLE_PAGES_IN_A_ROW ? "trouble" : null;
  }
  noteMissed(state, order);
  streak.missed += 1;
  streak.trouble = 0;
  return streak.missed >= 2 ? "missed" : null;
}

/**
 * Remembers how a run ended, as far as the retailer's trouble goes. A run that paused for it is
 * tried again by itself after TROUBLE_RETRY_AFTER_MS (longer each pause in a row), as long as a sync
 * the member started has finished here before: a schedule never begins by itself. A run that
 * finished starts the count again. Any other end leaves no retry waiting.
 * @param {SyncState} state  Changed in place.
 * @param {"paused" | "finished" | "other"} how
 * @param {number} now  Milliseconds since the epoch.
 * @returns {string | null}  When the retry is due, or null when none will run by itself.
 */
export function notePause(state, how, now) {
  if (how === "finished") state.troubledRuns = 0;
  if (how !== "paused") {
    state.retryAt = null;
    return null;
  }
  state.troubledRuns = (state.troubledRuns ?? 0) + 1;
  const after = TROUBLE_RETRY_AFTER_MS[state.troubledRuns - 1];
  state.retryAt = state.lastFinishedAt && after !== undefined ? new Date(now + after).toISOString() : null;
  return state.retryAt;
}

/** When a retry after the retailer's trouble is due, or NaN. @param {SyncState} state */
const retryAtMs = (state) => (state.retryAt ? Date.parse(state.retryAt) : NaN);

/**
 * Whether the schedule has stopped for this retailer on this computer, until the member acts.
 *
 * Two things stop it. The retailer turned a run away, which also stops the member's other
 * computers (lib/check-in.mjs). Or the last run met the retailer's sign-in page, which is this
 * computer's alone: nothing can be read here until somebody signs in, and a run each hour that
 * loads a sign-in page and leaves is a pattern a retailer could fairly read as a robot's.
 *
 * Either way the next run is the member's own Sync now. One of theirs that finishes clears a
 * refusal, and any run of theirs replaces the outcome that said a sign-in was needed.
 * @param {SyncState} state
 */
export function scheduleStopped(state) {
  return Boolean(state.refusedAt) || state.lastOutcome === "signed_out";
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
 * @param {ChosenSchedule | null} [schedule]  What the member chose, when SageFin has said.
 */
export function scheduledRunDue(state, now, every = SCHEDULE_EVERY_MS, schedule = null) {
  if (!state.lastFinishedAt) return false;
  // Turned away, or asked to sign in, a retailer is not asked again by a schedule. Only the
  // member, with Sync now, tries once more.
  if (scheduleStopped(state)) return false;
  // Paused for the retailer's trouble: tried again soon, rather than at the next daily time.
  if (now >= retryAtMs(state)) return true;
  const last = Date.parse(state.lastFinishedAt);
  return Number.isFinite(last) && now >= scheduledRunAtMs(last, every, schedule, catchingUp(state));
}

/**
 * When the next scheduled run falls due, or null when none will start: no sync the member started
 * has finished, or the retailer turned the last one away. The app looks hourly, so a run starts up to
 * an hour after this; a time already past means "at the next look".
 * @param {SyncState} state
 * @param {number} [every]  How long after a finished run the next is due (`scheduleEveryMs`).
 * @param {ChosenSchedule | null} [schedule]  What the member chose, when SageFin has said.
 * @returns {string | null}  An ISO time.
 */
export function nextScheduledRunAt(state, every = SCHEDULE_EVERY_MS, schedule = null) {
  if (!state.lastFinishedAt || scheduleStopped(state)) return null;
  const last = Date.parse(state.lastFinishedAt);
  if (!Number.isFinite(last)) return null;
  const due = scheduledRunAtMs(last, every, schedule, catchingUp(state));
  const retry = retryAtMs(state);
  return new Date(Number.isFinite(retry) ? Math.min(due, retry) : due).toISOString();
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
 * @property {string | null} refusedAt
 *   When the retailer last turned a run away: its robot check, a refusal status, a sign-in it asked
 *   for. Set, no scheduled run starts.
 * @property {import("./history.mjs").QueuedOrder[]} queue
 *   The to-do list: orders a list has shown whose own page is still to be read (lib/history.mjs).
 * @property {Record<string, string>} charges
 *   Charges a list has shown, by key, with their dates: where an Amazon run is caught up.
 * @property {import("./history.mjs").Setup} setup  How far the member's setup of the history has got.
 * @property {string | null} [retryAt]
 *   When a run that paused because the retailer was having trouble is tried again by itself
 *   (`notePause`). Null when none waits.
 * @property {number} [troubledRuns]
 *   Runs in a row that paused for the retailer's trouble. Zero once one finishes.
 * @property {string | null} readFor
 *   The credential under which SageFin last said it held what this computer has read
 *   (lib/read-orders.mjs). Null when it has never said, or for a memory from before this was kept.
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
  refusedAt: null,
  queue: [],
  charges: {},
  setup: emptySetup(),
  readFor: null,
  retryAt: null,
  troubledRuns: 0,
});

/**
 * A sync's memory, sealed like everything else the app keeps: it holds the member's order numbers.
 * One file per site, household and retailer: what was read for the test site is not taken as read
 * for production, and what was read for one household is not taken as read for another
 * (lib/owner.mjs). A household deleted and made again starts with nothing, as a new one should.
 *
 * Memory from before households were kept has no household in its name (`legacy`), and is either
 * taken on by the household that can be shown to own it or let go (`legacyIsTheirs`).
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {(plaintext: string) => Uint8Array} options.seal
 * @param {(sealed: Uint8Array) => string} options.open
 */
export function createSyncStates({ dir, seal, open }) {
  mkdirSync(dir, { recursive: true });
  /**
   * Households whose memory on a site was let go or given away while the app runs. A run under way
   * for one of them holds its own copy and writes it back when it ends; that write is dropped, so
   * nothing let go comes back as a file no household will ever read.
   * @type {Set<string>}
   */
  const gone = new Set();

  /** @param {string} siteKey @param {string} retailer */
  const checkKey = (siteKey, retailer) => {
    if (!/^[a-z]+$/.test(siteKey) || !/^[a-z0-9-]+$/.test(retailer)) throw new Error("Not a sync state key.");
  };
  /** @param {string} siteKey @param {string} owner @param {string} retailer */
  const file = (siteKey, owner, retailer) => {
    checkKey(siteKey, retailer);
    if (!isHouseholdKey(owner)) throw new Error("Not a sync state key.");
    return path.join(dir, `sync-${siteKey}~${owner}~${retailer}.bin`);
  };
  /** The one file a site and retailer had before households were kept. @param {string} siteKey @param {string} retailer */
  const legacyFile = (siteKey, retailer) => {
    checkKey(siteKey, retailer);
    return path.join(dir, `sync-${siteKey}-${retailer}.bin`);
  };

  /**
   * @param {string} source
   * @param {string} retailer
   * @returns {SyncState | null}  Null when there is nothing there, or nothing that can be read.
   */
  const readFrom = (source, retailer) => {
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
        refusedAt: str(raw.refusedAt),
        // A memory from before the to-do list has none, and no setup: a run lists until caught up
        // and the member is offered setup, which is how such a memory began anyway.
        // Its addresses worked out by the retailer, never read from disk (lib/history.mjs).
        queue: readQueue(raw.queue, retailerByCode(retailer) ?? undefined),
        charges: readCharges(raw.charges),
        setup: readSetup(raw.setup),
        readFor: str(raw.readFor),
        retryAt: str(raw.retryAt),
        troubledRuns: Number.isInteger(raw.troubledRuns) && raw.troubledRuns > 0 ? raw.troubledRuns : 0,
      };
    } catch {
      return null;
    }
  };

  /** @param {string} siteKey @param {string} owner */
  const filesOf = (siteKey, owner) => {
    if (!/^[a-z]+$/.test(siteKey) || !isHouseholdKey(owner)) throw new Error("Not a sync state key.");
    const prefix = `sync-${siteKey}~${owner}~`;
    return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".bin"));
  };

  return {
    /**
     * @param {string} siteKey
     * @param {string} owner     The household this memory is for (lib/owner.mjs).
     * @param {string} retailer
     * @returns {SyncState}
     */
    get(siteKey, owner, retailer) {
      // `file` outside the read: a bad key is a mistake in the caller, not a memory that cannot be
      // read. Missing or unreadable is "nothing remembered": the next run reads everything again,
      // which costs page loads and loses nothing.
      return readFrom(file(siteKey, owner, retailer), retailer) ?? empty();
    },

    /** @param {string} siteKey @param {string} owner @param {string} retailer @param {SyncState} state */
    set(siteKey, owner, retailer, state) {
      const target = file(siteKey, owner, retailer);
      if (gone.has(`${siteKey}~${owner}`)) return;
      writeFileSync(`${target}.partial`, seal(JSON.stringify(state)), { mode: 0o600 });
      renameSync(`${target}.partial`, target);
    },

    /**
     * The memory a site and retailer had before households were kept, or null when there is none.
     * @param {string} siteKey @param {string} retailer
     * @returns {SyncState | null}
     */
    legacy(siteKey, retailer) {
      const source = legacyFile(siteKey, retailer);
      return existsSync(source) ? (readFrom(source, retailer) ?? empty()) : null;
    },

    /**
     * Gives the memory from before households were kept to the household shown to own it. Should
     * that household somehow have memory of its own, it keeps its own and the old one is let go.
     * @param {string} siteKey @param {string} owner @param {string} retailer
     */
    adoptLegacy(siteKey, owner, retailer) {
      const source = legacyFile(siteKey, retailer);
      const target = file(siteKey, owner, retailer);
      if (!existsSync(source)) return;
      if (existsSync(target)) rmSync(source, { force: true });
      else renameSync(source, target);
    },

    /** Lets go of the memory from before households were kept. @param {string} siteKey @param {string} retailer */
    dropLegacy(siteKey, retailer) {
      rmSync(legacyFile(siteKey, retailer), { force: true });
    },

    /**
     * Gives one household's memory on a site to another: what was kept under NOBODY, to the first
     * household connected. Where the other already has memory of a retailer, it keeps its own.
     * @param {string} siteKey @param {string} from @param {string} to
     */
    move(siteKey, from, to) {
      gone.add(`${siteKey}~${from}`);
      gone.delete(`${siteKey}~${to}`);
      for (const name of filesOf(siteKey, from)) {
        const retailer = name.slice(`sync-${siteKey}~${from}~`.length, -".bin".length);
        const target = file(siteKey, to, retailer);
        if (existsSync(target)) rmSync(path.join(dir, name), { force: true });
        else renameSync(path.join(dir, name), target);
      }
    },

    /** Lets go of everything remembered for a household on a site. @param {string} siteKey @param {string} owner */
    forget(siteKey, owner) {
      gone.add(`${siteKey}~${owner}`);
      for (const name of filesOf(siteKey, owner)) rmSync(path.join(dir, name), { force: true });
    },
  };
}
