// @ts-check
// What the member's other computers have already read, so this one does not read it again.
//
// Each copy of the app remembers which orders it has opened (lib/sync-plan.mjs). A second computer
// knew none of that, and read the same ninety days again: twenty order pages a run, each a request
// to the retailer for an order SageFin already held. So before a run opens anything it asks
// SageFin which of the orders listed in front of it another of the member's computers has read,
// and tells SageFin which this one has.
//
// What is sent is a key per order, never the order. A key is a SHA-256 over the retailer, the
// order number and the fingerprint the app builds from the orders list, so an order that changes
// at the retailer has a new key and is read again. SageFin keeps the keys and answers by equality.
// It is not a secret from SageFin, which holds the order numbers already, in the pages this app
// saves; the key keeps this path from carrying them in the clear, and from carrying anything else.
//
// With no answer the app opens what its own record says to, as it did before it could ask.

import { createHash } from "node:crypto";

/** The most keys asked about in one call. SageFin refuses more. */
export const MAX_ASKED = 500;
/** The most keys recorded in one call. SageFin refuses more. */
export const MAX_READ = 2000;
/** A sync does not wait on SageFin for longer than this. */
export const ANSWER_WITHIN_MS = 10_000;

/**
 * The key SageFin knows an order in one state by.
 * @param {string} retailer     The retailer's code.
 * @param {string} id           The order number.
 * @param {string} fingerprint  What the orders list showed of it (lib/retailers.mjs).
 */
export function orderKey(retailer, id, fingerprint) {
  return createHash("sha256").update(`${retailer}\n${id}\n${fingerprint}`).digest("hex");
}

/**
 * The keys of everything this computer has read, for SageFin to remember. The latest read when
 * there are more than one call carries: those are the ones another computer will be shown.
 * @param {string} retailer
 * @param {Record<string, string>} seen  Order number to the fingerprint it had when read.
 */
export function readKeys(retailer, seen) {
  return Object.entries(seen)
    .slice(-MAX_READ)
    .map(([id, fingerprint]) => orderKey(retailer, id, fingerprint));
}

/**
 * The listed orders this computer has not read in the state shown: the ones worth asking about.
 * @param {import("./retailers.mjs").ListedOrder[]} listed
 * @param {Record<string, string>} seen
 */
export function ordersToAskAbout(listed, seen) {
  return listed.filter((order) => seen[order.id] !== order.fingerprint).slice(0, MAX_ASKED);
}

/**
 * Tells SageFin what this computer has read and asks which of `asked` another has.
 *
 * Null is "no answer": offline, a SageFin from before it could be asked, a credential it no longer
 * takes, or an answer that is not a list. It is never "none of them".
 * @param {object} options
 * @param {string} options.site    The SageFin origin.
 * @param {string} options.secret  This computer's upload credential.
 * @param {string} options.retailer
 * @param {string[]} options.asked  Keys.
 * @param {string[]} options.read   Keys.
 * @param {typeof globalThis.fetch} options.fetch
 * @returns {Promise<Set<string> | null>}
 */
export async function shareRead({ site, secret, retailer, asked, read, fetch }) {
  let response;
  try {
    response = await fetch(`${site}/api/v1/retail/desktop/read-orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ retailer, asked, read }),
      signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
    });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;

  const body = await response.json().catch(() => null);
  if (!body || !Array.isArray(body.known)) return null;
  // Only what was asked about: an answer cannot mark an order read that this call did not name.
  const mine = new Set(asked);
  return new Set(body.known.filter((/** @type {unknown} */ k) => typeof k === "string" && mine.has(k)));
}

/**
 * Remembers, as read here, the listed orders SageFin says another computer has read in the state
 * shown. Returns how many.
 * @param {string} retailer
 * @param {import("./retailers.mjs").ListedOrder[]} listed
 * @param {Record<string, string>} seen  Changed in place.
 * @param {Set<string> | null} known     `shareRead`'s answer.
 */
export function adoptRead(retailer, listed, seen, known) {
  if (!known) return 0;
  let adopted = 0;
  for (const order of listed) {
    if (seen[order.id] === order.fingerprint) continue;
    if (!known.has(orderKey(retailer, order.id, order.fingerprint))) continue;
    seen[order.id] = order.fingerprint;
    adopted += 1;
  }
  return adopted;
}
