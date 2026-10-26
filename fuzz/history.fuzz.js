// The to-do list is kept on disk and read back, so what it holds is not the app's to choose either:
// these hold the readme's promises about which orders a run opens for any stored list.
//
// Kept out of lib/ because fast-check has to be installed, and `npm test` runs with nothing
// installed. `npm run fuzz` runs these.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { MAX_MISSES, isSetAside, nextToOpen, readQueue } from "../lib/history.mjs";

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
