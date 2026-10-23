import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  addCheck,
  addCommitment,
  envelopeMacKey,
  holderRequest,
  isPoint,
  macMatches,
  openWithAgreement,
  parseEnvelope,
  seal,
  sealedCopyInfo,
  unlockApprove,
  unlockInfo,
  unlockRefuse,
} from "./private-protocol.mjs";

// The vectors SageFin's server and its iPhone app are held to, the cases a holder here needs.
// Every value in them is made up for the vectors: no household's data, no real key.
const vectors = JSON.parse(readFileSync(new URL("../fixtures/private-mode-vectors.json", import.meta.url), "utf8"));
const hex = (/** @type {string} */ s) => Buffer.from(s, "hex");
const toHex = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("hex");

/** The raw agreement, as the key store returns it, from a software key standing in for the chip. */
function agree(/** @type {string} */ privateHex, /** @type {Uint8Array} */ peer) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(hex(privateHex));
  return ecdh.computeSecret(Buffer.from(peer));
}

/** A raw r||s signature over `bytes` verifies against a 65-byte point. */
function verifies(/** @type {Uint8Array} */ point, /** @type {Uint8Array} */ bytes, /** @type {Uint8Array} */ signature) {
  const x = Buffer.from(point.subarray(1, 33)).toString("base64url");
  const y = Buffer.from(point.subarray(33)).toString("base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
  return verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, signature);
}

const request = (/** @type {any} */ i) => ({
  household: hex(i.household),
  request: hex(i.request),
  nonce: hex(i.nonce),
  epoch: i.epoch,
  purpose: i.purpose_text,
  requestPublicKey: hex(i.request_public_key),
});

test("a holder's sealed copy opens with the agreement the key store returns", () => {
  for (const { inputs: i, expected: e } of vectors["sealed-copy-open"]) {
    const info = sealedCopyInfo(hex(i.household), i.epoch, hex(i.holder));
    assert.equal(toHex(info), e.info, i.case);
    const opened = openWithAgreement({
      agreement: agree(i.recipient_private_key, hex(e.enc)),
      enc: hex(e.enc),
      recipientPublicKey: hex(i.recipient_public_key),
      info,
      ciphertext: hex(e.ct),
    });
    assert.equal(opened ? toHex(opened) : null, e.opens ? i.file_key : null);
  }
});

test("the file key sealed to a request's key is the bytes the server opens", () => {
  for (const { case: name, inputs: i, expected: e } of vectors["unlock-transit-seal"]) {
    const r = request(i);
    const holder = hex(i.holder);
    assert.equal(toHex(unlockInfo(r, holder)), e.info, name);
    const sealed = seal({ recipientPublicKey: r.requestPublicKey, info: unlockInfo(r, holder), plaintext: hex(i.file_key), ephemeralPrivateKey: hex(i.ephemeral_private_key) });
    assert.equal(toHex(sealed.enc), e.enc, name);
    assert.equal(toHex(sealed.ciphertext), e.ct, name);
  }
});

test("U4's signed bytes, and a signature over them, are the server's", () => {
  for (const { case: name, inputs: i, expected: e } of vectors["unlock-approve-signed-bytes"]) {
    const bytes = unlockApprove(request(i), hex(i.holder), hex(i.enc), hex(i.ct));
    assert.equal(toHex(bytes), e.signed_bytes, name);
    assert.equal(verifies(hex(i.signing_public_key), bytes, hex(e.signature)), true, name);
  }
});

test("Don't approve signs other bytes than an approval", () => {
  for (const { case: name, inputs: i, expected: e } of vectors["unlock-refuse-signed-bytes"]) {
    assert.equal(toHex(unlockRefuse(request(i), hex(i.holder))), e.signed_bytes, name);
  }
});

test("A1b's own signature is over the server's bytes", () => {
  for (const { inputs: i, expected: e } of vectors["holder-request-signed-bytes"]) {
    const device = {
      holder: hex(i.device.holder),
      name: i.device.name_text,
      agreementPublicKey: hex(i.device.agreement_public_key),
      signingPublicKey: hex(i.device.signing_public_key),
    };
    const bytes = holderRequest(hex(i.household), hex(i.add), hex(i.nonce), device);
    assert.equal(toHex(bytes), e.signed_bytes);
    // And this side can make one the server accepts: signed with the software stand-in's key.
    const key = createPrivateKey({ key: Buffer.concat([hex("308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420"), hex(i.signing_private_key)]), format: "der", type: "pkcs8" });
    const signature = sign("sha256", bytes, { key, dsaEncoding: "ieee-p1363" });
    assert.equal(verifies(device.signingPublicKey, bytes, signature), true);
  }
});

test("the add-a-device check: the commitment and the twelve characters are the phone's", () => {
  let compared = 0;
  for (const { case: name, inputs: i, expected: e } of vectors["device-add-committed-check"]) {
    const device = { holder: hex("d0d1d2d3d4d5d6d7d8d9dadbdcdddedf"), name: "", agreementPublicKey: hex(i.agreement_public_key), signingPublicKey: hex(i.signing_public_key) };
    let commitment;
    try {
      commitment = addCommitment(hex(i.household), hex(i.add), device, hex(i.new_device_value));
    } catch {
      continue; // a case of keys this side refuses to frame at all
    }
    assert.equal(toHex(commitment), e.commitment, name);
    assert.equal(addCheck(hex(i.household), hex(i.add), device, hex(i.new_device_value), hex(i.approver_value)), e.check_text, name);
    compared++;
  }
  // A comparison that never ran agrees with everything: count them.
  assert.ok(compared >= 4, `only ${compared} cases were compared`);
});

test("the envelope's MAC key and MAC are the server's, and a wrong key or epoch does not match", () => {
  for (const { case: name, inputs: i, expected: e } of vectors["envelope-mac-key"]) {
    assert.equal(toHex(envelopeMacKey(hex(i.file_key), hex(i.household), i.epoch)), e.mac_key, name);
  }
  for (const { case: name, inputs: i, expected: e } of vectors["envelope-mac"]) {
    const envelope = parseEnvelope(hex(e.bytes));
    assert.equal(toHex(envelope.macInput), e.mac_input, name);
    assert.equal(macMatches(envelope, hex(i.file_key), envelope.household, envelope.epoch), true, name);
    assert.equal(macMatches(envelope, Buffer.alloc(32, 7), envelope.household, envelope.epoch), false, name);
    assert.equal(macMatches(envelope, hex(i.file_key), envelope.household, envelope.epoch + 1), false, name);
  }
});

test("a point off the curve is not a key", () => {
  const good = createECDH("prime256v1");
  good.generateKeys();
  assert.equal(isPoint(good.getPublicKey()), true);
  const bad = Buffer.from(good.getPublicKey());
  bad[64] ^= 1;
  assert.equal(isPoint(bad), false);
  assert.equal(isPoint(Buffer.alloc(65)), false);
});
