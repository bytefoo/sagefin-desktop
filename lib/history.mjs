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
 *
 * Its address is not kept. What the list said that the address depends on is (`facts`), and a run
 * builds the address from that with the retailer's `orderUrl` each time it opens the order, so an
 * address one version built wrongly is not opened by every version after it. (Up to v0.1.80 the
 * address was kept, and an in-store Walmart purchase listed by v0.1.76 kept an online order's.)
 * @typedef {object} QueuedOrder
 * @property {string} id
 * @property {import("./retailers.mjs").OrderFacts} [facts]
 *   What the list said of it that its address depends on (Walmart's), as the list last showed it.
 * @property {string} fingerprint
 * @property {string | null} date
 * @property {number} [misses]
 *   How many runs opened its page and found no order on it, since the list last showed it changed.
 *   Left out while none have. At MAX_MISSES the order is set aside (`isSetAside`).
 * @property {number} [troubles]
 *   How many runs opened its page and found the retailer's error page (or a 5xx) instead, since the
 *   list last showed it changed: at most one a run. Left out while none have. At MAX_TROUBLES the
 *   order is set aside, as misses set it aside.
 * @property {true} [relist]
 *   The retailer cannot say where its page is from what is kept of it: an entry an older version
 *   stored with an address and no facts, where that address does not say them for certain
 *   (`legacyFacts` in lib/retailers.mjs). No run opens it, and it is not counted as set aside: it
 *   waits for the list to show it again, which gives it its facts and clears its misses. Worked out
 *   again each time the to-do list is read, never trusted from disk.
 */

/**
 * What `readQueue` needs of a retailer to tell where its orders' pages are.
 * @typedef {Pick<import("./retailers.mjs").Retailer, "orderUrl" | "legacyFacts">} Addresses
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
 * How many runs may find the retailer's error page in place of an order's page before it is set
 * aside, as MAX_MISSES misses set it aside. An error page says nothing about the order, so one is
 * not a miss, and a run pauses on two in a row (`noteOrderPage`, lib/sync-plan.mjs); but an order
 * whose page is the error page every time would otherwise be opened by every run for ever, and two
 * of them would pause every run before it reached the orders behind them. More than MAX_MISSES,
 * because a retailer having trouble for a day gives its error page for good orders too: a run
 * counts at most one against each order, and opens an order with more after those with fewer, so a
 * day's trouble is spread across the to-do list rather than piled on its first two orders.
 */
export const MAX_TROUBLES = 5;

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
 * @property {number} listedWith
 *   The retailer's `listingVersion` (lib/retailers.mjs) the setup listed its orders with. Below the
 *   version the app has now, `reachedDate` and `listedIds` say how far back an older reading of the
 *   list went, and that reading left out orders this one lists (Amazon's digital orders, before
 *   v0.1.88). The setup is then outdated (`setupOutdated`), and the next one starts its count again
 *   (`beginSetup`). A setup stored before this was kept was listed with version 1.
 */

/**
 * What SageFin said about the household's bank history, for the strip. Never guessed.
 * @typedef {object} BankHistory
 * @property {string | null} start  The date of the household's earliest bank transaction, YYYY-MM-DD.
 * @property {boolean} locked       The household is in private mode and locked, so SageFin cannot say.
 */

/** @returns {Setup} */
export const emptySetup = () => ({ status: "never", reachedDate: null, backTo: null, listedIds: [], skipped: 0, startedAt: null, doneAt: null, listedWith: 1 });

const isDay = (/** @type {unknown} */ v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : null);

/**
 * The to-do list as stored, keeping only entries that are whole. An entry that is not is dropped,
 * which costs a page load later if the order is listed again, and loses nothing.
 *
 * An address stored by an older version is never kept: it is read for the facts it was built from
 * (`legacyFacts`). Where the address built from those is not the one stored, the misses counted
 * against the stored one are dropped: they were misses of a page this version does not open. Every
 * entry the retailer then cannot address is marked `relist`.
 * @param {unknown} raw
 * @param {Addresses} [retailer]  Left out, nothing is worked out about addresses.
 * @returns {QueuedOrder[]}
 */
export function readQueue(raw, retailer) {
  if (!Array.isArray(raw)) return [];
  /** @type {QueuedOrder[]} */
  const queue = [];
  const ids = new Set();
  for (const o of raw) {
    if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.fingerprint !== "string") continue;
    if (ids.has(o.id)) continue;
    ids.add(o.id);
    /** @type {QueuedOrder} */
    const entry = { id: o.id, fingerprint: o.fingerprint, date: isDay(o.date) ? o.date : null };
    const kept = readFacts(o.facts);
    const legacy = !kept && typeof o.url === "string" ? (retailer?.legacyFacts?.(o.id, o.url) ?? null) : null;
    const facts = kept ?? legacy;
    if (facts) entry.facts = facts;
    const readdressed = legacy !== null && retailer?.orderUrl?.(entry) !== o.url;
    if (Number.isInteger(o.misses) && o.misses > 0 && !readdressed) entry.misses = Math.min(o.misses, MAX_MISSES);
    if (Number.isInteger(o.troubles) && o.troubles > 0 && !readdressed) entry.troubles = Math.min(o.troubles, MAX_TROUBLES);
    if (retailer?.orderUrl && retailer.orderUrl(entry) === null) entry.relist = true;
    queue.push(entry);
  }
  return queue;
}

/**
 * Facts as stored, in their shape. Whether they make an address is the retailer's `orderUrl`'s to say.
 * @param {unknown} raw
 * @returns {import("./retailers.mjs").OrderFacts | null}
 */
function readFacts(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { inStore, groupId } = /** @type {Record<string, unknown>} */ (raw);
  if (typeof inStore !== "boolean" || !(groupId === null || typeof groupId === "string")) return null;
  return { inStore, groupId };
}

/** @param {import("./retailers.mjs").OrderFacts} [a] @param {import("./retailers.mjs").OrderFacts} [b] */
const sameFacts = (a, b) => (a === undefined || b === undefined ? a === b : a.inStore === b.inStore && a.groupId === b.groupId);

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
    listedWith: Number.isInteger(r.listedWith) && /** @type {number} */ (r.listedWith) >= 1 ? /** @type {number} */ (r.listedWith) : 1,
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
 * An order the list shows changed starts again with no misses and no error pages counted against
 * it: its page may be filled now. So does
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
    /** @type {QueuedOrder} */
    const entry = { id: order.id, fingerprint: order.fingerprint, date: order.date };
    if (order.facts) entry.facts = { inStore: order.facts.inStore, groupId: order.facts.groupId };
    if (at < 0) {
      state.queue.push(entry);
      added += 1;
    } else if (
      state.queue[at].relist ||
      state.queue[at].fingerprint !== order.fingerprint ||
      !sameFacts(state.queue[at].facts, entry.facts)
    ) {
      // Changed, or now with facts it lacked: a new address, and no misses counted against the old.
      state.queue[at] = { ...entry, date: entry.date ?? state.queue[at].date };
    } else if (retry && (state.queue[at].misses || state.queue[at].troubles)) {
      const { misses: _, troubles: __, ...kept } = state.queue[at];
      state.queue[at] = kept;
    }
  }
  return { added, alreadyRead };
}

/**
 * Whether an order has been set aside: too many runs found no order on its page, or the retailer's
 * error page in its place.
 * @param {QueuedOrder} order
 */
export const isSetAside = (order) => (order.misses ?? 0) >= MAX_MISSES || (order.troubles ?? 0) >= MAX_TROUBLES;

/** The orders on the to-do list a run will still open. @param {QueuedOrder[]} queue */
export const stillToOpen = (queue) => queue.filter((q) => !q.relist && !isSetAside(q));

/** How many orders on the to-do list are set aside. @param {QueuedOrder[]} queue */
export const setAsideCount = (queue) => queue.filter((q) => !q.relist && isSetAside(q)).length;

/**
 * How many orders on the to-do list wait for the list to show them again, because what is kept of
 * them does not say where their page is (`relist`).
 * @param {QueuedOrder[]} queue
 */
export const waitingCount = (queue) => queue.filter((q) => q.relist).length;

/**
 * A run found it could not say where an order's page is (the retailer's `orderUrl` gave none). It is
 * not opened, and waits for the list to show it again.
 * @param {HistoryState} state  Changed in place.
 * @param {QueuedOrder} order
 */
export function awaitRelist(state, order) {
  const at = state.queue.findIndex((q) => q.id === order.id);
  if (at >= 0) state.queue[at] = { ...state.queue[at], relist: true };
}

/**
 * The orders a run opens: the next `limit` on the to-do list, newest first. An order the list gave
 * no date is opened after the dated ones, rather than never. An order whose page has shown no order
 * before is opened after every order whose page has not, so that two such pages cannot end each
 * run before it reaches the rest. Among those with as many misses, one whose page has been the
 * retailer's error page on fewer runs comes first, for the same reason. One set aside is not opened
 * at all, nor one waiting for the list
 * to show it again (`relist`).
 * @param {QueuedOrder[]} queue
 * @param {number} limit  MAX_ORDERS_PER_RUN (lib/sync-plan.mjs).
 */
export function nextToOpen(queue, limit) {
  return stillToOpen(queue)
    .sort(
      (a, b) =>
        (a.misses ?? 0) - (b.misses ?? 0) ||
        (a.troubles ?? 0) - (b.troubles ?? 0) ||
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
 * A run opened an order's page and found the retailer's error page (or a 5xx) in its place. It stays
 * on the to-do list, one run nearer being set aside for it. The caller counts it once a run
 * (`noteOrderPage`, lib/sync-plan.mjs).
 * @param {HistoryState} state  Changed in place.
 * @param {QueuedOrder} order
 * @returns {boolean}  Whether this set it aside.
 */
export function noteTrouble(state, order) {
  const at = state.queue.findIndex((q) => q.id === order.id);
  if (at < 0) return false;
  const troubles = Math.min((state.queue[at].troubles ?? 0) + 1, MAX_TROUBLES);
  state.queue[at] = { ...state.queue[at], troubles };
  return troubles >= MAX_TROUBLES;
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
 * Whether the member's setup was listed by an older reading of the retailer's list than this one,
 * which left out orders this version lists. Those orders were never put on the to-do list, and a
 * run cannot reach them: it stops at the first charge it has read before, and the older reading
 * remembered their charges as read. Only the member's own browsing back through the history reaches
 * them, so a run says to set the history up again (`outdatedSetupSentence`).
 * @param {Setup} setup
 * @param {number} listingVersion  The retailer's `listingVersion`, 1 where it has none.
 */
export const setupOutdated = (setup, listingVersion) => setup.status !== "never" && setup.listedWith < listingVersion;

/**
 * The setup as Set up history begins it. One started and not finished carries on, with what it saw.
 * One the member finished starts again with what it reached, skipping what was read. One that is
 * outdated (`setupOutdated`) starts its count again: how far back it reached and how many orders it
 * listed were an older reading's. Kept, the strip would say on the first page that the bank history
 * was covered, while the orders this version lists further back were still to be scrolled to. The
 * day "Change how far back" was given stands either way.
 * @param {Setup} setup
 * @param {number} listingVersion
 * @param {Date} now
 * @returns {Setup}
 */
export function beginSetup(setup, listingVersion, now) {
  const startedAt = now.toISOString();
  if (setupOutdated(setup, listingVersion)) {
    return { ...emptySetup(), backTo: setup.backTo, status: "started", startedAt, listedWith: listingVersion };
  }
  if (setup.status === "started") return setup;
  // A first setup lists with this version.
  const listedWith = setup.status === "never" ? listingVersion : setup.listedWith;
  return { ...setup, status: "started", startedAt, doneAt: null, listedWith };
}

/**
 * What a run adds to what it says while the setup is outdated: the orders an older version could not
 * list wait for the member to set the history up again, back as far as before.
 * @param {string} name  The retailer's name.
 * @param {Setup} setup
 */
export function outdatedSetupSentence(name, setup) {
  const back = setup.reachedDate ? ` back to ${longDate(setup.reachedDate)}, as before,` : "";
  return `This version reads ${name} orders that the version your history was set up with could not list. Set up your ${name} history again${back} to send them.`;
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
