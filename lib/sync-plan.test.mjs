import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { walmart } from "./retailers.mjs";
import { emptySetup } from "./history.mjs";
import { CATCH_UP_EVERY_MS, MAX_ORDERS_PER_RUN, SCHEDULE_EVERY_MS, catchingUp, createSyncStates, nextScheduledRunAt, scheduleEveryMs, scheduleStopped, scheduledRunAtMs, scheduledRunDue, showWindowForMemberSync } from "./sync-plan.mjs";

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

// Seen on 2026-10-25: an in-store purchase's page is filled only at `?groupId=0&storePurchase=true`;
// the online form of its address gives Walmart's header and nothing else.
test("an in-store purchase opens at the address Walmart fills for one", () => {
  const inStore = (id, groupId, extra = {}) =>
    order(id, { isInStore: true, groups: [{ groupId, items: [{ id: "1", statusCode: "3700.0031", isUnavailable: false }] }], ...extra });

  const listed = walmart.listedOrders(
    listPage([
      inStore("200000000000003", "0"),
      inStore("200000000000004", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"),
      order("200000000000005", { isInStore: false }),
      order("200000000000006", { isInStore: "true" }),
    ]),
  );

  assert.deepEqual(listed.map((o) => [o.id, o.url]), [
    ["200000000000003", "https://www.walmart.com/orders/200000000000003?groupId=0&storePurchase=true"],
    ["200000000000004", "https://www.walmart.com/orders/200000000000004?groupId=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6&storePurchase=true"],
    // Bought online: the address it always had.
    ["200000000000005", "https://www.walmart.com/orders/200000000000005?groupId=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
    // Only `true` itself says in-store.
    ["200000000000006", "https://www.walmart.com/orders/200000000000006?groupId=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
  ]);
});

// Seen on 2026-10-25: an in-store purchase's own page has `type: "IN_STORE"` and no `isInStore`, and
// online orders in the list are `type: "GLASS"`. Either marking makes an order in-store.
test("an order whose type is IN_STORE is an in-store purchase too, with or without isInStore", () => {
  const typed = (id, type, extra = {}) =>
    order(id, { type, groups: [{ groupId: "0", items: [{ id: "1", statusCode: "3700.0031", isUnavailable: false }] }], ...extra });

  const listed = walmart.listedOrders(
    listPage([
      typed("200000000000000000007", "IN_STORE"),
      typed("200000000000000000008", "IN_STORE", { isInStore: false }),
      typed("200000000000000000009", "GLASS", { isInStore: true }),
      order("200000000000010", { type: "GLASS", isInStore: false }),
      typed("200000000000011", "in_store"),
      typed("200000000000012", ["IN_STORE"]),
    ]),
  );

  assert.deepEqual(listed.map((o) => [o.id, o.url]), [
    ["200000000000000000007", "https://www.walmart.com/orders/200000000000000000007?groupId=0&storePurchase=true"],
    ["200000000000000000008", "https://www.walmart.com/orders/200000000000000000008?groupId=0&storePurchase=true"],
    ["200000000000000000009", "https://www.walmart.com/orders/200000000000000000009?groupId=0&storePurchase=true"],
    ["200000000000010", "https://www.walmart.com/orders/200000000000010?groupId=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"],
    // Only "IN_STORE" exactly; anything else is an online order, whose group id "0" is not one.
    ["200000000000011", "https://www.walmart.com/orders/200000000000011"],
    ["200000000000012", "https://www.walmart.com/orders/200000000000012"],
  ]);
});

test("an in-store purchase's group id is still only digits or hex, and is left out when it is not", () => {
  const inStore = (groupId) => order("200000000000003", { isInStore: true, groups: [{ groupId, items: [] }] });

  for (const bad of ["0&redirect=evil", "", " 0", "0\n", "-1", "g", "0".repeat(65), 0, null]) {
    const [listed] = walmart.listedOrders(listPage([inStore(bad)]));
    assert.equal(listed.url, "https://www.walmart.com/orders/200000000000003?storePurchase=true", JSON.stringify(bad));
  }
  // A short group id is only accepted for an in-store purchase: an online order's is long hex.
  const [online] = walmart.listedOrders(listPage([order("200000000000005", { groups: [{ groupId: "0", items: [] }] })]));
  assert.equal(online.url, "https://www.walmart.com/orders/200000000000005");
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

  const items = [{ items: [{ id: "1" }] }];
  assert.equal(walmart.orderIdIn(page({ id: "200000000000001", groups_2101: items })), "200000000000001");
  assert.equal(walmart.orderIdIn(page({ id: "200000000000001", groups: items })), "200000000000001");
  assert.equal(walmart.orderIdIn(page(null)), null);
  assert.equal(walmart.orderIdIn(listPage([order("200000000000001")])), null);
  assert.equal(walmart.orderIdIn("not json"), null);
});

// A page Walmart could not fill still names the order it was asked for, and sometimes still has a
// __NEXT_DATA__ with an order object in it. Counted as read, the order would never be opened again.
test("an order page with no order on it is not the order's page, so the order stays to be read", () => {
  const page = (o) => JSON.stringify({ props: { pageProps: { initialData: { data: { order: o } } } } });

  for (const empty of [
    { id: "200000000000001" },
    { id: "200000000000001", groups_2101: [] },
    { id: "200000000000001", groups_2101: null },
    { id: "200000000000001", groups_2101: "x" },
    { id: "200000000000001", groupsX: [{ items: [] }] },
    { id: "200000000000001", errors: [{ code: "WCP_ORDER_FAIL" }] },
    { id: "", groups_2101: [{ items: [] }] },
    { groups_2101: [{ items: [] }] },
    [],
    "200000000000001",
  ]) {
    assert.equal(walmart.orderIdIn(page(empty)), null, JSON.stringify(empty));
  }
  assert.equal(walmart.orderIdIn(JSON.stringify({ props: { pageProps: { errorCode: "WCP_ORDER_FAIL" } } })), null);
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
  const state = { seen: { "200000000000001": "abc" }, lastFinishedAt: "2026-10-02T12:00:00.000Z", lastResult: "Read 1 order.", lastRunAt: "2026-10-02T12:00:00.000Z", lastRunBy: "member", lastOutcome: "finished", lastOrders: 1, refusedAt: null, queue: [{ id: "200000000000002", url: "https://www.walmart.com/orders/200000000000002", fingerprint: "def", date: "2026-10-01" }], charges: {}, setup: { ...emptySetup(), status: /** @type {const} */ ("done"), reachedDate: "2025-01-02", listedIds: ["200000000000001", "200000000000002"] } };

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
    refusedAt: null,
    queue: [],
    charges: {},
    setup: emptySetup(),
  });
  assert.throws(() => sync.get("../x", "walmart"), /Not a sync state key/);
});

// ---- after a refusal ------------------------------------------------------------------------------

// The rule from the 2026-09-28 Walmart lockout, and Amazon's Agent Terms: a retailer that turned a run
// away is not asked again by a schedule. Only the member's own Sync now tries once more.
test("no scheduled run starts after the retailer turned one away", () => {
  const finishedLongAgo = { seen: {}, lastFinishedAt: "2026-09-01T00:00:00.000Z", lastResult: null, lastRunAt: null, queue: [], charges: {}, setup: emptySetup() };
  const now = Date.parse("2026-10-02T00:00:00.000Z");

  assert.equal(scheduledRunDue({ ...finishedLongAgo, refusedAt: null }, now), true);
  assert.equal(scheduledRunDue({ ...finishedLongAgo, refusedAt: "2026-09-02T00:00:00.000Z" }, now), false);
});

test("the next scheduled run is a day after the last finished one, and none is due where none will start", () => {
  const base = { seen: {}, lastResult: null, lastRunAt: null, lastRunBy: null, queue: [], charges: {}, setup: emptySetup(), refusedAt: null };
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
  const base = { seen: {}, lastResult: null, lastRunAt: null, lastRunBy: null, lastOutcome: null, lastOrders: null, queue: [], charges: {}, setup: emptySetup(), refusedAt: null };
  const finished = { ...base, lastFinishedAt: "2026-10-03T11:50:00.000Z" };

  assert.equal(scheduledRunDue(finished, now), false);
  assert.equal(scheduledRunDue(finished, now, 5 * 60 * 1000), true);
  assert.equal(scheduledRunDue(finished, now, 15 * 60 * 1000), false);
  assert.equal(nextScheduledRunAt(finished, 5 * 60 * 1000), "2026-10-03T11:55:00.000Z");
});

// A run that opened as many orders as a run may has perhaps left some unopened. The next starts an
// hour later, at the same pace and under the same cap, until one opens fewer.
test("a run that stopped at the cap with orders still to read is followed an hour later, whatever was chosen", () => {
  const base = { seen: {}, lastResult: null, lastRunAt: null, lastRunBy: null, queue: [], charges: {}, setup: emptySetup(), refusedAt: null };
  const at = "2026-10-03T06:51:00.000Z";
  const left = [{ id: "1", url: "https://www.walmart.com/orders/1", fingerprint: "x", date: null }];
  const capped = { ...base, queue: left, lastFinishedAt: at, lastOutcome: /** @type {const} */ ("finished"), lastOrders: MAX_ORDERS_PER_RUN };
  const daily7 = { preferredHour: 7, everyDays: 1 };
  const weekly = { preferredHour: null, everyDays: 7 };

  assert.equal(catchingUp(capped), true);
  assert.equal(nextScheduledRunAt(capped), "2026-10-03T07:51:00.000Z");
  assert.equal(nextScheduledRunAt(capped, SCHEDULE_EVERY_MS, daily7), "2026-10-03T07:51:00.000Z");
  assert.equal(nextScheduledRunAt(capped, SCHEDULE_EVERY_MS, weekly), "2026-10-03T07:51:00.000Z");
  assert.equal(scheduledRunAtMs(Date.parse(at), SCHEDULE_EVERY_MS, daily7, true), Date.parse(at) + CATCH_UP_EVERY_MS);
  const due = Date.parse(at) + CATCH_UP_EVERY_MS;
  assert.equal(scheduledRunDue(capped, due, SCHEDULE_EVERY_MS, weekly), true);
  assert.equal(scheduledRunDue(capped, due - 1, SCHEDULE_EVERY_MS, weekly), false);

  // Fewer than the cap: everything found was opened, and the member's schedule is back.
  const done = { ...capped, lastOrders: MAX_ORDERS_PER_RUN - 1 };
  assert.equal(catchingUp(done), false);
  assert.equal(nextScheduledRunAt(done), "2026-10-04T06:51:00.000Z");
  assert.equal(nextScheduledRunAt({ ...capped, lastOrders: 0 }), "2026-10-04T06:51:00.000Z");
  // The cap reached and nothing left on the to-do list: the member's schedule is back too.
  assert.equal(catchingUp({ ...capped, queue: [] }), false);
  // Nobody counted, or the run did not finish: nothing is known about what is left.
  assert.equal(catchingUp({ ...capped, lastOrders: null }), false);
  assert.equal(catchingUp({ ...capped, lastOutcome: "stopped" }), false);
  assert.equal(catchingUp({ ...capped, lastOutcome: null }), false);

  // Turned away: catching up does not bring the schedule back.
  assert.equal(nextScheduledRunAt({ ...capped, refusedAt: "2026-10-03T07:00:00.000Z" }), null);
  assert.equal(scheduledRunDue({ ...capped, refusedAt: "2026-10-03T07:00:00.000Z" }, due + SCHEDULE_EVERY_MS), false);
  // A run from source that shortens the wait still has the last word.
  assert.equal(nextScheduledRunAt(capped, 5 * 60 * 1000), "2026-10-03T06:56:00.000Z");
});

const memory = (over = {}) => ({
  seen: {}, lastFinishedAt: null, lastResult: null, lastRunAt: null, lastRunBy: null, lastOutcome: null, lastOrders: null,
  queue: [], charges: {}, setup: emptySetup(), refusedAt: null, ...over,
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
  // A late Sync now still leaves the next morning's run: six hours have passed by 7.
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 21, 0), SCHEDULE_EVERY_MS, at7), localMs(2026, 10, 4, 7));
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 22, 35), SCHEDULE_EVERY_MS, { preferredHour: 6, everyDays: 1 }), localMs(2026, 10, 4, 6));
  // In the small hours, six hours have not passed by 7 the same morning.
  assert.equal(scheduledRunAtMs(localMs(2026, 10, 3, 2, 0), SCHEDULE_EVERY_MS, at7), localMs(2026, 10, 4, 7));
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

test("a run that met the retailer's sign-in page stops the schedule on this computer", () => {
  const longAgo = "2026-09-01T12:00:00.000Z";
  const signedOut = memory({ lastFinishedAt: longAgo, lastRunAt: AT, lastOutcome: "signed_out" });
  const now = Date.parse("2026-10-10T12:00:00.000Z");

  assert.equal(scheduleStopped(signedOut), true);
  // Due many times over by the clock, and still not started: it would load a sign-in page and leave.
  assert.equal(scheduledRunDue(signedOut, now), false);
  assert.equal(nextScheduledRunAt(signedOut), null);
});

test("the member's own sync, however it ends, is what starts the schedule again", () => {
  const longAgo = "2026-09-01T12:00:00.000Z";
  const now = Date.parse("2026-10-10T12:00:00.000Z");

  // They signed in and Sync now finished.
  const finished = memory({ lastFinishedAt: longAgo, lastRunAt: longAgo, lastOutcome: "finished" });
  assert.equal(scheduleStopped(finished), false);
  assert.equal(scheduledRunDue(finished, now), true);
  // A run that merely stopped (the retailer could not be reached) is tried again by the schedule.
  const stopped = memory({ lastFinishedAt: longAgo, lastRunAt: AT, lastOutcome: "stopped" });
  assert.equal(scheduleStopped(stopped), false);
  assert.equal(scheduledRunDue(stopped, now), true);
});

test("a refusal still stops the schedule, and a memory from before outcomes were kept does not", () => {
  assert.equal(scheduleStopped(memory({ lastFinishedAt: AT, lastRunAt: AT, lastOutcome: "refused", refusedAt: AT })), true);
  assert.equal(scheduleStopped(memory({ lastFinishedAt: AT, lastRunAt: AT })), false);
});
