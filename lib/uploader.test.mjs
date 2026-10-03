import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCaptureStore } from "./capture-store.mjs";
import { addSent, sentSummary, uploadPending } from "./uploader.mjs";

const SITE = "https://my.sagefin.app";
const SECRET = `sfin_${"a1".repeat(24)}`;

function store(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-desktop-upload-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let tick = 0;
  return createCaptureStore({
    dir,
    seal: (s) => Buffer.from(s),
    open: (b) => Buffer.from(b).toString(),
    now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, tick++)),
  });
}

/** A stand-in for SageFin: answers each request from `answers` in turn and records what it was sent. */
function server(...answers) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const answer = answers.shift() ?? { status: 200, body: { status: "parsed", orders: 1, ordersMatched: 1 } };
    if (answer === "offline") throw new TypeError("fetch failed");
    return { status: answer.status, json: async () => answer.body };
  };
  return { fetch, requests };
}

const page = (n, kind = "order_detail_next_data") => ({ site: SITE, retailer: "walmart", kind, payload: `{"order":${n}}` });

test("each saved page is posted as it was saved, oldest first, with the token", async (t) => {
  const captures = store(t);
  captures.add(page(1));
  captures.add(page(2, "order_list_next_data"));
  const { fetch, requests } = server();

  const summary = await uploadPending({ store: captures, site: SITE, secret: SECRET, fetch });

  assert.equal(summary.stopped, null);
  assert.equal(summary.sent.length, 2);
  assert.deepEqual(requests.map((r) => r.url), [`${SITE}/api/v1/retail/captures`, `${SITE}/api/v1/retail/captures`]);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(requests[0].body, {
    retailer: "walmart",
    kind: "order_detail_next_data",
    payload: '{"order":1}',
    capturedAt: "2026-10-02T12:00:00.000Z",
  });
  assert.equal(requests[1].body.kind, "order_list_next_data");
});

// 200 is "read" and 202 is "held"; either way the server has the bytes.
test("a page SageFin holds is let go, whether it could read it or not", async (t) => {
  const captures = store(t);
  captures.add(page(1));
  captures.add(page(2));
  captures.add(page(3));
  const { fetch } = server(
    { status: 200, body: { status: "parsed", orders: 1, ordersMatched: 0 } },
    { status: 202, body: { status: "unsupported", orders: null } },
    { status: 202, body: { status: "failed", orders: null } },
  );

  const summary = await uploadPending({ store: captures, site: SITE, secret: SECRET, fetch });

  assert.deepEqual(summary.sent.map((s) => [s.status, s.orders, s.ordersMatched]), [
    ["parsed", 1, 0],
    ["unsupported", null, null],
    ["failed", null, null],
  ]);
  assert.deepEqual(captures.list(), []);
});

for (const [status, stopped] of [[401, "signed-out"], [403, "signed-out"], [409, "busy"], [429, "server"], [503, "server"]]) {
  test(`a ${status} ends the run and keeps everything that was not sent`, async (t) => {
    const captures = store(t);
    captures.add(page(1));
    captures.add(page(2));
    captures.add(page(3));
    const { fetch, requests } = server({ status: 200, body: { status: "parsed", orders: 1 } }, { status, body: {} });

    const summary = await uploadPending({ store: captures, site: SITE, secret: SECRET, fetch });

    assert.equal(summary.stopped, stopped);
    assert.equal(summary.sent.length, 1);
    assert.equal(requests.length, 2);
    assert.equal(captures.list().length, 2);
  });
}

test("with no connection the run ends and nothing is lost", async (t) => {
  const captures = store(t);
  captures.add(page(1));
  const { fetch } = server("offline");

  const summary = await uploadPending({ store: captures, site: SITE, secret: SECRET, fetch });

  assert.equal(summary.stopped, "offline");
  assert.equal(captures.list().length, 1);
});

// A refusal is about that one capture, so the queue goes on past it.
test("a page SageFin will not take as it is stays here, and the ones behind it still go", async (t) => {
  const captures = store(t);
  const refused = captures.add(page(1)).record;
  captures.add(page(2));
  const { fetch } = server({ status: 400, body: { detail: "too large" } }, { status: 200, body: { status: "parsed", orders: 2 } });

  const summary = await uploadPending({ store: captures, site: SITE, secret: SECRET, fetch });

  assert.equal(summary.refused, 1);
  assert.equal(summary.sent.length, 1);
  assert.equal(summary.stopped, null);
  assert.deepEqual(captures.list().map((r) => r.id), [refused.id]);
});

test("a page saved under another SageFin is never sent to this one", async (t) => {
  const captures = store(t);
  captures.add({ ...page(1), site: "https://my-test.sagefin.app" });
  captures.add(page(2));
  const { fetch, requests } = server();

  await uploadPending({ store: captures, site: SITE, secret: SECRET, fetch });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.payload, '{"order":2}');
  assert.deepEqual(captures.list().map((r) => r.site), ["https://my-test.sagefin.app"]);
});

test("an answer with no readable body is still an answer", async (t) => {
  const captures = store(t);
  captures.add(page(1));
  const fetch = async () => ({ status: 202, json: async () => { throw new SyntaxError("not json"); } });

  const summary = await uploadPending({ store: captures, site: SITE, secret: SECRET, fetch });

  assert.deepEqual(summary.sent[0], { retailer: "walmart", kind: "order_detail_next_data", status: "unsupported", orders: null, ordersMatched: null });
  assert.deepEqual(captures.list(), []);
});

test("what has been sent is counted in pages since the tally began, read or not", () => {
  const time = (iso) => iso.slice(11, 16);
  const sent = (status) => ({ retailer: "walmart", kind: "order_detail_next_data", status, orders: 1, ordersMatched: 0 });
  const at = (minute) => new Date(`2026-10-02T18:${String(minute).padStart(2, "0")}:00.000Z`);

  let tally = addSent(undefined, sent("parsed"), at(12));
  assert.equal(sentSummary(tally, time), "1 page at 18:12, read by SageFin.");

  for (let m = 13; m <= 17; m++) tally = addSent(tally, sent("parsed"), at(m));
  assert.equal(sentSummary(tally, time), "6 pages since 18:12, all read by SageFin.");

  tally = addSent(addSent(tally, sent("failed"), at(18)), sent("unsupported"), at(19));
  assert.equal(sentSummary(tally, time), "8 pages since 18:12. SageFin read 6, could not read 1 and cannot read 1 yet.");
  assert.equal(tally.at, at(19).toISOString());

  const heldOnly = addSent(addSent(undefined, sent("unsupported"), at(12)), sent("unsupported"), at(13));
  assert.equal(sentSummary(heldOnly, time), "2 pages since 18:12. SageFin cannot read 2 yet.");
});

// A sync sends a list page and then each order's page, each answering with the orders on it. Added
// up, every order counted twice; one page's answer alone read as if the sync had found one order.
test("no order count is claimed for what was sent", () => {
  const tally = addSent(undefined, { retailer: "walmart", kind: "order_list_next_data", status: "parsed", orders: 5, ordersMatched: 2 }, new Date());
  assert.doesNotMatch(sentSummary(tally), /order|matched/);
});
