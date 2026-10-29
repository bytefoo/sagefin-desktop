// @ts-check
// SageFin's private-mode protocol, as much of it as a holder on this computer needs: the byte
// strings it signs, the HPKE it seals and opens with, the key envelope it reads, and the
// add-a-device check it shows. SageFin's server and its iPhone app build the same bytes; the
// vectors in fixtures/private-mode-vectors.json (lib/private-protocol.test.mjs) hold this file to
// them, byte for byte.
//
// Nothing here holds a device key. The two steps a device's private keys take part in, the raw
// P-256 agreement and the signature, are the key store's (main/key-store.mjs), behind the
// operating system's own prompt. Everything else is hashing and one AES-GCM call, which is why it
// can live here and be tested with nothing installed.
//
// No Electron here: `node --test` runs it bare.

import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

/** The prefix of every label. A change to any byte string means a new version here. */
export const VERSION = "SageFin-PM-v1";
export const NONCE_LENGTH = 32;
export const POINT_LENGTH = 65;
export const SIGNATURE_LENGTH = 64;
export const FILE_KEY_LENGTH = 32;

/** @param {Uint8Array[]} parts */
export const concat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

/** @param {number} n */
const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** @param {number} n */
const be64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(n));
  return b;
};

/** @param {Uint8Array} bytes */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

/** Equality whose time does not depend on where two byte strings differ. */
export function sameBytes(/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Overwrites a secret's bytes. Best effort: the collector may have copied them. */
export function zero(/** @type {Uint8Array | null | undefined} */ secret) {
  secret?.fill(0);
}

/** Base64url without padding: how every byte field travels. */
export const b64 = (/** @type {Uint8Array} */ bytes) => Buffer.from(bytes).toString("base64url");

/** The reverse, or null for text that is not base64url. Padding is refused, as it is never sent. */
export function fromB64(/** @type {unknown} */ text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 65536 || !/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  return Buffer.from(text, "base64url");
}

/** A UUID's 16 bytes in RFC 4122 order, or null for text that is not one, or the empty id. */
export function uuidBytes(/** @type {unknown} */ text) {
  if (typeof text !== "string" || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(text)) return null;
  const bytes = Buffer.from(text.replaceAll("-", ""), "hex");
  return bytes.every((b) => b === 0) ? null : bytes;
}

/** Sixteen bytes as hyphenated lower-case text, the form the API takes an id in. */
export function uuidText(/** @type {Uint8Array} */ bytes) {
  if (bytes.length !== 16) throw new TypeError("An id is 16 bytes.");
  const h = Buffer.from(bytes).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── P-256 ─────────────────────────────────────────────────────────────────────────────────────

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

/** True for a 65-byte uncompressed point that is on the curve. */
export function isPoint(/** @type {Uint8Array} */ key) {
  if (!key || key.length !== POINT_LENGTH || key[0] !== 0x04) return false;
  const x = BigInt(`0x${Buffer.from(key.subarray(1, 33)).toString("hex")}`);
  const y = BigInt(`0x${Buffer.from(key.subarray(33)).toString("hex")}`);
  if (x >= P || y >= P) return false;
  const left = (y * y) % P;
  const right = (((x * x * x - 3n * x + B) % P) + P) % P;
  return left === right;
}

// ── Frames ────────────────────────────────────────────────────────────────────────────────────

/** A lone surrogate, which the UTF-8 encoder would quietly write as U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The one way a byte string that is signed, MACed or bound into a sealing is built: the ASCII
 * label `SageFin-PM-v1 <name>`, a zero byte, then each field with its length before it as four
 * bytes, big-endian. Nothing is ever signed as JSON text.
 */
export class Frame {
  /** @param {string} name */
  constructor(name) {
    if (!name) throw new TypeError("A frame has a name.");
    /** @type {Buffer[]} */
    this.parts = [Buffer.from(`${VERSION} ${name}`, "ascii"), Buffer.of(0)];
  }

  /** @param {Uint8Array} field @param {number} [exactly] */
  bytes(field, exactly) {
    if (exactly !== undefined && field.length !== exactly) throw new TypeError(`A field has the wrong length; it must be ${exactly}.`);
    this.parts.push(be32(field.length), Buffer.from(field));
    return this;
  }

  /** @param {Uint8Array} id */
  id(id) {
    if (id.length !== 16 || id.every((b) => b === 0)) throw new TypeError("An id is 16 bytes, and not the empty id.");
    return this.bytes(id);
  }

  /** @param {number} epoch */
  epoch(epoch) {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new TypeError("An epoch is at least 1.");
    return this.bytes(be64(epoch));
  }

  /** Text as its UTF-8 bytes. A lone surrogate is refused: two names would then share a signature. */
  text(/** @type {string} */ text) {
    if (LONE_SURROGATE.test(text)) throw new TypeError("The text is not well-formed Unicode.");
    return this.bytes(Buffer.from(text, "utf8"));
  }

  /** @param {Uint8Array} key */
  point(key) {
    if (!isPoint(key)) throw new TypeError("Not a 65-byte uncompressed P-256 point.");
    return this.bytes(key);
  }

  /** The field is SHA-256 of the parts, one after another. */
  sha256Of(/** @type {Uint8Array[]} */ ...parts) {
    return this.bytes(sha256(concat(...parts)));
  }

  toBytes() {
    return Buffer.concat(this.parts);
  }
}

/** @typedef {"full" | "sync"} Purpose  What an unlock is for. An agent's hour is not this app's to ask. */

/**
 * @typedef {object} Request  What U1 answers and this app approves, as bytes.
 * @property {Uint8Array} household
 * @property {Uint8Array} request
 * @property {Uint8Array} nonce
 * @property {number} epoch
 * @property {Purpose} purpose
 * @property {Uint8Array} requestPublicKey
 */

/** The HPKE `info` of a holder's sealed copy in the envelope. */
export const sealedCopyInfo = (/** @type {Uint8Array} */ household, /** @type {number} */ epoch, /** @type {Uint8Array} */ holder) =>
  new Frame("sealed-copy").id(household).epoch(epoch).id(holder).toBytes();

/** The HPKE `info` of the file key in transit to the API, sealed to a request's key (U4). */
export const unlockInfo = (/** @type {Request} */ r, /** @type {Uint8Array} */ holder) =>
  new Frame("unlock").id(r.household).epoch(r.epoch).id(holder).id(r.request).bytes(r.nonce, NONCE_LENGTH).text(r.purpose).toBytes();

/** U4's signed bytes (label `unlock-approve`). */
export function unlockApprove(/** @type {Request} */ r, /** @type {Uint8Array} */ holder, /** @type {Uint8Array} */ enc, /** @type {Uint8Array} */ ciphertext) {
  if (!isPoint(enc) || !isPoint(r.requestPublicKey)) throw new TypeError("Not a P-256 point.");
  return new Frame("unlock-approve")
    .id(r.household)
    .id(r.request)
    .bytes(r.nonce, NONCE_LENGTH)
    .epoch(r.epoch)
    .id(holder)
    .text(r.purpose)
    .sha256Of(enc, ciphertext)
    .sha256Of(r.requestPublicKey)
    .toBytes();
}

/** "Don't approve" (label `unlock-refuse`): ends a request, sealing nothing. */
export const unlockRefuse = (/** @type {Request} */ r, /** @type {Uint8Array} */ holder) =>
  new Frame("unlock-refuse").id(r.household).id(r.request).bytes(r.nonce, NONCE_LENGTH).epoch(r.epoch).id(holder).text(r.purpose).sha256Of(r.requestPublicKey).toBytes();

/**
 * @typedef {object} Device  This computer as it is enrolled: its id, its name, its two public keys.
 * @property {Uint8Array} holder
 * @property {string} name
 * @property {Uint8Array} agreementPublicKey
 * @property {Uint8Array} signingPublicKey
 */

/** A1b's own signature (label `holder-request`): the new device holds the signing key it offers. */
export function holderRequest(/** @type {Uint8Array} */ household, /** @type {Uint8Array} */ add, /** @type {Uint8Array} */ nonce, /** @type {Device} */ device) {
  if (sameBytes(device.agreementPublicKey, device.signingPublicKey)) throw new TypeError("The same public key appears twice.");
  return new Frame("holder-request")
    .id(household)
    .id(add)
    .bytes(nonce, NONCE_LENGTH)
    .id(device.holder)
    .text(device.name)
    .point(device.agreementPublicKey)
    .point(device.signingPublicKey)
    .toBytes();
}

// ── The add-a-device check ────────────────────────────────────────────────────────────────────

export const CHECK_VALUE_LENGTH = 20;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * What this computer commits to with its keys before it sees the approving phone's value (A1b):
 * SHA-256 of `device-add-commit`. It reveals the value only once the phone's is on the request.
 */
export const addCommitment = (/** @type {Uint8Array} */ household, /** @type {Uint8Array} */ add, /** @type {Device} */ device, /** @type {Uint8Array} */ value) =>
  sha256(new Frame("device-add-commit").id(household).id(add).point(device.agreementPublicKey).point(device.signingPublicKey).bytes(value, CHECK_VALUE_LENGTH).toBytes());

/** The twelve characters both screens show, `XXXX-XXXX-XXXX`, over both values (`device-add-check-2`). */
export function addCheck(
  /** @type {Uint8Array} */ household,
  /** @type {Uint8Array} */ add,
  /** @type {Device} */ device,
  /** @type {Uint8Array} */ newDeviceValue,
  /** @type {Uint8Array} */ approverValue,
) {
  const digest = sha256(
    new Frame("device-add-check-2")
      .id(household)
      .id(add)
      .point(device.agreementPublicKey)
      .point(device.signingPublicKey)
      .bytes(newDeviceValue, CHECK_VALUE_LENGTH)
      .bytes(approverValue, CHECK_VALUE_LENGTH)
      .toBytes(),
  );
  let out = "";
  for (let symbol = 0; symbol < 12; symbol++) {
    if (symbol > 0 && symbol % 4 === 0) out += "-";
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const bit = symbol * 5 + i;
      value = (value << 1) | ((digest[bit >> 3] >> (7 - (bit % 8))) & 1);
    }
    out += CROCKFORD[value];
  }
  return out;
}

// ── HPKE: RFC 9180, base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM ──────────────

const HPKE_V1 = Buffer.from("HPKE-v1", "ascii");
const KEM_SUITE = Buffer.from([0x4b, 0x45, 0x4d, 0x00, 0x10]);
export const AES_256_GCM = 0x0002;
export const AES_128_GCM = 0x0001;

/** @param {Uint8Array} salt @param {Uint8Array} ikm */
const extract = (salt, ikm) => createHmac("sha256", salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();

/** @param {Uint8Array} prk @param {Uint8Array} info @param {number} length */
function expand(prk, info, length) {
  /** @type {Buffer[]} */
  const out = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(out).length < length; i++) {
    previous = createHmac("sha256", prk).update(concat(previous, info, Buffer.of(i))).digest();
    out.push(previous);
  }
  return Buffer.concat(out).subarray(0, length);
}

/** @param {Uint8Array} suite @param {Uint8Array} salt @param {string} label @param {Uint8Array} ikm */
const labeledExtract = (suite, salt, label, ikm) => extract(salt, concat(HPKE_V1, suite, Buffer.from(label, "ascii"), ikm));

/** @param {Uint8Array} suite @param {Uint8Array} prk @param {string} label @param {Uint8Array} info @param {number} length */
const labeledExpand = (suite, prk, label, info, length) =>
  expand(prk, concat(Buffer.of((length >> 8) & 0xff, length & 0xff), HPKE_V1, suite, Buffer.from(label, "ascii"), info), length);

/** RFC 9180 4.1: the KEM's shared secret from the raw agreement. */
export function kemSharedSecret(/** @type {Uint8Array} */ agreement, /** @type {Uint8Array} */ enc, /** @type {Uint8Array} */ recipient) {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", agreement);
  try {
    return labeledExpand(KEM_SUITE, prk, "shared_secret", concat(enc, recipient), 32);
  } finally {
    zero(prk);
  }
}

/** RFC 9180 5.1: the key and base nonce for base mode. */
export function schedule(/** @type {Uint8Array} */ sharedSecret, /** @type {Uint8Array} */ info, aead = AES_256_GCM) {
  const suite = Buffer.from([0x48, 0x50, 0x4b, 0x45, 0x00, 0x10, 0x00, 0x01, 0x00, aead]);
  const context = concat(
    Buffer.of(0),
    labeledExtract(suite, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0)),
    labeledExtract(suite, Buffer.alloc(0), "info_hash", info),
  );
  const secret = labeledExtract(suite, sharedSecret, "secret", Buffer.alloc(0));
  try {
    return {
      key: labeledExpand(suite, secret, "key", context, aead === AES_128_GCM ? 16 : 32),
      baseNonce: labeledExpand(suite, secret, "base_nonce", context, 12),
    };
  } finally {
    zero(secret);
  }
}

/** @param {number} aead */
const cipherName = (aead) => (aead === AES_128_GCM ? "aes-128-gcm" : "aes-256-gcm");

/**
 * Opens a sealing given the raw agreement between the recipient's private key and `enc`, which the
 * key store produced behind the operating system's prompt. Null for anything that does not open.
 * @param {{ agreement: Uint8Array, enc: Uint8Array, recipientPublicKey: Uint8Array, info: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array, aead?: number }} options
 */
export function openWithAgreement({ agreement, enc, recipientPublicKey, info, ciphertext, aad = Buffer.alloc(0), aead = AES_256_GCM }) {
  if (agreement.length !== 32 || !isPoint(enc) || !isPoint(recipientPublicKey) || ciphertext.length < 16) return null;
  const shared = kemSharedSecret(agreement, enc, recipientPublicKey);
  const { key, baseNonce } = schedule(shared, info, aead);
  try {
    const decipher = createDecipheriv(cipherName(aead), key, baseNonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  } catch {
    return null;
  } finally {
    zero(shared);
    zero(key);
    zero(baseNonce);
  }
}

/**
 * Seals `plaintext` to `recipientPublicKey` with a fresh ephemeral key: the file key to a request's
 * key (U4). The ephemeral key is software and is used once.
 * @param {{ recipientPublicKey: Uint8Array, info: Uint8Array, plaintext: Uint8Array, ephemeralPrivateKey?: Uint8Array, aead?: number }} options
 *   `ephemeralPrivateKey` exists for the vectors only: one used twice to one recipient repeats a nonce.
 */
export function seal({ recipientPublicKey, info, plaintext, ephemeralPrivateKey, aead = AES_256_GCM }) {
  if (!isPoint(recipientPublicKey)) throw new TypeError("The recipient key is not a usable P-256 point.");
  const ecdh = createECDH("prime256v1");
  if (ephemeralPrivateKey) ecdh.setPrivateKey(Buffer.from(ephemeralPrivateKey));
  else ecdh.generateKeys();
  const enc = ecdh.getPublicKey();
  const agreement = ecdh.computeSecret(Buffer.from(recipientPublicKey));
  const shared = kemSharedSecret(agreement, enc, recipientPublicKey);
  const { key, baseNonce } = schedule(shared, info, aead);
  try {
    const cipher = createCipheriv(cipherName(aead), key, baseNonce);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { enc, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
  } finally {
    zero(agreement);
    zero(shared);
    zero(key);
    zero(baseNonce);
  }
}

// ── The key envelope ──────────────────────────────────────────────────────────────────────────

const MAGIC_V1 = Buffer.from("SFPMENV1", "ascii");
const MAGIC_V2 = Buffer.from("SFPMENV2", "ascii");
const MAX_ENVELOPE = 32 * 1024;

/**
 * @typedef {object} EnvelopeHolder
 * @property {Uint8Array} id
 * @property {"device" | "recovery"} kind
 * @property {Uint8Array} agreementPublicKey
 * @property {Uint8Array} signingPublicKey
 * @property {Uint8Array} enc
 * @property {Uint8Array} ciphertext
 *
 * @typedef {object} Envelope
 * @property {number} version
 * @property {Uint8Array} household
 * @property {"private" | "standard"} custody
 * @property {number} epoch
 * @property {EnvelopeHolder[]} holders
 * @property {Uint8Array} macInput
 * @property {Uint8Array} mac
 */

/**
 * Reads the envelope's shape, or throws. **A parsed envelope is whatever its last writer chose**
 * until `macMatches` has said true, and even then only that envelope and key belong together.
 * @param {Uint8Array} bytes
 * @returns {Envelope}
 */
export function parseEnvelope(bytes) {
  const all = Buffer.from(bytes);
  if (all.length > MAX_ENVELOPE || all.length < 8) throw new TypeError("Not a key envelope.");
  const magic = all.subarray(0, 8);
  const version = magic.equals(MAGIC_V1) ? 1 : magic.equals(MAGIC_V2) ? 2 : 0;
  if (!version) throw new TypeError("Not a key envelope.");

  let at = 8;
  const field = () => {
    if (all.length - at < 4) throw new TypeError("The envelope is cut short.");
    const length = all.readUInt32BE(at);
    if (length > all.length - at - 4) throw new TypeError("The envelope is cut short.");
    const out = all.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return out;
  };
  /** @param {number} n */
  const exactly = (n) => {
    const f = field();
    if (f.length !== n) throw new TypeError("A field of the envelope has the wrong length.");
    return f;
  };

  const household = exactly(16);
  const custodyByte = exactly(1)[0];
  const custody = custodyByte === 1 ? "private" : custodyByte === 2 ? "standard" : null;
  if (!custody) throw new TypeError("The envelope's custody is not one.");
  const epoch = Number(exactly(8).readBigInt64BE());
  if (epoch < 1) throw new TypeError("The envelope's epoch is not one.");
  exactly(8); // generation
  exactly(8); // changed at
  field(); // keep until
  const count = exactly(4).readUInt32BE();
  if (count < 1 || count > 64) throw new TypeError("The envelope's holder count is not one.");

  /** @type {EnvelopeHolder[]} */
  const holders = [];
  for (let i = 0; i < count; i++) {
    const id = exactly(16);
    const kindByte = exactly(1)[0];
    const kind = kindByte === 1 ? "device" : kindByte === 2 ? "recovery" : null;
    if (!kind) throw new TypeError("A holder of the envelope is of no kind.");
    if (version === 2) {
      exactly(16); // member
      field(); // platform
      field(); // key protection
    }
    const agreementPublicKey = exactly(65);
    const signingPublicKey = exactly(65);
    const enc = exactly(65);
    const ciphertext = exactly(48);
    field(); // salt
    field(); // wrapped
    if (!isPoint(agreementPublicKey) || !isPoint(signingPublicKey) || !isPoint(enc)) throw new TypeError("A key of the envelope is not a point.");
    holders.push({ id, kind, agreementPublicKey, signingPublicKey, enc, ciphertext });
  }

  const remaining = all.length - at;
  if (remaining !== 32) throw new TypeError("The envelope's MAC is not 32 bytes.");
  const label = Buffer.from(`${VERSION} ${version === 2 ? "envelope-v2" : "envelope"}\0`, "ascii");
  return { version, household, custody, epoch, holders, macInput: concat(label, all.subarray(8, at)), mac: all.subarray(at) };
}

/** The key the envelope's MAC is made under (label `envelope-mac`). A secret; the caller zeroes it. */
export function envelopeMacKey(/** @type {Uint8Array} */ fileKey, /** @type {Uint8Array} */ household, /** @type {number} */ epoch) {
  if (fileKey.length !== FILE_KEY_LENGTH) throw new TypeError("A file key is 32 bytes.");
  const info = new Frame("envelope-mac").id(household).epoch(epoch).toBytes();
  return Buffer.from(hkdfSync("sha256", fileKey, Buffer.alloc(0), info, 32));
}

/**
 * Whether `envelope` is the one of `household` at `epoch`, MACed under `fileKey`. The household
 * and epoch are the request's, never the envelope's own word about itself.
 */
export function macMatches(/** @type {Envelope} */ envelope, /** @type {Uint8Array} */ fileKey, /** @type {Uint8Array} */ household, /** @type {number} */ epoch) {
  if (fileKey.length !== FILE_KEY_LENGTH || !sameBytes(envelope.household, household) || envelope.epoch !== epoch) return false;
  const key = envelopeMacKey(fileKey, household, epoch);
  try {
    return sameBytes(createHmac("sha256", key).update(envelope.macInput).digest(), envelope.mac);
  } finally {
    zero(key);
  }
}

/** Twenty random bytes: this computer's half of the add-a-device check. */
export const newCheckValue = () => randomBytes(CHECK_VALUE_LENGTH);

// ── Going private on this computer, and adding a device from it ─────────────────────────────
//
// A member with no phone makes the household private here (S1 to S3), and adds their other
// devices from here (A2 to A3). The byte strings are the ones SageFin's iPhone app signs for the
// same steps; the vectors hold them to it.

/** Four recovery codes at setup, always. */
export const RECOVERY_CODES = 4;
export const RECOVERY_CODE_LENGTH = 20;
export const RECOVERY_SALT_LENGTH = 16;
export const RECOVERY_NONCE_LENGTH = 12;
export const RECOVERY_WRAPPED_LENGTH = 92;

/** A platform or key-protection token as the server takes one: 1 to 32 of `a-z`, `0-9` and `-`. */
export const isToken = (/** @type {unknown} */ text) => typeof text === "string" && /^[a-z0-9-]{1,32}$/.test(text);

/** @param {string} text @param {string} what */
function token(text, what) {
  if (!isToken(text)) throw new TypeError(`The ${what} is not a token.`);
  return text;
}

/** @param {Uint8Array[]} keys */
function distinct(...keys) {
  const seen = new Set(keys.map((k) => Buffer.from(k).toString("hex")));
  if (seen.size !== keys.length) throw new TypeError("The same public key appears twice.");
}

/** A count, as four bytes big-endian in a field of its own. */
const count = (/** @type {Frame} */ frame, /** @type {number} */ n) => frame.bytes(be32(n));

/**
 * @typedef {object} RecoveryEntry  One recovery code as it is sent: never the code, never a private key.
 * @property {Uint8Array} holder
 * @property {Uint8Array} agreementPublicKey
 * @property {Uint8Array} signingPublicKey
 * @property {Uint8Array} salt
 * @property {Uint8Array} wrapped
 */

/** @param {Frame} frame @param {RecoveryEntry} entry */
function appendRecovery(frame, entry) {
  distinct(entry.agreementPublicKey, entry.signingPublicKey);
  frame.id(entry.holder).point(entry.agreementPublicKey).point(entry.signingPublicKey).bytes(entry.salt, RECOVERY_SALT_LENGTH).bytes(entry.wrapped, RECOVERY_WRAPPED_LENGTH);
}

/**
 * S2, version 2 (label `setup-holders-v2`, vector V30): the whole holder set this computer goes
 * private with, signed by it. The member, and what this computer is and where its keys are, are in
 * the bytes, so the household's record of it is this computer's signed word.
 * @param {{ household: Uint8Array, setup: Uint8Array, epoch: number, member: Uint8Array, device: Device, platform: string, keyProtection: string, recovery: RecoveryEntry[] }} s
 */
export function setupHoldersV2({ household, setup, epoch, member, device, platform, keyProtection, recovery }) {
  distinct(device.agreementPublicKey, device.signingPublicKey, ...recovery.flatMap((r) => [r.agreementPublicKey, r.signingPublicKey]));
  const frame = new Frame("setup-holders-v2")
    .id(household)
    .id(setup)
    .epoch(epoch)
    .id(member)
    .id(device.holder)
    .text(device.name)
    .text(token(platform, "platform"))
    .text(token(keyProtection, "key protection"))
    .point(device.agreementPublicKey)
    .point(device.signingPublicKey);
  count(frame, recovery.length);
  for (const entry of recovery) appendRecovery(frame, entry);
  return frame.toBytes();
}

/** One recovery code's own signature over its entry (label `recovery-holder`), with the setup id as `context`. */
export function recoveryHolder(/** @type {{ household: Uint8Array, context: Uint8Array, epoch: number, entry: RecoveryEntry }} */ { household, context, epoch, entry }) {
  const frame = new Frame("recovery-holder").id(household).id(context).epoch(epoch);
  appendRecovery(frame, entry);
  return frame.toBytes();
}

/** The HPKE `info` of the new file key sealed to the setup's request key (S3). Not an unlock's. */
export const setupProveInfo = (/** @type {Uint8Array} */ household, /** @type {number} */ epoch, /** @type {Uint8Array} */ holder, /** @type {Uint8Array} */ setup, /** @type {Uint8Array} */ nonce) =>
  new Frame("setup-prove").id(household).epoch(epoch).id(holder).id(setup).bytes(nonce, NONCE_LENGTH).toBytes();

/** S3's signed bytes (label `setup-prove`, vector V06). */
export function setupProve(/** @type {{ household: Uint8Array, setup: Uint8Array, nonce: Uint8Array, epoch: number, holder: Uint8Array, enc: Uint8Array, ciphertext: Uint8Array, requestPublicKey: Uint8Array }} */ s) {
  if (!isPoint(s.enc) || !isPoint(s.requestPublicKey)) throw new TypeError("Not a P-256 point.");
  return new Frame("setup-prove")
    .id(s.household)
    .id(s.setup)
    .bytes(s.nonce, NONCE_LENGTH)
    .epoch(s.epoch)
    .id(s.holder)
    .sha256Of(s.enc, s.ciphertext)
    .sha256Of(s.requestPublicKey)
    .toBytes();
}

/** @param {Device} d */
function requireKeys(d) {
  distinct(d.agreementPublicKey, d.signingPublicKey);
  if (!isPoint(d.agreementPublicKey) || !isPoint(d.signingPublicKey)) throw new TypeError("Not a P-256 point.");
}

/** A3 (label `holder-add`, vector V19): this computer approves a phone, by its name and keys. */
export function holderAdd(/** @type {Uint8Array} */ household, /** @type {number} */ epoch, /** @type {Uint8Array} */ holder, /** @type {Uint8Array} */ add, /** @type {Device} */ newDevice) {
  requireKeys(newDevice);
  return new Frame("holder-add")
    .id(household)
    .epoch(epoch)
    .id(holder)
    .id(add)
    .id(newDevice.holder)
    .text(newDevice.name)
    .sha256Of(newDevice.agreementPublicKey)
    .sha256Of(newDevice.signingPublicKey)
    .toBytes();
}

/**
 * A3, version 2 (label `holder-add-v2`, vector V31): this computer approves another computer, and
 * signs whose it is, what it is and where its keys are, so the household records that as signed.
 * @param {Uint8Array} household @param {number} epoch @param {Uint8Array} holder @param {Uint8Array} add @param {Device} newDevice
 * @param {{ member: Uint8Array, platform: string, keyProtection: string }} ownership
 */
export function holderAddV2(household, epoch, holder, add, newDevice, ownership) {
  requireKeys(newDevice);
  return new Frame("holder-add-v2")
    .id(household)
    .epoch(epoch)
    .id(holder)
    .id(add)
    .id(newDevice.holder)
    .id(ownership.member)
    .text(newDevice.name)
    .text(token(ownership.platform, "platform"))
    .text(token(ownership.keyProtection, "key protection"))
    .sha256Of(newDevice.agreementPublicKey)
    .sha256Of(newDevice.signingPublicKey)
    .toBytes();
}

/** The 16 bytes remembered beside the epoch (label `key-fingerprint`, vector V16). Not a secret. */
export function keyFingerprint(/** @type {Uint8Array} */ fileKey, /** @type {Uint8Array} */ household, /** @type {number} */ epoch) {
  if (fileKey.length !== FILE_KEY_LENGTH) throw new TypeError("A file key is 32 bytes.");
  return Buffer.from(hkdfSync("sha256", fileKey, Buffer.alloc(0), new Frame("key-fingerprint").id(household).epoch(epoch).toBytes(), 16));
}

// ── Recovery codes ────────────────────────────────────────────────────────────────────────────

/** Twenty bytes as 32 Crockford characters in groups of four, with hyphens between (vector V10). */
export function recoveryCodeText(/** @type {Uint8Array} */ code) {
  if (code.length !== RECOVERY_CODE_LENGTH) throw new TypeError("A recovery code is 20 bytes.");
  let out = "";
  for (let symbol = 0; symbol < 32; symbol++) {
    if (symbol > 0 && symbol % 4 === 0) out += "-";
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const bit = symbol * 5 + i;
      value = (value << 1) | ((code[bit >> 3] >> (7 - (bit % 8))) & 1);
    }
    out += CROCKFORD[value];
  }
  return out;
}

/**
 * The twenty bytes a person typed, or null. Hyphens and spaces are skipped, either case is read,
 * O is read as zero and I and L as one; U, and anything that is not ASCII, is refused.
 * @param {unknown} text
 * @returns {Buffer | null}
 */
export function parseRecoveryCode(text) {
  if (typeof text !== "string" || text.length > 200) return null;
  const code = Buffer.alloc(RECOVERY_CODE_LENGTH);
  let symbols = 0;
  for (const ch of text) {
    if (ch === "-" || ch === " ") continue;
    const upper = ch.charCodeAt(0) > 0x7f || ch.length > 1 ? "" : ch.toUpperCase();
    const value = upper === "O" ? 0 : upper === "I" || upper === "L" ? 1 : upper ? CROCKFORD.indexOf(upper) : -1;
    if (value < 0 || symbols === 32) {
      zero(code);
      return null;
    }
    for (let i = 0; i < 5; i++) {
      if (value & (0x10 >> i)) {
        const bit = symbols * 5 + i;
        code[bit >> 3] |= 0x80 >> (bit % 8);
      }
    }
    symbols++;
  }
  if (symbols === 32) return code;
  zero(code);
  return null;
}

/** The recovery wrap's `info` (label `recovery-wrap`, vector V11). */
export const recoveryWrapInfo = (/** @type {Uint8Array} */ household, /** @type {Uint8Array} */ holder) => new Frame("recovery-wrap").id(household).id(holder).toBytes();

/** The wrap key: HKDF-SHA256 with the code as key material and the salt as salt. A secret; the caller zeroes it. */
export function recoveryWrapKey(/** @type {{ code: Uint8Array, salt: Uint8Array, household: Uint8Array, holder: Uint8Array }} */ { code, salt, household, holder }) {
  if (code.length !== RECOVERY_CODE_LENGTH || salt.length !== RECOVERY_SALT_LENGTH) throw new TypeError("A recovery code is 20 bytes and its salt 16.");
  return Buffer.from(hkdfSync("sha256", code, salt, recoveryWrapInfo(household, holder), 32));
}

/**
 * The two private scalars under the code: nonce (12) || AES-256-GCM of agreement || signing (64)
 * || tag (16), no associated data. 92 bytes.
 * @param {{ code: Uint8Array, salt: Uint8Array, household: Uint8Array, holder: Uint8Array, nonce: Uint8Array, agreementScalar: Uint8Array, signingScalar: Uint8Array }} w
 */
export function wrapRecovery(w) {
  if (w.nonce.length !== RECOVERY_NONCE_LENGTH || w.agreementScalar.length !== 32 || w.signingScalar.length !== 32) throw new TypeError("Not a recovery wrap's parts.");
  const key = recoveryWrapKey(w);
  const scalars = concat(w.agreementScalar, w.signingScalar);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, w.nonce);
    return concat(w.nonce, cipher.update(scalars), cipher.final(), cipher.getAuthTag());
  } finally {
    zero(key);
    zero(scalars);
  }
}

/** The 64 bytes of the two scalars, or null when the code does not open the wrap. */
export function unwrapRecovery(/** @type {{ code: Uint8Array, salt: Uint8Array, household: Uint8Array, holder: Uint8Array, wrapped: Uint8Array }} */ w) {
  if (w.wrapped.length !== RECOVERY_WRAPPED_LENGTH) return null;
  const key = recoveryWrapKey(w);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, w.wrapped.subarray(0, RECOVERY_NONCE_LENGTH));
    decipher.setAuthTag(w.wrapped.subarray(RECOVERY_WRAPPED_LENGTH - 16));
    return Buffer.concat([decipher.update(w.wrapped.subarray(RECOVERY_NONCE_LENGTH, RECOVERY_WRAPPED_LENGTH - 16)), decipher.final()]);
  } catch {
    return null;
  } finally {
    zero(key);
  }
}

/** A P-256 private scalar's public key, as a 65-byte point. */
export function publicKeyOf(/** @type {Uint8Array} */ scalar) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(scalar));
  return ecdh.getPublicKey();
}

/** A raw r||s ECDSA-SHA256 signature with a software P-256 scalar: a recovery code's own key, never this computer's. */
export function signWithScalar(/** @type {Uint8Array} */ scalar, /** @type {Uint8Array} */ bytes) {
  const point = publicKeyOf(scalar);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64(scalar), x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) },
    format: "jwk",
  });
  return sign("sha256", bytes, { key, dsaEncoding: "ieee-p1363" });
}

/** A fresh holder id: sixteen random bytes as a version 4 UUID. */
export function newHolderId() {
  const id = randomBytes(16);
  id[6] = (id[6] & 0x0f) | 0x40;
  id[8] = (id[8] & 0x3f) | 0x80;
  return id;
}

/**
 * @typedef {object} PreparedRecoveryCode  One code as this computer makes it at going private:
 *   twenty random bytes the member writes down, and a holder of its own whose two private keys are
 *   wrapped under it. Kept in memory only, from making to `dispose`, and never stored or sent.
 * @property {RecoveryEntry} entry  What is sent.
 * @property {string} text          The code as the member writes it.
 * @property {(typed: string) => boolean} matches  Whether a typed code is this one.
 * @property {(household: Uint8Array, context: Uint8Array, epoch: number) => Uint8Array} signEntry
 * @property {() => void} dispose   Overwrites the code and its signing key.
 */

/** Makes one recovery code for `household`. @returns {PreparedRecoveryCode} */
export function makeRecoveryCode(/** @type {Uint8Array} */ household) {
  const code = randomBytes(RECOVERY_CODE_LENGTH);
  const holder = newHolderId();
  const salt = randomBytes(RECOVERY_SALT_LENGTH);
  const agreement = createECDH("prime256v1");
  agreement.generateKeys();
  const signing = createECDH("prime256v1");
  signing.generateKeys();
  // Left-padded to 32 bytes: a scalar with leading zero bytes is still 32 bytes in the wrap.
  const scalar = (/** @type {import("node:crypto").ECDH} */ ecdh) => {
    const raw = ecdh.getPrivateKey();
    const out = Buffer.alloc(32);
    raw.copy(out, 32 - raw.length);
    zero(raw);
    return out;
  };
  const agreementScalar = scalar(agreement);
  const signingScalar = scalar(signing);
  const wrapped = wrapRecovery({ code, salt, household, holder, nonce: randomBytes(RECOVERY_NONCE_LENGTH), agreementScalar, signingScalar });
  zero(agreementScalar);
  /** @type {RecoveryEntry} */
  const entry = { holder, agreementPublicKey: agreement.getPublicKey(), signingPublicKey: signing.getPublicKey(), salt, wrapped };
  const text = recoveryCodeText(code);
  return {
    entry,
    text,
    matches(typed) {
      const parsed = parseRecoveryCode(typed);
      try {
        return parsed !== null && sameBytes(parsed, code);
      } finally {
        zero(parsed);
      }
    },
    signEntry: (h, context, epoch) => signWithScalar(signingScalar, recoveryHolder({ household: h, context, epoch, entry })),
    dispose() {
      zero(code);
      zero(signingScalar);
    },
  };
}
