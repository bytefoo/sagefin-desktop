import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createHmac, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NO_NOTICES,
  PAGE_ASK_GAP_MS,
  PROMPTS,
  SYNC_NOTICE_GAP_MS,
  beginEnrolment,
  forgetsHolding,
  inNoHousehold,
  failureReason,
  failedSaying,
  householdStanding,
  menuChoices,
  holderTokens,
  holdsKeyFor,
  lockedForThisWindow,
  PAGE_OFFER_WAIT_MS,
  unlockWindowOnShow,
  whyIgnorePageAsk,
  lookAtEnrolment,
  readPrivateMode,
  syncNotice,
  typedCode,
  unlockAskedByPage,
  unlockHere,
  whyNotNow,
} from "./private-mode.mjs";
import {
  addCheck,
  addCommitment,
  b64,
  envelopeMacKey,
  fromB64,
  holderRequest,
  openWithAgreement,
  seal,
  sealedCopyInfo,
  unlockApprove,
  unlockInfo,
  uuidBytes,
} from "./private-protocol.mjs";

// ── A computer's two keys, in software, standing in for its security chip ──────────────────────

function softwareKeys() {
  const agreement = createECDH("prime256v1");
  agreement.generateKeys();
  const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = signing.publicKey.export({ format: "jwk" });
  const signingPublicKey = Buffer.concat([Buffer.of(4), Buffer.from(/** @type {string} */ (jwk.x), "base64url"), Buffer.from(/** @type {string} */ (jwk.y), "base64url")]);
  const prompts = /** @type {string[]} */ ([]);
  let answer = "approve";
  const store = {
    prompts,
    /** @param {string} next */
    answerWith(next) {
      answer = next;
    },
    publicKeys: async () => ({ agreementPublicKey: agreement.getPublicKey(), signingPublicKey }),
    create: async () => ({ agreementPublicKey: agreement.getPublicKey(), signingPublicKey }),
    /** @template T @param {string} prompt @param {(s: any) => Promise<T>} use */
    async withPresence(prompt, use) {
      prompts.push(prompt);
      if (answer !== "approve") throw new Error("cancelled");
      return use({
        agree: async (/** @type {Uint8Array} */ peer) => agreement.computeSecret(Buffer.from(peer)),
        sign: async (/** @type {Uint8Array} */ bytes) => sign("sha256", bytes, { key: signing.privateKey, dsaEncoding: "ieee-p1363" }),
      });
    },
  };
  return store;
}

/** @param {Uint8Array} point @param {Uint8Array} bytes @param {Uint8Array} signature */
function verifies(point, bytes, signature) {
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(point.subarray(1, 33)).toString("base64url"), y: Buffer.from(point.subarray(33)).toString("base64url") }, format: "jwk" });
  return verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, signature);
}

/**
 * A version-1 envelope with one device, as SageFin's server writes one: each field with its
 * length, the sealed copy to the device's agreement key, the MAC under the file key.
 */
function envelopeFor({ household, epoch, holder, agreementPublicKey, signingPublicKey, fileKey }) {
  const field = (/** @type {Uint8Array} */ b) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, Buffer.from(b)]);
  };
  const long = (/** @type {number} */ v) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(v));
    return b;
  };
  const sealed = seal({ recipientPublicKey: agreementPublicKey, info: sealedCopyInfo(household, epoch, holder), plaintext: fileKey });
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const body = Buffer.concat([
    field(household), field(Buffer.of(1)), field(long(epoch)), field(long(1)), field(long(1_790_000_000)), field(Buffer.alloc(0)), field(count),
    field(holder), field(Buffer.of(1)), field(agreementPublicKey), field(signingPublicKey), field(sealed.enc), field(sealed.ciphertext), field(Buffer.alloc(0)), field(Buffer.alloc(0)),
  ]);
  const mac = createHmac("sha256", envelopeMacKey(fileKey, household, epoch)).update(Buffer.concat([Buffer.from("SageFin-PM-v1 envelope\0", "ascii"), body])).digest();
  return Buffer.concat([Buffer.from("SFPMENV1", "ascii"), body, mac]);
}

/** SageFin's side of U1, U3 and U4, as far as these tests need it. */
async function aServer({ asks = {} } = {}) {
  const keys = softwareKeys();
  const householdId = randomUUID();
  const holderId = randomUUID();
  const household = /** @type {Uint8Array} */ (uuidBytes(householdId));
  const holder = /** @type {Uint8Array} */ (uuidBytes(holderId));
  const fileKey = randomBytes(32);
  const { agreementPublicKey, signingPublicKey } = await keys.publicKeys();
  let envelope = envelopeFor({ household, epoch: 2, holder, agreementPublicKey, signingPublicKey, fileKey });
  /** @type {Map<string, any>} */
  const requests = new Map();
  const seen = /** @type {string[]} */ ([]);
  const opened = /** @type {Buffer[]} */ ([]);
  const api = {
    /** @param {string} path @param {any} body */
    async post(path, body) {
      seen.push(`POST ${path}`);
      if (path === "/private/unlock-requests") {
        const key = createECDH("prime256v1");
        key.generateKeys();
        const issued = {
          requestId: randomUUID(), nonce: b64(randomBytes(32)), requestPublicKey: b64(key.getPublicKey()), householdId, epoch: 2, purpose: body.purpose,
          askedByThisSession: true, ...asks,
        };
        requests.set(issued.requestId, { issued, key });
        return { status: 200, body: issued };
      }
      const approve = /^\/private\/unlock-requests\/([^/]+)\/approve$/.exec(path);
      if (approve) {
        const { issued, key } = requests.get(approve[1]);
        const r = { household, request: uuidBytes(issued.requestId), nonce: fromB64(issued.nonce), epoch: 2, purpose: issued.purpose, requestPublicKey: key.getPublicKey() };
        const enc = /** @type {Buffer} */ (fromB64(body.enc));
        const ct = /** @type {Buffer} */ (fromB64(body.ct));
        const got = openWithAgreement({ agreement: key.computeSecret(enc), enc, recipientPublicKey: key.getPublicKey(), info: unlockInfo(/** @type {any} */ (r), holder), ciphertext: ct });
        const ok = got && verifies(signingPublicKey, unlockApprove(/** @type {any} */ (r), holder, enc, ct), /** @type {Buffer} */ (fromB64(body.signature)));
        if (!ok) return { status: 403, body: { code: "bad_signature" } };
        opened.push(got);
        return { status: 200, body: { state: "unlocked" } };
      }
      return { status: 404, body: { code: "not_found" } };
    },
    /** @param {string} path */
    async get(path) {
      seen.push(`GET ${path}`);
      if (path === "/private/envelope") return { status: 200, body: { envelope: b64(envelope) } };
      return { status: 404, body: { code: "not_found" } };
    },
  };
  return {
    api, keys, fileKey, seen, opened, holding: { householdId, holderId },
    /** Somebody else's envelope under another key: the same holder, sealed a key that is not the household's. */
    replaceEnvelopeKey() {
      const other = randomBytes(32);
      const good = envelopeFor({ household, epoch: 2, holder, agreementPublicKey, signingPublicKey, fileKey: other });
      // Its MAC made under the real key's MAC key, so the sealed key and the MAC disagree.
      envelope = Buffer.concat([good.subarray(0, good.length - 32), envelopeFor({ household, epoch: 2, holder, agreementPublicKey, signingPublicKey, fileKey }).subarray(-32)]);
    },
  };
}

test("its own window: asked on its own sign-in, approved at the prompt, and the server opens the household's key", async () => {
  const s = await aServer();
  const done = await unlockHere({ api: s.api, keys: s.keys, holding: s.holding, purpose: "full" });
  assert.deepEqual(done, { outcome: "done", code: null });
  assert.deepEqual(s.keys.prompts, [PROMPTS.unlock]);
  assert.equal(s.opened.length, 1);
  assert.ok(s.opened[0].equals(s.fileKey));
});

test("Sync and lock asks in its own words, and is approved the same way", async () => {
  const s = await aServer();
  assert.equal((await unlockHere({ api: s.api, keys: s.keys, holding: s.holding, purpose: "sync" })).outcome, "done");
  assert.deepEqual(s.keys.prompts, [PROMPTS.sync]);
});

test("a request this sign-in did not ask for is never approved, and nobody is asked", async () => {
  for (const asks of [{ askedByThisSession: false }, { purpose: "sync" }]) {
    const s = await aServer({ asks });
    const done = await unlockHere({ api: s.api, keys: s.keys, holding: s.holding, purpose: "full" });
    assert.equal(done.outcome, "failed", JSON.stringify(asks));
    assert.deepEqual(s.keys.prompts, []);
    assert.equal(s.seen.some((line) => line.endsWith("/approve")), false);
  }
});

test("a sign-in in another household is refused as such, and the key is not touched", async () => {
  const s = await aServer({ asks: { householdId: randomUUID() } });
  const done = await unlockHere({ api: s.api, keys: s.keys, holding: s.holding, purpose: "full" });
  assert.deepEqual(done, { outcome: "refused", code: "other_household" });
  assert.equal(forgetsHolding(done.code), false);
  assert.deepEqual(s.keys.prompts, []);
});

test("a holding is forgotten only when the key can no longer open anything", () => {
  for (const code of ["unknown_holder", "not_private", "standard_again", "no_household"]) assert.equal(forgetsHolding(code), true, code);
  for (const code of ["not_found", "other_household", "wipe_begun", "too_many_requests", "epoch_behind", "no_file", null, undefined]) assert.equal(forgetsHolding(code), false, String(code));
});

test("a person who says no sends nothing", async () => {
  const s = await aServer();
  s.keys.answerWith("cancel");
  assert.equal((await unlockHere({ api: s.api, keys: s.keys, holding: s.holding, purpose: "full" })).outcome, "cancelled");
  assert.equal(s.seen.some((line) => line.endsWith("/approve")), false);
});

test("an envelope whose sealed key and MAC do not belong together is not approved", async () => {
  const s = await aServer();
  s.replaceEnvelopeKey();
  assert.equal((await unlockHere({ api: s.api, keys: s.keys, holding: s.holding, purpose: "full" })).outcome, "failed");
  assert.equal(s.seen.some((line) => line.endsWith("/approve")), false);
});

test("the key is used only from this app's own control, or a page ask let through, in front of a person", () => {
  /** @type {import("./private-mode.mjs").Circumstances} */
  const fine = { by: "app", pageAskAllowed: false, screenLocked: false, windowShown: true, windowFocused: true, prompting: false };
  assert.equal(whyNotNow(fine), null);
  // The page may ask; an ask whyIgnorePageAsk refused is never a use.
  assert.equal(whyNotNow({ ...fine, by: "page" }), "page-ask-ignored");
  assert.equal(whyNotNow({ ...fine, by: "page", pageAskAllowed: true }), null);
  // Anything that is not plainly one of the two is refused.
  assert.equal(whyNotNow(/** @type {any} */ ({ ...fine, by: undefined, pageAskAllowed: true })), "page-ask-ignored");
  assert.equal(whyNotNow(/** @type {any} */ ({ ...fine, by: "page", pageAskAllowed: "yes" })), "page-ask-ignored");
  // A page ask let through still meets every other rule.
  const page = { ...fine, by: /** @type {const} */ ("page"), pageAskAllowed: true };
  assert.equal(whyNotNow({ ...page, screenLocked: true }), "screen-locked");
  assert.equal(whyNotNow({ ...page, windowShown: false }), "window-hidden");
  assert.equal(whyNotNow({ ...page, windowFocused: false }), "window-behind");
  assert.equal(whyNotNow({ ...page, prompting: true }), "already-asking");
  assert.equal(whyNotNow({ ...fine, screenLocked: true }), "screen-locked");
  assert.equal(whyNotNow({ ...fine, windowShown: false }), "window-hidden");
  assert.equal(whyNotNow({ ...fine, windowFocused: false }), "window-behind");
  assert.equal(whyNotNow({ ...fine, prompting: true }), "already-asking");
});

test("the page learns one yes or no: whether this computer holds a key of the household it names", () => {
  const holding = { householdId: "6f1c2a3b-0000-4000-8000-00000000000a", holderId: "6f1c2a3b-0000-4000-8000-00000000000b" };
  assert.equal(holdsKeyFor(holding, "6f1c2a3b-0000-4000-8000-00000000000a"), true);
  assert.equal(holdsKeyFor(holding, "6F1C2A3B-0000-4000-8000-00000000000A"), true);
  assert.equal(holdsKeyFor(holding, "6f1c2a3b-0000-4000-8000-00000000000c"), false);
  // Naming the holder id does not count as naming the household.
  assert.equal(holdsKeyFor(holding, holding.holderId), false);
  assert.equal(holdsKeyFor(null, "6f1c2a3b-0000-4000-8000-00000000000a"), false);
  for (const odd of [undefined, null, "", 42, {}, ["6f1c2a3b-0000-4000-8000-00000000000a"]]) assert.equal(holdsKeyFor(holding, odd), false);
});

test("the window counts as locked only when SageFin plainly says so", () => {
  assert.equal(lockedForThisWindow({ status: 200, body: { state: "locked" } }), true);
  // Unlocked for another sign-in is locked for this one.
  assert.equal(lockedForThisWindow({ status: 200, body: { state: "unlocked", forThisSession: false } }), true);
  assert.equal(lockedForThisWindow({ status: 200, body: { state: "unlocked", forThisSession: true } }), false);
  assert.equal(lockedForThisWindow({ status: 200, body: { state: "unlocked" } }), false);
  assert.equal(lockedForThisWindow({ status: 200, body: { state: "off" } }), false);
  for (const odd of [null, undefined, { status: 401, body: null }, { status: 500, body: { state: "locked" } }, { status: 200, body: null }, { status: 200, body: "locked" }]) {
    assert.equal(lockedForThisWindow(odd), false);
  }
});

test("the unlock window does not open by itself over a page that offers its own unlock", () => {
  const shown = { holdsAKey: true, locked: true, pageOffers: false, waitedMs: 0 };
  // The page has said it draws its way in: nothing opens, then or later.
  assert.equal(unlockWindowOnShow({ ...shown, pageOffers: true }), "page-offers");
  assert.equal(unlockWindowOnShow({ ...shown, pageOffers: true, waitedMs: PAGE_OFFER_WAIT_MS * 10 }), "page-offers");
  // Not yet: the app waits for it.
  assert.equal(unlockWindowOnShow(shown), "wait");
  assert.equal(unlockWindowOnShow({ ...shown, waitedMs: PAGE_OFFER_WAIT_MS - 1 }), "wait");
  // A page that never says so (a web app from before it did) still gets the window.
  assert.equal(unlockWindowOnShow({ ...shown, waitedMs: PAGE_OFFER_WAIT_MS }), "open");
  // Nothing to unlock, or no key here to unlock it with: nothing, whatever the page says.
  for (const pageOffers of [true, false]) {
    assert.equal(unlockWindowOnShow({ ...shown, pageOffers, locked: false, waitedMs: PAGE_OFFER_WAIT_MS }), "nothing");
    assert.equal(unlockWindowOnShow({ ...shown, pageOffers, holdsAKey: false, waitedMs: PAGE_OFFER_WAIT_MS }), "nothing");
  }
});

test("the page may ask only in front of a person, and not again and again", () => {
  const fine = { lastAt: null, now: 1_000_000, screenLocked: false, windowShown: true, windowFocused: true, overlayOpen: false };
  assert.equal(whyIgnorePageAsk(fine), null);
  assert.equal(whyIgnorePageAsk({ ...fine, screenLocked: true }), "screen-locked");
  assert.equal(whyIgnorePageAsk({ ...fine, windowShown: false }), "window-hidden");
  assert.equal(whyIgnorePageAsk({ ...fine, windowFocused: false }), "window-behind");
  assert.equal(whyIgnorePageAsk({ ...fine, overlayOpen: true }), "already-showing");
  assert.equal(whyIgnorePageAsk({ ...fine, lastAt: fine.now - 1 }), "too-soon");
  assert.equal(whyIgnorePageAsk({ ...fine, lastAt: fine.now - PAGE_ASK_GAP_MS + 1 }), "too-soon");
  assert.equal(whyIgnorePageAsk({ ...fine, lastAt: fine.now - PAGE_ASK_GAP_MS }), null);
  // A clock that went backwards is not a reason to refuse for ever.
  assert.equal(whyIgnorePageAsk({ ...fine, lastAt: fine.now + 60_000 }), null);
  // An ask ignored here is never a use of the key.
  assert.equal(whyNotNow({ by: "page", pageAskAllowed: false, screenLocked: false, windowShown: true, windowFocused: true, prompting: false }), "page-ask-ignored");
});

/** A page ask that may be carried out, and the circumstances that go with it. */
const pageAskNow = () => ({
  ask: { lastAt: null, now: 1_000_000, screenLocked: false, windowShown: true, windowFocused: true, overlayOpen: false },
  circumstances: { screenLocked: false, windowShown: true, windowFocused: true, prompting: false },
});

test("the page's unlock button goes straight to the prompt, with the app's own sentence, and the page learns only how it ended", async () => {
  const s = await aServer();
  let started = 0;
  const done = await unlockAskedByPage({ ...pageAskNow(), holding: s.holding, householdId: s.holding.householdId, api: s.api, keys: () => s.keys, started: () => started++ });
  assert.equal(done.outcome, "unlocked");
  assert.equal(started, 1);
  // The operating system's prompt was asked, once, with the fixed sentence for this window.
  assert.deepEqual(s.keys.prompts, [PROMPTS.unlock]);
  assert.equal(s.opened.length, 1);
  // What the page is told is one of five words: nothing of the key, the request or the holder.
  assert.ok(["unlocked", "cancelled", "refused", "failed", "not-now"].includes(done.outcome));
});

test("a page ask never skips the prompt: a person who says no unlocks nothing, and the page hears cancelled", async () => {
  const s = await aServer();
  s.keys.answerWith("cancel");
  const done = await unlockAskedByPage({ ...pageAskNow(), holding: s.holding, householdId: s.holding.householdId, api: s.api, keys: () => s.keys });
  assert.equal(done.outcome, "cancelled");
  assert.deepEqual(s.keys.prompts, [PROMPTS.unlock]);
  assert.equal(s.seen.some((line) => line.endsWith("/approve")), false);
  assert.equal(s.opened.length, 0);
});

test("a page ask that is not let through asks nobody and sends nothing", async () => {
  const fine = pageAskNow();
  const refused = [
    { ...fine, ask: { ...fine.ask, lastAt: fine.ask.now - 1 } }, // within ten seconds
    { ...fine, ask: { ...fine.ask, windowFocused: false }, circumstances: { ...fine.circumstances, windowFocused: false } }, // window not in front
    { ...fine, ask: { ...fine.ask, windowShown: false }, circumstances: { ...fine.circumstances, windowShown: false } },
    { ...fine, ask: { ...fine.ask, screenLocked: true }, circumstances: { ...fine.circumstances, screenLocked: true } },
    { ...fine, ask: { ...fine.ask, overlayOpen: true } }, // the unlock window is up
    { ...fine, circumstances: { ...fine.circumstances, prompting: true } }, // a prompt is showing
  ];
  for (const [i, c] of refused.entries()) {
    const s = await aServer();
    let started = 0;
    const done = await unlockAskedByPage({ ...c, holding: s.holding, householdId: s.holding.householdId, api: s.api, keys: () => s.keys, started: () => started++ });
    assert.equal(done.outcome, "not-now", `case ${i}`);
    assert.equal(started, 0, `case ${i}`);
    assert.deepEqual(s.keys.prompts, [], `case ${i}`);
    assert.deepEqual(s.seen, [], `case ${i}`);
  }
  // A household this computer holds no key of, or none at all.
  for (const [holding, householdId] of [[undefined, randomUUID()], ["mine", randomUUID()], ["mine", undefined]]) {
    const s = await aServer();
    const done = await unlockAskedByPage({ ...fine, holding: holding ? s.holding : undefined, householdId, api: s.api, keys: () => s.keys });
    assert.equal(done.outcome, "not-now");
    assert.deepEqual(s.keys.prompts, []);
    assert.deepEqual(s.seen, []);
  }
});

test("the page's bridge can ask, and never press the app's buttons or reach its key", () => {
  const preload = readFileSync(path.join(import.meta.dirname, "..", "main", "shell-preload.cjs"), "utf8");
  const channels = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(channels.includes("shell:holds-key"));
  assert.ok(channels.includes("shell:unlock-here"));
  assert.ok(channels.includes("shell:show-unlock"));
  assert.ok(channels.includes("shell:add-this-computer"));
  assert.ok(channels.includes("shell:go-private-here"));
  assert.ok(channels.includes("shell:add-a-device"));
  assert.deepEqual(channels.filter((c) => !c.startsWith("shell:")), []);
  // The unlock window's own channels are not on the page's bridge.
  assert.equal(/unlock:go|unlock:cancel/.test(preload), false);
  // Every ask that may start something is passed on only straight after a real press on the page.
  for (const channel of ["shell:unlock-here", "shell:show-unlock", "shell:add-this-computer", "shell:go-private-here", "shell:add-a-device"]) {
    assert.match(preload, new RegExp(`pressed\\(\\) \\? ipcRenderer\\.invoke\\("${channel}"`), channel);
  }
});

test("a key lives only in a Mac's or a Windows computer's security chip", () => {
  assert.deepEqual(holderTokens("darwin", { hardwareKeys: true }), { platform: "desktop-macos", keyProtection: "secure-enclave" });
  assert.deepEqual(holderTokens("win32", { hardwareKeys: true }), { platform: "desktop-windows", keyProtection: "tpm" });
  assert.equal(holderTokens("linux", { hardwareKeys: true }), null);
  assert.equal(holderTokens("darwin", { hardwareKeys: false }), null);
  assert.equal(Object.isFrozen(PROMPTS), true);
});

test("new bank activity: one notification a locked period, never two within six hours, counted here", () => {
  const here = { holdsAKey: true };
  const waiting = { locked: true, syncWaiting: true };
  let at = 1_800_000_000_000;
  let { notify, state } = syncNotice(NO_NOTICES, waiting, at, here);
  assert.equal(notify, true);
  // SageFin saying it again changes nothing in the same locked period.
  ({ notify, state } = syncNotice(state, waiting, (at += 60_000), here));
  assert.equal(notify, false);
  // Unlocked, then locked again within six hours: still no second one.
  ({ state } = syncNotice(state, { locked: false, syncWaiting: false }, (at += 60_000), here));
  ({ notify, state } = syncNotice(state, waiting, (at += 60_000), here));
  assert.equal(notify, false);
  // After six hours, a new locked period may have its one.
  ({ notify } = syncNotice(state, waiting, at + SYNC_NOTICE_GAP_MS, here));
  assert.equal(notify, true);
  // Nothing waiting, or no key here: nothing.
  assert.equal(syncNotice(NO_NOTICES, { locked: true, syncWaiting: false }, at, here).notify, false);
  assert.equal(syncNotice(NO_NOTICES, waiting, at, { holdsAKey: false }).notify, false);
});

test("the check-in's privateMode is read strictly", () => {
  assert.deepEqual(readPrivateMode({ locked: true, syncWaiting: true }), { locked: true, syncWaiting: true });
  assert.deepEqual(readPrivateMode({ locked: false, syncWaiting: true }), { locked: false, syncWaiting: false });
  assert.deepEqual(readPrivateMode({ locked: true, syncWaiting: "yes" }), { locked: true, syncWaiting: false });
  assert.equal(readPrivateMode(null), null);
  assert.equal(readPrivateMode({ syncWaiting: true }), null);
});

test("adding this computer: its keys, what it is, a commitment; it reveals once, and shows the phone's twelve characters", async () => {
  const keys = softwareKeys();
  const householdId = randomUUID();
  const addId = randomUUID();
  const nonce = randomBytes(32);
  const approverValue = randomBytes(20);
  /** @type {any} */
  let offered = null;
  let reveals = 0;
  let challenged = false;
  const api = {
    /** @param {string} path @param {any} body */
    async post(path, body) {
      if (path === "/private/holder-requests") return { status: 200, body: { addId, householdId, nonce: b64(nonce) } };
      if (path.endsWith("/device")) {
        offered = body;
        return { status: 200, body: {} };
      }
      if (path.endsWith("/reveal")) {
        reveals++;
        offered.reveal = body.value;
        return { status: 200, body: {} };
      }
      return { status: 404, body: {} };
    },
    /** @param {string} _path */
    async get(_path) {
      return { status: 200, body: { state: "pending", device: offered.device, challenge: challenged ? b64(approverValue) : null } };
    },
  };
  const begun = await beginEnrolment({ api, keys, name: "A test Mac", tokens: { platform: "desktop-macos", keyProtection: "secure-enclave" } });
  assert.ok("enrolment" in begun);
  const enrolment = begun.enrolment;
  assert.deepEqual(keys.prompts, [PROMPTS.enrol]);
  assert.equal(offered.platform, "desktop-macos");
  assert.equal(offered.keyProtection, "secure-enclave");

  // The request's own signature is the signing key's over A1b's bytes.
  const household = /** @type {Uint8Array} */ (uuidBytes(householdId));
  const add = /** @type {Uint8Array} */ (uuidBytes(addId));
  assert.equal(verifies(enrolment.device.signingPublicKey, holderRequest(household, add, nonce, enrolment.device), /** @type {Uint8Array} */ (fromB64(offered.signature))), true);

  // Nothing revealed before the phone's value is on the request.
  assert.equal((await lookAtEnrolment(api, enrolment)).show, "waiting");
  assert.equal(reveals, 0);

  challenged = true;
  const looked = await lookAtEnrolment(api, enrolment);
  assert.equal(looked.show, "check");
  assert.equal(reveals, 1);
  // The revealed value opens the commitment, and the check is the one the phone computes.
  assert.ok(Buffer.from(addCommitment(household, add, enrolment.device, /** @type {Uint8Array} */ (fromB64(offered.reveal)))).equals(/** @type {Buffer} */ (fromB64(offered.commitment))));
  assert.equal(looked.enrolment.check, addCheck(household, add, enrolment.device, enrolment.value, approverValue));

  // Looking again reveals nothing more.
  await lookAtEnrolment(api, looked.enrolment);
  assert.equal(reveals, 1);
});

test("the code a person types into the phone is the add id in groups of four", () => {
  assert.equal(typedCode("0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001"), "0190 AAAA BBBB 7CCC 8DDD EEEE FFFF 0001");
});

test("the menu follows the signed-in household, and offers nothing when it does not know", () => {
  const h = { locked: false, holdsAKey: false, canHoldKey: true };
  assert.deepEqual(menuChoices({ ...h, standing: "standard" }), ["go-private"]);
  assert.deepEqual(menuChoices({ ...h, standing: "standard", holdsAKey: true }), ["go-private"]);
  assert.deepEqual(menuChoices({ ...h, standing: "standard", canHoldKey: false }), []);
  assert.deepEqual(menuChoices({ ...h, standing: "private" }), ["enrol"]);
  assert.deepEqual(menuChoices({ ...h, standing: "private", canHoldKey: false }), []);
  assert.deepEqual(menuChoices({ ...h, standing: "private", holdsAKey: true, locked: true }), ["unlock", "add-device"]);
  assert.deepEqual(menuChoices({ ...h, standing: "private", holdsAKey: true }), ["add-device"]);
  assert.deepEqual(menuChoices({ ...h, standing: "unknown", holdsAKey: true, locked: true }), []);
});

test("a household's standing is read strictly from the status", () => {
  const read = (status, state) => householdStanding({ status, body: { state } });
  assert.equal(read(200, "standard"), "standard");
  for (const s of ["locked", "unlocked"]) assert.equal(read(200, s), "private");
  for (const [st, s] of [[200, "key_to_restore"], [200, undefined], [401, "locked"], [500, "standard"]]) assert.equal(read(st, s), "unknown");
  assert.equal(householdStanding(null), "unknown");
  assert.equal(householdStanding({ status: 200, body: null }), "unknown");
});

test("a failure is kept as its step and the error's name, never what the error said", () => {
  const error = Object.assign(new Error("secret-looking text 0123456789abcdef"), { name: "NotAllowedError" });
  const reason = failureReason("second-confirmation", error);
  assert.equal(reason, "second-confirmation: NotAllowedError");
  assert.equal(reason.includes("secret"), false);
  assert.equal(failureReason("x", "a string"), "x: string");
  assert.equal(failureReason("x", null), "x: object".replace("object", "object"));
  assert.equal(failedSaying(reason), " (second-confirmation: NotAllowedError)");
  assert.equal(failedSaying(undefined), "");
});
