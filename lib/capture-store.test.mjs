import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCaptureStore } from "./capture-store.mjs";

// A stand-in for the keychain the tests can see through: reversed text behind a marker. Enough to
// tell "sealed" from "written as it arrived" without depending on Electron.
const seal = (plaintext) => Buffer.from(`sealed:${[...plaintext].reverse().join("")}`);
const open = (sealed) => [...Buffer.from(sealed).toString().slice("sealed:".length)].reverse().join("");

function store(t, now) {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-desktop-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, captures: createCaptureStore({ dir, seal, open, now }) };
}

const SITE = "https://my.sagefin.app";
const PAYLOAD = '{"props":{"pageProps":{"order":{"id":"200000000000001","shipTo":"742 Evergreen Terrace"}}}}';

test("a saved page comes back exactly as it arrived", (t) => {
  const { captures } = store(t);

  const { added, record } = captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });

  assert.equal(added, true);
  assert.equal(captures.read(record.id), PAYLOAD);
  assert.equal(record.bytes, Buffer.byteLength(PAYLOAD));
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(captures.list(), [record]);
});

// The reason seal is not optional: a payload is purchases and an address, verbatim.
test("nothing a page said is on disk as it arrived", (t) => {
  const { dir, captures } = store(t);
  captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });

  for (const name of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, name), "utf8");
    assert.ok(!text.includes("Evergreen"), `${name} holds the payload in the clear`);
    assert.ok(!text.includes("200000000000001"), `${name} holds an order number in the clear`);
  }
});

test("saved files are readable by this user only", { skip: process.platform === "win32" }, (t) => {
  const { dir, captures } = store(t);
  captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });

  for (const name of readdirSync(dir)) {
    assert.equal(statSync(path.join(dir, name)).mode & 0o077, 0, name);
  }
});

// Opening the same unchanged order twice is the ordinary case.
test("the same page twice is one capture", (t) => {
  const { dir, captures } = store(t);

  const first = captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });
  const second = captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });

  assert.equal(second.added, false);
  assert.equal(second.record.id, first.record.id);
  assert.equal(captures.list().length, 1);
  assert.equal(readdirSync(dir).length, 2);
});

test("the same bytes from another retailer or as another kind are a different capture", (t) => {
  const { captures } = store(t);

  captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });
  assert.equal(captures.add({ site: SITE, retailer: "walmart", kind: "order_list_next_data", payload: PAYLOAD }).added, true);
  assert.equal(captures.add({ site: SITE, retailer: "costco", kind: "order_detail_next_data", payload: PAYLOAD }).added, true);
  assert.equal(captures.list().length, 3);

  // Saved while showing another SageFin: a separate capture, bound for that site only.
  const other = captures.add({ site: "https://my-test.sagefin.app", retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });
  assert.equal(other.added, true);
  assert.equal(other.record.site, "https://my-test.sagefin.app");
  assert.equal(captures.list().length, 4);
});

test("captures are listed oldest first", (t) => {
  const times = ["2026-10-02T10:00:00.000Z", "2026-10-02T09:00:00.000Z", "2026-10-02T11:00:00.000Z"];
  const { captures } = store(t, () => new Date(times.shift()));

  for (const n of [1, 2, 3]) captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: `{"n":${n}}` });

  assert.deepEqual(
    captures.list().map((r) => r.capturedAt),
    ["2026-10-02T09:00:00.000Z", "2026-10-02T10:00:00.000Z", "2026-10-02T11:00:00.000Z"],
  );
});

test("a store reopened on the same folder still has what was saved", (t) => {
  const { dir, captures } = store(t);
  const { record } = captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });

  const reopened = createCaptureStore({ dir, seal, open });

  assert.deepEqual(reopened.list(), [record]);
  assert.equal(reopened.read(record.id), PAYLOAD);
  assert.equal(reopened.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD }).added, false);
});

// One bad file must not hide every capture beside it.
test("a damaged record is skipped, and the captures beside it are still listed", (t) => {
  const { dir, captures } = store(t);
  const { record } = captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });

  writeFileSync(path.join(dir, "garbage.json"), "{ not json");
  writeFileSync(path.join(dir, "wrong-shape.json"), JSON.stringify({ id: 7, retailer: "walmart" }));
  writeFileSync(path.join(dir, "orphan.json"), JSON.stringify({ ...record, id: "20261002T000000000Z-000000000000" }));

  assert.deepEqual(captures.list(), [record]);
});

test("a capture id cannot be used to read another file", (t) => {
  const { captures } = store(t);

  for (const id of ["../secret", "..%2Fsecret", "/etc/passwd", "", "20261002T000000000Z-ABCDEF000000/.."]) {
    assert.throws(() => captures.read(id), /Not a capture id/, id);
  }
});

test("a capture that has been let go is gone, record and bytes", (t) => {
  const { dir, captures } = store(t);
  const first = captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });
  const second = captures.add({ site: SITE, retailer: "walmart", kind: "order_list_next_data", payload: PAYLOAD });

  captures.remove(first.record.id);

  assert.deepEqual(captures.list(), [second.record]);
  assert.equal(readdirSync(dir).length, 2);
  assert.throws(() => captures.read(first.record.id));

  // Letting go twice, or of something never held, is not an error; a bad id still is.
  captures.remove(first.record.id);
  assert.throws(() => captures.remove("../x"), /Not a capture id/);
});

test("a record from before captures named their site is not listed", (t) => {
  const { dir, captures } = store(t);
  const { record } = captures.add({ site: SITE, retailer: "walmart", kind: "order_detail_next_data", payload: PAYLOAD });
  const { site: _site, ...old } = record;
  writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(old));

  assert.deepEqual(captures.list(), []);
});
