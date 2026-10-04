// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ASKED, MAX_READ, adoptRead, orderKey, ordersToAskAbout, readKeys, shareRead } from "./read-orders.mjs";
import { ordersToOpen } from "./sync-plan.mjs";

const SITE = "https://my.sagefin.app";
const SECRET = `sfin_${"a1".repeat(24)}`;

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

  assert.deepEqual(ordersToOpen(listed, seen).map((o) => o.id), ["3"]);
});

test("an order that changed since another computer read it is still opened", () => {
  const listed = [order("1", "refunded")];
  /** @type {Record<string, string>} */
  const seen = {};

  assert.equal(adoptRead("walmart", listed, seen, new Set([orderKey("walmart", "1", "delivered")])), 0);

  assert.deepEqual(ordersToOpen(listed, seen).map((o) => o.id), ["1"]);
});

test("with no answer the app opens what its own record says to", () => {
  const listed = [order("1", "delivered"), order("2", "delivered")];
  const seen = { 1: "delivered" };

  assert.equal(adoptRead("walmart", listed, seen, null), 0);

  assert.deepEqual(seen, { 1: "delivered" });
  assert.deepEqual(ordersToOpen(listed, seen).map((o) => o.id), ["2"]);
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
