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
 */

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
  return { secret: v.secret, tokenId: v.tokenId, name: v.name };
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

    /** @param {string} siteKey @param {Credential} credential */
    set(siteKey, credential) {
      const target = file(siteKey);
      writeFileSync(`${target}.partial`, seal(JSON.stringify(credential)), { mode: 0o600 });
      renameSync(`${target}.partial`, target);
    },

    /** @param {string} siteKey */
    clear(siteKey) {
      rmSync(file(siteKey), { force: true });
    },
  };
}
