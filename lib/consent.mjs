// @ts-check
// The member's choices about what the app may do at each retailer, and the gate they are.
//
// Which retailers the app saves pages from and syncs was decided in code, retailer by retailer, as
// each one's terms were read. But a retailer's terms are between the member and the retailer: the
// account that carries the risk is theirs, and so are the orders. So where the terms prohibit
// something the app can do, the app shows the member the words, quoted and dated
// (lib/retailers.mjs), and does it only if they say so. Until then it is off.
//
// Two rules that do not bend:
//
// - **A choice is about the terms as they were when it was made.** It is recorded with the date
//   the retailer says its terms were updated. When that date changes, the choice no longer counts
//   and is asked again.
// - **A choice changes whether the app acts, never how.** The pacing, the stop at the first
//   refusal, the agent marker, never answering a robot check: none of them reads a choice.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The two things a member chooses about. */
export const CONSENT_KINDS = /** @type {const} */ (["saving", "automation"]);
/** @typedef {"saving" | "automation"} ConsentKind */

/**
 * @typedef {object} Choice
 * @property {boolean} answer        Yes or no. A no is recorded too: it is an answer, not a blank.
 * @property {string} at             When it was given.
 * @property {string} termsUpdated   The retailer's terms as of this date, YYYY-MM-DD.
 */
/** @typedef {Partial<Record<ConsentKind, Choice>>} RetailerChoices */

/**
 * Whether the member has to choose before the app does this at this retailer.
 * @param {{ terms: import("./retailers.mjs").Terms }} retailer
 * @param {ConsentKind} kind
 */
export function needsChoice(retailer, kind) {
  return retailer.terms[kind] === "prohibited";
}

/**
 * The member's standing answer, or null: never asked, or asked about terms that have since changed.
 * Null is not no. A no is the member's; null is nobody's, and the screen asks.
 * @param {{ terms: import("./retailers.mjs").Terms }} retailer
 * @param {ConsentKind} kind
 * @param {RetailerChoices | undefined} choices
 * @returns {boolean | null}
 */
export function standingAnswer(retailer, kind, choices) {
  const choice = choices?.[kind];
  if (!choice || choice.termsUpdated !== retailer.terms.updated) return null;
  return choice.answer;
}

/**
 * Whether the app may do this at this retailer now. Within the terms: yes. Prohibited by them:
 * only on a standing yes.
 * @param {{ terms: import("./retailers.mjs").Terms }} retailer
 * @param {ConsentKind} kind
 * @param {RetailerChoices | undefined} choices
 */
export function allowed(retailer, kind, choices) {
  return !needsChoice(retailer, kind) || standingAnswer(retailer, kind, choices) === true;
}

/**
 * A sync saves the pages it opens, so it needs both: there is no syncing a retailer whose pages
 * the member has not agreed to save.
 * @param {{ terms: import("./retailers.mjs").Terms }} retailer
 * @param {RetailerChoices | undefined} choices
 */
export function maySync(retailer, choices) {
  return allowed(retailer, "saving", choices) && allowed(retailer, "automation", choices);
}

/** A choice read back from disk, or nothing for anything not shaped like one. @param {unknown} value @returns {Choice | undefined} */
function asChoice(value) {
  if (!value || typeof value !== "object") return undefined;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (typeof v.answer !== "boolean" || typeof v.at !== "string" || typeof v.termsUpdated !== "string") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.termsUpdated)) return undefined;
  return { answer: v.answer, at: v.at, termsUpdated: v.termsUpdated };
}

/**
 * The choices, sealed like everything else the app keeps, so they hold without a connection.
 * One file for the computer: a choice is about the retailer, not about which SageFin is showing.
 *
 * @param {object} options
 * @param {string} options.dir
 * @param {(plaintext: string) => Uint8Array} options.seal
 * @param {(sealed: Uint8Array) => string} options.open
 */
export function createConsents({ dir, seal, open }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "consent.bin");

  /** @returns {Record<string, RetailerChoices>} */
  const read = () => {
    try {
      const raw = JSON.parse(open(readFileSync(file)));
      /** @type {Record<string, RetailerChoices>} */
      const all = {};
      for (const [code, choices] of Object.entries(raw ?? {})) {
        if (!/^[a-z0-9-]+$/.test(code) || !choices || typeof choices !== "object") continue;
        /** @type {RetailerChoices} */
        const mine = {};
        for (const kind of CONSENT_KINDS) {
          const choice = asChoice(/** @type {Record<string, unknown>} */ (choices)[kind]);
          if (choice) mine[kind] = choice;
        }
        all[code] = mine;
      }
      return all;
    } catch {
      // Missing or unreadable is "never asked": everything that needs a choice is off, and asks.
      return {};
    }
  };

  return {
    /** @param {string} code @returns {RetailerChoices} */
    get: (code) => read()[code] ?? {},

    /**
     * Records an answer against the terms as they are now.
     * @param {{ code: string, terms: import("./retailers.mjs").Terms }} retailer
     * @param {ConsentKind} kind
     * @param {boolean} answer
     * @param {Date} [now]
     * @returns {Choice}
     */
    set(retailer, kind, answer, now = new Date()) {
      const all = read();
      const choice = { answer, at: now.toISOString(), termsUpdated: retailer.terms.updated };
      all[retailer.code] = { ...all[retailer.code], [kind]: choice };
      writeFileSync(`${file}.partial`, seal(JSON.stringify(all)), { mode: 0o600 });
      renameSync(`${file}.partial`, file);
      return choice;
    },
  };
}
