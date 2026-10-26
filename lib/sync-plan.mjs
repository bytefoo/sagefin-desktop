// @ts-check
// Which orders a sync opens, and what it remembers between runs.
//
// A sync lists a retailer's orders until it is caught up, then opens the next orders on its to-do
// list (lib/history.mjs). What it has read is remembered as an order number and a fingerprint, so
// an order is opened again only when it has changed.

import { readCharges, readQueue, readSetup, emptySetup } from "./history.mjs";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  return state.lastOutcome === "finished" && state.lastOrders === MAX_ORDERS_PER_RUN && (state.queue ?? []).length > 0;
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
  return Number.isFinite(last) ? new Date(scheduledRunAtMs(last, every, schedule, catchingUp(state))).toISOString() : null;
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
          refusedAt: str(raw.refusedAt),
          // A memory from before the to-do list has none, and no setup: a run lists until caught up
          // and the member is offered setup, which is how such a memory began anyway.
          queue: readQueue(raw.queue),
          charges: readCharges(raw.charges),
          setup: readSetup(raw.setup),
          readFor: str(raw.readFor),
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
