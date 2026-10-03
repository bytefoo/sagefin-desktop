// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { LINK_SYNC_EVERY_MS, linkAction, linkAmong, readSyncLink } from "./sync-link.mjs";

const SYNCABLE = ["walmart", "amazon"];

test("a link asks for one retailer's sync, by its code and nothing else", () => {
  assert.deepEqual(readSyncLink("sagefin-desktop://sync?retailer=walmart", SYNCABLE), { retailer: "walmart" });
  assert.deepEqual(readSyncLink("sagefin-desktop://sync/?retailer=amazon", SYNCABLE), { retailer: "amazon" });
  // Anything else it carries is ignored: there is nothing a link can hand the app or point it at.
  assert.deepEqual(
    readSyncLink("sagefin-desktop://sync?retailer=walmart&site=https://evil.example&token=x&url=https://evil.example/orders", SYNCABLE),
    { retailer: "walmart" },
  );
});

test("a link that names nothing the app syncs only brings the app forward", () => {
  for (const url of [
    "sagefin-desktop://sync",
    "sagefin-desktop://sync?retailer=target",
    "sagefin-desktop://sync?retailer=https://evil.example",
    "sagefin-desktop://sync?retailer=WALMART",
    "sagefin-desktop://open",
    "sagefin-desktop://sync/walmart",
    "sagefin-desktop://",
    "sagefin-desktop:sync?retailer=walmart",
  ]) {
    assert.deepEqual(readSyncLink(url, SYNCABLE), { retailer: null }, url);
  }
});

test("a link that is not ours is not read", () => {
  for (const url of ["https://my.sagefin.app/sync?retailer=walmart", "sagefin://sync?retailer=walmart", "file:///x", "not a url", ""]) {
    assert.equal(readSyncLink(url, SYNCABLE), null, url);
  }
});

test("Windows and Linux deliver a link among the launch arguments", () => {
  assert.equal(linkAmong(["C:\\\\app.exe", "--hidden", "sagefin-desktop://sync?retailer=walmart"]), "sagefin-desktop://sync?retailer=walmart");
  assert.equal(linkAmong(["/opt/app", "--no-sandbox"]), null);
});

test("a link starts a sync only for a retailer the member has synced here, one at a time, and not in a loop", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");
  const ok = { retailer: "walmart", lastFinishedAt: "2026-10-02T12:00:00Z", refusedAt: null, syncing: false, lastLinkSyncAt: null, now };
  assert.equal(linkAction(ok), "sync");

  // Never synced in this copy of the app: any page on the web could otherwise make it open a retailer.
  assert.equal(linkAction({ ...ok, lastFinishedAt: null }), "show");
  assert.equal(linkAction({ ...ok, retailer: null }), "show");
  assert.equal(linkAction({ ...ok, syncing: true }), "show");
  // Turned away: starting again is the member's call, in the app.
  assert.equal(linkAction({ ...ok, refusedAt: "2026-10-03T11:00:00Z" }), "show");

  // A page sending the link over and over gets one sync a quarter of an hour.
  assert.equal(linkAction({ ...ok, lastLinkSyncAt: now - 60_000 }), "show");
  assert.equal(linkAction({ ...ok, lastLinkSyncAt: now - LINK_SYNC_EVERY_MS }), "sync");
});
