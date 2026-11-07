// @ts-check
// The app's SageFin credential: an upload-only token the signed-in web page minted and handed
// over, as the browser extension's is. It can post saved pages and read nothing back.
//
// One per site, sealed like the captures. The token is only ever used against the site that
// minted it: a test credential cannot post to production, because it is filed under test.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * @typedef {object} Credential
 * @property {string} secret   The token itself.
 * @property {string} tokenId  Its id at SageFin, for revoking it.
 * @property {string} name     What Settings → Integrations calls it.
 * @property {string | null} [householdId]
 *   The household SageFin bound it to, when the page said. Which household this computer's memory
 *   belongs to (lib/owner.mjs); with none, the credential itself stands for the household.
 * @property {string | null} [userId]
 *   The person SageFin bound it to, when the page said. Whose choices about retailers' terms apply.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A credential as the page handed it over, or null for anything not shaped like one.
 *
 * The page is SageFin's own, and the bridge has already checked that. This still refuses anything
 * that is not a SageFin token, so a mistake on the page cannot file an arbitrary string as one.
 * @param {unknown} value
 * @returns {Credential | null}
 */
export function asCredential(value) {
  if (!value || typeof value !== "object") return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.secret !== "string" || !/^sfin_[0-9a-f]{32,128}$/.test(v.secret)) return null;
  if (typeof v.tokenId !== "string" || !/^[0-9a-f-]{36}$/i.test(v.tokenId)) return null;
  if (typeof v.name !== "string" || v.name.length === 0 || v.name.length > 200) return null;
  /** @type {Credential} */
  const credential = { secret: v.secret, tokenId: v.tokenId, name: v.name };
  // Optional, and only as ids: anything else is as if the page had not said, and the credential
  // stands for the household and the person (lib/owner.mjs). Never a reason to refuse the token.
  if (typeof v.householdId === "string" && UUID.test(v.householdId)) credential.householdId = v.householdId.toLowerCase();
  if (typeof v.userId === "string" && UUID.test(v.userId)) credential.userId = v.userId.toLowerCase();
  return credential;
}

/**
 * @typedef {object} LostConnection
 * @property {string} tokenId  The credential SageFin stopped accepting. Not a secret: Settings lists it.
 * @property {string} at       ISO 8601: when this computer was told.
 */

/**
 * A lost connection as kept on disk, or null for anything not shaped like one.
 * @param {unknown} value
 * @returns {LostConnection | null}
 */
export function asLostConnection(value) {
  if (!value || typeof value !== "object") return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.tokenId !== "string" || !/^[0-9a-f-]{36}$/i.test(v.tokenId)) return null;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return { tokenId: v.tokenId, at: v.at };
}

/**
 * @param {object} options
 * @param {string} options.dir
 * @param {(plaintext: string) => Uint8Array} options.seal
 * @param {(sealed: Uint8Array) => string} options.open
 */
export function createCredentialStore({ dir, seal, open }) {
  mkdirSync(dir, { recursive: true });

  /** @param {string} siteKey */
  const file = (siteKey) => {
    if (!/^[a-z]+$/.test(siteKey)) throw new Error("Not a site key.");
    return path.join(dir, `credential-${siteKey}.bin`);
  };
  /** Which credential SageFin stopped accepting, kept until another replaces it. @param {string} siteKey */
  const lostFile = (siteKey) => {
    file(siteKey);
    return path.join(dir, `lost-${siteKey}.bin`);
  };

  return {
    /**
     * The credential for a site, or null when there is none — or when what is there cannot be
     * opened or read, which is treated as none so the member is asked to connect again.
     * @param {string} siteKey
     * @returns {Credential | null}
     */
    get(siteKey) {
      try {
        return asCredential(JSON.parse(open(readFileSync(file(siteKey)))));
      } catch {
        return null;
      }
    },

    /**
     * Keeps a credential. A connection lost earlier is over: this is the one that replaced it.
     * @param {string} siteKey @param {Credential} credential
     */
    set(siteKey, credential) {
      const target = file(siteKey);
      writeFileSync(`${target}.partial`, seal(JSON.stringify(credential)), { mode: 0o600 });
      renameSync(`${target}.partial`, target);
      rmSync(lostFile(siteKey), { force: true });
    },

    /**
     * Lets go of the credential because the member disconnected this computer. Nothing is kept of
     * it, not even that it was lost: there is nothing for the page to connect again by itself.
     * @param {string} siteKey
     */
    clear(siteKey) {
      rmSync(file(siteKey), { force: true });
      rmSync(lostFile(siteKey), { force: true });
    },

    /**
     * Lets go of the credential because SageFin stopped accepting it, and remembers which one that
     * was, so the signed-in page can ask SageFin for its successor (`lost`). Only the credential
     * named: one connected while the refused request was on its way is not the one refused, and is
     * kept. Null when the credential held is not that one, or there is none.
     * @param {string} siteKey
     * @param {string} tokenId  The credential the refused request carried.
     * @param {string} at       ISO 8601: now.
     * @returns {LostConnection | null}
     */
    drop(siteKey, tokenId, at) {
      const credentialFile = file(siteKey);
      const target = lostFile(siteKey);
      let held;
      try {
        held = asCredential(JSON.parse(open(readFileSync(credentialFile))));
      } catch {
        held = null;
      }
      if (!held || held.tokenId !== tokenId) return null;
      /** @type {LostConnection} */
      const lost = { tokenId, at };
      writeFileSync(`${target}.partial`, seal(JSON.stringify(lost)), { mode: 0o600 });
      renameSync(`${target}.partial`, target);
      rmSync(credentialFile, { force: true });
      return lost;
    },

    /**
     * The connection SageFin last stopped accepting for a site, while none has replaced it; null
     * otherwise, or when what is there cannot be read.
     * @param {string} siteKey
     * @returns {LostConnection | null}
     */
    lost(siteKey) {
      try {
        return asLostConnection(JSON.parse(open(readFileSync(lostFile(siteKey)))));
      } catch {
        return null;
      }
    },
  };
}
