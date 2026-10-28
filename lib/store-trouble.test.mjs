// When a retailer is having trouble: its own error page, or a 5xx, served in place of an order. The
// run takes that as "try later" (lib/sync-plan.mjs), the page is not saved (`keepsPage`,
// lib/retailers.mjs), and a real order's page is read as it always was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { amazon, walmart } from "./retailers.mjs";
import { MAX_TROUBLES, emptySetup, enqueue, isSetAside, nextToOpen, readQueue, setAsideCount, stillToOpen } from "./history.mjs";
import {
  SCHEDULE_EVERY_MS,
  TROUBLE_PAGES_IN_A_ROW,
  TROUBLE_RETRY_AFTER_MS,
  nextScheduledRunAt,
  noteOrderPage,
  notePause,
  orderPageVerdict,
  scheduleStopped,
  scheduledRunDue,
  troubleStatus,
} from "./sync-plan.mjs";

const fixture = (name) => readFileSync(path.join(import.meta.dirname, "..", "fixtures", name), "utf8");
/** The data a sync reads from a Walmart page: its __NEXT_DATA__. */
const nextData = (html) => /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? null;

const WALMART_ERROR_HTML = fixture("walmart-error-page.html");
const WALMART_ERROR = /** @type {string} */ (nextData(WALMART_ERROR_HTML));
const AMAZON_ERROR = fixture("amazon-error-page.html");

const WALMART_ID = "200000000000001";
const WALMART_URL = `https://www.walmart.com/orders/${WALMART_ID}?groupId=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6`;
const walmartOrderPage = (order) => JSON.stringify({ props: { pageProps: { initialData: { data: { order } } } } });
const WALMART_ORDER = walmartOrderPage({ id: WALMART_ID, groups_2101: [{ items: [{ id: "1" }] }] });
/** Walmart's header and nothing else: an order object with no items, which is the order's page not being there. */
const WALMART_EMPTY = walmartOrderPage({ id: WALMART_ID });

const AMAZON_ID = "113-0000001-0000001";
const AMAZON_URL = `https://www.amazon.com/gp/your-account/order-details?orderID=${AMAZON_ID}`;
const AMAZON_ORDER = `<html><head><title>Order Details</title></head><body><div data-component="orderId"><span>Order # <bdi>${AMAZON_ID}</bdi></span></div><a href="/gp/css/summary/print.html?orderID=${AMAZON_ID}">Invoice</a></body></html>`;

// ---- recognising the page ---------------------------------------------------------------------

test("Walmart: its error page is recognised, from its data or from its text", () => {
  assert.equal(walmart.isErrorPage?.(WALMART_URL, WALMART_ERROR, 200), true);
  // What the page says, for a page whose data the run could not read.
  assert.equal(walmart.isErrorPage?.(WALMART_URL, "Walmart.com\nSorry...\nWe’re having technical issues, but we'll be back in a flash.", 200), true);
  // An order page's data with no order object in it at all, and no words to go by.
  assert.equal(walmart.isErrorPage?.(WALMART_URL, JSON.stringify({ props: { pageProps: { initialData: {} } } }), 200), true);
  assert.equal(walmart.isErrorPage?.(WALMART_URL, JSON.stringify({ props: { pageProps: { errorCode: "WCP_ORDER_FAIL" } } }), 200), true);
});

test("Walmart: an order's page, filled or not, and every other page, is not its error page", () => {
  assert.equal(walmart.isErrorPage?.(WALMART_URL, WALMART_ORDER, 200), false);
  // The header-only page still has an order object: the order's page not being there, which is a miss.
  assert.equal(walmart.isErrorPage?.(WALMART_URL, WALMART_EMPTY, 200), false);
  assert.equal(walmart.isErrorPage?.(WALMART_URL, null, 200), false);
  assert.equal(walmart.isErrorPage?.(WALMART_URL, "not json, and no words of its error page", 200), false);
  // Only on an order's page: Purchase history has no order object and never had.
  assert.equal(walmart.isErrorPage?.("https://www.walmart.com/orders", JSON.stringify({ props: { pageProps: {} } }), 200), false);
  assert.equal(walmart.isErrorPage?.("https://example.com/orders/1", WALMART_ERROR, 200), false);
  assert.equal(walmart.isErrorPage?.("http://localhost:4000/orders/1", WALMART_ERROR, 200, { anyHost: true }), true);
});

test("Amazon: its error page is recognised on an order's details", () => {
  assert.equal(amazon.isErrorPage?.(AMAZON_URL, AMAZON_ERROR, 200), true);
  assert.equal(amazon.isErrorPage?.(AMAZON_URL, "<html><body><a href=\"/ref=cs_500_link\">Amazon</a></body></html>", 500), true);
  assert.equal(amazon.isErrorPage?.(AMAZON_URL, AMAZON_ORDER, 200), false);
  assert.equal(amazon.isErrorPage?.(AMAZON_URL, null, 200), false);
  // Not on a page that is not an order's details.
  assert.equal(amazon.isErrorPage?.("https://www.amazon.com/cpe/yourpayments/transactions", AMAZON_ERROR, 200), false);
  // Its not-found page is not trouble: the order is not having trouble, it is not there.
  assert.equal(amazon.isErrorPage?.(AMAZON_URL, '<html><title>Page Not Found</title><a href="/ref=cs_404_link">Amazon</a></html>', 200), false);
});

test("Amazon: an order's details that happen to say the words are still the order", () => {
  // An item could be named anything; the page's own landmarks say it is the order's details.
  const named = AMAZON_ORDER.replace("</body>", "<span>Sorry! Something went wrong on our end (paperback)</span></body>");
  assert.equal(amazon.isErrorPage?.(AMAZON_URL, named, 200), false);
  assert.equal(amazon.orderIdIn?.(named), AMAZON_ID);
});

test("Amazon: its error page is never the order, whatever it links to", () => {
  // The fixture links back to the order it could not show; without the guard the linked-orders rule
  // would take it for that order and the order would be marked read.
  assert.match(AMAZON_ERROR, /orderID=113-0000001-0000001/);
  assert.equal(amazon.orderIdIn?.(AMAZON_ERROR), null);
  assert.equal(amazon.orderIdIn?.(AMAZON_ORDER), AMAZON_ID);
});

// ---- not saved, so never sent -----------------------------------------------------------------

test("an error page, or an order's page with no order on it, is not kept", () => {
  assert.equal(walmart.keepsPage?.("order_detail_next_data", WALMART_ERROR), false);
  assert.equal(walmart.keepsPage?.("order_detail_next_data", WALMART_EMPTY), false);
  assert.equal(amazon.keepsPage?.("order_detail_html", AMAZON_ERROR), false);
  assert.equal(amazon.keepsPage?.("order_detail_html", "<html><body>Your account</body></html>"), false);
});

test("an order's page with its order on it is kept, and so is every other kind", () => {
  assert.equal(walmart.keepsPage?.("order_detail_next_data", WALMART_ORDER), true);
  assert.equal(walmart.keepsPage?.("order_list_next_data", JSON.stringify({ props: { pageProps: {} } })), true);
  // The orders answer the page requests is kept as it comes.
  assert.equal(walmart.keepsPage?.("order_detail_json", "{}"), true);
  assert.equal(amazon.keepsPage?.("order_detail_html", AMAZON_ORDER), true);
  // A details page the app cannot place (two order numbers, no landmark) is still SageFin's to read.
  assert.equal(amazon.orderIdIn?.("<html>113-0000001-0000001 and 113-0000002-0000002</html>"), null);
  assert.equal(amazon.keepsPage?.("order_detail_html", "<html>113-0000001-0000001 and 113-0000002-0000002</html>"), true);
  assert.equal(amazon.keepsPage?.("payments_html", "<html></html>"), true);
});

test("the stand-in page a development run saves is still kept", () => {
  const html = fixture("order-page.html");
  assert.equal(walmart.keepsPage?.("order_detail_next_data", /** @type {string} */ (nextData(html))), true);
});

// ---- what an order page was -------------------------------------------------------------------

test("a 5xx on an order page is trouble, except a status the retailer refuses with", () => {
  for (const status of [500, 502, 503, 504]) assert.equal(troubleStatus(walmart, status), true, `walmart ${status}`);
  assert.equal(troubleStatus(amazon, 500), true);
  assert.equal(troubleStatus(amazon, 504), true);
  // Amazon's 503 turns the run away, as it always has.
  assert.equal(troubleStatus(amazon, 503), false);
  for (const status of [200, 404, 412, 418, 429, 600]) {
    assert.equal(troubleStatus(walmart, status), false, `walmart ${status}`);
    assert.equal(troubleStatus(amazon, status), false, `amazon ${status}`);
  }
});

test("an order page is read, trouble, or a miss", () => {
  const w = (payload, status = 200) => orderPageVerdict(walmart, { url: WALMART_URL, status, payload, orderId: WALMART_ID });
  assert.equal(w(WALMART_ORDER), "read");
  assert.equal(w(WALMART_ERROR), "trouble");
  assert.equal(w(null, 504), "trouble");
  assert.equal(w(WALMART_EMPTY), "missed");
  assert.equal(w(null), "missed");
  assert.equal(orderPageVerdict(walmart, { url: WALMART_URL, status: 200, payload: WALMART_ORDER, orderId: "200000000000002" }), "missed");

  const a = (payload, status = 200) => orderPageVerdict(amazon, { url: AMAZON_URL, status, payload, orderId: AMAZON_ID });
  assert.equal(a(AMAZON_ORDER), "read");
  assert.equal(a(AMAZON_ERROR), "trouble");
  assert.equal(a(AMAZON_ERROR, 500), "trouble");
  assert.equal(a("<html>Nothing</html>"), "missed");
});

// ---- a run over pages like these --------------------------------------------------------------

const queued = (id, date) => ({ id, facts: { inStore: false, groupId: null }, fingerprint: `f-${id}`, date });
const runState = (extra = {}) => ({
  seen: {},
  lastFinishedAt: "2026-10-27T12:00:00.000Z",
  lastResult: null,
  lastRunAt: null,
  lastRunBy: /** @type {"member"} */ ("member"),
  lastOutcome: /** @type {"finished"} */ ("finished"),
  lastOrders: 0,
  refusedAt: null,
  queue: [queued("200000000000003", "2026-10-20"), queued("200000000000002", "2026-10-19"), queued("200000000000001", "2026-10-18")],
  charges: {},
  setup: emptySetup(),
  readFor: null,
  retryAt: null,
  troubledRuns: 0,
  ...extra,
});

/**
 * What the loop in main/main.mjs does with each order page: the verdict, carried out, until a stop.
 * @param {ReturnType<typeof runState>} state
 * @param {("read" | "trouble" | "missed")[]} verdicts  What each order page, in turn, turns out to be.
 */
function run(state, verdicts) {
  const streak = { missed: 0, trouble: 0 };
  const todo = nextToOpen(state.queue, 20);
  for (const [i, order] of todo.entries()) {
    const stop = noteOrderPage(state, order, verdicts[i] ?? "read", streak);
    if (stop) return { stop, opened: i + 1 };
  }
  return { stop: null, opened: todo.length };
}

test("an error page counts no miss, and the order stays on the to-do list with one run's trouble against it", () => {
  const state = runState();
  const before = structuredClone(state.queue);

  const { stop, opened } = run(state, ["trouble", "read", "read"]);

  assert.equal(stop, null);
  assert.equal(opened, 3);
  // The newest was the error page: still to read, no miss, one run's trouble, first again next time.
  assert.deepEqual(state.queue, [{ ...before[0], troubles: 1 }]);
  assert.equal(state.queue[0].misses, undefined);
  assert.deepEqual(Object.keys(state.seen).sort(), ["200000000000001", "200000000000002"]);
  assert.equal(nextToOpen(state.queue, 20)[0].id, "200000000000003");
});

test(`${TROUBLE_PAGES_IN_A_ROW} error pages in a row pause the run, with no miss counted against any order`, () => {
  const state = runState();
  const before = structuredClone(state.queue);

  const { stop, opened } = run(state, ["trouble", "trouble", "read"]);

  assert.equal(stop, "trouble");
  assert.equal(opened, TROUBLE_PAGES_IN_A_ROW);
  assert.deepEqual(state.queue, [{ ...before[0], troubles: 1 }, { ...before[1], troubles: 1 }, before[2]]);
  assert.ok(state.queue.every((q) => q.misses === undefined));
  assert.deepEqual(state.seen, {});
  assert.equal(stillToOpen(state.queue).length, 3);
});

test("an error page between two empty pages breaks their run, and they still count", () => {
  const state = runState();
  const { stop } = run(state, ["missed", "trouble", "missed"]);
  assert.equal(stop, null);
  assert.deepEqual(state.queue.map((q) => [q.id, q.misses]), [
    ["200000000000003", 1],
    ["200000000000002", undefined],
    ["200000000000001", 1],
  ]);
});

test("two empty pages in a row still stop the run, and count, as before", () => {
  const state = runState();
  const { stop } = run(state, ["missed", "missed"]);
  assert.equal(stop, "missed");
  assert.deepEqual(state.queue.map((q) => q.misses), [1, 1, undefined]);
});

test("real order pages are read and taken off the to-do list", () => {
  const state = runState();
  const { stop } = run(state, ["read", "read", "read"]);
  assert.equal(stop, null);
  assert.deepEqual(state.queue, []);
  assert.equal(state.seen["200000000000001"], "f-200000000000001");
});

// ---- an order whose page is the error page every time ----------------------------------------

/**
 * One run, as the loop in main/main.mjs carries it out, where what each order's page turns out to be
 * depends on the order: `broken` orders are always the error page, the rest are read.
 * @param {ReturnType<typeof runState>} state
 * @param {Set<string>} broken
 */
function runWith(state, broken) {
  const streak = { missed: 0, trouble: 0 };
  for (const order of nextToOpen(state.queue, 20)) {
    if (noteOrderPage(state, order, broken.has(order.id) ? "trouble" : "read", streak)) return;
  }
}

const BROKEN = "200000000000009";

test(`an order whose page is the error page on ${MAX_TROUBLES} runs is set aside, as misses set one aside`, () => {
  const state = runState({ queue: [queued(BROKEN, "2026-10-21")] });
  for (let run = 1; run < MAX_TROUBLES; run += 1) {
    runWith(state, new Set([BROKEN]));
    assert.equal(state.queue[0].troubles, run);
    assert.equal(isSetAside(state.queue[0]), false, `still opened after ${run} runs`);
  }
  runWith(state, new Set([BROKEN]));
  assert.equal(state.queue[0].troubles, MAX_TROUBLES);
  assert.equal(state.queue[0].misses, undefined);
  assert.equal(isSetAside(state.queue[0]), true);
  assert.equal(setAsideCount(state.queue), 1);
  assert.deepEqual(stillToOpen(state.queue), []);
  assert.deepEqual(nextToOpen(state.queue, 20), []);
  // Another run opens nothing, and counts nothing more.
  runWith(state, new Set([BROKEN]));
  assert.equal(state.queue[0].troubles, MAX_TROUBLES);
});

test("however often one run finds the error page for an order, it counts once", () => {
  const state = runState({ queue: [queued(BROKEN, "2026-10-21")] });
  const order = state.queue[0];
  const streak = { missed: 0, trouble: 0 };
  for (let i = 0; i < MAX_TROUBLES * 2; i += 1) noteOrderPage(state, order, "trouble", streak);
  assert.equal(state.queue[0].troubles, 1);
  assert.equal(isSetAside(state.queue[0]), false);
  // The next run is another run: one more.
  noteOrderPage(state, order, "trouble", { missed: 0, trouble: 0 });
  assert.equal(state.queue[0].troubles, 2);
});

test("two orders whose pages are always the error page do not pause every run before the rest", () => {
  const broken = new Set(["200000000000003", "200000000000002"]);
  const state = runState();
  // The first run opens the two newest, both the error page, and pauses.
  runWith(state, broken);
  assert.deepEqual(Object.keys(state.seen), []);
  // The next opens the order with no trouble against it first, and reads it.
  runWith(state, broken);
  assert.deepEqual(Object.keys(state.seen), ["200000000000001"]);
  for (let run = 3; run <= MAX_TROUBLES; run += 1) runWith(state, broken);
  assert.equal(setAsideCount(state.queue), 2);
  assert.deepEqual(stillToOpen(state.queue), []);
});

test("an order set aside for its error page comes back when the list shows it changed, as misses do", () => {
  const state = runState({ queue: [{ ...queued(BROKEN, "2026-10-21"), troubles: MAX_TROUBLES }] });
  assert.equal(setAsideCount(state.queue), 1);

  // Listed again as it was: still aside.
  const listed = { id: BROKEN, fingerprint: `f-${BROKEN}`, date: "2026-10-21", facts: { inStore: false, groupId: null } };
  enqueue(state, [listed]);
  assert.equal(setAsideCount(state.queue), 1);

  // The member's own browsing past it while setting up the history: back, nothing counted.
  enqueue(state, [listed], { retry: true });
  assert.equal(state.queue[0].troubles, undefined);
  assert.equal(stillToOpen(state.queue).length, 1);

  // Set aside again, then listed changed: back, nothing counted.
  state.queue[0] = { ...state.queue[0], troubles: MAX_TROUBLES };
  enqueue(state, [{ ...listed, fingerprint: "f-changed" }]);
  assert.equal(state.queue[0].troubles, undefined);
  assert.equal(state.queue[0].fingerprint, "f-changed");
  assert.equal(setAsideCount(state.queue), 0);
  assert.equal(nextToOpen(state.queue, 20)[0].id, BROKEN);
});

test("the error pages counted against an order are read back as stored, and only in their shape", () => {
  const stored = [
    { ...queued("1", null), troubles: 2 },
    { ...queued("2", null), troubles: 99 },
    { ...queued("3", null), troubles: 0 },
    { ...queued("4", null), troubles: -1 },
    { ...queued("5", null), troubles: "3" },
    { ...queued("6", null), troubles: 1.5 },
  ];
  assert.deepEqual(
    readQueue(stored).map((q) => q.troubles),
    [2, MAX_TROUBLES, undefined, undefined, undefined, undefined],
  );
});

// ---- the pause, and trying again --------------------------------------------------------------

const NOW = Date.parse("2026-10-28T09:00:00.000Z");

test("a pause is tried again by itself, a little later, and is not a refusal", () => {
  const state = runState({ lastOutcome: "stopped" });

  const retryAt = notePause(state, "paused", NOW);

  assert.equal(retryAt, new Date(NOW + TROUBLE_RETRY_AFTER_MS[0]).toISOString());
  assert.equal(state.troubledRuns, 1);
  assert.equal(scheduleStopped(state), false);
  assert.equal(scheduledRunDue(state, NOW + TROUBLE_RETRY_AFTER_MS[0] - 1000), false);
  assert.equal(scheduledRunDue(state, NOW + TROUBLE_RETRY_AFTER_MS[0]), true);
  // What the Retail sync page is told: the retry, not tomorrow.
  assert.equal(nextScheduledRunAt(state), retryAt);
});

test("each pause in a row waits longer, and after the last the schedule is the member's again", () => {
  const state = runState({ lastOutcome: "stopped" });
  const waits = TROUBLE_RETRY_AFTER_MS.map(() => Date.parse(/** @type {string} */ (notePause(state, "paused", NOW))) - NOW);
  assert.deepEqual(waits, TROUBLE_RETRY_AFTER_MS);
  assert.ok(waits.every((w, i) => i === 0 || w > waits[i - 1]));

  assert.equal(notePause(state, "paused", NOW), null);
  assert.equal(state.retryAt, null);
  assert.equal(nextScheduledRunAt(state), new Date(Date.parse(state.lastFinishedAt) + SCHEDULE_EVERY_MS).toISOString());
});

test("a run that finishes starts the count again, and any other end leaves no retry waiting", () => {
  const state = runState();
  notePause(state, "paused", NOW);
  notePause(state, "paused", NOW);
  notePause(state, "finished", NOW);
  assert.equal(state.troubledRuns, 0);
  assert.equal(state.retryAt, null);

  notePause(state, "paused", NOW);
  assert.equal(Date.parse(/** @type {string} */ (state.retryAt)) - NOW, TROUBLE_RETRY_AFTER_MS[0]);
  notePause(state, "other", NOW);
  assert.equal(state.retryAt, null);
  assert.equal(state.troubledRuns, 1);
});

test("a retry never starts a schedule the member has not, and never runs past a refusal", () => {
  // No sync the member started has finished here: no schedule, so no retry either.
  const first = runState({ lastFinishedAt: null, lastOutcome: "stopped" });
  assert.equal(notePause(first, "paused", NOW), null);
  assert.equal(scheduledRunDue(first, NOW + 24 * SCHEDULE_EVERY_MS), false);

  // A retry waiting, then the retailer turns a run away: the schedule stops, retry and all.
  const refused = runState({ retryAt: new Date(NOW).toISOString(), refusedAt: new Date(NOW).toISOString(), lastOutcome: "refused" });
  assert.equal(scheduledRunDue(refused, NOW + 1000), false);
  assert.equal(nextScheduledRunAt(refused), null);
});

test("a retry waiting, and the pauses in a row, are remembered across a restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createSyncStates } = await import("./sync-plan.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-trouble-"));
  try {
    const seal = (text) => Buffer.from(text);
    const open = (sealed) => Buffer.from(sealed).toString();
    const H = `h_${"1".repeat(32)}`;
    const states = createSyncStates({ dir, seal, open });
    const state = runState({ lastOutcome: "stopped" });
    const retryAt = notePause(state, "paused", NOW);
    states.set("test", H, "walmart", state);

    const back = createSyncStates({ dir, seal, open }).get("test", H, "walmart");
    assert.equal(back.retryAt, retryAt);
    assert.equal(back.troubledRuns, 1);
    assert.equal(createSyncStates({ dir, seal, open }).get("test", H, "amazon").retryAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the error pages counted against an order are remembered across a restart, and still set it aside", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createSyncStates } = await import("./sync-plan.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-trouble-"));
  try {
    const seal = (text) => Buffer.from(text);
    const open = (sealed) => Buffer.from(sealed).toString();
    const H = `h_${"1".repeat(32)}`;
    const restart = () => createSyncStates({ dir, seal, open });

    let state = runState({ queue: [queued(BROKEN, "2026-10-21"), queued("200000000000001", "2026-10-18")] });
    for (let run = 1; run < MAX_TROUBLES; run += 1) {
      runWith(state, new Set([BROKEN]));
      restart().set("test", H, "walmart", state);
      // The app restarts between every run.
      state = restart().get("test", H, "walmart");
      assert.equal(state.queue.find((q) => q.id === BROKEN)?.troubles, run);
    }
    runWith(state, new Set([BROKEN]));
    restart().set("test", H, "walmart", state);
    const back = restart().get("test", H, "walmart");
    assert.equal(back.queue.find((q) => q.id === BROKEN)?.troubles, MAX_TROUBLES);
    assert.equal(setAsideCount(back.queue), 1);
    assert.deepEqual(stillToOpen(back.queue), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
