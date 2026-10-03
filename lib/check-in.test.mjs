import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANSWER_GOOD_FOR_MS,
  CHECK_IN_EVERY_MS,
  checkIn,
  refusalLifted,
  report,
  scheduleAllowedBy,
  shouldStartRequested,
  standingAnswerFor,
  waitingSentence,
} from "./check-in.mjs";

const SITE = "https://my.sagefin.app";
const SECRET = `sfin_${"a1".repeat(24)}`;

/** A sync memory as lib/sync-plan.mjs keeps one, with a run that finished. */
const state = (over = {}) => ({
  seen: { "200000000000001": "delivered|179.25" },
  lastFinishedAt: "2026-10-03T06:51:24.000Z",
  lastResult: "Read 5 orders.",
  lastRunAt: "2026-10-03T06:51:24.000Z",
  lastRunBy: "member",
  lastOutcome: "finished",
  lastOrders: 5,
  caughtUp: true,
  listedThroughPage: null,
  refusedAt: null,
  ...over,
});

/** A stand-in for SageFin: answers with `answer` and records what it was sent. */
function server(answer) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    if (answer === "offline") throw new TypeError("fetch failed");
    return { status: answer.status, json: async () => answer.body };
  };
  return { fetch, requests };
}

const yes = { retailer: "walmart", mayRunScheduled: true, reason: "holder", heldBy: null, refusedAt: null };
const no = { retailer: "walmart", mayRunScheduled: false, reason: "other_computer", heldBy: "SageFin Desktop (The desktop)", refusedAt: null };

test("a report carries times, who started the run, how it ended and a count, and nothing about orders", () => {
  const sent = report("walmart", state(), true);

  assert.deepEqual(sent, {
    retailer: "walmart",
    lastRunAt: "2026-10-03T06:51:24.000Z",
    lastRunBy: "member",
    lastRunOutcome: "finished",
    lastRunOrders: 5,
    lastFinishedAt: "2026-10-03T06:51:24.000Z",
    refusedAt: null,
    automationAllowed: true,
  });
  // The order numbers it has read, and the sentence that may name them, stay on this computer.
  assert.equal(JSON.stringify(sent).includes("200000000000001"), false);
  assert.equal(JSON.stringify(sent).includes("Read 5"), false);
});

test("a check-in is one post with the token, and the answer is read by retailer", async () => {
  const sagefin = server({ status: 200, body: { retailers: [yes], checkInAgainInSeconds: 300 } });

  const result = await checkIn({ site: SITE, secret: SECRET, version: "0.1.22", reports: [report("walmart", state(), true)], fetch: sagefin.fetch });

  assert.equal(sagefin.requests.length, 1);
  assert.equal(sagefin.requests[0].url, `${SITE}/api/v1/retail/desktop/check-in`);
  assert.equal(sagefin.requests[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(Object.keys(sagefin.requests[0].body), ["appVersion", "retailers"]);
  assert.equal(result.status, "answered");
  assert.equal(result.answers.walmart.mayRunScheduled, true);
  assert.equal(result.againInMs, 300_000);
});

test("anything that is not an answer is 'unavailable', and the app runs as it did before", async () => {
  for (const answer of ["offline", { status: 404, body: null }, { status: 500, body: null }, { status: 200, body: { nope: 1 } }]) {
    const result = await checkIn({ site: SITE, secret: SECRET, version: "0.1.22", reports: [], fetch: server(answer).fetch });

    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.answers, {});
    assert.equal(result.againInMs, CHECK_IN_EVERY_MS);
    assert.equal(scheduleAllowedBy(standingAnswerFor({ at: 0, answers: result.answers }, "walmart", 0)), true);
  }
});

test("a credential SageFin no longer accepts is told apart from an outage", async () => {
  const result = await checkIn({ site: SITE, secret: SECRET, version: "0.1.22", reports: [], fetch: server({ status: 401, body: null }).fetch });

  assert.equal(result.status, "signed-out");
});

test("an entry that does not say yes or no outright is dropped, not read as either", async () => {
  const sagefin = server({ status: 200, body: { retailers: [{ retailer: "walmart", reason: "holder" }, { mayRunScheduled: false }] } });

  const result = await checkIn({ site: SITE, secret: SECRET, version: "0.1.22", reports: [], fetch: sagefin.fetch });

  assert.equal(result.status, "answered");
  assert.deepEqual(result.answers, {});
});

test("SageFin cannot ask for a check-in every second, or once a week", async () => {
  const ask = async (seconds) =>
    (await checkIn({ site: SITE, secret: SECRET, version: "0.1.22", reports: [], fetch: server({ status: 200, body: { retailers: [], checkInAgainInSeconds: seconds } }).fetch })).againInMs;

  assert.equal(await ask(1), 60_000);
  assert.equal(await ask(7 * 24 * 3600), 3_600_000);
  assert.equal(await ask("soon"), CHECK_IN_EVERY_MS);
});

test("a 'no' is only believed for a while: a SageFin that went quiet does not stop the sync for good", () => {
  const last = { at: 1_000_000, answers: { walmart: no } };

  assert.equal(scheduleAllowedBy(standingAnswerFor(last, "walmart", last.at + 60_000)), false);
  assert.equal(scheduleAllowedBy(standingAnswerFor(last, "walmart", last.at + ANSWER_GOOD_FOR_MS + 1)), true);
  // A retailer the answer did not mention, and no answer at all, are both nobody to ask.
  assert.equal(standingAnswerFor(last, "amazon", last.at), null);
  assert.equal(standingAnswerFor(null, "walmart", last.at), null);
  // A clock set back is not a fresher answer.
  assert.equal(standingAnswerFor(last, "walmart", last.at - 1), null);
});

test("a refusal remembered here is lifted only when SageFin answered and named none", () => {
  const turnedAway = state({ refusedAt: "2026-10-03T08:00:00.000Z" });

  assert.equal(refusalLifted(turnedAway, yes), true);
  assert.equal(refusalLifted(turnedAway, no), true);
  assert.equal(refusalLifted(turnedAway, { ...no, reason: "refused", refusedAt: "2026-10-03T08:00:00.000Z" }), false);
  assert.equal(refusalLifted(turnedAway, null), false);
  assert.equal(refusalLifted(state(), yes), false);
});

test("the member is told why the daily sync is not running here", () => {
  assert.equal(waitingSentence(yes, "Walmart"), null);
  assert.equal(waitingSentence(null, "Walmart"), null);
  assert.equal(waitingSentence(no, "Walmart"), "The daily sync runs on SageFin Desktop (The desktop). Sync now still works here.");
  assert.equal(waitingSentence({ ...no, heldBy: null }, "Walmart"), "The daily sync runs on another of your computers. Sync now still works here.");
  assert.equal(
    waitingSentence({ ...no, reason: "refused", heldBy: null, refusedAt: "2026-10-03T08:00:00.000Z" }, "Walmart"),
    "Walmart turned a sync away on one of your computers. Press Sync now to try again.",
  );
});

const asked = (expiresAt) => ({ ...yes, requestedSync: { id: "0199", expiresAt } });
const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const LATER = "2026-10-03T12:10:00.000Z";

test("a sync the member asked for is read from the answer, and one with no expiry is not a request", async () => {
  const body = {
    retailers: [
      { ...yes, requestedSync: { requestId: "0199", expiresAt: LATER } },
      { ...yes, retailer: "amazon", requestedSync: { requestId: "0200" } },
    ],
  };

  const result = await checkIn({ site: SITE, secret: SECRET, version: "0.1.36", reports: [], fetch: server({ status: 200, body }).fetch });

  assert.deepEqual(result.answers.walmart.requestedSync, { id: "0199", expiresAt: LATER });
  assert.equal(result.answers.amazon.requestedSync, null);
});

test("a requested sync starts where a scheduled one would", () => {
  assert.equal(shouldStartRequested(state(), asked(LATER), NOW), true);
});

test("a requested sync that has lapsed is not started by a computer that checks in later", () => {
  assert.equal(shouldStartRequested(state(), asked("2026-10-03T12:00:00.000Z"), NOW), false);
  assert.equal(shouldStartRequested(state(), asked("2026-10-02T12:00:00.000Z"), NOW), false);
  assert.equal(shouldStartRequested(state(), asked("soon"), NOW), false);
});

test("a requested sync does not start where a person is needed at the computer", () => {
  // Never synced here by the member; turned away; last met a sign-in page.
  assert.equal(shouldStartRequested(state({ lastFinishedAt: null }), asked(LATER), NOW), false);
  assert.equal(shouldStartRequested(state({ refusedAt: "2026-10-03T08:00:00.000Z" }), asked(LATER), NOW), false);
  assert.equal(shouldStartRequested(state({ lastOutcome: "signed_out" }), asked(LATER), NOW), false);
});

test("with nothing asked for, nothing starts", () => {
  assert.equal(shouldStartRequested(state(), yes, NOW), false);
  assert.equal(shouldStartRequested(state(), { ...yes, requestedSync: null }, NOW), false);
  assert.equal(shouldStartRequested(state(), null, NOW), false);
});
