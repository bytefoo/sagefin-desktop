// @ts-check
// This computer as a household's first key holder, for a member with no phone: making the
// household private here, with the recovery codes that are then the only other way in, and adding
// the member's other devices from here.
//
// The rule lib/private-mode.mjs keeps holds here unchanged: **the key is used only after a person
// at this computer approves the operating system's own prompt**, started from the app's own window
// (never from the page: the page may ask the app to open that window, and nothing more). Going
// private asks twice, once to sign the holders and once to prove the new key opens; adding a device
// asks once, after the person has compared the twelve characters on both screens group by group.
//
// What this computer still never does: unlock a browser (a phone does that), give another member a
// key, or make new recovery codes after setup. SageFin's server refuses those from a computer as
// well, and refuses an add from it once the member has a phone, which then adds devices instead.
//
// No Electron here: `node --test` runs it bare. main/private-mode.mjs carries the decisions out.

import { randomInt, randomUUID } from "node:crypto";
import {
  RECOVERY_CODES,
  addCheck,
  addCommitment,
  b64,
  fromB64,
  holderAdd,
  holderAddV2,
  isToken,
  macMatches,
  makeRecoveryCode,
  newCheckValue,
  openWithAgreement,
  parseEnvelope,
  sameBytes,
  seal,
  sealedCopyInfo,
  setupHoldersV2,
  setupProve,
  setupProveInfo,
  sha256,
  uuidBytes,
  uuidText,
  zero,
} from "./private-protocol.mjs";
import { PROMPTS, failureReason } from "./private-mode.mjs";

/** @typedef {import("./private-mode.mjs").Api} Api */
/** @typedef {import("./private-mode.mjs").KeyStore} KeyStore */
/** @typedef {import("./private-mode.mjs").Holding} Holding */
/** @typedef {import("./private-protocol.mjs").Device} Device */
/** @typedef {import("./private-protocol.mjs").PreparedRecoveryCode} PreparedRecoveryCode */

/** @param {any} body */
const codeOf = (body) => (body && typeof body.code === "string" ? body.code : null);

/** The one sentence private mode promises, as SageFin's server and apps say it. Never anything else. */
export const PROMISE = "Your data is encrypted with a key only you hold, and we can't read it while you're signed out.";

// ── Going private here ────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Setup  S1's answer, as this computer read it.
 * @property {string} setupId
 * @property {string} householdId
 * @property {number} epoch
 * @property {number} expiresAt  When S1's id stops being good, by this computer's clock.
 *
 * @typedef {object} GoingPrivate  A switch in progress, in memory only. The codes are the member's
 *   to write down; they are never stored and never sent, and `forget` overwrites them.
 * @property {Setup | null} setup  Null once it cannot be used again (S1 is asked again, with the same keys and codes).
 * @property {Challenge | null} [challenge]  S2's answer, while it can still be proved.
 * @property {string} householdId
 * @property {string} memberUserId  Whose holders these are: the signed-in member's, signed into S2.
 * @property {string} holderId      This computer's holder id.
 * @property {{ agreementPublicKey: Uint8Array, signingPublicKey: Uint8Array }} keys  Made in the security chip for this switch.
 * @property {PreparedRecoveryCode[]} codes
 * @property {number} confirmIndex  Which code (from zero) the member types back.
 * @property {boolean} confirmed
 */

/** S1's answer, or null for one that is not well-formed. @param {any} body @param {number} now */
function readSetup(body, now) {
  if (!uuidBytes(body?.setupId) || !uuidBytes(body?.householdId) || !Number.isSafeInteger(body?.epoch) || body.epoch < 1) return null;
  if (body.recoveryCodes !== RECOVERY_CODES) return null;
  const expires = Date.parse(body.expiresAt);
  return { setupId: body.setupId, householdId: body.householdId, epoch: body.epoch, expiresAt: Number.isNaN(expires) ? now + 9 * 60_000 : Math.min(expires, now + 10 * 60_000) };
}

/**
 * Whether this household may go private now, and if not why: `GET /private/eligibility`. Null when
 * SageFin did not say (private mode switched off, or no answer).
 * @param {Api} api
 * @returns {Promise<{ eligible: boolean, reasons: string[] } | null>}
 */
export async function goPrivateEligibility(api) {
  const read = await api.get("/private/eligibility").catch(() => null);
  if (read?.status !== 200 || typeof read.body?.eligible !== "boolean") return null;
  const reasons = Array.isArray(read.body.reasons) ? read.body.reasons.filter((/** @type {unknown} */ r) => typeof r === "string") : [];
  return { eligible: read.body.eligible, reasons };
}

/**
 * S1, then this computer's two new keys in its security chip and the four recovery codes. Nothing
 * of the household changes yet, and the codes exist only here until the member has typed one back.
 * @param {object} options
 * @param {Api} options.api
 * @param {KeyStore} options.keys
 * @param {number} [options.now]
 * @returns {Promise<{ going: GoingPrivate } | { refused: string | null, reasons?: string[] }>}
 */
export async function beginGoingPrivate({ api, keys, now = Date.now() }) {
  const asked = await api.post("/private/setup");
  if (asked.status !== 200) return { refused: codeOf(asked.body), reasons: Array.isArray(asked.body?.reasons) ? asked.body.reasons : undefined };
  const setup = readSetup(asked.body, now);
  if (!setup) return { refused: null };
  // Whose holders these are, signed into S2 (`setup-holders-v2`): the signed-in member's own id.
  const me = await api.get("/me");
  const memberUserId = me.status === 200 && uuidBytes(me.body?.userId) ? String(me.body.userId).toLowerCase() : null;
  if (!memberUserId) return { refused: null };
  const household = /** @type {Uint8Array} */ (uuidBytes(setup.householdId));
  // New keys every time: the household is standard, so no key this computer had is anybody's holder.
  const made = await keys.create();
  const codes = Array.from({ length: RECOVERY_CODES }, () => makeRecoveryCode(household));
  return {
    going: { setup, householdId: setup.householdId, memberUserId, holderId: randomUUID(), keys: made, codes, confirmIndex: randomInt(RECOVERY_CODES), confirmed: false },
  };
}

/** The four codes as the member writes them down, in order. */
export const codeTexts = (/** @type {GoingPrivate} */ going) => going.codes.map((c) => c.text);

/**
 * The codes as plain text, one per line, for the member to copy or save. Built here from the
 * going-private state, never from anything the window sends.
 * @param {GoingPrivate} going
 */
export const codesAsText = (going) => `${codeTexts(going).join("\n")}\n`;

/** Whether `typed` is the code asked for. Checked here; SageFin is told only that one was. */
export function confirmRecoveryCode(/** @type {GoingPrivate} */ going, /** @type {unknown} */ typed) {
  if (typeof typed === "string" && going.codes[going.confirmIndex]?.matches(typed)) going.confirmed = true;
  return going.confirmed;
}

/** Overwrites the codes and their keys. Safe to call twice. */
export function forgetGoingPrivate(/** @type {GoingPrivate | null | undefined} */ going) {
  for (const code of going?.codes ?? []) code.dispose();
}

/**
 * Whether the draft envelope S2 answered holds exactly this computer and the four codes it made,
 * each with its own keys, under a private custody of the household and epoch asked. A draft that
 * left a code out, or put somebody's device in, is not proved.
 * @param {import("./private-protocol.mjs").Envelope} draft @param {GoingPrivate} going @param {Setup} setup
 */
function draftIsOurs(draft, going, setup) {
  const household = /** @type {Uint8Array} */ (uuidBytes(setup.householdId));
  if (!sameBytes(draft.household, household) || draft.epoch !== setup.epoch || draft.custody !== "private") return null;
  const devices = draft.holders.filter((h) => h.kind === "device");
  const codes = draft.holders.filter((h) => h.kind === "recovery");
  const mine = devices[0];
  if (devices.length !== 1 || !sameBytes(mine.id, /** @type {Uint8Array} */ (uuidBytes(going.holderId)))) return null;
  if (!sameBytes(mine.agreementPublicKey, going.keys.agreementPublicKey) || !sameBytes(mine.signingPublicKey, going.keys.signingPublicKey)) return null;
  if (codes.length !== going.codes.length) return null;
  for (const made of going.codes) {
    const listed = codes.filter((c) => sameBytes(c.id, made.entry.holder));
    if (listed.length !== 1 || !sameBytes(listed[0].agreementPublicKey, made.entry.agreementPublicKey) || !sameBytes(listed[0].signingPublicKey, made.entry.signingPublicKey)) return null;
  }
  return mine;
}

/**
 * @typedef {object} Challenge  S2's answer, read and checked: the draft holds exactly this
 *   computer and the four codes, and S3 must arrive before `proveBy`.
 * @property {Setup} setup
 * @property {import("./private-protocol.mjs").Envelope} draft
 * @property {import("./private-protocol.mjs").EnvelopeHolder} mine
 * @property {Uint8Array} nonce
 * @property {Uint8Array} requestPublicKey
 * @property {Uint8Array} draftSha
 * @property {number} proveBy
 */

/**
 * S1 where the last one can no longer be used, then S2 with the first prompt.
 * @param {{ api: Api, keys: KeyStore, going: GoingPrivate, name: string, tokens: { platform: string, keyProtection: string }, now: () => number }} options
 * @returns {Promise<{ challenge: Challenge } | { outcome: "refused" | "cancelled" | "failed", code: string | null, reason?: string }>}
 */
async function offerHolders({ api, keys, going, name, tokens, now }) {
  let setup = going.setup;
  if (!setup || now() > setup.expiresAt - 30_000) {
    const again = await api.post("/private/setup");
    if (again.status !== 200) return { outcome: "refused", code: codeOf(again.body) };
    setup = readSetup(again.body, now());
    if (!setup || setup.householdId !== going.householdId) return { outcome: "failed", code: null };
    going.setup = setup;
  }
  const household = /** @type {Uint8Array} */ (uuidBytes(setup.householdId));
  const setupBytes = /** @type {Uint8Array} */ (uuidBytes(setup.setupId));
  const holder = /** @type {Uint8Array} */ (uuidBytes(going.holderId));
  /** @type {Device} */
  const device = { holder, name, ...going.keys };
  const recovery = going.codes.map((c) => c.entry);

  // The first prompt: the whole set, this computer's platform and key protection, and the member.
  let deviceSignature;
  try {
    const signed = setupHoldersV2({ household, setup: setupBytes, epoch: setup.epoch, member: /** @type {Uint8Array} */ (uuidBytes(going.memberUserId)), device, platform: tokens.platform, keyProtection: tokens.keyProtection, recovery });
    deviceSignature = await keys.withPresence(PROMPTS.goPrivate, (presence) => presence.sign(signed));
  } catch (error) {
    return { outcome: /** @type {any} */ (error)?.message === "cancelled" ? "cancelled" : "failed", code: null, reason: failureReason("first-confirmation", error) };
  }
  const offered = await api.post(`/private/setup/${setup.setupId}/holders`, {
    device: { holderId: going.holderId, name, agreementPublicKey: b64(device.agreementPublicKey), signingPublicKey: b64(device.signingPublicKey) },
    deviceSignature: b64(deviceSignature),
    recovery: recovery.map((r) => ({ holderId: uuidText(r.holder), agreementPublicKey: b64(r.agreementPublicKey), signingPublicKey: b64(r.signingPublicKey), salt: b64(r.salt), wrapped: b64(r.wrapped) })),
    recoverySignatures: going.codes.map((c) => b64(c.signEntry(household, setupBytes, setup.epoch))),
    platform: tokens.platform,
    keyProtection: tokens.keyProtection,
    memberUserId: going.memberUserId,
  });
  // Whatever happens next, this setup has had its S2: the next try asks S1 again, with the same
  // keys and codes.
  going.setup = null;
  if (offered.status !== 200) return { outcome: "refused", code: codeOf(offered.body) };
  const c = offered.body;
  const draftBytes = fromB64(c?.draftEnvelope);
  const nonce = fromB64(c?.nonce);
  const requestPublicKey = fromB64(c?.requestPublicKey);
  const draftSha = fromB64(c?.draftEnvelopeSha256);
  if (c?.householdId !== setup.householdId || c?.epoch !== setup.epoch || String(c?.holderId).toLowerCase() !== going.holderId.toLowerCase()
    || !draftBytes || !nonce || nonce.length !== 32 || !requestPublicKey || !draftSha || !sameBytes(sha256(draftBytes), draftSha)) {
    return { outcome: "failed", code: null };
  }
  let draft;
  try {
    draft = parseEnvelope(draftBytes);
  } catch (error) {
    return { outcome: "failed", code: null, reason: failureReason("draft", error) };
  }
  const mine = draftIsOurs(draft, going, setup);
  if (!mine) return { outcome: "failed", code: "keys_do_not_match" };
  const deadline = Date.parse(c?.proveBy);
  const proveBy = Number.isNaN(deadline) ? now() + 110_000 : Math.min(deadline, now() + 120_000);
  return { challenge: { setup, draft, mine, nonce, requestPublicKey, draftSha, proveBy } };
}

/**
 * S2 and S3: signs the holders, then proves the new key opens and sends the proof. The household is
 * private, and locked, when this answers `done`; this computer then unlocks its own window as any
 * holder does. Safe to call again after a person said no, a lost connection or a refusal that says
 * to begin again: it asks S1 again where it has to, with the same keys and the same four codes.
 * @param {object} options
 * @param {Api} options.api
 * @param {KeyStore} options.keys
 * @param {GoingPrivate} options.going
 * @param {string} options.name  What the household calls this computer: its name.
 * @param {{ platform: string, keyProtection: string }} options.tokens  From `holderTokens`.
 * @param {() => number} [options.now]
 * @returns {Promise<{ outcome: "done", holding: Holding } | { outcome: "refused" | "cancelled" | "failed", code: string | null, reason?: string }>}
 */
export async function finishGoingPrivate({ api, keys, going, name, tokens, now = Date.now }) {
  if (!going.confirmed) return { outcome: "refused", code: "codes_not_confirmed" };
  if (!isToken(tokens.platform) || !isToken(tokens.keyProtection)) return { outcome: "failed", code: null };

  // S2's answer is kept for as long as it can be proved: a person who said no at the second prompt,
  // or a dropped connection, proves the same S2 again, which the server takes once per setup.
  let challenge = going.challenge;
  if (!challenge || now() > challenge.proveBy - 5_000) {
    going.challenge = null;
    const offered = await offerHolders({ api, keys, going, name, tokens, now });
    if (!("challenge" in offered)) return offered;
    challenge = going.challenge = offered.challenge;
  }
  const { setup, draft, mine, nonce, requestPublicKey } = challenge;
  const household = /** @type {Uint8Array} */ (uuidBytes(setup.householdId));
  const setupBytes = /** @type {Uint8Array} */ (uuidBytes(setup.setupId));
  const holder = /** @type {Uint8Array} */ (uuidBytes(going.holderId));

  // S3: the second prompt. Open this computer's sealed copy of the new key, check the draft is the
  // one that key MACs, and seal the key to the setup's request key. The key never stays.
  /** @type {{ enc: Uint8Array, ciphertext: Uint8Array, signature: Uint8Array } | null} */
  let proof;
  try {
    proof = await keys.withPresence(PROMPTS.goPrivate, async (presence) => {
      const agreement = await presence.agree(mine.enc);
      const fileKey = openWithAgreement({ agreement, enc: mine.enc, recipientPublicKey: mine.agreementPublicKey, info: sealedCopyInfo(household, setup.epoch, holder), ciphertext: mine.ciphertext });
      zero(agreement);
      if (!fileKey) return null;
      try {
        if (!macMatches(draft, fileKey, household, setup.epoch)) return null;
        const sealed = seal({ recipientPublicKey: requestPublicKey, info: setupProveInfo(household, setup.epoch, holder, setupBytes, nonce), plaintext: fileKey });
        const signature = await presence.sign(setupProve({ household, setup: setupBytes, nonce, epoch: setup.epoch, holder, enc: sealed.enc, ciphertext: sealed.ciphertext, requestPublicKey }));
        return { ...sealed, signature };
      } finally {
        zero(fileKey);
      }
    });
  } catch (error) {
    return { outcome: /** @type {any} */ (error)?.message === "cancelled" ? "cancelled" : "failed", code: null, reason: failureReason("second-confirmation", error) };
  }
  if (!proof) {
    going.setup = null;
    going.challenge = null;
    return { outcome: "failed", code: "keys_do_not_match" };
  }
  const draftSha = challenge.draftSha;

  const sent = await api.post(`/private/setup/${setup.setupId}/prove`, { enc: b64(proof.enc), ct: b64(proof.ciphertext), signature: b64(proof.signature), recoveryCodeConfirmed: true }).catch(() => null);
  const holding = { householdId: setup.householdId, holderId: going.holderId };
  if (sent?.status === 200 && sameBytes(/** @type {Uint8Array} */ (fromB64(sent.body?.envelopeSha256) ?? Buffer.alloc(0)), draftSha)) return { outcome: "done", holding };
  // The answer was lost, or the server is still finishing: whether it committed is the status's to say.
  if (!sent || sent.status >= 500 || codeOf(sent.body) === "begin_again") {
    const status = await api.get("/private/status").catch(() => null);
    if (status?.status === 200 && (status.body?.state === "locked" || status.body?.state === "unlocked")) return { outcome: "done", holding };
  }
  going.setup = null;
  going.challenge = null;
  return { outcome: sent ? "refused" : "failed", code: codeOf(sent?.body) };
}

// ── Adding a device from here ─────────────────────────────────────────────────────────────────

/**
 * The add id from what the person typed: the code under the new device's QR code, 32 hexadecimal
 * characters in any grouping or case, or the QR code's own text. Null for anything else.
 * @param {unknown} text
 */
export function addIdFromTyped(text) {
  if (typeof text !== "string" || text.length > 200) return null;
  const bare = text.trim().replace(/^SAGEFIN-ADD:/i, "").replace(/[\s-]/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(bare)) return null;
  const h = bare.toLowerCase();
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return uuidBytes(id) ? id : null;
}

/** What a device is called on this computer's screens, from what it said it is. */
export function deviceKind(/** @type {unknown} */ platform) {
  switch (platform) {
    case "ios":
      return "iPhone";
    case "android":
      return "Android phone";
    case "desktop-macos":
      return "Mac with SageFin Desktop";
    case "desktop-windows":
      return "Windows computer with SageFin Desktop";
    default:
      return "device";
  }
}

/**
 * @typedef {object} Approving  An add this computer is approving. Its value is drawn only after it
 *   read the new device's keys and commitment, and is sent once.
 * @property {string} addId
 * @property {string} householdId
 * @property {number} epoch
 * @property {Device} device       The new device, as first read; nothing read later changes it.
 * @property {Uint8Array} commitment
 * @property {Uint8Array} value    This computer's half of the check.
 * @property {string | null} memberUserId
 * @property {string | null} platform
 * @property {string | null} keyProtection
 * @property {string | null} check The twelve characters, once both values are in.
 */

/** A2's device, or null. @param {any} body */
function deviceOf(body) {
  const d = body?.device;
  const holder = uuidBytes(d?.holderId);
  const agreementPublicKey = fromB64(d?.agreementPublicKey);
  const signingPublicKey = fromB64(d?.signingPublicKey);
  if (!holder || !agreementPublicKey || !signingPublicKey || typeof d?.name !== "string" || d.name.length === 0 || d.name.length > 256) return null;
  return { holder, name: d.name, agreementPublicKey, signingPublicKey };
}

/**
 * A2, then A2b: reads the new device's keys and commitment, and only then draws this computer's
 * value and sends it, once. The household has to be the one this computer holds a key of.
 * @param {object} options
 * @param {Api} options.api
 * @param {Holding} options.holding
 * @param {string} options.addId
 * @returns {Promise<{ approving: Approving } | { refused: string | null }>}
 */
export async function beginApproving({ api, holding, addId }) {
  const read = await api.get(`/private/holder-requests/${addId}`);
  if (read.status !== 200) return { refused: codeOf(read.body) ?? "request_expired" };
  const r = read.body;
  if (r?.state !== "pending") return { refused: "request_expired" };
  if (String(r.householdId).toLowerCase() !== holding.householdId.toLowerCase() || !Number.isSafeInteger(r.epoch)) return { refused: null };
  const device = deviceOf(r);
  if (!device) return { refused: "device_not_offered" };
  const commitment = fromB64(r.commitment);
  if (!commitment || commitment.length !== 32) return { refused: "app_update_required" };
  const value = newCheckValue();
  const sent = await api.post(`/private/holder-requests/${addId}/challenge`, { value: b64(value) });
  if (sent.status !== 200) return { refused: codeOf(sent.body) };
  const tokenOrNull = (/** @type {unknown} */ t) => (isToken(t) ? /** @type {string} */ (t) : null);
  return {
    approving: {
      addId,
      householdId: holding.householdId,
      epoch: r.epoch,
      device,
      commitment,
      value,
      memberUserId: uuidBytes(r.memberUserId) ? String(r.memberUserId).toLowerCase() : null,
      platform: tokenOrNull(r.platform),
      keyProtection: tokenOrNull(r.keyProtection),
      check: null,
    },
  };
}

/**
 * One look at the add (A2): once the new device has revealed its value, and the value opens the
 * commitment it made with its keys before it saw this computer's, the twelve characters to compare.
 * @param {Api} api @param {Approving} approving
 * @returns {Promise<{ show: "waiting" | "check" | "ended" | "mismatch", approving: Approving }>}
 */
export async function lookAtApproving(api, approving) {
  const read = await api.get(`/private/holder-requests/${approving.addId}`);
  if (read.status !== 200) return { show: "ended", approving };
  const r = read.body;
  if (r?.state !== "pending") return { show: "ended", approving };
  const device = deviceOf(r);
  if (!device || !sameBytes(device.agreementPublicKey, approving.device.agreementPublicKey) || !sameBytes(device.signingPublicKey, approving.device.signingPublicKey)
    || !sameBytes(device.holder, approving.device.holder) || device.name !== approving.device.name) {
    return { show: "mismatch", approving };
  }
  const challenge = fromB64(r.challenge);
  if (challenge && !sameBytes(challenge, approving.value)) return { show: "mismatch", approving };
  const reveal = fromB64(r.reveal);
  if (!reveal) return { show: "waiting", approving };
  const household = /** @type {Uint8Array} */ (uuidBytes(approving.householdId));
  const add = /** @type {Uint8Array} */ (uuidBytes(approving.addId));
  if (reveal.length !== 20 || !sameBytes(addCommitment(household, add, approving.device, reveal), approving.commitment)) return { show: "mismatch", approving };
  const check = addCheck(household, add, approving.device, reveal, approving.value);
  // The server's own answer, if it gives one, has to be this one. This computer shows its own.
  if (typeof r.keyCheck === "string" && r.keyCheck !== check) return { show: "mismatch", approving };
  return { show: "check", approving: { ...approving, check } };
}

/**
 * A3: the person compared every group and pressed Add; the operating system's prompt asks, and this
 * computer signs the new device by its name and keys. A computer is signed as one, whose it is and
 * where its keys are (`holder-add-v2`), so the household records that as signed; a phone as the
 * phones sign one (`holder-add`). Sent on this window's own sign-in, which has to be unlocked.
 * @param {object} options
 * @param {Api} options.api
 * @param {KeyStore} options.keys
 * @param {Holding} options.holding
 * @param {Approving} options.approving
 * @returns {Promise<{ outcome: "done" | "refused" | "cancelled" | "failed", code: string | null, reason?: string }>}
 */
export async function approveAdding({ api, keys, holding, approving }) {
  if (!approving.check) return { outcome: "failed", code: "check_not_finished" };
  const household = /** @type {Uint8Array} */ (uuidBytes(approving.householdId));
  const add = /** @type {Uint8Array} */ (uuidBytes(approving.addId));
  const holder = /** @type {Uint8Array} */ (uuidBytes(holding.holderId));
  const computer = typeof approving.platform === "string" && approving.platform.startsWith("desktop-");
  let bytes;
  try {
    if (computer) {
      const member = uuidBytes(approving.memberUserId);
      if (!member || !approving.platform || !approving.keyProtection) return { outcome: "failed", code: null };
      bytes = holderAddV2(household, approving.epoch, holder, add, approving.device, { member, platform: approving.platform, keyProtection: approving.keyProtection });
    } else {
      bytes = holderAdd(household, approving.epoch, holder, add, approving.device);
    }
  } catch (error) {
    return { outcome: "failed", code: null, reason: failureReason("add-build", error) };
  }
  let signature;
  try {
    signature = await keys.withPresence(PROMPTS.addDevice, (presence) => presence.sign(bytes));
  } catch (error) {
    return { outcome: /** @type {any} */ (error)?.message === "cancelled" ? "cancelled" : "failed", code: null, reason: failureReason("add-confirmation", error) };
  }
  const sent = await api.post(`/private/holder-requests/${approving.addId}/approve`, { holderId: holding.holderId, signature: b64(signature) });
  return sent.status === 200 ? { outcome: "done", code: null } : { outcome: "refused", code: codeOf(sent.body) };
}

/** The twelve characters as three groups, for comparing one at a time. */
export const checkGroups = (/** @type {string} */ check) => check.split("-");
