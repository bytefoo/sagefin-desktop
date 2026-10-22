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

import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

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
