// The byte strings this computer signs when it goes private and when it adds a device, held to
// the vectors SageFin's server and its iPhone app are held to. Every value in them is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  holderAdd,
  holderAddV2,
  keyFingerprint,
  makeRecoveryCode,
  parseRecoveryCode,
  publicKeyOf,
  recoveryCodeText,
  recoveryHolder,
  recoveryWrapInfo,
  recoveryWrapKey,
  seal,
  setupHoldersV2,
  setupProve,
  setupProveInfo,
  signWithScalar,
  unwrapRecovery,
  wrapRecovery,
} from "./private-protocol.mjs";

const vectors = JSON.parse(readFileSync(new URL("../fixtures/private-mode-vectors.json", import.meta.url), "utf8"));
const hex = (/** @type {string} */ s) => Buffer.from(s, "hex");
const toHex = (/** @type {Uint8Array} */ b) => Buffer.from(b).toString("hex");

function verifies(/** @type {Uint8Array} */ point, /** @type {Uint8Array} */ bytes, /** @type {Uint8Array} */ signature) {
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: Buffer.from(point.subarray(1, 33)).toString("base64url"), y: Buffer.from(point.subarray(33)).toString("base64url") },
    format: "jwk",
  });
  return verify("sha256", bytes, { key, dsaEncoding: "ieee-p1363" }, signature);
}

/** Every vector list read here must have cases: a comparison that never ran agrees with everything. */
function cases(/** @type {string} */ name) {
  const list = vectors[name];
  assert.ok(Array.isArray(list) && list.length > 0, `no cases for ${name}`);
  return list;
}

test("a recovery code reads and writes as the phone's, forgiving what the phone forgives", () => {
  for (const { case: name, inputs: i, expected: e } of cases("recovery-code-text")) {
    if (e.text) {
      assert.equal(recoveryCodeText(hex(i.code)), e.text, name);
      for (const typed of [e.text, ...e.also_read_as_the_same_code_text]) assert.equal(toHex(/** @type {Buffer} */ (parseRecoveryCode(typed))), i.code, typed);
    }
    for (const typed of e.refused_text ?? []) assert.equal(parseRecoveryCode(typed), null, JSON.stringify(typed));
  }
});

test("a recovery code wraps its two keys as the server opens them, and a wrong code does not open them", () => {
  for (const { case: name, inputs: i, expected: e } of cases("recovery-wrap")) {
    const parts = { code: hex(i.code), salt: hex(i.salt), household: hex(i.household), holder: hex(i.holder) };
    assert.equal(toHex(recoveryWrapInfo(parts.household, parts.holder)), e.info, name);
    assert.equal(toHex(recoveryWrapKey(parts)), e.wrap_key, name);
    const wrapped = wrapRecovery({ ...parts, nonce: hex(i.nonce), agreementScalar: hex(i.agreement_private_key), signingScalar: hex(i.signing_private_key) });
    assert.equal(toHex(wrapped), e.wrapped, name);
    assert.equal(toHex(publicKeyOf(hex(i.agreement_private_key))), e.agreement_public_key, name);
    assert.equal(toHex(publicKeyOf(hex(i.signing_private_key))), e.signing_public_key, name);
    assert.equal(toHex(/** @type {Buffer} */ (unwrapRecovery({ ...parts, wrapped }))), i.agreement_private_key + i.signing_private_key, name);
  }
  for (const { case: name, inputs: i, expected: e } of cases("recovery-wrong-code")) {
    const opened = unwrapRecovery({ code: hex(i.code), salt: hex(i.salt), household: hex(i.household), holder: hex(i.holder), wrapped: hex(i.wrapped) });
    assert.equal(opened !== null, e.opens, name);
  }
});

test("S2's signed bytes are the server's, and each code signs its own entry", () => {
  for (const { case: name, inputs: i, expected: e } of cases("setup-holders-v2-signed-bytes")) {
    const recovery = i.recovery.map((/** @type {any} */ r) => ({
      holder: hex(r.holder),
      agreementPublicKey: hex(r.agreement_public_key),
      signingPublicKey: hex(r.signing_public_key),
      salt: hex(r.salt),
      wrapped: hex(r.wrapped),
    }));
    const device = { holder: hex(i.device.holder), name: i.device.name_text, agreementPublicKey: hex(i.device.agreement_public_key), signingPublicKey: hex(i.device.signing_public_key) };
    const bytes = setupHoldersV2({
      household: hex(i.household),
      setup: hex(i.setup),
      epoch: i.epoch,
      member: hex(i.member),
      device,
      platform: i.device.platform_text,
      keyProtection: i.device.key_protection_text,
      recovery,
    });
    assert.equal(toHex(bytes), e.device_signed_bytes, name);
    assert.equal(verifies(device.signingPublicKey, bytes, hex(e.device_signature)), true, name);
    assert.equal(e.recovery.length, 4, name);
    e.recovery.forEach((/** @type {any} */ expected, /** @type {number} */ n) => {
      const entryBytes = recoveryHolder({ household: hex(i.household), context: hex(i.setup), epoch: i.epoch, entry: recovery[n] });
      assert.equal(toHex(entryBytes), expected.signed_bytes, `${name} code ${n}`);
      // This computer signs with the code's own software key; the server verifies it as it does the phone's.
      assert.equal(verifies(recovery[n].signingPublicKey, entryBytes, signWithScalar(hex(i.recovery[n].signing_private_key), entryBytes)), true);
    });
  }
});

test("S3 seals and signs the bytes the server opens and verifies", () => {
  for (const { case: name, inputs: i, expected: e } of cases("setup-prove-transit-seal")) {
    const info = setupProveInfo(hex(i.household), i.epoch, hex(i.holder), hex(i.setup), hex(i.nonce));
    assert.equal(toHex(info), e.info, name);
    const sealed = seal({ recipientPublicKey: hex(i.request_public_key), info, plaintext: hex(i.file_key), ephemeralPrivateKey: hex(i.ephemeral_private_key) });
    assert.equal(toHex(sealed.enc), e.enc, name);
    assert.equal(toHex(sealed.ciphertext), e.ct, name);
  }
  for (const { case: name, inputs: i, expected: e } of cases("setup-prove-signed-bytes")) {
    const bytes = setupProve({
      household: hex(i.household),
      setup: hex(i.setup),
      nonce: hex(i.nonce),
      epoch: i.epoch,
      holder: hex(i.holder),
      enc: hex(i.enc),
      ciphertext: hex(i.ct),
      requestPublicKey: hex(i.request_public_key),
    });
    assert.equal(toHex(bytes), e.signed_bytes, name);
    assert.equal(verifies(hex(i.signing_public_key), bytes, hex(e.signature)), e.verifies, name);
  }
  for (const { case: name, inputs: i, expected: e } of cases("key-fingerprint")) {
    assert.equal(toHex(keyFingerprint(hex(i.file_key), hex(i.household), i.epoch)), e.fingerprint, name);
  }
});

test("A3's signed bytes are the server's: a phone by version 1, a computer by version 2", () => {
  for (const { case: name, inputs: i, expected: e } of cases("holder-add-signed-bytes")) {
    const device = { holder: hex(i.new_holder), name: i.new_name_text, agreementPublicKey: hex(i.new_agreement_public_key), signingPublicKey: hex(i.new_signing_public_key) };
    const bytes = holderAdd(hex(i.household), i.epoch, hex(i.holder), hex(i.add), device);
    assert.equal(toHex(bytes), e.signed_bytes, name);
    assert.equal(verifies(hex(i.signing_public_key), bytes, hex(e.signature)), true, name);
  }
  for (const { case: name, inputs: i, expected: e } of cases("holder-add-v2-signed-bytes")) {
    const device = { holder: hex(i.new_holder), name: i.new_name_text, agreementPublicKey: hex(i.new_agreement_public_key), signingPublicKey: hex(i.new_signing_public_key) };
    const ownership = { member: hex(i.new_member), platform: i.new_platform_text, keyProtection: i.new_key_protection_text };
    const bytes = holderAddV2(hex(i.household), i.epoch, hex(i.holder), hex(i.add), device, ownership);
    assert.equal(toHex(bytes), e.signed_bytes, name);
    assert.equal(verifies(hex(i.signing_public_key), bytes, hex(e.signature)), true, name);
    assert.equal(toHex(holderAddV2(hex(i.household), i.epoch, hex(i.holder), hex(i.add), device, { ...ownership, member: hex(e.other_member) })), e.signed_bytes_for_another_member, name);
    assert.throws(() => holderAddV2(hex(i.household), i.epoch, hex(i.holder), hex(i.add), device, { ...ownership, platform: "Not A Token" }));
  }
});

test("a recovery code made here opens with its own text, is never sent, and is forgotten", () => {
  const household = hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
  const made = makeRecoveryCode(household);
  assert.match(made.text, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(made.matches(made.text.toLowerCase().replaceAll("-", " ")), true);
  assert.equal(made.matches("0000-0000-0000-0000-0000-0000-0000-0000"), false);
  // What is sent holds no code and no private key: only what the wrap and two public keys say.
  assert.deepEqual(Object.keys(made.entry).sort(), ["agreementPublicKey", "holder", "salt", "signingPublicKey", "wrapped"]);
  const scalars = unwrapRecovery({ code: /** @type {Buffer} */ (parseRecoveryCode(made.text)), salt: made.entry.salt, household, holder: made.entry.holder, wrapped: made.entry.wrapped });
  assert.ok(scalars);
  assert.equal(toHex(publicKeyOf(scalars.subarray(0, 32))), toHex(made.entry.agreementPublicKey));
  assert.equal(toHex(publicKeyOf(scalars.subarray(32))), toHex(made.entry.signingPublicKey));
  const context = hex("505152535455565758595a5b5c5d5e5f");
  const signature = made.signEntry(household, context, 1);
  assert.equal(verifies(made.entry.signingPublicKey, recoveryHolder({ household, context, epoch: 1, entry: made.entry }), signature), true);
  const text = made.text;
  made.dispose();
  assert.equal(made.matches(text), false);
});
