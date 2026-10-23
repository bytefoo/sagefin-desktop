// @ts-check
// This computer as a key holder of a private SageFin household: what it may do with its key,
// when it asks the person in front of it, and the three things it does with SageFin's server.
//
// The rule every line here keeps: **the key is used only after something SageFin's server cannot
// produce has happened**, which is a person at this computer approving the operating system's own
// prompt (Touch ID on a Mac). The window shows SageFin's web app, which SageFin's server serves, so
// nothing the page asks for is that. The page cannot start an unlock, cannot see the key, and
// cannot choose what the prompt says.
//
// What this computer approves, and nothing else:
// - **its own window**: a request it asked for itself, on the window's own sign-in, and approves
//   on that same sign-in. Never a code shown by a browser somewhere else; your phone approves those.
// - **Sync and lock**: the same, for a short unlock that only syncs your banks, when SageFin says
//   there is new bank activity and you choose to let it.
// SageFin's server refuses this computer's approval of anything else as well, so a build that
// forgot one of these rules would still be stopped there.
//
// No Electron here: `node --test` runs it bare. main/private-mode.mjs carries the decisions out.

import { randomUUID } from "node:crypto";
import {
  addCheck,
  addCommitment,
  b64,
  fromB64,
  holderRequest,
  macMatches,
  newCheckValue,
  openWithAgreement,
  parseEnvelope,
  sameBytes,
  seal,
  sealedCopyInfo,
  unlockApprove,
  unlockInfo,
  uuidBytes,
  uuidText,
  zero,
} from "./private-protocol.mjs";

// ── Where the key may live ────────────────────────────────────────────────────────────────────

/**
 * What this computer tells SageFin it is and where its keys are, or null where it cannot hold a
 * key. **Only a computer's own security chip**, with the operating system's own check each time:
 * a Mac's Secure Enclave with Touch ID or the login password. Windows' TPM with Windows Hello is
 * allowed by SageFin too, and is not built here yet: whether Hello can be required for each use of
 * a TPM key is still to be shown. Linux has no standard chip or prompt and holds no key; nor does
 * any computer by the operating system's keychain alone, which protects a key from other users of
 * the computer and not from a program running as you. Without a key, the window unlocks with your
 * phone, as a browser does.
 * @param {string} platform  `process.platform`.
 * @param {{ hardwareKeys: boolean }} keyStore  What the key store says it can do on this computer.
 * @returns {{ platform: string, keyProtection: string } | null}
 */
export function holderTokens(platform, keyStore) {
  if (!keyStore.hardwareKeys) return null;
  if (platform === "darwin") return { platform: "desktop-macos", keyProtection: "secure-enclave" };
  if (platform === "win32") return { platform: "desktop-windows", keyProtection: "tpm" };
  return null;
}

// ── What the prompt says ──────────────────────────────────────────────────────────────────────

/**
 * Every sentence the operating system's prompt may show, fixed here. The page never chooses one,
 * and nothing it sends is put in one: what you approve is what this list says.
 */
export const PROMPTS = Object.freeze({
  unlock: "unlock SageFin in this window",
  sync: "sync your banks and keep your household locked",
  enrol: "use this computer to unlock SageFin",
});

/** @typedef {keyof typeof PROMPTS} PromptKind */

// ── When the key may be used at all ───────────────────────────────────────────────────────────

/**
 * @typedef {object} Circumstances
 * @property {boolean} fromPage      The request came from the web page, over the bridge.
 * @property {boolean} screenLocked  The computer's screen is locked.
 * @property {boolean} windowShown   SageFin's window is on screen, not hidden or minimized.
 * @property {boolean} windowFocused It is the window in front.
 * @property {boolean} prompting     Another prompt of this app's is already showing.
 */

/**
 * Why the key may not be used now, or null when it may. **A use starts only from this app's own
 * button or menu, in front of a person**: never from the page, never with the screen locked, never
 * with the window hidden or behind another, never while another prompt is showing.
 * @param {Circumstances} c
 * @returns {"from-page" | "screen-locked" | "window-hidden" | "window-behind" | "already-asking" | null}
 */
export function whyNotNow(c) {
  if (c.fromPage) return "from-page";
  if (c.screenLocked) return "screen-locked";
  if (!c.windowShown) return "window-hidden";
  if (!c.windowFocused) return "window-behind";
  if (c.prompting) return "already-asking";
  return null;
}

// ── When SageFin says your bank has new activity ──────────────────────────────────────────────

/** Never two notifications within this long, whatever SageFin says. */
export const SYNC_NOTICE_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * What the check-in answer says of private mode, or null when it says nothing usable (a standard
 * household, an older SageFin). Read strictly: anything that is not plainly true is false.
 * @param {unknown} answer  The check-in's `privateMode`.
 * @returns {{ locked: boolean, syncWaiting: boolean } | null}
 */
export function readPrivateMode(answer) {
  if (!answer || typeof answer !== "object") return null;
  const { locked, syncWaiting } = /** @type {Record<string, unknown>} */ (answer);
  if (typeof locked !== "boolean") return null;
  return { locked, syncWaiting: locked && syncWaiting === true };
}

/**
 * @typedef {object} NoticeState  Kept by this app, about its own notifications. SageFin cannot reset it.
 * @property {number | null} lastAt        When it last showed one.
 * @property {boolean} thisLockedPeriod    It has shown one since the household was last seen unlocked.
 */

/** @type {NoticeState} */
export const NO_NOTICES = Object.freeze({ lastAt: null, thisLockedPeriod: false });

/**
 * Whether to show "Your bank has new activity. Sync and lock?", and the state after. **This app
 * counts, not SageFin**: one per locked period, matching the phone's one push, and never two within
 * six hours, so a server that says "waiting" at will cannot teach anyone to approve on sight. A
 * notification only asks; it is the person's approval at the prompt that unlocks.
 * @param {NoticeState} state
 * @param {{ locked: boolean, syncWaiting: boolean } | null} privateMode
 * @param {number} now
 * @param {{ holdsAKey: boolean }} here  Whether this computer holds a key of the household.
 * @returns {{ notify: boolean, state: NoticeState }}
 */
export function syncNotice(state, privateMode, now, here) {
  if (!privateMode || !here.holdsAKey) return { notify: false, state };
  // Seen unlocked: the locked period is over, and the next one may have its one notification.
  if (!privateMode.locked) return { notify: false, state: { ...state, thisLockedPeriod: false } };
  if (!privateMode.syncWaiting || state.thisLockedPeriod) return { notify: false, state };
  if (state.lastAt !== null && now >= state.lastAt && now - state.lastAt < SYNC_NOTICE_GAP_MS) return { notify: false, state };
  return { notify: true, state: { lastAt: now, thisLockedPeriod: true } };
}

/** The notification's words. Fixed: nothing of the household is in them. */
export const SYNC_NOTICE = Object.freeze({ title: "Your bank has new activity", body: "Sync and lock? You'll be asked to confirm on this computer." });

// ── This computer's record of what it unlocked ────────────────────────────────────────────────

/**
 * @typedef {object} LogEntry  One use of the key, kept on this computer. SageFin cannot erase it.
 * @property {string} at       ISO time.
 * @property {PromptKind} what
 * @property {"done" | "refused" | "cancelled" | "failed"} outcome
 * @property {string | null} code  SageFin's code when it refused.
 */

export const LOG_KEEPS = 500;

/** @param {LogEntry[]} log @param {LogEntry} entry */
export const logged = (log, entry) => [...log, entry].slice(-LOG_KEEPS);

// ── Talking to SageFin ────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Api  The window's own sign-in, used by this app's main process.
 * @property {(path: string, body?: unknown) => Promise<{ status: number, body: any }>} post
 * @property {(path: string) => Promise<{ status: number, body: any }>} get
 *
 * @typedef {object} PresenceSession  One approval: one agreement and one signature, then it ends.
 * @property {(peer: Uint8Array) => Promise<Uint8Array>} agree  The raw P-256 agreement with the agreement key.
 * @property {(bytes: Uint8Array) => Promise<Uint8Array>} sign  A raw r||s ECDSA-SHA256 signature with the signing key.
 *
 * @typedef {object} KeyStore  The two keys in the computer's security chip (main/key-store.mjs).
 * @property {() => Promise<{ agreementPublicKey: Uint8Array, signingPublicKey: Uint8Array } | null>} publicKeys
 * @property {() => Promise<{ agreementPublicKey: Uint8Array, signingPublicKey: Uint8Array }>} create
 * @property {<T>(prompt: string, use: (session: PresenceSession) => Promise<T>) => Promise<T>} withPresence
 *   Shows the operating system's prompt with `prompt`, and only when the person approves it runs
 *   `use`. Throws `cancelled` when they do not.
 *
 * @typedef {object} Holding  What this computer remembers of the household it holds a key of.
 * @property {string} householdId
 * @property {string} holderId
 */

/** @param {any} body */
const codeOf = (body) => (body && typeof body.code === "string" ? body.code : null);

/**
 * One single-use guard around a presence session: one agreement, one signature, in that order.
 * The key store keeps the same rule on its side; this is so a mistake here fails here first.
 * @param {PresenceSession} session
 */
function once(session) {
  let agreed = false;
  let signed = false;
  return {
    /** @param {Uint8Array} peer */
    agree(peer) {
      if (agreed) throw new Error("One agreement per approval.");
      agreed = true;
      return session.agree(peer);
    },
    /** @param {Uint8Array} bytes */
    sign(bytes) {
      if (signed || !agreed) throw new Error("One signature per approval, after its agreement.");
      signed = true;
      return session.sign(bytes);
    },
  };
}

/**
 * Unlocks the household for this window, or for a Sync and lock: U1 asked on the window's own
 * sign-in, the person approves at the prompt, U4 sent on the same sign-in.
 *
 * **Only a request this app asked for, here, now.** U1's answer has to say it was asked by this
 * sign-in. A request id from anywhere else (a page, a QR code, a link) is never taken: that is how a
 * browser somewhere else would be let in by a person who meant to unlock this window.
 * @param {object} options
 * @param {Api} options.api
 * @param {KeyStore} options.keys
 * @param {Holding} options.holding
 * @param {"full" | "sync"} options.purpose
 * @returns {Promise<{ outcome: "done" | "refused" | "cancelled" | "failed", code: string | null }>}
 */
export async function unlockHere({ api, keys, holding, purpose }) {
  const asked = await api.post("/private/unlock-requests", { purpose });
  if (asked.status !== 200) return { outcome: "refused", code: codeOf(asked.body) };
  const issued = asked.body;
  // Asked by this sign-in, for the household this computer holds a key of, for the purpose asked.
  if (issued?.askedByThisSession !== true || issued.householdId !== holding.householdId || issued.purpose !== purpose) {
    return { outcome: "failed", code: null };
  }
  const request = {
    household: uuidBytes(issued.householdId),
    request: uuidBytes(issued.requestId),
    nonce: fromB64(issued.nonce),
    epoch: issued.epoch,
    purpose,
    requestPublicKey: fromB64(issued.requestPublicKey),
  };
  const holder = uuidBytes(holding.holderId);
  if (!request.household || !request.request || !request.nonce || !request.requestPublicKey || !holder || !Number.isSafeInteger(request.epoch)) {
    return { outcome: "failed", code: null };
  }
  const r = /** @type {import("./private-protocol.mjs").Request} */ (request);

  const read = await api.get("/private/envelope");
  const bytes = read.status === 200 ? fromB64(read.body?.envelope) : null;
  if (!bytes) return { outcome: "refused", code: codeOf(read.body) };
  let envelope;
  try {
    envelope = parseEnvelope(bytes);
  } catch {
    return { outcome: "failed", code: null };
  }
  if (!sameBytes(envelope.household, r.household) || envelope.epoch !== r.epoch) return { outcome: "refused", code: "epoch_behind" };
  const mine = envelope.holders.find((h) => h.kind === "device" && sameBytes(h.id, holder));
  const ours = await keys.publicKeys();
  if (!mine || !ours || !sameBytes(mine.agreementPublicKey, ours.agreementPublicKey) || !sameBytes(mine.signingPublicKey, ours.signingPublicKey)) {
    return { outcome: "refused", code: "unknown_holder" };
  }

  /** @type {{ enc: Uint8Array, ciphertext: Uint8Array, signature: Uint8Array } | null} */
  let approval;
  try {
    approval = await keys.withPresence(PROMPTS[purpose === "sync" ? "sync" : "unlock"], async (presence) => {
      const use = once(presence);
      const agreement = await use.agree(mine.enc);
      const fileKey = openWithAgreement({ agreement, enc: mine.enc, recipientPublicKey: mine.agreementPublicKey, info: sealedCopyInfo(r.household, r.epoch, holder), ciphertext: mine.ciphertext });
      zero(agreement);
      if (!fileKey) return null;
      try {
        // The envelope and the key belong together. Whether the key is the household's is the
        // server's to say, by opening the household's data with it.
        if (!macMatches(envelope, fileKey, r.household, r.epoch)) return null;
        const sealed = seal({ recipientPublicKey: r.requestPublicKey, info: unlockInfo(r, holder), plaintext: fileKey });
        const signature = await use.sign(unlockApprove(r, holder, sealed.enc, sealed.ciphertext));
        return { ...sealed, signature };
      } finally {
        zero(fileKey);
      }
    });
  } catch (error) {
    return { outcome: /** @type {any} */ (error)?.message === "cancelled" ? "cancelled" : "failed", code: null };
  }
  if (!approval) return { outcome: "failed", code: null };

  const sent = await api.post(`/private/unlock-requests/${issued.requestId}/approve`, {
    holderId: holding.holderId,
    epoch: r.epoch,
    enc: b64(approval.enc),
    ct: b64(approval.ciphertext),
    signature: b64(approval.signature),
  });
  return sent.status === 200 ? { outcome: "done", code: null } : { outcome: "refused", code: codeOf(sent.body) };
}

// ── Adding this computer, approved by your phone ──────────────────────────────────────────────

/**
 * @typedef {object} Enrolment  An add in progress. The value is this computer's secret until the
 * phone's is on the request; it is revealed once, for the first value read.
 * @property {string} addId
 * @property {string} householdId
 * @property {string} holderId
 * @property {import("./private-protocol.mjs").Device} device
 * @property {Uint8Array} value
 * @property {Uint8Array | null} challenge   The phone's value, as first read.
 * @property {string | null} check           The twelve characters, once both values are in.
 */

/** The add id as a person types it into the phone: 32 hexadecimal characters in groups of four. */
export const typedCode = (/** @type {string} */ addId) => addId.replaceAll("-", "").toUpperCase().match(/.{4}/g)?.join(" ") ?? "";

/**
 * What the enrolment QR code holds: `SAGEFIN-ADD:` and the add id, hyphenated, upper case. Exactly
 * what the phone's "Add a device" scanner reads (and what a new phone's own code holds), so the
 * phone scans this computer's code as it scans another phone's. Upper case keeps it in QR's compact
 * alphanumeric mode. The phone only ever asks SageFin about the id, signed in as the person.
 */
export const enrolmentQrText = (/** @type {string} */ addId) => `SAGEFIN-ADD:${addId.toUpperCase()}`;

/**
 * A1 and A1b: asks to be added, with this computer's two keys from its security chip, what it is
 * and where they are, and a commitment to its half of the check. The person approves the prompt
 * first: the request is signed with the signing key, as every use of it is.
 * @param {object} options
 * @param {Api} options.api
 * @param {KeyStore} options.keys
 * @param {string} options.name  What the phone shows it as: the computer's name.
 * @param {{ platform: string, keyProtection: string }} options.tokens  From `holderTokens`.
 * @returns {Promise<{ enrolment: Enrolment } | { refused: string | null }>}
 */
export async function beginEnrolment({ api, keys, name, tokens }) {
  const begun = await api.post("/private/holder-requests");
  if (begun.status !== 200) return { refused: codeOf(begun.body) };
  const household = uuidBytes(begun.body?.householdId);
  const add = uuidBytes(begun.body?.addId);
  const nonce = fromB64(begun.body?.nonce);
  if (!household || !add || !nonce) return { refused: null };

  const publicKeys = (await keys.publicKeys()) ?? (await keys.create());
  const holderId = randomUUID();
  /** @type {import("./private-protocol.mjs").Device} */
  const device = { holder: /** @type {Uint8Array} */ (uuidBytes(holderId)), name, ...publicKeys };
  const value = newCheckValue();
  let signature;
  try {
    signature = await keys.withPresence(PROMPTS.enrol, async (presence) => presence.sign(holderRequest(household, add, nonce, device)));
  } catch {
    return { refused: "cancelled" };
  }
  const offered = await api.post(`/private/holder-requests/${begun.body.addId}/device`, {
    device: { holderId, name, agreementPublicKey: b64(device.agreementPublicKey), signingPublicKey: b64(device.signingPublicKey) },
    signature: b64(signature),
    commitment: b64(addCommitment(household, add, device, value)),
    platform: tokens.platform,
    keyProtection: tokens.keyProtection,
  });
  if (offered.status !== 200) return { refused: codeOf(offered.body) };
  return { enrolment: { addId: begun.body.addId, householdId: begun.body.householdId, holderId, device, value, challenge: null, check: null } };
}

/**
 * One look at the add (A2), and A2c when the phone's value has arrived: this computer reveals its
 * value then, once, and only for the first phone value it read. Returns what to show next.
 * @param {Api} api
 * @param {Enrolment} enrolment
 * @returns {Promise<{ show: "waiting" | "check" | "added" | "ended" | "mismatch", enrolment: Enrolment }>}
 */
export async function lookAtEnrolment(api, enrolment) {
  const read = await api.get(`/private/holder-requests/${enrolment.addId}`);
  if (read.status !== 200) return { show: "ended", enrolment };
  const now = read.body;
  if (now.state === "refused" || now.state === "expired") return { show: "ended", enrolment };
  // The keys on the request are this computer's, as offered: nothing the server says changes them.
  const device = now.device;
  if (!device || fromB64(device.agreementPublicKey) === null || !sameBytes(/** @type {Uint8Array} */ (fromB64(device.agreementPublicKey)), enrolment.device.agreementPublicKey)) {
    return { show: "mismatch", enrolment };
  }
  if (now.state === "approved") return { show: enrolment.check ? "added" : "mismatch", enrolment };

  const challenge = fromB64(now.challenge);
  if (!challenge) return { show: "waiting", enrolment };
  // The phone sends one value, once. Another one later is a server trying again.
  if (enrolment.challenge && !sameBytes(enrolment.challenge, challenge)) return { show: "mismatch", enrolment };

  let next = enrolment;
  if (!enrolment.challenge) {
    next = { ...enrolment, challenge };
    const revealed = await api.post(`/private/holder-requests/${enrolment.addId}/reveal`, { value: b64(enrolment.value) });
    if (revealed.status !== 200) return { show: "ended", enrolment: next };
  }
  const household = /** @type {Uint8Array} */ (uuidBytes(next.householdId));
  const add = /** @type {Uint8Array} */ (uuidBytes(next.addId));
  const check = addCheck(household, add, next.device, next.value, challenge);
  return { show: "check", enrolment: { ...next, check } };
}

/** What this computer remembers once its add is approved and its own first unlock has worked. */
export const holdingOf = (/** @type {Enrolment} */ e) => /** @type {Holding} */ ({ householdId: e.householdId, holderId: uuidText(e.device.holder) });
