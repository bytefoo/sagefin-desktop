// The to-do list is kept on disk and read back, so what it holds is not the app's to choose either:
// these hold the readme's promises about which orders a run opens for any stored list.
//
// Kept out of lib/ because fast-check has to be installed, and `npm test` runs with nothing
// installed. `npm run fuzz` runs these.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { MAX_MISSES, isSetAside, nextToOpen, readQueue, setAsideCount, stillToOpen, waitingCount } from "../lib/history.mjs";
import { walmart } from "../lib/retailers.mjs";

const day = fc.integer({ min: 0, max: 3650 }).map((n) => new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toISOString().slice(0, 10));
const stored = fc.array(
  fc.record(
    {
      id: fc.stringMatching(/^[0-9]{1,6}$/),
      url: fc.constant("https://www.walmart.com/orders/1"),
      fingerprint: fc.string(),
      date: fc.option(day),
      misses: fc.oneof(fc.integer({ min: -2, max: 9 }), fc.double(), fc.string()),
    },
    { requiredKeys: ["id", "url", "fingerprint"] },
  ),
  { maxLength: 60 },
);

test("a run never opens an order set aside, never more than its limit, and tries untried orders first", () => {
  fc.assert(
    fc.property(stored, fc.integer({ min: 0, max: 30 }), (raw, limit) => {
      const queue = readQueue(raw);
      for (const q of queue) assert.ok(q.misses === undefined || (Number.isInteger(q.misses) && q.misses >= 1 && q.misses <= MAX_MISSES));
      const next = nextToOpen(queue, limit);
      assert.ok(next.length <= limit);
      assert.ok(!next.some(isSetAside));
      const open = queue.filter((q) => !isSetAside(q));
      assert.equal(next.length, Math.min(limit, open.length));
      // No order left out has fewer misses than one opened.
      const most = Math.max(0, ...next.map((q) => q.misses ?? 0));
      const opened = new Set(next);
      if (next.length === limit) assert.ok(!open.some((q) => !opened.has(q) && (q.misses ?? 0) < most));
    }),
  );
});

// What an older version kept, and what this one keeps, side by side: a run opens only orders the
// retailer can address from what is kept, and every one of those it can address.
const walmartStored = fc.array(
  fc.record(
    {
      id: fc.oneof(fc.stringMatching(/^[0-9]{15}$/), fc.stringMatching(/^[0-9]{20,21}$/), fc.string()),
      url: fc.oneof(
        fc.string(),
        fc.tuple(fc.stringMatching(/^[0-9]{15,21}$/), fc.constantFrom("", "?groupId=0", "?groupId=0&storePurchase=true", "?groupId=0123456789abcdef")).map(
          ([id, q]) => `https://www.walmart.com/orders/${id}${q}`,
        ),
      ),
      facts: fc.oneof(fc.anything(), fc.record({ inStore: fc.boolean(), groupId: fc.oneof(fc.constant(null), fc.constant("0"), fc.string()) })),
      fingerprint: fc.string(),
      date: fc.option(day),
      misses: fc.integer({ min: 0, max: 5 }),
      relist: fc.anything(),
    },
    { requiredKeys: ["id", "fingerprint"] },
  ),
  { maxLength: 40 },
);

test("Walmart: a run opens only orders it can build an address for, and waiting ones are not set aside", () => {
  fc.assert(
    fc.property(walmartStored, (raw) => {
      const queue = readQueue(raw, walmart);
      for (const q of queue) {
        assert.equal(Boolean(q.relist), walmart.orderUrl?.(q) === null, JSON.stringify(q));
        assert.ok(!("url" in q));
      }
      for (const q of nextToOpen(queue, 1000)) assert.notEqual(walmart.orderUrl?.(q), null);
      assert.equal(stillToOpen(queue).length + setAsideCount(queue) + waitingCount(queue), queue.length);
    }),
  );
});
