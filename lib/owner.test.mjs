// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCaptureStore } from "./capture-store.mjs";
import { createConsents, standingAnswer } from "./consent.mjs";
import { asCredential } from "./credential-store.mjs";
import { NO_OWNER, NOBODY, canComeBack, createOwners, householdKey, legacyIsTheirs, ownerOf, personKey, settle, takeOwnership } from "./owner.mjs";
import { walmart } from "./retailers.mjs";
import { createSyncStates } from "./sync-plan.mjs";
import { uploadPending } from "./uploader.mjs";

const seal = (/** @type {string} */ plaintext) => Buffer.from(`sealed:${plaintext}`);
const open = (/** @type {Uint8Array} */ sealed) => Buffer.from(sealed).toString().slice("sealed:".length);

const SITE = "https://my.sagefin.app";
const SECRET = `sfin_${"a1".repeat(24)}`;
const RETAILERS = ["amazon", "walmart", "costco"];

// Made-up ids.
const HOUSEHOLD_A = "0199a8b2-0000-7000-8000-00000000000a";
const HOUSEHOLD_B = "0199a8b2-0000-7000-8000-00000000000b";
const PERSON_1 = "0199a8b2-0000-7000-8000-000000000001";
const PERSON_2 = "0199a8b2-0000-7000-8000-000000000002";
const token = (/** @type {number} */ n) => `0199a8b2-1111-7000-8000-${String(n).padStart(12, "0")}`;

/** A credential as the page hands it over, with or without who it is for. */
const credential = (/** @type {number} */ n, /** @type {{ householdId?: string, userId?: string }} */ who = {}) =>
  /** @type {import("./credential-store.mjs").Credential} */ (asCredential({ secret: SECRET, tokenId: token(n), name: "SageFin Desktop (Test)", ...who }));

/** One computer's memory: everything takeOwnership looks after, in one folder. @param {import("node:test").TestContext} t */
function computer(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-desktop-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let tick = 0;
  const parts = {
    dir,
    owners: createOwners({ dir: path.join(dir, "sync"), seal, open }),
    syncStates: createSyncStates({ dir: path.join(dir, "sync"), seal, open }),
    captures: createCaptureStore({ dir: path.join(dir, "captures"), seal, open, now: () => new Date(Date.UTC(2026, 9, 28, 12, 0, tick++)) }),
    consents: createConsents({ dir: path.join(dir, "consent"), seal, open }),
  };
  /** Connects as `held` (or loses the connection, with null), as the app does on connect and at start. */
  const connect = (/** @type {import("./credential-store.mjs").Credential | null} */ held) =>
    takeOwnership({ siteKey: "prod", siteOrigin: SITE, credential: held, retailers: RETAILERS, ...parts });
  /** Whose memory the site has, as main/main.mjs reads it. */
  const owner = () => parts.owners.get("prod") ?? NO_OWNER;
  /** A sync that read one order and saved its page, for whoever the memory is for now. */
  const syncOne = (/** @type {string} */ id) => {
    const h = owner().household;
    const state = parts.syncStates.get("prod", h, "walmart");
    state.seen[id] = "fp";
    state.setup = { ...state.setup, status: "done" };
    parts.syncStates.set("prod", h, "walmart", state);
    parts.captures.add({ site: SITE, owner: h, retailer: "walmart", kind: "order_detail_next_data", payload: JSON.stringify({ order: id }) });
  };
  return { ...parts, connect, owner, syncOne };
}

/** A stand-in for SageFin that takes every page and remembers what it was sent. */
function server() {
  /** @type {string[]} */
  const payloads = [];
  /** @type {typeof globalThis.fetch} */
  const fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)).payload);
    return /** @type {any} */ ({ status: 200, json: async () => ({ status: "parsed" }) });
  };
  return { fetch, payloads };
}

test("a credential says which household and person when the page does, and stands for both when not", () => {
  const plain = credential(1);
  assert.equal(householdKey(plain), `t_${token(1).replace(/-/g, "")}`);
  assert.equal(personKey(plain), `t_${token(1).replace(/-/g, "")}`);

  const said = credential(1, { householdId: HOUSEHOLD_A.toUpperCase(), userId: PERSON_1 });
  assert.equal(said.householdId, HOUSEHOLD_A);
  assert.equal(householdKey(said), `h_${HOUSEHOLD_A.replace(/-/g, "")}`);
  assert.equal(personKey(said), `u_${PERSON_1.replace(/-/g, "")}`);

  // Anything that is not an id is as if the page had not said, and never costs the credential.
  const odd = credential(1, { householdId: "../../x", userId: "7" });
  assert.equal(odd.householdId, undefined);
  assert.equal(odd.userId, undefined);
  assert.deepEqual(ownerOf(odd), ownerOf(plain));

  assert.equal(canComeBack(householdKey(said)), true);
  assert.equal(canComeBack(personKey(said)), true);
  assert.equal(canComeBack(householdKey(plain)), false);
});

test("settling: nobody recorded takes on what is here; somebody else starts fresh; no credential changes nothing", () => {
  const a = ownerOf(credential(1, { householdId: HOUSEHOLD_A, userId: PERSON_1 }));
  const b = ownerOf(credential(2, { householdId: HOUSEHOLD_B, userId: PERSON_1 }));
  const byToken = ownerOf(credential(3));

  assert.deepEqual(settle(null, a), { owner: a, adoptNobody: { household: true, person: true }, drop: { household: null, person: null }, migrate: true });
  assert.deepEqual(settle(a, null).owner, a);
  assert.equal(settle(null, null).owner, null);
  assert.deepEqual(settle(a, a).drop, { household: null, person: null });
  // Another household, the same person: the household's memory is kept for it, the person's choices go with them.
  assert.deepEqual(settle(a, b).drop, { household: null, person: null });
  assert.deepEqual(settle(a, b).adoptNobody, { household: false, person: false });
  // Known only by a credential that has been replaced: never coming back, so let go.
  assert.deepEqual(settle(byToken, a).drop, { household: byToken.household, person: byToken.person });
});

test("a household deleted and made again starts with nothing, and is never sent the old one's pages", async (t) => {
  // The page says who the credential is for.
  const pc = computer(t);
  pc.connect(credential(1, { householdId: HOUSEHOLD_A, userId: PERSON_1 }));
  pc.syncOne("200000000000001");
  pc.consents.set(pc.owner().person, walmart, "saving", true);
  // SageFin could not take the page before the household was deleted.
  assert.equal(pc.captures.list().length, 1);

  // Deleted; the credential with it. The computer has none until the new household's page connects it.
  assert.equal(pc.connect(null).changed, false);
  assert.equal(pc.owner().household, householdKey({ tokenId: token(1), householdId: HOUSEHOLD_A }));

  const settled = pc.connect(credential(2, { householdId: HOUSEHOLD_B, userId: PERSON_1 }));
  assert.equal(settled.changed, true);
  const fresh = pc.syncStates.get("prod", pc.owner().household, "walmart");
  assert.deepEqual(fresh.seen, {});
  assert.equal(fresh.setup.status, "never");
  // What the new household is shown as waiting: only its own.
  assert.equal(pc.captures.list().filter((r) => r.owner === pc.owner().household).length, 0);
  // Sending with the new household's credential sends nothing of the old one's.
  const { fetch, payloads } = server();
  await uploadPending({ store: pc.captures, site: SITE, owner: ownerOf(credential(2, { householdId: HOUSEHOLD_B })).household, secret: SECRET, fetch });
  assert.deepEqual(payloads, []);
  // The person is the same, so their choice about Walmart's terms holds in the new household.
  assert.equal(standingAnswer(walmart, "saving", pc.consents.get(pc.owner().person, "walmart")), true);
});

test("without the page saying, a new credential is somebody new, and the old one's pages are let go", (t) => {
  const pc = computer(t);
  pc.connect(credential(1));
  pc.syncOne("200000000000001");
  pc.consents.set(pc.owner().person, walmart, "saving", true);
  const old = pc.owner();

  const settled = pc.connect(credential(2));
  assert.equal(settled.changed, true);
  // Kept by a credential that can never be held again, so nobody could ever claim them.
  assert.equal(settled.discarded, 1);
  assert.deepEqual(pc.captures.list(), []);
  assert.deepEqual(pc.syncStates.get("prod", old.household, "walmart").seen, {});
  assert.deepEqual(pc.syncStates.get("prod", pc.owner().household, "walmart").seen, {});
  assert.equal(standingAnswer(walmart, "saving", pc.consents.get(pc.owner().person, "walmart")), null);
});

test("a member who moves households, and back, finds each household's memory its own", async (t) => {
  const pc = computer(t);
  const inA = credential(1, { householdId: HOUSEHOLD_A, userId: PERSON_1 });
  pc.connect(inA);
  pc.syncOne("200000000000001");
  const a = pc.owner().household;

  pc.connect(credential(2, { householdId: HOUSEHOLD_B, userId: PERSON_1 }));
  const b = pc.owner().household;
  assert.deepEqual(pc.syncStates.get("prod", b, "walmart").seen, {});
  pc.syncOne("200000000000002");

  // Back in A: its own memory, and its own waiting page, which goes with A's credential alone.
  pc.connect(credential(3, { householdId: HOUSEHOLD_A, userId: PERSON_1 }));
  assert.equal(pc.owner().household, a);
  assert.deepEqual(pc.syncStates.get("prod", a, "walmart").seen, { "200000000000001": "fp" });
  const { fetch, payloads } = server();
  await uploadPending({ store: pc.captures, site: SITE, owner: a, secret: SECRET, fetch });
  assert.deepEqual(payloads, [JSON.stringify({ order: "200000000000001" })]);
  assert.deepEqual(pc.captures.list().map((r) => r.owner), [b]);
});

test("another person connecting the same computer is not taken to have made the first one's choices", (t) => {
  const pc = computer(t);
  pc.connect(credential(1, { householdId: HOUSEHOLD_A, userId: PERSON_1 }));
  pc.consents.set(pc.owner().person, walmart, "automation", true);
  const first = pc.owner().person;

  // The same household, another person.
  const settled = pc.connect(credential(2, { householdId: HOUSEHOLD_A, userId: PERSON_2 }));
  assert.equal(settled.changed, true);
  assert.equal(standingAnswer(walmart, "automation", pc.consents.get(pc.owner().person, "walmart")), null);
  // The household's memory is the household's, whoever connected it.
  assert.equal(pc.owner().household, householdKey({ tokenId: token(1), householdId: HOUSEHOLD_A }));
  // And the first person's choice is kept for them.
  pc.connect(credential(3, { householdId: HOUSEHOLD_A, userId: PERSON_1 }));
  assert.equal(pc.owner().person, first);
  assert.equal(standingAnswer(walmart, "automation", pc.consents.get(first, "walmart")), true);
});

test("what was kept before this computer was ever connected is the first household's", (t) => {
  const pc = computer(t);
  assert.deepEqual(pc.owner(), NO_OWNER);
  pc.syncOne("200000000000001");
  pc.consents.set(NOBODY, walmart, "saving", true);

  pc.connect(credential(1, { householdId: HOUSEHOLD_A, userId: PERSON_1 }));
  const now = pc.owner();
  assert.deepEqual(pc.syncStates.get("prod", now.household, "walmart").seen, { "200000000000001": "fp" });
  assert.deepEqual(pc.captures.list().map((r) => r.owner), [now.household]);
  assert.equal(standingAnswer(walmart, "saving", pc.consents.get(now.person, "walmart")), true);
  assert.deepEqual(pc.syncStates.get("prod", NOBODY, "walmart").seen, {});
});

// ---- the first start after the update -------------------------------------------------------

/** Writes what a computer kept before households were: memory per site and retailer, choices, pages. */
function before(/** @type {ReturnType<typeof computer>} */ pc, { readFor = /** @type {string | null} */ (null), pages = 0 } = {}) {
  const memory = { seen: { "200000000000001": "fp" }, readFor, lastFinishedAt: "2026-10-20T12:00:00.000Z", setup: { status: "done", reachedDate: "2025-01-01", listedIds: ["200000000000001"] } };
  writeFileSync(path.join(pc.dir, "sync", "sync-prod-walmart.bin"), seal(JSON.stringify(memory)));
  writeFileSync(path.join(pc.dir, "consent", "consent.bin"), seal(JSON.stringify({ walmart: { saving: { answer: true, at: "2026-10-01T00:00:00Z", termsUpdated: walmart.terms.updated } } })));
  for (let n = 0; n < pages; n += 1) {
    const { record } = pc.captures.add({ site: SITE, owner: NOBODY, retailer: "walmart", kind: "order_detail_next_data", payload: `{"old":${n}}` });
    const { owner: _owner, ...old } = record;
    writeFileSync(path.join(pc.dir, "captures", `${record.id}.json`), JSON.stringify(old));
  }
}

test("memory from before is the household's only when SageFin held it under the credential connected now", (t) => {
  assert.equal(legacyIsTheirs(null, token(1), 0), false);
  assert.equal(legacyIsTheirs({ readFor: null }, token(1), 0), false);
  assert.equal(legacyIsTheirs({ readFor: token(2) }, token(1), 0), false);
  assert.equal(legacyIsTheirs({ readFor: token(1) }, token(1), 1), false);
  assert.equal(legacyIsTheirs({ readFor: token(1) }, token(1), 0), true);

  const pc = computer(t);
  before(pc, { readFor: token(1) });
  const settled = pc.connect(credential(1));
  assert.equal(settled.changed, true);
  const now = pc.owner();
  assert.deepEqual(pc.syncStates.get("prod", now.household, "walmart").seen, { "200000000000001": "fp" });
  assert.equal(pc.syncStates.get("prod", now.household, "walmart").setup.status, "done");
  // The choices it synced under go with it.
  assert.equal(standingAnswer(walmart, "saving", pc.consents.get(now.person, "walmart")), true);
  assert.equal(pc.syncStates.legacy("prod", "walmart"), null);
});

test("memory from before that cannot be shown to be this household's is let go, pages and choices with it", (t) => {
  // The case that was found: the household was deleted, and the computer connected to the new one.
  const pc = computer(t);
  before(pc, { readFor: token(1), pages: 6 });
  const settled = pc.connect(credential(2));
  assert.equal(settled.discarded, 6);
  const now = pc.owner();
  assert.deepEqual(pc.syncStates.get("prod", now.household, "walmart").seen, {});
  assert.equal(pc.syncStates.get("prod", now.household, "walmart").setup.status, "never");
  assert.deepEqual(pc.captures.list(), []);
  assert.equal(standingAnswer(walmart, "saving", pc.consents.get(now.person, "walmart")), null);
  assert.equal(pc.syncStates.legacy("prod", "walmart"), null);
});

test("memory from before goes with its waiting pages or not at all", (t) => {
  // Held under this very credential, but a page from before still waits, and a page cannot be shown
  // to be anybody's: keeping the memory without it would say an order was read that SageFin never got.
  const pc = computer(t);
  before(pc, { readFor: token(1), pages: 1 });
  const settled = pc.connect(credential(1));
  assert.equal(settled.discarded, 1);
  assert.deepEqual(pc.syncStates.get("prod", pc.owner().household, "walmart").seen, {});
  assert.deepEqual(pc.captures.list(), []);
});

test("memory from before waits, untouched, while the computer has no credential", (t) => {
  const pc = computer(t);
  before(pc, { readFor: token(1), pages: 2 });
  assert.equal(pc.connect(null).changed, false);
  assert.deepEqual(pc.owner(), NO_OWNER);
  assert.notEqual(pc.syncStates.legacy("prod", "walmart"), null);
  assert.equal(pc.captures.list().length, 2);
  // And nothing of it is sent by anybody in the meantime.
  assert.equal(pc.captures.list().filter((r) => r.owner !== undefined).length, 0);
});

test("whose memory each site's is survives the app closing, and an unreadable record is nobody's", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-desktop-owners-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const owners = createOwners({ dir, seal, open });
  const a = ownerOf(credential(1, { householdId: HOUSEHOLD_A, userId: PERSON_1 }));
  owners.set("prod", a);
  assert.deepEqual(createOwners({ dir, seal, open }).get("prod"), a);
  assert.equal(owners.get("test"), null);
  assert.throws(() => owners.set("prod", { household: "../x", person: a.person }), /Not an owner/);
  writeFileSync(path.join(dir, "owners.bin"), "garbage");
  assert.equal(owners.get("prod"), null);
});
