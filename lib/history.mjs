// @ts-check
// A retailer's order history: set up once by the member, kept up by small runs.
//
// The member loads their history themselves. The app opens the retailer's history page (Amazon's
// Your Payments, Walmart's Purchase history), the member scrolls or presses Next as far back as
// they want, and the app saves what their browsing loads, as it saves anything they open. Each
// order the list shows goes to SageFin at once, inside the saved list, and into a to-do list kept
// here: the orders whose own page has still to be read for its items.
//
// A run after that is small. It lists only until it is caught up, then opens the next twenty
// orders on the to-do list, newest first. A run never reaches back through the history: a list
// with no address for "after this point" can only be read from its top, and reading thirty scrolls
// of it in one run is what met Amazon's robot check on 2026-10-24.
//
// Pure: no Electron, nothing on disk. What is kept lives in the sync state (lib/sync-plan.mjs),
// sealed with it.

/** The capture kinds that are a history list, whose orders go on the to-do list. */
export const LIST_KINDS = ["order_list_next_data", "order_list_json", "payments_html", "payments_json"];

/** How long a Walmart order keeps changing after it is placed: late shipments, substitutions, refunds. */
export const SETTLING_DAYS = 30;

/** How many charges are remembered as read. A run stops at the first it knows, so only the newest matter. */
export const MAX_CHARGES = 3000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An order on the to-do list: its page has not been read in the state the list last showed.
 * @typedef {object} QueuedOrder
 * @property {string} id
 * @property {string} url
 * @property {string} fingerprint
 * @property {string | null} date
 * @property {number} [misses]
 *   How many runs opened its page and found no order on it, since the list last showed it changed.
 *   Left out while none have. At MAX_MISSES the order is set aside (`isSetAside`).
 */

/**
 * How many runs may open an order's page and find no order on it before it is set aside: no longer
 * opened by a run, so that it cannot hold back the orders behind it or cost a page load every run.
 * One miss can be a slow load; three runs, an hour or a day apart, is a page the retailer does not
 * fill at that address. Its charges and total reached SageFin with the list already; what is lost
 * is its items. The list showing it changed (a new fingerprint or a new address) brings it back,
 * and so does the member setting the history up past it.
 */
export const MAX_MISSES = 3;

/**
 * How far the member's own setup of the history has got.
 * @typedef {object} Setup
 * @property {"never" | "started" | "done"} status
 *   `started`: begun, and the window closed or still open; what it saw is kept. `done`: the member
 *   pressed Done.
 * @property {string | null} reachedDate  The oldest date the history page has shown while setting up.
 * @property {string | null} backTo
 *   The day "Change how far back" was last given, while it stands: until setup lists an order older
 *   than it again, which puts that order back on the to-do list.
 * @property {string[]} listedIds         The orders it has shown while setting up, each once.
 * @property {number} skipped             Of those, how many were already read, and so skipped.
 * @property {string | null} startedAt
 * @property {string | null} doneAt
 */

/**
 * What SageFin said about the household's bank history, for the strip. Never guessed.
 * @typedef {object} BankHistory
 * @property {string | null} start  The date of the household's earliest bank transaction, YYYY-MM-DD.
 * @property {boolean} locked       The household is in private mode and locked, so SageFin cannot say.
 */

/** @returns {Setup} */
export const emptySetup = () => ({ status: "never", reachedDate: null, backTo: null, listedIds: [], skipped: 0, startedAt: null, doneAt: null });

const isDay = (/** @type {unknown} */ v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : null);

/**
 * The to-do list as stored, keeping only entries that are whole. An entry that is not is dropped,
 * which costs a page load later if the order is listed again, and loses nothing.
 * @param {unknown} raw
 * @returns {QueuedOrder[]}
 */
export function readQueue(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {QueuedOrder[]} */
  const queue = [];
  const ids = new Set();
  for (const o of raw) {
    if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.url !== "string" || typeof o.fingerprint !== "string") continue;
    if (ids.has(o.id)) continue;
    ids.add(o.id);
    /** @type {QueuedOrder} */
    const entry = { id: o.id, url: o.url, fingerprint: o.fingerprint, date: isDay(o.date) ? o.date : null };
    if (Number.isInteger(o.misses) && o.misses > 0) entry.misses = Math.min(o.misses, MAX_MISSES);
    queue.push(entry);
  }
  return queue;
}

/** @param {unknown} raw @returns {Setup} */
export function readSetup(raw) {
  if (!raw || typeof raw !== "object") return emptySetup();
  const r = /** @type {Record<string, unknown>} */ (raw);
  return {
    status: r.status === "started" || r.status === "done" ? r.status : "never",
    reachedDate: isDay(r.reachedDate) ? /** @type {string} */ (r.reachedDate) : null,
    backTo: isDay(r.backTo) ? /** @type {string} */ (r.backTo) : null,
    listedIds: Array.isArray(r.listedIds) ? [...new Set(r.listedIds.filter((id) => typeof id === "string"))] : [],
    skipped: Number.isInteger(r.skipped) && /** @type {number} */ (r.skipped) >= 0 ? /** @type {number} */ (r.skipped) : 0,
    startedAt: str(r.startedAt),
    doneAt: str(r.doneAt),
  };
}

/** @param {unknown} raw @returns {Record<string, string>} Charge key to its date ("" when undated). */
export function readCharges(raw) {
  /** @type {Record<string, string>} */
  const charges = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return charges;
  for (const [key, date] of Object.entries(raw)) {
    if (/^[0-9a-f]{64}$/.test(key) && typeof date === "string") charges[key] = date;
  }
  return charges;
}

/**
 * The part of the sync state this module works on.
 * @typedef {object} HistoryState
 * @property {Record<string, string>} seen     Order to the fingerprint it had when its page was read.
 * @property {QueuedOrder[]} queue
 * @property {Record<string, string>} charges
 * @property {Setup} setup
 */

/**
 * Puts what a list page showed on the to-do list. An order read in the state it is shown in is
 * not put there (and taken off, if it was); an order not read, or changed since, is put there once,
 * with what the list now says of it.
 * An order the list shows changed starts again with no misses: its page may be filled now. So does
 * every order it shows with `retry`, which is the member setting the history up: their own browsing
 * past an order is the sign it is still there to read.
 * @param {HistoryState} state  Changed in place.
 * @param {import("./retailers.mjs").ListedOrder[]} orders
 * @param {{ retry?: boolean }} [options]
 * @returns {{ added: number, alreadyRead: string[] }}
 *   `added`: orders that were not on the list as they are now. `alreadyRead`: the orders shown that
 *   were already read in this state.
 */
export function enqueue(state, orders, { retry = false } = {}) {
  let added = 0;
  /** @type {string[]} */
  const alreadyRead = [];
  for (const order of orders) {
    const at = state.queue.findIndex((q) => q.id === order.id);
    if (Object.hasOwn(state.seen, order.id) && state.seen[order.id] === order.fingerprint) {
      alreadyRead.push(order.id);
      if (at >= 0) state.queue.splice(at, 1);
      continue;
    }
    const entry = { id: order.id, url: order.url, fingerprint: order.fingerprint, date: order.date };
    if (at < 0) {
      state.queue.push(entry);
      added += 1;
    } else if (state.queue[at].fingerprint !== order.fingerprint || state.queue[at].url !== order.url) {
      state.queue[at] = { ...entry, date: entry.date ?? state.queue[at].date };
    } else if (retry && state.queue[at].misses) {
      const { misses: _, ...kept } = state.queue[at];
      state.queue[at] = kept;
    }
  }
  return { added, alreadyRead };
}

/** Whether an order has been set aside: too many runs found no order on its page. @param {QueuedOrder} order */
export const isSetAside = (order) => (order.misses ?? 0) >= MAX_MISSES;

/** The orders on the to-do list a run will still open. @param {QueuedOrder[]} queue */
export const stillToOpen = (queue) => queue.filter((q) => !isSetAside(q));

/** How many orders on the to-do list are set aside. @param {QueuedOrder[]} queue */
export const setAsideCount = (queue) => queue.length - stillToOpen(queue).length;

/**
 * The orders a run opens: the next `limit` on the to-do list, newest first. An order the list gave
 * no date is opened after the dated ones, rather than never. An order whose page has shown no order
 * before is opened after every order whose page has not, so that two such pages cannot end each
 * run before it reaches the rest; one set aside is not opened at all.
 * @param {QueuedOrder[]} queue
 * @param {number} limit  MAX_ORDERS_PER_RUN (lib/sync-plan.mjs).
 */
export function nextToOpen(queue, limit) {
  return stillToOpen(queue)
    .sort(
      (a, b) =>
        (a.misses ?? 0) - (b.misses ?? 0) ||
        (a.date === b.date ? 0 : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? 1 : -1),
    )
    .slice(0, limit);
}

/**
 * A run opened an order's page and found no order on it. It stays on the to-do list, a miss nearer
 * being set aside.
 * @param {HistoryState} state  Changed in place.
 * @param {QueuedOrder} order
 * @returns {boolean}  Whether this miss set it aside.
 */
export function noteMissed(state, order) {
  const at = state.queue.findIndex((q) => q.id === order.id);
  if (at < 0) return false;
  const misses = Math.min((state.queue[at].misses ?? 0) + 1, MAX_MISSES);
  state.queue[at] = { ...state.queue[at], misses };
  return misses >= MAX_MISSES;
}

/**
 * An order whose page has been read: off the to-do list, and remembered as read in the state the
 * to-do list had it.
 * @param {HistoryState} state  Changed in place.
 * @param {QueuedOrder} order
 */
export function markRead(state, order) {
  state.seen[order.id] = order.fingerprint;
  state.queue = state.queue.filter((q) => q.id !== order.id);
}

/**
 * Takes off the to-do list what another of the member's computers has read since it was put there
 * (lib/read-orders.mjs adopts those into `seen`).
 * @param {HistoryState} state  Changed in place.
 */
export function dropRead(state) {
  state.queue = state.queue.filter((q) => state.seen[q.id] !== q.fingerprint);
}

/**
 * Remembers the charges a list page showed as read. Only the newest MAX_CHARGES are kept: a run
 * stops at the first it knows, which is near the top.
 * @param {HistoryState} state  Changed in place.
 * @param {import("./retailers.mjs").ListedCharge[]} charges
 */
export function noteCharges(state, charges) {
  for (const c of charges) state.charges[c.key] = c.date ?? "";
  const keys = Object.keys(state.charges);
  if (keys.length <= MAX_CHARGES) return;
  keys.sort((a, b) => (state.charges[b] < state.charges[a] ? -1 : state.charges[b] > state.charges[a] ? 1 : 0));
  /** @type {Record<string, string>} */
  const kept = {};
  for (const key of keys.slice(0, MAX_CHARGES)) kept[key] = state.charges[key];
  state.charges = kept;
}

/**
 * Amazon's rule: a run has listed far enough at the first charge it has read before. Anything new
 * — a charge, a refund, a hold now charged — arrives as a row at the top, above it.
 * @param {import("./retailers.mjs").ListedCharge[]} pageCharges
 * @param {Record<string, string>} readCharges
 */
export function reachedReadCharge(pageCharges, readCharges) {
  return pageCharges.some((c) => Object.hasOwn(readCharges, c.key));
}

/**
 * Walmart's rule: a run has listed far enough once it has reached an order it already knows (read,
 * or on the to-do list) and is past the SETTLING_DAYS in which an order still changes. An order
 * there changes in place, rather than arriving as a new row, so the first known order is not the
 * end: those after it may have changed too.
 * @param {object} options
 * @param {import("./retailers.mjs").ListedOrder[]} options.pageOrders
 * @param {HistoryState} options.state
 * @param {boolean} options.reachedKnown  An earlier page of this run reached a known order.
 * @param {Date} options.now
 * @returns {{ reachedKnown: boolean, settled: boolean }}
 *   `settled`: this page reaches past the settling days, having reached a known order by now.
 */
export function settledListing({ pageOrders, state, reachedKnown, now }) {
  const known = reachedKnown || pageOrders.some((o) => Object.hasOwn(state.seen, o.id) || state.queue.some((q) => q.id === o.id));
  const horizon = new Date(now.getTime() - SETTLING_DAYS * DAY_MS).toISOString().slice(0, 10);
  const past = pageOrders.some((o) => o.date !== null && o.date < horizon);
  return { reachedKnown: known, settled: known && past };
}

/**
 * What one list page shown while setting up adds to the setup: the orders it showed, how far back
 * it reached, and how many of its orders were already read.
 * @param {Setup} setup  Changed in place.
 * @param {import("./retailers.mjs").ListedOrder[]} orders
 * @param {string[]} alreadyRead  From `enqueue`.
 * @param {(string | null)[]} [dates]  Every date the page showed, charges included.
 */
export function noteSetup(setup, orders, alreadyRead, dates = []) {
  const ids = new Set(setup.listedIds);
  const read = new Set(alreadyRead);
  for (const o of orders) {
    if (ids.has(o.id)) continue;
    ids.add(o.id);
    setup.listedIds.push(o.id);
    if (read.has(o.id)) setup.skipped += 1;
  }
  for (const d of [...orders.map((o) => o.date), ...dates]) {
    if (d !== null && (setup.reachedDate === null || d < setup.reachedDate)) setup.reachedDate = d;
  }
  // An order older than the day "Change how far back" was given is on the to-do list again.
  if (setup.backTo && orders.some((o) => o.date !== null && o.date < /** @type {string} */ (setup.backTo))) setup.backTo = null;
}

/**
 * How far back the history reads now, YYYY-MM-DD, or null when nothing says: the day "Change how
 * far back" was given, where that is later than the oldest date setup reached, and otherwise that
 * date. It is what the date box starts at, so the member only moves it.
 * @param {Setup} setup
 * @returns {string | null}
 */
export function readsBackTo(setup) {
  const { reachedDate, backTo } = setup;
  if (backTo && reachedDate) return backTo > reachedDate ? backTo : reachedDate;
  return backTo ?? reachedDate;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2025-03-14" as "March 14, 2025". @param {string} day */
export function longDate(day) {
  const [y, m, d] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * What the strip above the retailer's page says while the member sets up their history. Its own
 * words, never the page's: a date, a count, and the bank history's start as SageFin said it.
 * @param {object} options
 * @param {string} options.name  The retailer's name.
 * @param {Setup} options.setup
 * @param {BankHistory | null} options.bank  Null: SageFin has not said, in this run of the app.
 * @param {boolean} [options.checking]  The retailer is showing its robot check.
 * @returns {{ progress: string, target: string, covered: boolean, note: string | null }}
 */
export function stripText({ name, setup, bank, checking = false }) {
  const orders = setup.listedIds.length;
  const parts = [`Setting up your ${name} history`];
  if (setup.reachedDate) parts.push(`back to ${longDate(setup.reachedDate)}`);
  parts.push(`${orders} order${orders === 1 ? "" : "s"} so far`);
  const progress = parts.join(" · ");

  const covered = Boolean(bank?.start && setup.reachedDate && setup.reachedDate <= bank.start);
  const target = covered
    ? "That covers all your bank history. Press Done."
    : bank?.start
      ? `Your bank history in SageFin starts ${longDate(bank.start)}. Keep going until you reach it, or press Done.`
      : bank?.locked
        ? "Your household is locked, so SageFin cannot say where your bank history starts. Go back as far as you want."
        : "SageFin has not said where your bank history starts. Open Settings → Retail sync in SageFin to see it.";

  const how = name === "Amazon" ? "Scroll down the list to load older charges." : "Press Next page to load older orders.";
  const note = checking
    ? `${name} is checking this browser. Answer its check in the window, then carry on.`
    : setup.skipped > 0
      ? `${setup.skipped} already read, so skipped. ${how}`
      : how;
  return { progress, target, covered, note };
}

/**
 * "Change how far back": drops the orders on the to-do list older than `from`, which then are never
 * opened. Their charges and totals already reached SageFin with the list; only their items will not.
 * The day is kept as the setup's `backTo`.
 * @param {HistoryState} state  Changed in place.
 * @param {string} from  YYYY-MM-DD.
 * @returns {number}  How many were dropped.
 */
export function dropOlderThan(state, from) {
  if (!isDay(from)) return 0;
  state.setup = { ...state.setup, backTo: from };
  const before = state.queue.length;
  state.queue = state.queue.filter((q) => q.date === null || q.date >= from);
  return before - state.queue.length;
}

/**
 * "Start over": forgets the to-do list, every order read and every charge read, and the setup. The
 * next setup and run read everything again. What SageFin already holds stays there: it is removed
 * only from SageFin.
 * @param {HistoryState} state  Changed in place.
 */
export function startOver(state) {
  state.seen = {};
  state.queue = [];
  state.charges = {};
  state.setup = emptySetup();
}

/**
 * The date "Change how far back" was given, as it may be used: a real calendar day, YYYY-MM-DD, no
 * later than today. Anything else is null, and nothing is dropped. The retailers window and the web
 * page both send one, and neither is taken on trust.
 * @param {unknown} value
 * @param {Date} [now]
 * @returns {string | null}
 */
export function howFarBackDate(value, now = new Date()) {
  if (!isDay(value)) return null;
  const day = /** @type {string} */ (value);
  const parsed = new Date(`${day}T00:00:00Z`);
  // 2026-02-30 parses as 2 March: a day that does not come back the same is not a day.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return day > today ? null : day;
}
