import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createHmac, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import {
  addIdFromTyped,
  approveAdding,
  beginApproving,
  beginGoingPrivate,
  checkGroups,
  codeTexts,
  confirmRecoveryCode,
  deviceKind,
  finishGoingPrivate,
  forgetGoingPrivate,
  lookAtApproving,
} from "./first-holder.mjs";
import { PROMPTS } from "./private-mode.mjs";
import {
  addCheck,
  addCommitment,
  b64,
  envelopeMacKey,
  fromB64,
  holderAdd,
  holderAddV2,
  openWithAgreement,
  parseRecoveryCode,
  recoveryHolder,
  seal,
  sealedCopyInfo,
  setupHoldersV2,
  setupProve,
  setupProveInfo,
  sha256,
  unwrapRecovery,
  uuidBytes,
} from "./private-protocol.mjs";

// ── A computer's two keys, in software, standing in for its security chip ──────────────────────

function softwareKeys() {
  let agreement = createECDH("prime256v1");
  agreement.generateKeys();
  let signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const point = () => {
    const jwk = signing.publicKey.export({ format: "jwk" });
    return Buffer.concat([Buffer.of(4), Buffer.from(/** @type {string} */ (jwk.x), "base64url"), Buffer.from(/** @type {string} */ (jwk.y), "base64url")]);
  };
  const prompts = /** @type {string[]} */ ([]);
  const answers = /** @type {string[]} */ ([]);
  let created = 0;
  return {
    prompts,
    /** The next prompts' answers, in order; "approve" once they run out. */
    answers,
    get created() {
      return created;
    },
    publicKeys: async () => ({ agreementPublicKey: agreement.getPublicKey(), signingPublicKey: point() }),
    async create() {
      created++;
      agreement = createECDH("prime256v1");
      agreement.generateKeys();
      signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
      return { agreementPublicKey: agreement.getPublicKey(), signingPublicKey: point() };
    },
    /** @template T @param {string} prompt @param {(s: any) => Promise<T>} use */
    async withPresence(prompt, use) {
      prompts.push(prompt);
      if ((answers.shift() ?? "approve") !== "approve") throw new Error("cancelled");
      return use({
        agree: async (/** @type {Uint8Array} */ peer) => agreement.computeSecret(Buffer.from(peer)),
        sign: async (/** @type {Uint8Array} */ bytes) => sign("sha256", bytes, { key: signing.privateKey, dsaEncoding: "ieee-p1363" }),
      });
    },
  };
}

/** @param {Uint8Array} point @param {Uint8Array} bytes @param {Uint8Array} signature */
function verifies(point, bytes, signature) {
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(point.subarray(1, 33)).toString("base64url"), y: Buffer.from(point.subarray(33)).toString("base64url") }, format: "jwk" });
  return verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, signature);
}

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

/**
 * A version-1 draft envelope as SageFin's server writes one at S2: every holder offered, each
 * with the new file key sealed to its agreement key, and the MAC under the file key.
 * @param {{ household: Uint8Array, epoch: number, fileKey: Uint8Array, holders: { id: Uint8Array, kind: 1 | 2, agreementPublicKey: Uint8Array, signingPublicKey: Uint8Array, salt?: Uint8Array, wrapped?: Uint8Array }[] }} e
 */
function draftEnvelope({ household, epoch, fileKey, holders }) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(holders.length);
  const parts = [field(household), field(Buffer.of(1)), field(long(epoch)), field(long(1)), field(long(1_790_000_000)), field(Buffer.alloc(0)), field(count)];
  for (const h of holders) {
    const sealed = seal({ recipientPublicKey: h.agreementPublicKey, info: sealedCopyInfo(household, epoch, h.id), plaintext: fileKey });
    parts.push(field(h.id), field(Buffer.of(h.kind)), field(h.agreementPublicKey), field(h.signingPublicKey), field(sealed.enc), field(sealed.ciphertext), field(h.salt ?? Buffer.alloc(0)), field(h.wrapped ?? Buffer.alloc(0)));
  }
  const body = Buffer.concat(parts);
  const mac = createHmac("sha256", envelopeMacKey(fileKey, household, epoch)).update(Buffer.concat([Buffer.from("SageFin-PM-v1 envelope\0", "ascii"), body])).digest();
  return Buffer.concat([Buffer.from("SFPMENV1", "ascii"), body, mac]);
}

/** SageFin's side of S1 to S3, checking what a server checks. */
function aStandardHousehold({ draftWithAStranger = false } = {}) {
  const householdId = randomUUID();
  const memberUserId = randomUUID();
  const household = /** @type {Uint8Array} */ (uuidBytes(householdId));
  const seen = /** @type {string[]} */ ([]);
  /** @type {Map<string, any>} */
  const setups = new Map();
  let committed = /** @type {any} */ (null);
  const api = {
    /** @param {string} path @param {any} body */
    async post(path, body) {
      seen.push(`POST ${path}`);
      if (path === "/private/setup") {
        const setupId = randomUUID();
        setups.set(setupId, { epoch: 1 });
        return { status: 200, body: { setupId, householdId, epoch: 1, expiresAt: new Date(Date.now() + 600_000).toISOString(), recoveryCodes: 4 } };
      }
      const holders = /^\/private\/setup\/([^/]+)\/holders$/.exec(path);
      if (holders) {
        const setup = setups.get(holders[1]);
        // A setup takes one S2; other bytes for it again are refused, as the server refuses them.
        if (setup.device) return { status: 409, body: { code: "request_used" } };
        const setupBytes = /** @type {Uint8Array} */ (uuidBytes(holders[1]));
        const device = { holder: /** @type {Uint8Array} */ (uuidBytes(body.device.holderId)), name: body.device.name, agreementPublicKey: /** @type {Buffer} */ (fromB64(body.device.agreementPublicKey)), signingPublicKey: /** @type {Buffer} */ (fromB64(body.device.signingPublicKey)) };
        const recovery = body.recovery.map((/** @type {any} */ r) => ({ holder: /** @type {Uint8Array} */ (uuidBytes(r.holderId)), agreementPublicKey: fromB64(r.agreementPublicKey), signingPublicKey: fromB64(r.signingPublicKey), salt: fromB64(r.salt), wrapped: fromB64(r.wrapped) }));
        // The server's own checks of S2: version 2, this member, a Desktop's two tokens, every signature.
        assert.equal(body.memberUserId, memberUserId);
        assert.deepEqual([body.platform, body.keyProtection], ["desktop-macos", "secure-enclave"]);
        assert.equal(recovery.length, 4);
        const signed = setupHoldersV2({ household, setup: setupBytes, epoch: setup.epoch, member: /** @type {Uint8Array} */ (uuidBytes(memberUserId)), device, platform: body.platform, keyProtection: body.keyProtection, recovery });
        if (!verifies(device.signingPublicKey, signed, /** @type {Buffer} */ (fromB64(body.deviceSignature)))) return { status: 400, body: { code: "holders_not_accepted" } };
        recovery.forEach((/** @type {any} */ r, /** @type {number} */ n) => assert.equal(verifies(r.signingPublicKey, recoveryHolder({ household, context: setupBytes, epoch: 1, entry: r }), /** @type {Buffer} */ (fromB64(body.recoverySignatures[n]))), true));
        const fileKey = randomBytes(32);
        const stranger = createECDH("prime256v1");
        stranger.generateKeys();
        const listed = [
          { id: device.holder, kind: /** @type {1} */ (1), agreementPublicKey: device.agreementPublicKey, signingPublicKey: device.signingPublicKey },
          ...(draftWithAStranger ? [{ id: randomBytes(16), kind: /** @type {1} */ (1), agreementPublicKey: stranger.getPublicKey(), signingPublicKey: createECDH("prime256v1").generateKeys() }] : []),
          ...recovery.map((/** @type {any} */ r) => ({ id: r.holder, kind: /** @type {2} */ (2), agreementPublicKey: r.agreementPublicKey, signingPublicKey: r.signingPublicKey, salt: r.salt, wrapped: r.wrapped })),
        ];
        const draft = draftEnvelope({ household, epoch: 1, fileKey, holders: listed });
        const requestKey = createECDH("prime256v1");
        requestKey.generateKeys();
        const nonce = randomBytes(32);
        Object.assign(setup, { fileKey, draft, requestKey, nonce, device, recovery });
        return {
          status: 200,
          body: { requestId: holders[1], householdId, epoch: 1, holderId: body.device.holderId, nonce: b64(nonce), requestPublicKey: b64(requestKey.getPublicKey()), draftEnvelope: b64(draft), draftEnvelopeSha256: b64(sha256(draft)) },
        };
      }
      const prove = /^\/private\/setup\/([^/]+)\/prove$/.exec(path);
      if (prove) {
        const setup = setups.get(prove[1]);
        const setupBytes = /** @type {Uint8Array} */ (uuidBytes(prove[1]));
        const enc = /** @type {Buffer} */ (fromB64(body.enc));
        const ct = /** @type {Buffer} */ (fromB64(body.ct));
        const info = setupProveInfo(household, 1, setup.device.holder, setupBytes, setup.nonce);
        const opened = openWithAgreement({ agreement: setup.requestKey.computeSecret(enc), enc, recipientPublicKey: setup.requestKey.getPublicKey(), info, ciphertext: ct });
        const signed = setupProve({ household, setup: setupBytes, nonce: setup.nonce, epoch: 1, holder: setup.device.holder, enc, ciphertext: ct, requestPublicKey: setup.requestKey.getPublicKey() });
        if (!opened || !opened.equals(setup.fileKey) || !verifies(setup.device.signingPublicKey, signed, /** @type {Buffer} */ (fromB64(body.signature)))) return { status: 403, body: { code: "proof_wrong" } };
        if (body.recoveryCodeConfirmed !== true) return { status: 409, body: { code: "codes_not_confirmed" } };
        committed = setup;
        return { status: 200, body: { householdId, epoch: 1, envelopeSha256: b64(sha256(setup.draft)) } };
      }
      return { status: 404, body: { code: "not_found" } };
    },
    /** @param {string} path */
    async get(path) {
      seen.push(`GET ${path}`);
      if (path === "/me") return { status: 200, body: { userId: memberUserId } };
      if (path === "/private/status") return { status: 200, body: { state: committed ? "locked" : "standard" } };
      return { status: 404, body: { code: "not_found" } };
    },
  };
  return { api, seen, householdId, household, committed: () => committed };
}

const TOKENS = { platform: "desktop-macos", keyProtection: "secure-enclave" };

test("going private here: new keys in the chip, four codes, one typed back, two prompts, and the household is private", async () => {
  const server = aStandardHousehold();
  const keys = softwareKeys();
  const begun = await beginGoingPrivate({ api: server.api, keys });
  assert.ok("going" in begun);
  const going = begun.going;
  assert.equal(keys.created, 1);
  assert.equal(codeTexts(going).length, 4);
  assert.equal(new Set(codeTexts(going)).size, 4);
  // Nothing about the household changes before a code is typed back: only S1 and who is asking.
  assert.deepEqual(server.seen, ["POST /private/setup", "GET /me"]);
  assert.deepEqual(keys.prompts, []);

  // Not confirmed: nothing is signed, nothing is sent.
  assert.deepEqual(await finishGoingPrivate({ api: server.api, keys, going, name: "A test Mac", tokens: TOKENS }), { outcome: "refused", code: "codes_not_confirmed" });
  assert.deepEqual(keys.prompts, []);

  // A code that is not the one asked for does not confirm; the one asked for does, typed loosely.
  const asked = codeTexts(going)[going.confirmIndex];
  assert.equal(confirmRecoveryCode(going, codeTexts(going)[(going.confirmIndex + 1) % 4]), false);
  assert.equal(confirmRecoveryCode(going, asked.toLowerCase().replaceAll("-", " ")), true);

  const done = await finishGoingPrivate({ api: server.api, keys, going, name: "A test Mac", tokens: TOKENS });
  assert.equal(done.outcome, "done");
  assert.deepEqual(keys.prompts, [PROMPTS.goPrivate, PROMPTS.goPrivate]);
  const committed = server.committed();
  assert.ok(committed);
  assert.equal(/** @type {any} */ (done).holding.householdId, server.householdId);

  // Every code the member wrote down opens its own wrap, as a recovery would.
  const texts = codeTexts(going);
  committed.recovery.forEach((/** @type {any} */ r, /** @type {number} */ n) => {
    const scalars = unwrapRecovery({ code: /** @type {Buffer} */ (parseRecoveryCode(texts[n])), salt: r.salt, household: server.household, holder: r.holder, wrapped: r.wrapped });
    assert.ok(scalars, `code ${n}`);
  });
  forgetGoingPrivate(going);
  assert.equal(confirmRecoveryCode({ ...going, confirmed: false }, asked), false);
});

test("a person who says no at either prompt changes nothing, and Try again uses the same codes", async () => {
  const server = aStandardHousehold();
  const keys = softwareKeys();
  const begun = await beginGoingPrivate({ api: server.api, keys });
  assert.ok("going" in begun);
  const going = begun.going;
  const codes = codeTexts(going);
  confirmRecoveryCode(going, codes[going.confirmIndex]);

  keys.answers.push("no");
  assert.equal((await finishGoingPrivate({ api: server.api, keys, going, name: "A test Mac", tokens: TOKENS })).outcome, "cancelled");
  assert.equal(server.seen.filter((s) => s.includes("/holders")).length, 0);

  keys.answers.push("approve", "no");
  assert.equal((await finishGoingPrivate({ api: server.api, keys, going, name: "A test Mac", tokens: TOKENS })).outcome, "cancelled");
  assert.equal(server.committed(), null);

  assert.equal((await finishGoingPrivate({ api: server.api, keys, going, name: "A test Mac", tokens: TOKENS })).outcome, "done");
  assert.deepEqual(codeTexts(going), codes);
  assert.equal(keys.created, 1);
});

test("a draft that holds a device this computer did not offer is never proved", async () => {
  const server = aStandardHousehold({ draftWithAStranger: true });
  const keys = softwareKeys();
  const begun = await beginGoingPrivate({ api: server.api, keys });
  assert.ok("going" in begun);
  confirmRecoveryCode(begun.going, codeTexts(begun.going)[begun.going.confirmIndex]);
  const ended = await finishGoingPrivate({ api: server.api, keys, going: begun.going, name: "A test Mac", tokens: TOKENS });
  assert.deepEqual(ended, { outcome: "failed", code: "keys_do_not_match" });
  // Only S2's prompt: the key was never opened for a draft that is not ours.
  assert.deepEqual(keys.prompts, [PROMPTS.goPrivate]);
  assert.equal(server.seen.filter((s) => s.includes("/prove")).length, 0);
});

test("a household that may not go private says why, and nothing is made", async () => {
  const keys = softwareKeys();
  const api = {
    post: async () => ({ status: 409, body: { code: "not_eligible", reasons: ["more_than_one_member"] } }),
    get: async () => ({ status: 404, body: null }),
  };
  assert.deepEqual(await beginGoingPrivate({ api, keys }), { refused: "not_eligible", reasons: ["more_than_one_member"] });
  assert.equal(keys.created, 0);
});

// ── Adding a device from here ─────────────────────────────────────────────────────────────────

/** A new device asking to be added (A1, A1b, A2c), and SageFin's side of A2 to A3. */
function aNewDevice({ platform = "ios", keyProtection = "secure-enclave", revealOther = false } = {}) {
  const householdId = randomUUID();
  const memberUserId = randomUUID();
  const addId = randomUUID();
  const household = /** @type {Uint8Array} */ (uuidBytes(householdId));
  const add = /** @type {Uint8Array} */ (uuidBytes(addId));
  const agreement = createECDH("prime256v1");
  agreement.generateKeys();
  const signing = createECDH("prime256v1");
  signing.generateKeys();
  const device = { holder: /** @type {Uint8Array} */ (uuidBytes(randomUUID())), name: "Derek's iPhone", agreementPublicKey: agreement.getPublicKey(), signingPublicKey: signing.getPublicKey() };
  const value = randomBytes(20);
  const commitment = addCommitment(household, add, device, value);
  const state = { challenge: /** @type {string | null} */ (null), reveal: /** @type {string | null} */ (null), approved: /** @type {any} */ (null), challenges: 0 };
  const view = () => ({
    addId, householdId, epoch: 3, state: state.approved ? "approved" : "pending", memberUserId, platform, keyProtection,
    device: { holderId: Buffer.from(device.holder).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5"), name: device.name, agreementPublicKey: b64(device.agreementPublicKey), signingPublicKey: b64(device.signingPublicKey) },
    commitment: b64(commitment), challenge: state.challenge, reveal: state.reveal,
  });
  const api = {
    /** @param {string} path @param {any} body */
    async post(path, body) {
      if (path.endsWith("/challenge")) {
        state.challenges++;
        state.challenge = body.value;
        // The new device reveals only once it has read this value.
        state.reveal = b64(revealOther ? randomBytes(20) : value);
        return { status: 200, body: view() };
      }
      if (path.endsWith("/approve")) {
        state.approved = body;
        return { status: 200, body: view() };
      }
      return { status: 404, body: null };
    },
    /** @param {string} _path */
    async get(_path) {
      return { status: 200, body: view() };
    },
  };
  return { api, state, householdId, memberUserId, addId, household, add, device, value };
}

test("the code typed from the new device's screen is its add id, and nothing else is", () => {
  assert.equal(addIdFromTyped("0190 AAAA BBBB 7CCC 8DDD EEEE FFFF 0001"), "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001");
  assert.equal(addIdFromTyped("SAGEFIN-ADD:0190AAAA-BBBB-7CCC-8DDD-EEEEFFFF0001"), "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001");
  assert.equal(addIdFromTyped("0190 AAAA BBBB 7CCC 8DDD EEEE FFFF 000"), null);
  assert.equal(addIdFromTyped("https://example.com/0190aaaabbbb7ccc8dddeeeeffff0001"), null);
  assert.equal(addIdFromTyped("0000 0000 0000 0000 0000 0000 0000 0000"), null);
});

test("adding a phone from here: its keys first, then one value, the phone's twelve characters, and one prompt", async () => {
  const phone = aNewDevice();
  const keys = softwareKeys();
  const holding = { householdId: phone.householdId, holderId: randomUUID() };
  const begun = await beginApproving({ api: phone.api, holding, addId: phone.addId });
  assert.ok("approving" in begun);
  assert.equal(phone.state.challenges, 1);
  const looked = await lookAtApproving(phone.api, begun.approving);
  assert.equal(looked.show, "check");
  const check = /** @type {string} */ (looked.approving.check);
  // The same characters the phone computes from its own value and this computer's.
  assert.equal(check, addCheck(phone.household, phone.add, phone.device, phone.value, /** @type {Buffer} */ (fromB64(phone.state.challenge))));
  assert.equal(checkGroups(check).length, 3);
  assert.equal(phone.state.challenges, 1);

  const done = await approveAdding({ api: phone.api, keys, holding, approving: looked.approving });
  assert.deepEqual(done, { outcome: "done", code: null });
  assert.deepEqual(keys.prompts, [PROMPTS.addDevice]);
  // A phone is signed as the phones sign one: holder-add, by this computer's signing key.
  const { signingPublicKey } = await keys.publicKeys();
  const bytes = holderAdd(phone.household, 3, /** @type {Uint8Array} */ (uuidBytes(holding.holderId)), phone.add, phone.device);
  assert.equal(verifies(signingPublicKey, bytes, /** @type {Buffer} */ (fromB64(phone.state.approved.signature))), true);
});

test("adding another computer signs what it is and whose it is", async () => {
  const computer = aNewDevice({ platform: "desktop-windows", keyProtection: "tpm" });
  const keys = softwareKeys();
  const holding = { householdId: computer.householdId, holderId: randomUUID() };
  const begun = await beginApproving({ api: computer.api, holding, addId: computer.addId });
  assert.ok("approving" in begun);
  const looked = await lookAtApproving(computer.api, begun.approving);
  assert.equal((await approveAdding({ api: computer.api, keys, holding, approving: looked.approving })).outcome, "done");
  const { signingPublicKey } = await keys.publicKeys();
  const bytes = holderAddV2(computer.household, 3, /** @type {Uint8Array} */ (uuidBytes(holding.holderId)), computer.add, computer.device, {
    member: /** @type {Uint8Array} */ (uuidBytes(computer.memberUserId)),
    platform: "desktop-windows",
    keyProtection: "tpm",
  });
  assert.equal(verifies(signingPublicKey, bytes, /** @type {Buffer} */ (fromB64(computer.state.approved.signature))), true);
  assert.equal(deviceKind("desktop-windows"), "Windows computer with SageFin Desktop");
});

test("a reveal that does not open the new device's commitment is a mismatch, and nothing is approved", async () => {
  const phone = aNewDevice({ revealOther: true });
  const keys = softwareKeys();
  const holding = { householdId: phone.householdId, holderId: randomUUID() };
  const begun = await beginApproving({ api: phone.api, holding, addId: phone.addId });
  assert.ok("approving" in begun);
  const looked = await lookAtApproving(phone.api, begun.approving);
  assert.equal(looked.show, "mismatch");
  assert.equal((await approveAdding({ api: phone.api, keys, holding, approving: looked.approving })).code, "check_not_finished");
  assert.deepEqual(keys.prompts, []);
  assert.equal(phone.state.approved, null);
});

test("an add for another household than the one this computer holds is not approved", async () => {
  const phone = aNewDevice();
  const begun = await beginApproving({ api: phone.api, holding: { householdId: randomUUID(), holderId: randomUUID() }, addId: phone.addId });
  assert.ok("refused" in begun);
  assert.equal(phone.state.challenges, 0);
});
