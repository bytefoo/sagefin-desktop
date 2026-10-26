// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIST_KINDS,
  MAX_CHARGES,
  MAX_MISSES,
  SETTLING_DAYS,
  dropOlderThan,
  dropRead,
  emptySetup,
  enqueue,
  howFarBackDate,
  isSetAside,
  longDate,
  markRead,
  nextToOpen,
  noteCharges,
  noteMissed,
  setAsideCount,
  stillToOpen,
  waitingCount,
  awaitRelist,
  noteSetup,
  reachedReadCharge,
  readCharges,
  readQueue,
  readSetup,
  readsBackTo,
  settledListing,
  startOver,
  stripText,
} from "./history.mjs";
import { amazon, walmart } from "./retailers.mjs";

/** @returns {import("./history.mjs").HistoryState} */
const fresh = () => ({ seen: {}, queue: [], charges: {}, setup: emptySetup() });
/** An online order's facts, as Walmart's list gives them with no group id in the right shape. */
const ONLINE = Object.freeze({ inStore: false, groupId: null });
/** As the list gives an order. @param {string} id @param {string | null} date @param {string} [fingerprint] */
const order = (id, date, fingerprint = `fp-${id}`) => ({ id, url: `https://www.walmart.com/orders/${id}`, facts: { ...ONLINE }, fingerprint, date });
/** As the to-do list keeps it: no address. @param {string} id @param {string | null} date @param {string} [fingerprint] */
const queued = (id, date, fingerprint = `fp-${id}`) => ({ id, facts: { ...ONLINE }, fingerprint, date });
const NOW = new Date("2026-10-24T12:00:00Z");
/** @param {number} n */
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10);

// ---- the to-do list ---------------------------------------------------------------------------

test("an order a list shows goes on the to-do list once, with what its address is built from and its fingerprint", () => {
  const state = fresh();
  assert.equal(enqueue(state, [order("1", "2026-10-01"), order("2", "2026-09-01")]).added, 2);
  assert.equal(enqueue(state, [order("1", "2026-10-01")]).added, 0);
  // The facts, never the address: a run builds that when it opens the order.
  assert.deepEqual(state.queue, [queued("1", "2026-10-01"), queued("2", "2026-09-01")]);
});

test("an order already read as it is shown is skipped, and said to be", () => {
  const state = fresh();
  state.seen["1"] = "fp-1";
  const { added, alreadyRead } = enqueue(state, [order("1", "2026-10-01"), order("2", "2026-10-02")]);
  assert.equal(added, 1);
  assert.deepEqual(alreadyRead, ["1"]);
  assert.deepEqual(state.queue.map((q) => q.id), ["2"]);
});

test("an order read and changed since goes back on the list, and a listed one takes the change", () => {
  const state = fresh();
  state.seen["1"] = "old";
  enqueue(state, [order("1", "2026-10-01", "new")]);
  assert.deepEqual(state.queue.map((q) => q.fingerprint), ["new"]);
  enqueue(state, [order("1", null, "newer")]);
  assert.deepEqual(state.queue.map((q) => [q.fingerprint, q.date]), [["newer", "2026-10-01"]]);
  // An order whose number names an object property is still an order never read.
  assert.equal(enqueue(fresh(), [order("constructor", null)]).added, 1);
});

test("a run opens the next twenty, newest first, and undated ones after the dated", () => {
  const queue = [order("old", "2025-01-02"), order("none", null), order("new", "2026-10-20"), ...Array.from({ length: 30 }, (_, i) => order(`m${i}`, "2026-05-01"))];
  const next = nextToOpen(queue, 20);
  assert.equal(next.length, 20);
  assert.equal(next[0].id, "new");
  assert.ok(!next.some((o) => o.id === "none" || o.id === "old"));
  assert.deepEqual(nextToOpen([order("none", null), order("old", "2025-01-02")], 20).map((o) => o.id), ["old", "none"]);
  // It only reads the list; nothing is taken off by looking.
  assert.equal(queue.length, 33);
});

test("an order whose page shows no order is opened after the rest, and set aside after three runs", () => {
  const state = fresh();
  enqueue(state, [order("a", "2026-10-20"), order("b", "2026-10-19"), ...Array.from({ length: 25 }, (_, i) => order(`m${i}`, "2026-05-01"))]);
  // Two empty pages, the newest on the list: before, every run met them first and stopped there.
  assert.deepEqual(nextToOpen(state.queue, 20).slice(0, 2).map((o) => o.id), ["a", "b"]);
  assert.equal(noteMissed(state, state.queue[0]), false);
  assert.equal(noteMissed(state, state.queue[1]), false);
  const next = nextToOpen(state.queue, 20).map((o) => o.id);
  assert.ok(!next.includes("a") && !next.includes("b"), "the orders behind them come first now");
  // Once the rest are read, they are tried again, and after MAX_MISSES runs they are set aside.
  for (const id of Array.from({ length: 25 }, (_, i) => `m${i}`)) markRead(state, /** @type {any} */ (state.queue.find((q) => q.id === id)));
  assert.deepEqual(nextToOpen(state.queue, 20).map((o) => o.id), ["a", "b"]);
  for (let run = 2; run <= MAX_MISSES; run += 1) {
    assert.equal(noteMissed(state, state.queue[0]), run === MAX_MISSES);
    noteMissed(state, state.queue[1]);
  }
  assert.ok(state.queue.every(isSetAside));
  assert.deepEqual(nextToOpen(state.queue, 20), []);
  assert.equal(stillToOpen(state.queue).length, 0);
  assert.equal(setAsideCount(state.queue), 2);
  // Still on the list, never past the limit, and kept that way when stored.
  assert.equal(noteMissed(state, state.queue[0]), true);
  assert.equal(state.queue[0].misses, MAX_MISSES);
  assert.deepEqual(readQueue(JSON.parse(JSON.stringify(state.queue))), state.queue);
  // A miss for an order no longer on the list changes nothing.
  assert.equal(noteMissed(state, order("gone", null)), false);
});

test("an order set aside comes back when the list shows it changed, or the member sets up past it", () => {
  const state = fresh();
  enqueue(state, [order("a", "2026-10-20"), order("b", "2026-10-19")]);
  for (let i = 0; i < MAX_MISSES; i += 1) state.queue.forEach((q) => noteMissed(state, q));
  assert.equal(setAsideCount(state.queue), 2);

  // Listed again as it was, by a run: still set aside.
  enqueue(state, [order("a", "2026-10-20"), order("b", "2026-10-19")]);
  assert.equal(setAsideCount(state.queue), 2);

  // Listed changed (here, a new address, as an in-store purchase's became): tried again.
  enqueue(state, [{ ...order("a", "2026-10-20"), facts: { inStore: true, groupId: "0" } }]);
  assert.deepEqual(nextToOpen(state.queue, 20).map((o) => o.id), ["a"]);
  assert.equal(state.queue[0].misses, undefined);

  // The member's own browsing past it while setting up: tried again.
  enqueue(state, [order("b", "2026-10-19")], { retry: true });
  assert.equal(setAsideCount(state.queue), 0);
  assert.equal(state.queue.find((q) => q.id === "b")?.misses, undefined);
});

test("a stored miss count is a positive whole number, no more than the limit", () => {
  const stored = [
    { ...order("1", null), misses: 2 },
    { ...order("2", null), misses: 99 },
    { ...order("3", null), misses: 0 },
    { ...order("4", null), misses: -1 },
    { ...order("5", null), misses: "3" },
    { ...order("6", null), misses: 1.5 },
  ];
  assert.deepEqual(
    readQueue(stored).map((q) => q.misses),
    [2, MAX_MISSES, undefined, undefined, undefined, undefined],
  );
});

test("an order whose page was read comes off the list, read in the state the list had it", () => {
  const state = fresh();
  enqueue(state, [order("1", "2026-10-01"), order("2", "2026-10-01")]);
  markRead(state, state.queue[0]);
  assert.deepEqual(state.queue.map((q) => q.id), ["2"]);
  assert.equal(state.seen["1"], "fp-1");
});

test("what another computer has read since comes off the list", () => {
  const state = fresh();
  enqueue(state, [order("1", "2026-10-01"), order("2", "2026-10-01")]);
  state.seen["1"] = "fp-1";
  state.seen["2"] = "some other state";
  dropRead(state);
  assert.deepEqual(state.queue.map((q) => q.id), ["2"]);
});

test("a stored to-do list keeps only whole entries, each once", () => {
  assert.deepEqual(readQueue("nope"), []);
  assert.deepEqual(
    readQueue([queued("1", "2026-10-01"), queued("1", "2026-10-02"), { id: "2" }, null, { ...queued("3", "yesterday") }]),
    [queued("1", "2026-10-01"), queued("3", null)],
  );
  // Facts not in their shape are not kept.
  assert.deepEqual(readQueue([{ ...queued("4", null), facts: { inStore: "yes", groupId: null } }]), [{ id: "4", fingerprint: "fp-4", date: null }]);
});

// ---- where an order's page is ------------------------------------------------------------------

// Made-up numbers in the shapes Walmart uses: 15 digits online, 21 in store.
const ONLINE_ID = "200000000000011";
const STORE_ID = "300000000000000000021";
const ONLINE_GROUP = "0123456789abcdef0123";

test("Walmart: a run opens the address built from the facts kept, never an address stored", () => {
  const state = fresh();
  enqueue(state, walmart.listedOrders?.(JSON.stringify({ data: { purchaseHistory: { orders: [
    { id: STORE_ID, isInStore: true, type: "IN_STORE", orderDate: "2026-10-01", groups: [{ groupId: "0", items: [] }] },
    { id: ONLINE_ID, isInStore: false, type: "GLASS", orderDate: "2026-10-02", groups: [{ groupId: ONLINE_GROUP, items: [] }] },
  ] } } })) ?? []);
  // Stored and read back, as a run finds it.
  const queue = readQueue(JSON.parse(JSON.stringify(state.queue)), walmart);
  assert.ok(queue.every((q) => !("url" in q)));
  assert.deepEqual(queue.map((q) => walmart.orderUrl?.(q)), [
    `https://www.walmart.com/orders/${STORE_ID}?groupId=0&storePurchase=true`,
    `https://www.walmart.com/orders/${ONLINE_ID}?groupId=${ONLINE_GROUP}`,
  ]);
  // Facts that do not make an address are never opened: the entry waits for the list.
  const odd = readQueue([{ ...queued(ONLINE_ID, null), facts: { inStore: false, groupId: "../../x" } }], walmart);
  assert.equal(odd[0].relist, true);
  assert.deepEqual(stillToOpen(odd), []);
});

test("Walmart: an entry an older version stored is addressed from what its address says for certain, and only that", () => {
  const legacy = (/** @type {string} */ id, /** @type {string} */ url, /** @type {number} */ misses = 0) => ({ id, url, fingerprint: `fp-${id}`, date: "2026-01-01", ...(misses ? { misses } : {}) });
  const queue = readQueue(
    [
      // v0.1.76 listed every order with the online form: an online order's is right as it was.
      legacy(ONLINE_ID, `https://www.walmart.com/orders/${ONLINE_ID}?groupId=${ONLINE_GROUP}`),
      legacy("200000000000012", "https://www.walmart.com/orders/200000000000012"),
      // v0.1.80 built an in-store purchase's address from the list's marking.
      legacy("300000000000000000022", "https://www.walmart.com/orders/300000000000000000022?groupId=0&storePurchase=true"),
      // v0.1.76's in-store purchase: the online form, and a number only an in-store purchase has had.
      // Not guessed at, set aside or not.
      legacy(STORE_ID, `https://www.walmart.com/orders/${STORE_ID}`, MAX_MISSES),
      legacy("300000000000000000023", "https://www.walmart.com/orders/300000000000000000023?groupId=0"),
      // An address that is not the order's own says nothing.
      legacy("200000000000013", "https://www.walmart.com/orders/200000000000099?groupId=0123456789abcdef"),
    ],
    walmart,
  );
  assert.deepEqual(queue.map((q) => [q.id, q.facts ?? null, q.relist ?? false]), [
    [ONLINE_ID, { inStore: false, groupId: ONLINE_GROUP }, false],
    ["200000000000012", { inStore: false, groupId: null }, false],
    ["300000000000000000022", { inStore: true, groupId: "0" }, false],
    [STORE_ID, null, true],
    ["300000000000000000023", null, true],
    ["200000000000013", null, true],
  ]);
  // Waiting is neither still to read nor set aside, and a run does not open it.
  assert.deepEqual(nextToOpen(queue, 20).map((q) => q.id), [ONLINE_ID, "200000000000012", "300000000000000000022"]);
  assert.equal(waitingCount(queue), 3);
  assert.equal(setAsideCount(queue), 0);
  // Amazon's pages need nothing but the number, so nothing of Amazon's waits.
  const amazonQueue = readQueue([{ id: "113-0000001-0000001", url: "https://www.amazon.com/old", fingerprint: "f", date: null }], amazon);
  assert.equal(amazon.orderUrl?.(amazonQueue[0]), "https://www.amazon.com/gp/your-account/order-details?orderID=113-0000001-0000001");
  assert.equal(waitingCount(amazonQueue), 0);
});

test("Walmart: an in-store purchase queued with the online address gets the store address when listed again, with its misses cleared", () => {
  // As v0.1.76 stored it, then set aside by three runs that found Walmart's page empty.
  const stored = [{ id: STORE_ID, url: `https://www.walmart.com/orders/${STORE_ID}`, fingerprint: "fp", date: "2026-03-01", misses: MAX_MISSES }];
  const state = { ...fresh(), queue: readQueue(stored, walmart) };
  assert.equal(waitingCount(state.queue), 1);
  assert.deepEqual(nextToOpen(state.queue, 20), []);

  // The member sets up the history again past it (or a run reaches it): the list shows it as before.
  const [listed] = walmart.listedOrders?.(JSON.stringify({ data: { purchaseHistory: { orders: [
    { id: STORE_ID, isInStore: true, type: "IN_STORE", orderDate: "2026-03-01", groups: [{ groupId: "0", items: [] }] },
  ] } } })) ?? [];
  // Even with the same fingerprint, and even listed by a run rather than setup.
  enqueue(state, [{ ...listed, fingerprint: "fp" }]);
  const [entry] = readQueue(JSON.parse(JSON.stringify(state.queue)), walmart);
  assert.equal(entry.relist, undefined);
  assert.equal(entry.misses, undefined);
  assert.equal(walmart.orderUrl?.(entry), `https://www.walmart.com/orders/${STORE_ID}?groupId=0&storePurchase=true`);
  assert.deepEqual(nextToOpen([entry], 20).map((q) => q.id), [STORE_ID]);
  assert.equal(waitingCount([entry]), 0);
  assert.equal(setAsideCount([entry]), 0);

  // An order set aside whose facts change the address comes back the same way.
  const aside = { ...fresh(), queue: [{ ...queued(ONLINE_ID, "2026-03-02"), misses: MAX_MISSES }] };
  enqueue(aside, [{ ...order(ONLINE_ID, "2026-03-02"), facts: { inStore: false, groupId: ONLINE_GROUP } }]);
  assert.equal(aside.queue[0].misses, undefined);
});

test("a run that cannot address an order leaves it waiting for the list", () => {
  const state = fresh();
  enqueue(state, [order("1", "2026-10-01"), order("2", "2026-10-01")]);
  awaitRelist(state, state.queue[0]);
  assert.deepEqual(stillToOpen(state.queue).map((q) => q.id), ["2"]);
  assert.equal(waitingCount(state.queue), 1);
  enqueue(state, [order("1", "2026-10-01")]);
  assert.equal(waitingCount(state.queue), 0);
});

// ---- Amazon: caught up at the first charge it has read -----------------------------------------

const charge = (/** @type {string} */ key, /** @type {string | null} */ date = "2026-10-01") => ({ key: key.repeat(64).slice(0, 64), date });

test("Amazon: a run has listed far enough at the first charge it has read before", () => {
  const state = fresh();
  noteCharges(state, [charge("a"), charge("b")]);
  assert.equal(reachedReadCharge([charge("c"), charge("d")], state.charges), false);
  // A refund or a late charge is a new row at the top; the row under it is one already read.
  assert.equal(reachedReadCharge([charge("c"), charge("a")], state.charges), true);
  assert.equal(reachedReadCharge([], state.charges), false);
});

test("Amazon: a charge read on the page is known in the page's own answer, and a hold now charged is new", () => {
  const html = '<a data-testid="transaction-link"><span data-testid="text">Oct 9, 2026</span><div data-testid="text">Order #113-0000001-0000001</div><div data-testid="text">-$38.52</div><div data-testid="text">Charged</div></a>';
  const state = fresh();
  noteCharges(state, amazon.listedCharges?.(html) ?? []);
  const later = JSON.stringify({ displayResponse: { transactionsList: [
    { formattedAmount: "-$12.00", formattedDate: "Oct 20, 2026", orderData: [{ orderDisplayString: "Order #113-0000002-0000002" }], statusInfo: { label: "Charged" } },
    { formattedAmount: "-$38.52", formattedDate: "Oct 9, 2026", orderData: [{ orderDisplayString: "Order #113-0000001-0000001" }], statusInfo: { label: "Charged" } },
  ] } });
  const charges = amazon.listedCharges?.(later) ?? [];
  assert.equal(reachedReadCharge(charges.slice(0, 1), state.charges), false);
  assert.equal(reachedReadCharge(charges, state.charges), true);
});

test("only the newest charges are remembered, which is where a run stops", () => {
  const state = fresh();
  const many = Array.from({ length: MAX_CHARGES + 10 }, (_, i) => ({ key: i.toString(16).padStart(64, "0"), date: `2026-${String(1 + (i % 9)).padStart(2, "0")}-01` }));
  noteCharges(state, many);
  assert.equal(Object.keys(state.charges).length, MAX_CHARGES);
  assert.ok(Object.values(state.charges).every((d) => d >= "2026-01-01"));
  assert.ok(Object.hasOwn(state.charges, many.find((c) => c.date === "2026-09-01")?.key ?? ""));
  assert.deepEqual(readCharges({ [many[0].key]: "2026-01-01", short: "x", [many[1].key]: 3 }), { [many[0].key]: "2026-01-01" });
  assert.deepEqual(readCharges(null), {});
});

// ---- Walmart: past a known order and past the settling days -------------------------------------

test("Walmart: a run reads on past a known order until it is past the days orders still change", () => {
  const state = fresh();
  state.seen["3"] = "fp-3";

  // Nothing known yet: read on, however old.
  let step = settledListing({ pageOrders: [order("1", daysAgo(2)), order("2", daysAgo(40))], state, reachedKnown: false, now: NOW });
  assert.deepEqual(step, { reachedKnown: false, settled: false });

  // Known, and still inside the settling days: read on, since those after it may have changed.
  step = settledListing({ pageOrders: [order("3", daysAgo(5)), order("4", daysAgo(10))], state, reachedKnown: false, now: NOW });
  assert.deepEqual(step, { reachedKnown: true, settled: false });

  // A later page past the settling days, after a known order on an earlier one: far enough.
  step = settledListing({ pageOrders: [order("5", daysAgo(SETTLING_DAYS + 1))], state, reachedKnown: step.reachedKnown, now: NOW });
  assert.deepEqual(step, { reachedKnown: true, settled: true });
});

test("Walmart: an order on the to-do list is known too, and an undated order is no date", () => {
  const state = fresh();
  enqueue(state, [order("9", daysAgo(60))]);
  assert.equal(settledListing({ pageOrders: [order("9", daysAgo(60))], state, reachedKnown: false, now: NOW }).settled, true);
  assert.equal(settledListing({ pageOrders: [order("8", null)], state, reachedKnown: true, now: NOW }).settled, false);
});

// ---- setup and the strip ----------------------------------------------------------------------

test("setup counts each order once, how far back it got, and what it skipped as read", () => {
  const setup = emptySetup();
  noteSetup(setup, [order("1", "2026-10-01"), order("2", "2025-03-14")], ["2"]);
  noteSetup(setup, [order("2", "2025-03-14"), order("3", null)], ["2"], ["2025-02-01", null]);
  assert.deepEqual(setup.listedIds, ["1", "2", "3"]);
  assert.equal(setup.skipped, 1);
  assert.equal(setup.reachedDate, "2025-02-01");
});

test("the strip says how far back, how many, and where the bank history starts", () => {
  const setup = { ...emptySetup(), status: /** @type {const} */ ("started"), reachedDate: "2025-03-14", listedIds: Array.from({ length: 96 }, (_, i) => String(i)) };
  const strip = stripText({ name: "Amazon", setup, bank: { start: "2025-01-02", locked: false } });
  assert.equal(strip.progress, "Setting up your Amazon history · back to March 14, 2025 · 96 orders so far");
  assert.match(strip.target, /^Your bank history in SageFin starts January 2, 2025\./);
  assert.equal(strip.covered, false);
  assert.match(strip.note ?? "", /Scroll down/);

  const passed = stripText({ name: "Amazon", setup: { ...setup, reachedDate: "2024-12-30" }, bank: { start: "2025-01-02", locked: false } });
  assert.equal(passed.covered, true);
  assert.match(passed.target, /^That covers all your bank history\./);
  // Reaching the very day covers it.
  assert.equal(stripText({ name: "Amazon", setup: { ...setup, reachedDate: "2025-01-02" }, bank: { start: "2025-01-02", locked: false } }).covered, true);

  assert.equal(stripText({ name: "Walmart", setup: { ...emptySetup(), listedIds: ["1"] }, bank: null }).progress, "Setting up your Walmart history · 1 order so far");
});

test("the strip never guesses where the bank history starts", () => {
  const setup = { ...emptySetup(), reachedDate: "2020-01-01" };
  const locked = stripText({ name: "Walmart", setup, bank: { start: null, locked: true } });
  assert.match(locked.target, /locked, so SageFin cannot say where your bank history starts/);
  assert.equal(locked.covered, false);
  const unsaid = stripText({ name: "Walmart", setup, bank: null });
  assert.match(unsaid.target, /has not said/);
  assert.equal(unsaid.covered, false);
});

test("the strip says what it skipped, and that a robot check in setup is the member's to answer", () => {
  const setup = { ...emptySetup(), skipped: 12 };
  assert.match(stripText({ name: "Walmart", setup, bank: null }).note ?? "", /^12 already read, so skipped\. Press Next page/);
  assert.match(stripText({ name: "Amazon", setup, bank: null, checking: true }).note ?? "", /Answer its check in the window, then carry on/);
});

test("dates read as a person writes them", () => {
  assert.equal(longDate("2025-03-14"), "March 14, 2025");
  assert.equal(longDate("2026-12-01"), "December 1, 2026");
});

test("a stored setup is read back, and anything unreadable is no setup", () => {
  const stored = { status: "done", reachedDate: "2025-01-02", backTo: "2025-06-01", listedIds: ["1", "1", 2, "3"], skipped: 4, startedAt: "a", doneAt: "b" };
  assert.deepEqual(readSetup(stored), { status: "done", reachedDate: "2025-01-02", backTo: "2025-06-01", listedIds: ["1", "3"], skipped: 4, startedAt: "a", doneAt: "b" });
  // A setup stored before `backTo` existed reads as never having been given a day.
  assert.equal(readSetup({ status: "done", reachedDate: "2025-01-02" }).backTo, null);
  assert.deepEqual(readSetup({ status: "everything", reachedDate: "soon", backTo: "June", skipped: -1 }), emptySetup());
  assert.deepEqual(readSetup(null), emptySetup());
});

// ---- setting it up again ----------------------------------------------------------------------

test("changing how far back drops the to-do list's older orders, and keeps undated ones", () => {
  const state = fresh();
  enqueue(state, [order("1", "2026-10-01"), order("2", "2025-01-01"), order("3", null), order("4", "2025-06-01")]);
  assert.equal(dropOlderThan(state, "2025-06-01"), 1);
  assert.deepEqual(state.queue.map((q) => q.id), ["1", "3", "4"]);
  assert.equal(dropOlderThan(state, "June"), 0);
  assert.equal(state.queue.length, 3);
  assert.equal(state.setup.backTo, "2025-06-01");
});

test("how far back the history reads is the later of the day given and the oldest date setup reached", () => {
  assert.equal(readsBackTo(emptySetup()), null);
  assert.equal(readsBackTo({ ...emptySetup(), reachedDate: "2024-03-14" }), "2024-03-14");
  assert.equal(readsBackTo({ ...emptySetup(), backTo: "2025-01-01" }), "2025-01-01");
  assert.equal(readsBackTo({ ...emptySetup(), reachedDate: "2024-03-14", backTo: "2025-01-01" }), "2025-01-01");
  // A day older than setup ever reached drops nothing it has not got: the reach is still the setup's.
  assert.equal(readsBackTo({ ...emptySetup(), reachedDate: "2024-03-14", backTo: "2020-01-01" }), "2024-03-14");
});

test("the day given stands until setup lists an order older than it again", () => {
  const state = fresh();
  state.setup = { ...emptySetup(), status: "done", reachedDate: "2024-03-14" };
  dropOlderThan(state, "2025-01-01");
  noteSetup(state.setup, [order("1", "2026-10-01"), order("2", null)], []);
  assert.equal(state.setup.backTo, "2025-01-01");
  noteSetup(state.setup, [order("3", "2024-12-31")], []);
  assert.equal(state.setup.backTo, null);
  assert.equal(readsBackTo(state.setup), "2024-03-14");
});

test("starting over forgets the to-do list, what was read and the setup", () => {
  const state = fresh();
  enqueue(state, [order("1", "2026-10-01")]);
  state.seen["2"] = "x";
  noteCharges(state, [charge("a")]);
  state.setup = { ...emptySetup(), status: "done", reachedDate: "2025-01-01", listedIds: ["1"] };
  startOver(state);
  assert.deepEqual(state, fresh());
});

test("the lists whose orders go on the to-do list are the history pages, and not an order's own", () => {
  assert.deepEqual(LIST_KINDS, ["order_list_next_data", "order_list_json", "payments_html", "payments_json"]);
  assert.ok(!LIST_KINDS.includes("order_detail_html"));
});

test("how far back takes a real day no later than today, and nothing else", () => {
  const now = new Date(2026, 9, 25, 9, 0);
  assert.equal(howFarBackDate("2024-01-31", now), "2024-01-31");
  assert.equal(howFarBackDate("2026-10-25", now), "2026-10-25");
  // Tomorrow would drop nothing a member could mean; a made-up day is not a day.
  assert.equal(howFarBackDate("2026-10-26", now), null);
  assert.equal(howFarBackDate("2026-02-30", now), null);
  assert.equal(howFarBackDate("2026-13-01", now), null);
  for (const bad of ["", "June", "2024-1-5", "2024-01-05T00:00", " 2024-01-05", 20240105, null, undefined, {}, ["2024-01-05"]]) {
    assert.equal(howFarBackDate(bad, now), null, JSON.stringify(bad));
  }
});
