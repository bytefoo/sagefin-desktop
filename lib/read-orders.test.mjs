// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ASKED, MAX_READ, adoptRead, askHeld, orderKey, ordersToAskAbout, readKeys, sageFinLostReading, shareRead } from "./read-orders.mjs";
import { emptySetup, enqueue } from "./history.mjs";

const SITE = "https://my.sagefin.app";
const SECRET = `sfin_${"a1".repeat(24)}`;

/** What the to-do list would take of these, after what is read. @param {ReturnType<typeof order>[]} listed @param {Record<string, string>} seen */
const toRead = (listed, seen) => {
  /** @type {import("./history.mjs").HistoryState} */
  const state = { seen, queue: [], charges: {}, setup: emptySetup() };
  enqueue(state, listed);
  return state.queue.map((o) => o.id);
};

/** @param {string} id @param {string} fingerprint */
const order = (id, fingerprint) => ({ id, fingerprint, url: `https://retailer.example/orders/${id}`, date: null });

/** A stand-in SageFin that records what it is sent. @param {{ status: number, body?: unknown }} answer */
function server(answer) {
  /** @type {{ url: string, init: any, body: any }[]} */
  const requests = [];
  /** @type {any} */
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return { status: answer.status, json: async () => answer.body };
  };
  return { requests, fetch };
}

test("a key is the same for the same order in the same state, on any computer", () => {
  const key = orderKey("walmart", "200000000000001", "delivered|179.25");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(orderKey("walmart", "200000000000001", "delivered|179.25"), key);
});

test("a key changes with the order's state, its number and its retailer", () => {
  const key = orderKey("walmart", "200000000000001", "delivered|179.25");
  assert.notEqual(orderKey("walmart", "200000000000001", "refunded|179.25"), key);
  assert.notEqual(orderKey("walmart", "200000000000002", "delivered|179.25"), key);
  assert.notEqual(orderKey("amazon", "200000000000001", "delivered|179.25"), key);
  // The parts are kept apart: moving a character across a boundary is a different order.
  assert.notEqual(orderKey("walmart", "2000000000000011", "delivered"), orderKey("walmart", "200000000000001", "1delivered"));
});

test("what is sent names no order number and no fingerprint", async () => {
  const sagefin = server({ status: 200, body: { known: [] } });
  const seen = { "200000000000001": "delivered|179.25" };

  await shareRead({
    site: SITE,
    secret: SECRET,
    retailer: "walmart",
    asked: [orderKey("walmart", "200000000000002", "shipped|12.00")],
    read: readKeys("walmart", seen),
    fetch: sagefin.fetch,
  });

  assert.equal(sagefin.requests.length, 1);
  assert.equal(sagefin.requests[0].url, `${SITE}/api/v1/retail/desktop/read-orders`);
  assert.equal(sagefin.requests[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(Object.keys(sagefin.requests[0].body), ["retailer", "asked", "read"]);
  const sent = sagefin.requests[0].init.body;
  for (const text of ["200000000000001", "200000000000002", "delivered", "179.25", "shipped"]) assert.equal(sent.includes(text), false, text);
  for (const key of [...sagefin.requests[0].body.asked, ...sagefin.requests[0].body.read]) assert.match(key, /^[0-9a-f]{64}$/);
});

test("the answer is the asked keys SageFin knows, and nothing it was not asked", async () => {
  const a = orderKey("walmart", "1", "x");
  const b = orderKey("walmart", "2", "x");
  const stranger = orderKey("walmart", "3", "x");
  const sagefin = server({ status: 200, body: { known: [a, stranger, 7] } });

  const known = await shareRead({ site: SITE, secret: SECRET, retailer: "walmart", asked: [a, b], read: [], fetch: sagefin.fetch });

  assert.deepEqual([...(known ?? [])], [a]);
});

test("no answer is null, never 'none of them'", async () => {
  const ask = (/** @type {any} */ fetch) => shareRead({ site: SITE, secret: SECRET, retailer: "walmart", asked: [orderKey("walmart", "1", "x")], read: [], fetch });

  // A SageFin from before it could be asked, one that no longer takes the credential, and one in trouble.
  for (const status of [404, 401, 403, 400, 500, 503]) assert.equal(await ask(server({ status, body: { known: [] } }).fetch), null, String(status));
  assert.equal(await ask(server({ status: 200, body: {} }).fetch), null);
  assert.equal(await ask(server({ status: 200, body: { known: "all" } }).fetch), null);
  assert.equal(await ask(async () => { throw new Error("offline"); }), null);
  // And a real "none" is an empty set, which is not null.
  assert.deepEqual(await ask(server({ status: 200, body: { known: [] } }).fetch), new Set());
});

test("an order another computer read in this state is not opened here", () => {
  const listed = [order("1", "delivered"), order("2", "delivered"), order("3", "shipped")];
  /** @type {Record<string, string>} */
  const seen = {};
  const known = new Set([orderKey("walmart", "1", "delivered"), orderKey("walmart", "2", "delivered")]);

  assert.equal(adoptRead("walmart", listed, seen, known), 2);

  assert.deepEqual(toRead(listed, seen), ["3"]);
});

test("an order that changed since another computer read it is still opened", () => {
  const listed = [order("1", "refunded")];
  /** @type {Record<string, string>} */
  const seen = {};

  assert.equal(adoptRead("walmart", listed, seen, new Set([orderKey("walmart", "1", "delivered")])), 0);

  assert.deepEqual(toRead(listed, seen), ["1"]);
});

test("with no answer the app opens what its own record says to", () => {
  const listed = [order("1", "delivered"), order("2", "delivered")];
  const seen = { 1: "delivered" };

  assert.equal(adoptRead("walmart", listed, seen, null), 0);

  assert.deepEqual(seen, { 1: "delivered" });
  assert.deepEqual(toRead(listed, seen), ["2"]);
});

test("only orders this computer has not read in the state shown are asked about", () => {
  const listed = [order("1", "delivered"), order("2", "refunded"), order("3", "shipped")];

  assert.deepEqual(ordersToAskAbout(listed, { 1: "delivered", 2: "delivered" }).map((o) => o.id), ["2", "3"]);
});

test("a call never carries more than SageFin takes", () => {
  /** @type {Record<string, string>} */
  const seen = {};
  for (let i = 0; i < MAX_READ + 5; i++) seen[`o${i}`] = "x";
  const keys = readKeys("walmart", seen);
  assert.equal(keys.length, MAX_READ);
  // The latest read are the ones kept.
  assert.equal(keys.at(-1), orderKey("walmart", `o${MAX_READ + 4}`, "x"));

  const listed = Array.from({ length: MAX_ASKED + 5 }, (_, i) => order(`o${i}`, "x"));
  assert.equal(ordersToAskAbout(listed, {}).length, MAX_ASKED);
});

// ---- When SageFin has lost what this computer read ---------------------------------------------

const MINE = "0199a6f0-0000-7000-8000-000000000001";
const NEW = "0199a6f0-0000-7000-8000-000000000002";

test("a run asks how much is held with nothing sent and nothing asked", async () => {
  const sagefin = server({ status: 200, body: { known: [], heldHere: 3, heldOnAccount: 5 } });

  assert.deepEqual(await askHeld({ site: SITE, secret: SECRET, retailer: "walmart", fetch: sagefin.fetch }), { here: 3, onAccount: 5 });

  assert.equal(sagefin.requests.length, 1);
  assert.deepEqual(sagefin.requests[0].body, { retailer: "walmart", asked: [], read: [] });
});

test("a SageFin that does not say how much it holds says nothing, and no answer is not none", async () => {
  const ask = (/** @type {any} */ fetch) => askHeld({ site: SITE, secret: SECRET, retailer: "walmart", fetch });

  // From before it said; half an answer; something that is not a count; offline; refused.
  assert.equal(await ask(server({ status: 200, body: { known: [] } }).fetch), null);
  assert.equal(await ask(server({ status: 200, body: { known: [], heldHere: 0 } }).fetch), null);
  assert.equal(await ask(server({ status: 200, body: { known: [], heldHere: -1, heldOnAccount: 0 } }).fetch), null);
  assert.equal(await ask(server({ status: 200, body: { known: [], heldHere: "0", heldOnAccount: 0 } }).fetch), null);
  assert.equal(await ask(async () => { throw new Error("offline"); }), null);
  assert.equal(await ask(server({ status: 401, body: { known: [], heldHere: 0, heldOnAccount: 0 } }).fetch), null);
  // A real zero is zero.
  assert.deepEqual(await ask(server({ status: 200, body: { known: [], heldHere: 0, heldOnAccount: 0 } }).fetch), { here: 0, onAccount: 0 });
});

test("what a call that says what was read is told of what is held reaches the caller", async () => {
  const sagefin = server({ status: 200, body: { known: [], heldHere: 2, heldOnAccount: 2 } });
  /** @type {unknown[]} */
  const told = [];

  await shareRead({ site: SITE, secret: SECRET, retailer: "walmart", asked: [], read: readKeys("walmart", { 1: "x", 2: "y" }), fetch: sagefin.fetch, onHeld: (h) => told.push(h) });

  assert.deepEqual(told, [{ here: 2, onAccount: 2 }]);
});

test("under the credential SageFin held this computer's reading for, none held means SageFin lost it", () => {
  const state = { seen: { 1: "delivered" }, readFor: MINE };

  assert.equal(sageFinLostReading(state, { here: 0, onAccount: 0 }, MINE), true);
  // Another computer putting its own reading back does not bring this one's back.
  assert.equal(sageFinLostReading(state, { here: 0, onAccount: 4 }, MINE), true);
  // The control: still held.
  assert.equal(sageFinLostReading(state, { here: 1, onAccount: 1 }, MINE), false);
});

test("under another credential, only none held on the whole account means SageFin lost it", () => {
  // A reset deleted the credential and every key with it; this is the one connected after.
  assert.equal(sageFinLostReading({ seen: { 1: "delivered" }, readFor: MINE }, { here: 0, onAccount: 0 }, NEW), true);
  // Revoked and connected again: the old credential's keys are still held.
  assert.equal(sageFinLostReading({ seen: { 1: "delivered" }, readFor: MINE }, { here: 0, onAccount: 3 }, NEW), false);
  // A memory from before this was kept, under the credential that has been sending all along.
  assert.equal(sageFinLostReading({ seen: { 1: "delivered" }, readFor: null }, { here: 0, onAccount: 3 }, MINE), false);
  assert.equal(sageFinLostReading({ seen: { 1: "delivered" }, readFor: null }, { here: 0, onAccount: 0 }, MINE), true);
});

test("no answer, or nothing remembered here, is never a reason to forget", () => {
  assert.equal(sageFinLostReading({ seen: { 1: "delivered" }, readFor: MINE }, null, MINE), false);
  assert.equal(sageFinLostReading({ seen: {}, readFor: MINE }, { here: 0, onAccount: 0 }, MINE), false);
  assert.equal(sageFinLostReading({ seen: {}, readFor: null }, { here: 0, onAccount: 0 }, NEW), false);
});
