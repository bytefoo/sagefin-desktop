import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { walmart } from "./retailers.mjs";
import { HISTORY_DAYS, MAX_LIST_PAGES_PER_RUN, MAX_ORDERS_PER_RUN, SCHEDULE_EVERY_MS, createSyncStates, nextScheduledRunAt, ordersToOpen, readListPage, scheduleEveryMs, scheduledRunAtMs, scheduledRunDue, showWindowForMemberSync } from "./sync-plan.mjs";

const seal = (plaintext) => Buffer.from(`sealed:${[...plaintext].reverse().join("")}`);
const open = (sealed) => [...Buffer.from(sealed).toString().slice("sealed:".length)].reverse().join("");

const listPage = (orders) =>
  JSON.stringify({ props: { pageProps: { phRedesignInitialData: { data: { purchaseHistory: { orders } } } } } });

const order = (id, extra = {}) => ({
  id,
  version: 0,
  itemCount: 2,
  priceDetails: { orderTotal: { value: 42.5 } },
  groups: [{ groupId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", items: [{ id: "1", statusCode: "3700.0031", isUnavailable: false }, { id: "2", statusCode: "3700.0031", isUnavailable: false }] }],
  ...extra,
});

// ---- what Purchase history lists ------------------------------------------------------------

test("each listed order gives its number and the address of its own page", () => {
  const listed = walmart.listedOrders(listPage([order("200000000000001"), order("200000000000002", { groups: [] })]));

  assert.deepEqual(listed.map((o) => [o.id, o.url]), [
    ["200000000000001", "https://www.walmart.com/orders/200000000000001?groupId=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
    ["200000000000002", "https://www.walmart.com/orders/200000000000002"],
  ]);
});

// The id goes into a URL the app then loads.
test("an order whose number is not a number is not opened", () => {
  const listed = walmart.listedOrders(
    listPage([order("200000000000001"), order("../account"), order("1?x=https://example.com"), order(""), { groups: [] }, null]),
  );

  assert.deepEqual(listed.map((o) => o.id), ["200000000000001"]);
});

test("a group id that is not one is left out of the address, and the order is still opened", () => {
  const [listed] = walmart.listedOrders(listPage([order("200000000000001", { groups: [{ groupId: "x&redirect=evil", items: [] }] })]));

  assert.equal(listed.url, "https://www.walmart.com/orders/200000000000001");
});

test("a page that is not Purchase history lists nothing", () => {
  for (const payload of ["", "not json", "{}", listPage(undefined), JSON.stringify({ props: { pageProps: { phRedesignInitialData: { data: { purchaseHistory: {} } } } } })]) {
    assert.deepEqual(walmart.listedOrders(payload), []);
  }
});

// Measured on 2026-10-02: Walmart reorders an order's cancel reasons and renumbers its feedback
// prompts on every load, so the whole entry hashed differently three times in two hours.
test("an order's fingerprint ignores what Walmart reshuffles on every load", () => {
  const first = order("200000000000001", {
    groups: [{ groupId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", cancelReasons: [{ subReasonCode: "A" }, { subReasonCode: "B" }], customerFeedback: { createdId: "one" }, items: [{ id: "1", statusCode: "3700.0031", isUnavailable: false }] }],
  });
  const reloaded = order("200000000000001", {
    groups: [{ groupId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", cancelReasons: [{ subReasonCode: "B" }, { subReasonCode: "A" }], customerFeedback: { createdId: "two" }, items: [{ id: "1", statusCode: "3700.0031", isUnavailable: false }] }],
  });

  assert.equal(walmart.listedOrders(listPage([first]))[0].fingerprint, walmart.listedOrders(listPage([reloaded]))[0].fingerprint);
});

test("an order's fingerprint changes when the order does", () => {
  const print = (o) => walmart.listedOrders(listPage([o]))[0].fingerprint;
  const base = order("200000000000001");

  assert.notEqual(print(order("200000000000001", { version: 1 })), print(base));
  assert.notEqual(print(order("200000000000001", { itemCount: 3 })), print(base));
  assert.notEqual(print(order("200000000000001", { priceDetails: { orderTotal: { value: 40.0 } } })), print(base));
  const delivered = structuredClone(base);
  delivered.groups[0].items[0].statusCode = "9000.450";
  assert.notEqual(print(delivered), print(base));
});

test("an order page says which order it holds, and any other page says none", () => {
  const page = (o) => JSON.stringify({ props: { pageProps: { initialData: { data: { order: o } } } } });

  assert.equal(walmart.orderIdIn(page({ id: "200000000000001" })), "200000000000001");
  assert.equal(walmart.orderIdIn(page(null)), null);
  assert.equal(walmart.orderIdIn(listPage([order("200000000000001")])), null);
  assert.equal(walmart.orderIdIn("not json"), null);
});

// ---- which of them a run opens --------------------------------------------------------------

const listed = (id, fingerprint) => ({ id, url: `https://www.walmart.com/orders/${id}`, fingerprint });

test("a run opens what it has never read and what has changed, and nothing else", () => {
  const list = [listed("3", "c"), listed("2", "b2"), listed("1", "a")];

  assert.deepEqual(ordersToOpen(list, { 1: "a", 2: "b" }).map((o) => o.id), ["3", "2"]);
  assert.deepEqual(ordersToOpen(list, { 1: "a", 2: "b2", 3: "c" }), []);
  assert.deepEqual(ordersToOpen(list, {}).map((o) => o.id), ["3", "2", "1"]);
});

test("a first run on a long list is bounded, newest first", () => {
  const long = Array.from({ length: 60 }, (_, i) => listed(String(1000 + i), "x"));

  const opened = ordersToOpen(long, {});

  assert.equal(opened.length, MAX_ORDERS_PER_RUN);
  assert.equal(opened[0].id, "1000");
});

// ---- when a run starts by itself ------------------------------------------------------------

test("no run starts by itself until one the member started has finished", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const state = (lastFinishedAt) => ({ seen: {}, lastFinishedAt, lastResult: null, lastRunAt: null });

  assert.equal(scheduledRunDue(state(null), now), false);
  assert.equal(scheduledRunDue(state("not a date"), now), false);
  assert.equal(scheduledRunDue(state(new Date(now - SCHEDULE_EVERY_MS + 1000).toISOString()), now), false);
  assert.equal(scheduledRunDue(state(new Date(now - SCHEDULE_EVERY_MS).toISOString()), now), true);
});

// ---- what is remembered ---------------------------------------------------------------------

function states(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-desktop-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, sync: createSyncStates({ dir, seal, open }) };
}

test("what a sync has read is remembered, sealed, per site and retailer", (t) => {
  const { dir, sync } = states(t);
  const state = { seen: { "200000000000001": "abc" }, lastFinishedAt: "2026-10-02T12:00:00.000Z", lastResult: "Read 1 order.", lastRunAt: "2026-10-02T12:00:00.000Z", lastRunBy: "member", lastOutcome: "finished", lastOrders: 1, caughtUp: true, listedThroughPage: null, refusedAt: null };

  sync.set("prod", "walmart", state);

  assert.deepEqual(sync.get("prod", "walmart"), state);
  assert.deepEqual(sync.get("test", "walmart").seen, {});
  assert.deepEqual(sync.get("prod", "costco").seen, {});
  for (const name of readdirSync(dir)) {
    assert.ok(!readFileSync(path.join(dir, name), "utf8").includes("200000000000001"), `${name} holds an order number in the clear`);
  }
});

// A memory written before a run's outcome and count were kept has neither. That is "not recorded":
// never "stopped", and never zero orders.
test("a memory from before outcomes were kept says nothing about how its run ended", (t) => {
  const { sync } = states(t);
  sync.set("prod", "walmart", /** @type {any} */ ({ seen: {}, lastFinishedAt: "2026-10-02T12:00:00.000Z", lastRunAt: "2026-10-02T12:00:00.000Z", lastRunBy: "member" }));
  sync.set("prod", "amazon", /** @type {any} */ ({ seen: {}, lastOutcome: "great", lastOrders: -3 }));

  assert.equal(sync.get("prod", "walmart").lastOutcome, null);
  assert.equal(sync.get("prod", "walmart").lastOrders, null);
  assert.equal(sync.get("prod", "amazon").lastOutcome, null);
  assert.equal(sync.get("prod", "amazon").lastOrders, null);
});

// Unreadable is "nothing remembered": the next run reads everything again and loses nothing.
test("a memory that cannot be read is an empty one", (t) => {
  const { dir, sync } = states(t);
  writeFileSync(path.join(dir, "sync-prod-walmart.bin"), "garbage");

  assert.deepEqual(sync.get("prod", "walmart"), {
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
  assert.throws(() => sync.get("../x", "walmart"), /Not a sync state key/);
});

// ---- paging through Purchase history ----------------------------------------------------------

const NOW = new Date("2026-10-02T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);
const entry = (id, date = daysAgo(1), fingerprint = `fp-${id}`) => ({ id, url: `https://www.walmart.com/orders/${id}`, fingerprint, date });
const page = (from, count = 5, date) => Array.from({ length: count }, (_, i) => entry(String(200000000000000 + from + i), date));
const step = (overrides) =>
  readListPage({ pageOrders: [], listed: [], seen: {}, caughtUp: false, hasNextPage: true, pagesRead: 1, now: NOW, ...overrides });

test("a page with orders to open and another after it asks for the next", () => {
  const result = step({ pageOrders: page(1) });

  assert.equal(result.fresh.length, 5);
  assert.deepEqual([result.more, result.end], [true, false]);
});

test("the last page of the history ends the listing, and says it reached the end", () => {
  assert.deepEqual(
    (({ more, end }) => [more, end])(step({ pageOrders: page(1), hasNextPage: false })),
    [false, true],
  );
});

test("orders older than the history worth reading are left out, and reaching them is the end", () => {
  const pageOrders = [entry("200000000000001", daysAgo(10)), entry("200000000000002", daysAgo(HISTORY_DAYS + 5))];

  const result = step({ pageOrders });

  assert.deepEqual(result.fresh.map((o) => o.id), ["200000000000001"]);
  assert.deepEqual([result.more, result.end], [false, true]);
});

// Leaving an order out is worse than opening one too old to match.
test("an order the list gives no date for is kept", () => {
  assert.equal(step({ pageOrders: [entry("200000000000001", null)] }).fresh.length, 1);
});

// What a retailer that ignored ?page= would look like: the first page again.
test("a page that lists only what this run has already seen stops the listing, and is not an end", () => {
  const first = page(1);

  const result = step({ pageOrders: first, listed: first, pagesRead: 2 });

  assert.deepEqual([result.fresh, result.more, result.end], [[], false, false]);
});

test("a run stops listing once enough orders are waiting to fill it", () => {
  const before = page(1, MAX_ORDERS_PER_RUN - 3);

  const result = step({ pageOrders: page(100), listed: before, pagesRead: 4 });

  assert.equal(result.fresh.length, 5, "the whole page is kept, for the next run to resume on");
  assert.deepEqual([result.more, result.end], [false, false]);
});

test("a run reads no more than its share of pages", () => {
  assert.equal(step({ pageOrders: page(1), pagesRead: MAX_LIST_PAGES_PER_RUN - 1 }).more, true);
  assert.equal(step({ pageOrders: page(1), pagesRead: MAX_LIST_PAGES_PER_RUN }).more, false);
});

// Before catching up, read pages are passed over on the way to unread ones.
test("before the history is caught up, a page with nothing to open still leads to the next", () => {
  const first = page(1);
  const seen = Object.fromEntries(first.map((o) => [o.id, o.fingerprint]));

  assert.equal(step({ pageOrders: first, seen }).more, true);
});

test("once caught up, a page with nothing to open is where a daily run stops", () => {
  const first = page(1);
  const seen = Object.fromEntries(first.map((o) => [o.id, o.fingerprint]));

  assert.deepEqual((({ more, end }) => [more, end])(step({ pageOrders: first, seen, caughtUp: true })), [false, false]);
  // A day with more than a page of new orders still reads on.
  assert.equal(step({ pageOrders: page(50), seen, caughtUp: true }).more, true);
});

test("where catching up resumes is remembered, and only as a page past the first", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-state-"));
  try {
    const states = createSyncStates({ dir, seal, open });
    assert.deepEqual([states.get("test", "walmart").caughtUp, states.get("test", "walmart").listedThroughPage], [false, null]);

    states.set("test", "walmart", { ...states.get("test", "walmart"), listedThroughPage: 4 });
    assert.equal(states.get("test", "walmart").listedThroughPage, 4);

    for (const bad of [1, 0, -2, 2.5, "4", null]) {
      states.set("test", "walmart", { ...states.get("test", "walmart"), listedThroughPage: bad });
      assert.equal(states.get("test", "walmart").listedThroughPage, null, `${bad}`);
    }

    states.set("test", "walmart", { ...states.get("test", "walmart"), caughtUp: "yes" });
    assert.equal(states.get("test", "walmart").caughtUp, false, "only a stored true is caught up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- after a refusal ------------------------------------------------------------------------------

// The rule from the 2026-09-28 Walmart lockout, and Amazon's Agent Terms: a retailer that turned a run
// away is not asked again by a schedule. Only the member's own Sync now tries once more.
test("no scheduled run starts after the retailer turned one away", () => {
  const finishedLongAgo = { seen: {}, lastFinishedAt: "2026-09-01T00:00:00.000Z", lastResult: null, lastRunAt: null, caughtUp: true, listedThroughPage: null };
  const now = Date.parse("2026-10-02T00:00:00.000Z");

  assert.equal(scheduledRunDue({ ...finishedLongAgo, refusedAt: null }, now), true);
  assert.equal(scheduledRunDue({ ...finishedLongAgo, refusedAt: "2026-09-02T00:00:00.000Z" }, now), false);
});

test("the next scheduled run is a day after the last finished one, and none is due where none will start", () => {
  const base = { seen: {}, lastResult: null, lastRunAt: null, lastRunBy: null, caughtUp: false, listedThroughPage: null, refusedAt: null };
  assert.equal(nextScheduledRunAt({ ...base, lastFinishedAt: "2026-10-03T06:51:00.000Z" }), "2026-10-04T06:51:00.000Z");
  // No sync the member started has finished: there is no schedule to describe.
  assert.equal(nextScheduledRunAt({ ...base, lastFinishedAt: null }), null);
  // Turned away: no scheduled run starts, so none is promised.
  assert.equal(nextScheduledRunAt({ ...base, lastFinishedAt: "2026-10-03T06:51:00.000Z", refusedAt: "2026-10-03T07:00:00.000Z" }), null);
  assert.equal(nextScheduledRunAt({ ...base, lastFinishedAt: "not a time" }), null);
  // It agrees with the rule that starts the run.
  const due = Date.parse(/** @type {string} */ (nextScheduledRunAt({ ...base, lastFinishedAt: "2026-10-03T06:51:00.000Z" })));
  assert.equal(scheduledRunDue({ ...base, lastFinishedAt: "2026-10-03T06:51:00.000Z" }, due), true);
  assert.equal(scheduledRunDue({ ...base, lastFinishedAt: "2026-10-03T06:51:00.000Z" }, due - 1), false);
});

test("who started the last run is remembered, and a memory from before it was kept says nobody did", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-sync-by-"));
  const states = createSyncStates({ dir, seal, open });
  assert.equal(states.get("prod", "walmart").lastRunBy, null);
  const state = states.get("prod", "walmart");
  states.set("prod", "walmart", { ...state, lastRunBy: "schedule" });
  assert.equal(states.get("prod", "walmart").lastRunBy, "schedule");
  // Anything else on disk is not a guess at either.
  states.set("prod", "walmart", /** @type {any} */ ({ ...state, lastRunBy: "robot" }));
  assert.equal(states.get("prod", "walmart").lastRunBy, null);
  rmSync(dir, { recursive: true, force: true });
});

test("an installed app schedules daily, whatever it is told", () => {
  assert.equal(scheduleEveryMs(undefined, true), SCHEDULE_EVERY_MS);
  assert.equal(scheduleEveryMs("5", true), SCHEDULE_EVERY_MS);
});

test("a run from source may shorten the wait, to no less than a minute", () => {
  assert.equal(scheduleEveryMs("5", false), 5 * 60 * 1000);
  assert.equal(scheduleEveryMs("1", false), 60 * 1000);
  assert.equal(scheduleEveryMs(undefined, false), SCHEDULE_EVERY_MS);
  // A typo, zero or a negative number is a day, never a loop.
  for (const bad of ["", "0", "0.5", "-3", "soon", "NaN"]) assert.equal(scheduleEveryMs(bad, false), SCHEDULE_EVERY_MS, bad);
});

test("a shortened wait decides when a run is due and when the next one is", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const base = { seen: {}, lastResult: null, lastRunAt: null, lastRunBy: null, lastOutcome: null, lastOrders: null, caughtUp: false, listedThroughPage: null, refusedAt: null };
  const finished = { ...base, lastFinishedAt: "2026-10-03T11:50:00.000Z" };

  assert.equal(scheduledRunDue(finished, now), false);
  assert.equal(scheduledRunDue(finished, now, 5 * 60 * 1000), true);
  assert.equal(scheduledRunDue(finished, now, 15 * 60 * 1000), false);
  assert.equal(nextScheduledRunAt(finished, 5 * 60 * 1000), "2026-10-03T11:55:00.000Z");
});

const memory = (over = {}) => ({
  seen: {}, lastFinishedAt: null, lastResult: null, lastRunAt: null, lastRunBy: null, lastOutcome: null, lastOrders: null,
  caughtUp: false, listedThroughPage: null, refusedAt: null, ...over,
});
const AT = "2026-10-03T12:00:00.000Z";

test("the first sync of a retailer here shows its window: the member will have to sign in", () => {
  assert.equal(showWindowForMemberSync(memory()), true);
});

test("after a run that finished, the member's next sync works out of the way", () => {
  assert.equal(showWindowForMemberSync(memory({ lastFinishedAt: AT, lastRunAt: AT, lastOutcome: "finished" })), false);
});

test("after a run that did not reach its end, the window shows: the retailer said something", () => {
  for (const lastOutcome of ["refused", "signed_out", "stopped"]) {
    assert.equal(showWindowForMemberSync(memory({ lastFinishedAt: "2026-10-01T12:00:00.000Z", lastRunAt: AT, lastOutcome })), true, lastOutcome);
  }
  // Turned away and not yet cleared, whatever the last outcome says.
  assert.equal(showWindowForMemberSync(memory({ lastFinishedAt: AT, lastRunAt: AT, lastOutcome: "finished", refusedAt: AT })), true);
});

test("a memory from before outcomes were kept is read by whether its last run was the one that finished", () => {
  assert.equal(showWindowForMemberSync(memory({ lastFinishedAt: AT, lastRunAt: AT })), false);
  assert.equal(showWindowForMemberSync(memory({ lastFinishedAt: "2026-10-01T12:00:00.000Z", lastRunAt: AT })), true);
});

// Local times throughout: the rule is about what the clock on the wall shows.
const localMs = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();

// The same examples as SageFin's web app's lib/desktop-schedule.test.ts. Change one, change the other.
test("with nothing chosen, or a number of days and no hour, the next run is that long after the last finish", () => {
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 14, 43)), localMs(2026, 10, 4, 14, 43));
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 14, 43), SCHEDULE_EVERY_MS, { preferredHour: null, everyDays: 1 }), localMs(2026, 10, 4, 14, 43));
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 14, 43), SCHEDULE_EVERY_MS, { preferredHour: null, everyDays: 3 }), localMs(2026, 10, 6, 14, 43));
});

test("with an hour chosen, the next run is the next time the clock shows it", () => {
  const at7 = { preferredHour: 7, everyDays: 1 };
  // Sync now in the afternoon: tomorrow morning, not the same time tomorrow.
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 14, 43), SCHEDULE_EVERY_MS, at7), localMs(2026, 10, 4, 7));
  // A scheduled run at 7:20: tomorrow at 7, a little under a day later.
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 7, 20), SCHEDULE_EVERY_MS, at7), localMs(2026, 10, 4, 7));
});

test("a sync that finished shortly before the hour does not run again the same morning", () => {
  const at7 = { preferredHour: 7, everyDays: 1 };
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 6, 30), SCHEDULE_EVERY_MS, at7), localMs(2026, 10, 4, 7));
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 18, 0), SCHEDULE_EVERY_MS, at7), localMs(2026, 10, 4, 7));
  // After 7 PM, half a day has not passed by 7 the next morning.
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 21, 0), SCHEDULE_EVERY_MS, at7), localMs(2026, 10, 5, 7));
});

test("the chosen number of days passes before the hour is looked for", () => {
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 7, 20), SCHEDULE_EVERY_MS, { preferredHour: 7, everyDays: 2 }), localMs(2026, 10, 5, 7));
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 7, 20), SCHEDULE_EVERY_MS, { preferredHour: 7, everyDays: 7 }), localMs(2026, 10, 10, 7));
});

test("a schedule is never more often than daily, whatever it is handed", () => {
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 14, 43), SCHEDULE_EVERY_MS, { preferredHour: null, everyDays: 0 }), localMs(2026, 10, 4, 14, 43));
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 14, 43), SCHEDULE_EVERY_MS, { preferredHour: null, everyDays: -5 }), localMs(2026, 10, 4, 14, 43));
});

test("a development run's shortened wait is obeyed over any choice", () => {
  const five = 5 * 60 * 1000;
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 14, 43), five, { preferredHour: 7, everyDays: 7 }), localMs(2026, 10, 3, 14, 48));
});

test("due, and the next time, follow what the member chose", () => {
  const finished = { ...memory(), lastFinishedAt: new Date(localMs(2026, 10, 3, 14, 43)).toISOString(), lastRunAt: new Date(localMs(2026, 10, 3, 14, 43)).toISOString() };
  const at7 = { preferredHour: 7, everyDays: 1 };

  assert.equal(scheduledRunDue(finished, localMs(2026, 10, 4, 6, 59), SCHEDULE_EVERY_MS, at7), false);
  assert.equal(scheduledRunDue(finished, localMs(2026, 10, 4, 7, 0), SCHEDULE_EVERY_MS, at7), true);
  // Without the choice it would have waited until 2:43 PM.
  assert.equal(scheduledRunDue(finished, localMs(2026, 10, 4, 7, 0)), false);
  assert.equal(nextScheduledRunAt(finished, SCHEDULE_EVERY_MS, at7), new Date(localMs(2026, 10, 4, 7)).toISOString());
  // A retailer that turned a run away is not due at any hour.
  assert.equal(scheduledRunDue({ ...finished, refusedAt: finished.lastFinishedAt }, localMs(2026, 10, 9, 7), SCHEDULE_EVERY_MS, at7), false);
});
