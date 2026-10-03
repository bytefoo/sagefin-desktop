// @ts-check
// What the member calls the account they are signed in to at a retailer, on this computer.
//
// Some retailers' pages say whose account they are, and SageFin reads that from the page. Amazon's,
// as this app saves them, do not. A member with two computers signed in to two Amazon accounts
// would have their orders mixed together and one daily sync between them, with nothing to tell the
// accounts apart. So where the page does not say, the member may: a name typed once per computer
// ("Derek's Amazon"), sent with the check-in. Two computers given the same name are one account.
//
// It is a label the member chose, never read from a page and never checked against one.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The longest name kept. SageFin's own limit; a longer one is cut, not refused. */
export const MAX_ACCOUNT_NAME = 64;

/**
 * A name as it is kept: trimmed, with runs of white space made one space, cut to the limit. Null
 * for anything that is not text or has nothing in it, which is how a name is taken away.
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanAccountName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_ACCOUNT_NAME).trim();
  return name || null;
}

/**
 * The names, sealed like everything else the app keeps. One per site and retailer, so a name given
 * while looking at the test site is not taken as given for production.
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {(plaintext: string) => Uint8Array} options.seal
 * @param {(sealed: Uint8Array) => string} options.open
 */
export function createAccountNames({ dir, seal, open }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "account-names.bin");

  /** @returns {Record<string, string>} */
  const read = () => {
    try {
      const raw = JSON.parse(open(readFileSync(file)));
      /** @type {Record<string, string>} */
      const all = {};
      for (const [key, value] of Object.entries(raw ?? {})) {
        const name = cleanAccountName(value);
        if (/^[a-z]+:[a-z0-9-]+$/.test(key) && name) all[key] = name;
      }
      return all;
    } catch {
      // Missing or unreadable is "never named".
      return {};
    }
  };

  /** @param {string} siteKey @param {string} retailer */
  const keyOf = (siteKey, retailer) => {
    if (!/^[a-z]+$/.test(siteKey) || !/^[a-z0-9-]+$/.test(retailer)) throw new Error("Not an account name key.");
    return `${siteKey}:${retailer}`;
  };

  return {
    /** @param {string} siteKey @param {string} retailer @returns {string | null} */
    get: (siteKey, retailer) => read()[keyOf(siteKey, retailer)] ?? null,

    /**
     * Keeps a name, or takes it away when given nothing.
     * @param {string} siteKey @param {string} retailer @param {unknown} value
     * @returns {string | null}  The name as kept.
     */
    set(siteKey, retailer, value) {
      const key = keyOf(siteKey, retailer);
      const all = read();
      const name = cleanAccountName(value);
      if (name) all[key] = name;
      else delete all[key];
      writeFileSync(`${file}.partial`, seal(JSON.stringify(all)), { mode: 0o600 });
      renameSync(`${file}.partial`, file);
      return name;
    },
  };
}
