import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, cardSummary } from "./card.mjs";

const NOW = new Date("2026-10-30T17:00:00.000Z");

/** A retailer's status as main/main.mjs reports it, set up and synced, with invented values. */
const base = (over = {}, history = {}) => ({
  syncable: true,
  syncing: false,
  syncProgress: null,
  captures: 0,
  lastSync: "Read 1 order.",
  lastSyncAt: "2026-10-30T16:59:00.000Z",
  lastOutcome: /** @type {const} */ ("finished"),
  ...over,
  history: { setup: /** @type {const} */ ("done"), settingUp: false, reachedDate: "2026-06-30", goal: null, toRead: 0, outdated: false, ...history },
});

test("a finished sync with nothing left is up to date, and offers nothing", () => {
  assert.deepEqual(cardSummary(base(), NOW), { line: "Up to date · last synced 1 min ago", action: null });
});

test("orders still to read are catching up", () => {
  assert.equal(cardSummary(base({}, { toRead: 12 }), NOW).line, "Catching up: 12 orders still to read · last synced 1 min ago");
  assert.equal(cardSummary(base({}, { toRead: 1 }), NOW).line, "Catching up: 1 order still to read · last synced 1 min ago");
});

test("a history an older version listed asks to be set up again, once, with the button, and drops the old sentence", () => {
  const card = cardSummary(base({}, { outdated: true }), NOW);
  assert.equal(card.action, "set-up-again");
  assert.doesNotMatch(card.line, /Up to date/);
});

test("setting up says how far back it has got of how far it is going", () => {
  assert.deepEqual(cardSummary(base({}, { setup: "started", settingUp: true, reachedDate: "2026-08-12", goal: "2026-06-30" }), NOW), {
    line: "Setting up in its window: reached Aug 12, 2026 of Jun 30, 2026",
    action: null,
  });
  assert.deepEqual(cardSummary(base({}, { setup: "started", reachedDate: "2026-08-12", goal: "2026-06-30" }), NOW), {
    line: "History partly set up: reached Aug 12, 2026 of Jun 30, 2026",
    action: "carry-on",
  });
  assert.equal(cardSummary(base({}, { setup: "started", reachedDate: null }), NOW).line, "History partly set up");
  assert.deepEqual(cardSummary(base({ lastSync: null }, { setup: "never", reachedDate: null }), NOW), { line: "History not set up yet", action: "set-up" });
});

test("a sync that did not finish says what it came to, never up to date", () => {
  const card = cardSummary(base({ lastOutcome: "refused", lastSync: "Amazon showed its robot check, so the sync stopped." }), NOW);
  assert.equal(card.line, "Last sync 1 min ago: Amazon showed its robot check, so the sync stopped.");
  // A memory from before outcomes were kept is not called finished either.
  assert.match(cardSummary(base({ lastOutcome: null }), NOW).line, /^Last sync 1 min ago: Read 1 order\.$/);
});

test("a running sync says what it is doing; a retailer that does not sync says what it saved", () => {
  assert.deepEqual(cardSummary(base({ syncing: true, syncProgress: "Reading order 2 of 5…" }), NOW), { line: "Reading order 2 of 5…", action: null });
  assert.equal(cardSummary({ ...base({ syncable: false, captures: 3 }), history: null }, NOW).line, "3 pages saved");
  assert.equal(cardSummary(base({ lastSync: null }), NOW).line, "History set up · not synced yet");
});

test("ago reads as a person says it", () => {
  assert.equal(ago("2026-10-30T16:59:50.000Z", NOW), "just now");
  assert.equal(ago("2026-10-30T16:55:00.000Z", NOW), "5 min ago");
  assert.equal(ago("2026-10-30T14:00:00.000Z", NOW), "3 hours ago");
  assert.equal(ago("2026-10-30T16:00:00.000Z", NOW), "1 hour ago");
  assert.equal(ago("2026-10-28T17:00:00.000Z", NOW), "2 days ago");
  assert.equal(ago("not a time", NOW), null);
});
