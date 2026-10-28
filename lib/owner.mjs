// @ts-check
// Whose memory this computer is keeping: which SageFin household, and which person.
//
// What a sync remembers (lib/sync-plan.mjs) and the pages waiting to be sent (lib/capture-store.mjs)
// belong to one household: the orders were read for it, and the pages are its purchases. The
// member's choices about a retailer's terms (lib/consent.mjs) belong to one person: they are that
// person's agreement with the retailer. Until this was kept, all three belonged to the computer, so
// a household deleted and made again on the same computer, or another person connecting it, was
// shown the last one's history, never got the orders the computer believed it had read, and would
// have been sent the last one's waiting pages.
//
// The app knows who it is connected as only from the credential the signed-in page hands it
// (lib/credential-store.mjs). SageFin binds the credential to one household and one person, and the
// page may say which (`householdId`, `userId`). Where it does not, the credential itself stands for
// both: a household or person known only by a credential cannot be told from another once the
// credential is replaced, so a new credential is treated as somebody new.
//
// No Electron here: `node --test` runs it bare.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Memory nobody has claimed: kept on a site this computer has never been connected to. */
export const NOBODY = "none";

/** @param {string} uuid */
const hex = (uuid) => uuid.toLowerCase().replace(/-/g, "");

/**
 * The household a credential is for, as a key: `h_` and its id when the page said, else `t_` and
 * the credential's own id.
 * @param {{ tokenId: string, householdId?: string | null }} credential
 */
export function householdKey(credential) {
  return credential.householdId ? `h_${hex(credential.householdId)}` : `t_${hex(credential.tokenId)}`;
}

/**
 * The person a credential is for, as a key: `u_` and their id when the page said, else `t_` and the
 * credential's own id.
 * @param {{ tokenId: string, userId?: string | null }} credential
 */
export function personKey(credential) {
  return credential.userId ? `u_${hex(credential.userId)}` : `t_${hex(credential.tokenId)}`;
}

/** Whether a string is a household key, or NOBODY. @param {unknown} key @returns {key is string} */
export const isHouseholdKey = (key) => typeof key === "string" && /^(?:[ht]_[0-9a-f]{32,36}|none)$/.test(key);

/** Whether a string is a person key, or NOBODY. @param {unknown} key @returns {key is string} */
export const isPersonKey = (key) => typeof key === "string" && /^(?:[ut]_[0-9a-f]{32,36}|none)$/.test(key);

/**
 * Whether memory kept under this key can ever be claimed again. A household or person known by its
 * own id can: the member moves back, or the other person connects again. One known only by a
 * credential cannot, because a credential that has been replaced never comes back.
 * @param {string} key
 */
export const canComeBack = (key) => key.startsWith("h_") || key.startsWith("u_");

/**
 * @typedef {object} Owner
 * @property {string} household  `householdKey`, or NOBODY.
 * @property {string} person     `personKey`, or NOBODY.
 */

/** @type {Owner} */
export const NO_OWNER = Object.freeze({ household: NOBODY, person: NOBODY });

/** @param {{ tokenId: string, householdId?: string | null, userId?: string | null }} credential @returns {Owner} */
export const ownerOf = (credential) => ({ household: householdKey(credential), person: personKey(credential) });

/**
 * @typedef {object} Settled
 * @property {Owner | null} owner  Whose memory the site's is now; null while nobody's is recorded.
 * @property {{ household: boolean, person: boolean }} adoptNobody
 *   Whether what was kept under NOBODY becomes the new owner's.
 * @property {{ household: string | null, person: string | null }} drop
 *   The last owner's keys, where their memory is to be let go because it can never be claimed.
 * @property {boolean} migrate
 *   Whether memory from before owners were kept is to be weighed (`legacyIsTheirs`).
 */

/**
 * What connecting as `current` does to the memory kept for `last`, on one site.
 *
 * - **Nobody recorded** (`last` null): the first owner of this site's memory. What was kept under
 *   NOBODY, saved before the computer was ever connected here, is theirs: no other household's
 *   memory can be on a site nobody has connected. Memory from before owners were kept is weighed,
 *   retailer by retailer (`legacyIsTheirs`).
 * - **Somebody else:** the new owner starts with nothing of theirs. The last one's memory is kept
 *   for when they come back, or let go when they cannot (`canComeBack`).
 * - **The same:** nothing changes.
 *
 * No credential is no change: the memory stays with whoever had it last, so a computer that lost its
 * connection does not hand the last household's memory to whoever connects next.
 * @param {Owner | null} last     Whose memory the site has, or null when nobody's has been recorded.
 * @param {Owner | null} current  Whose credential the computer holds now, or null for none.
 * @returns {Settled}
 */
export function settle(last, current) {
  if (!current) return { owner: last, adoptNobody: { household: false, person: false }, drop: { household: null, person: null }, migrate: false };
  if (!last) return { owner: current, adoptNobody: { household: true, person: true }, drop: { household: null, person: null }, migrate: true };
  /** @param {"household" | "person"} k */
  const drop = (k) => (last[k] !== current[k] && !canComeBack(last[k]) ? last[k] : null);
  return {
    owner: current,
    adoptNobody: { household: false, person: false },
    drop: { household: drop("household"), person: drop("person") },
    migrate: false,
  };
}

/**
 * Whether a retailer's sync memory from before owners were kept is the new owner's.
 *
 * Only when it can be shown. SageFin said it held what this computer read under exactly the
 * credential connected now (`readFor`, lib/read-orders.mjs), and SageFin binds that credential to one
 * household: so the memory was this household's. And no page from before is still waiting for that
 * retailer, because a waiting page cannot be shown to be anybody's: it may have been saved for a
 * household since deleted, whose credential is long gone. Memory kept without its waiting pages
 * would say orders were read that SageFin never got, so the two go together or not at all.
 *
 * Anything else belongs to nobody and is let go: the household starts that retailer fresh.
 * @param {{ readFor: string | null } | null} legacy  The old memory, or null when there is none.
 * @param {string} tokenId    The credential connected now.
 * @param {number} waiting    Pages from before owners were kept, for this site and retailer.
 */
export function legacyIsTheirs(legacy, tokenId, waiting) {
  return legacy !== null && legacy.readFor !== null && legacy.readFor === tokenId && waiting === 0;
}

/**
 * Carries out `settle` for one site, given the credential the computer holds now: records the new
 * owner, gives them what nobody had claimed, weighs memory from before owners were kept, and lets
 * go of what can never be claimed again.
 *
 * Nothing kept for another household is ever given to this one, and no page saved for another
 * household is ever left where this one's credential would send it (lib/uploader.mjs).
 *
 * @param {object} options
 * @param {string} options.siteKey
 * @param {string} options.siteOrigin  What captures are filed under (lib/capture-store.mjs).
 * @param {{ tokenId: string, householdId?: string | null, userId?: string | null } | null} options.credential
 * @param {string[]} options.retailers  The codes of every retailer the app keeps memory of.
 * @param {ReturnType<typeof createOwners>} options.owners
 * @param {Pick<ReturnType<typeof import("./sync-plan.mjs").createSyncStates>, "legacy" | "adoptLegacy" | "dropLegacy" | "move" | "forget">} options.syncStates
 * @param {Pick<ReturnType<typeof import("./capture-store.mjs").createCaptureStore>, "list" | "reassign" | "discard">} options.captures
 * @param {Pick<ReturnType<typeof import("./consent.mjs").createConsents>, "hasLegacy" | "adoptLegacy" | "dropLegacy" | "move" | "forget">} options.consents
 * @returns {{ owner: Owner, changed: boolean, discarded: number }}
 *   Whose memory the site's is now (NO_OWNER while nobody's is recorded), whether that changed, and
 *   how many waiting pages were let go because nobody who can connect owns them.
 */
export function takeOwnership({ siteKey, siteOrigin, credential, retailers, owners, syncStates, captures, consents }) {
  const last = owners.get(siteKey);
  const current = credential ? ownerOf(credential) : null;
  const plan = settle(last, current);
  if (!current || !plan.owner) return { owner: last ?? NO_OWNER, changed: false, discarded: 0 };

  let discarded = 0;
  /** @param {(r: import("./capture-store.mjs").CaptureRecord) => boolean} which */
  const discard = (which) => {
    discarded += captures.discard((r) => r.site === siteOrigin && which(r)).length;
  };

  if (plan.migrate) {
    let shown = false;
    for (const code of retailers) {
      const waiting = captures.list().filter((r) => r.site === siteOrigin && r.owner === undefined && r.retailer === code).length;
      if (legacyIsTheirs(syncStates.legacy(siteKey, code), /** @type {typeof credential & {}} */ (credential).tokenId, waiting)) {
        syncStates.adoptLegacy(siteKey, current.household, code);
        shown = true;
      } else {
        syncStates.dropLegacy(siteKey, code);
      }
    }
    // Every page from before is nobody's: where its retailer's memory was taken on, there were none.
    discard((r) => r.owner === undefined);
    // The choices from before go with the person shown to have synced under them, or are asked again.
    if (consents.hasLegacy()) {
      if (shown) consents.adoptLegacy(current.person);
      else consents.dropLegacy();
    }
  }
  if (plan.adoptNobody.household) {
    syncStates.move(siteKey, NOBODY, current.household);
    captures.reassign(siteOrigin, NOBODY, current.household);
  }
  if (plan.adoptNobody.person) consents.move(NOBODY, current.person);
  const goneHousehold = plan.drop.household;
  if (goneHousehold) {
    syncStates.forget(siteKey, goneHousehold);
    discard((r) => r.owner === goneHousehold);
  }
  if (plan.drop.person) consents.forget(plan.drop.person);

  owners.set(siteKey, current);
  return { owner: current, changed: !last || last.household !== current.household || last.person !== current.person, discarded };
}

/**
 * Whose memory each site's is now, sealed like everything else the app keeps: a household's id is
 * not a secret, but it is not the computer's to show either.
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {(plaintext: string) => Uint8Array} options.seal
 * @param {(sealed: Uint8Array) => string} options.open
 */
export function createOwners({ dir, seal, open }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "owners.bin");

  /** @returns {Record<string, Owner>} */
  const read = () => {
    try {
      const raw = JSON.parse(open(readFileSync(file)));
      /** @type {Record<string, Owner>} */
      const all = {};
      for (const [site, owner] of Object.entries(raw ?? {})) {
        if (/^[a-z]+$/.test(site) && isHouseholdKey(owner?.household) && isPersonKey(owner?.person)) {
          all[site] = { household: owner.household, person: owner.person };
        }
      }
      return all;
    } catch {
      // Missing or unreadable is "nobody recorded": the next credential is the first owner, and
      // what is kept from before is weighed as from before owners were kept.
      return {};
    }
  };

  return {
    /** @param {string} siteKey @returns {Owner | null} */
    get: (siteKey) => read()[siteKey] ?? null,

    /** @param {string} siteKey @param {Owner} owner */
    set(siteKey, owner) {
      if (!/^[a-z]+$/.test(siteKey) || !isHouseholdKey(owner.household) || !isPersonKey(owner.person)) throw new Error("Not an owner.");
      const all = read();
      all[siteKey] = { household: owner.household, person: owner.person };
      writeFileSync(`${file}.partial`, seal(JSON.stringify(all)), { mode: 0o600 });
      renameSync(`${file}.partial`, file);
    },
  };
}
