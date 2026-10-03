// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { allowed, createConsents, maySync, needsChoice, standingAnswer } from "./consent.mjs";
import { RETAILERS, amazon, walmart } from "./retailers.mjs";

const seal = (/** @type {string} */ plaintext) => Buffer.from(`sealed:${plaintext}`);
const open = (/** @type {Uint8Array} */ sealed) => Buffer.from(sealed).toString().slice("sealed:".length);
const fresh = () => createConsents({ dir: mkdtempSync(path.join(tmpdir(), "sagefin-consent-")), seal, open });

test("every retailer says what its terms say, quoted and dated", () => {
  for (const r of RETAILERS) {
    assert.match(r.terms.url, /^https:\/\//, r.code);
    assert.match(r.terms.updated, /^\d{4}-\d{2}-\d{2}$/, r.code);
    assert.match(r.terms.read, /^\d{4}-\d{2}-\d{2}$/, r.code);
    assert.ok(r.terms.quotes.length > 0 && r.terms.quotes.every((q) => q.length > 20), r.code);
    // Something within the terms on conditions says what they are; nothing prohibited claims to be.
    const within = r.terms.saving === "within_terms" || r.terms.automation === "within_terms";
    assert.equal(Boolean(r.terms.withinTermsBecause), within, r.code);
  }
});

test("Walmart's terms prohibit both things the app does there, and Amazon's allow both on conditions", () => {
  assert.equal(needsChoice(walmart, "saving"), true);
  assert.equal(needsChoice(walmart, "automation"), true);
  assert.equal(needsChoice(amazon, "saving"), false);
  assert.equal(needsChoice(amazon, "automation"), false);
});

test("what the terms prohibit is off until the member says yes, and a no is an answer", () => {
  const consents = fresh();
  assert.equal(allowed(walmart, "saving", consents.get("walmart")), false);
  assert.equal(standingAnswer(walmart, "saving", consents.get("walmart")), null);
  assert.equal(maySync(walmart, consents.get("walmart")), false);
  // Within the terms: nothing to accept.
  assert.equal(maySync(amazon, consents.get("amazon")), true);

  consents.set(walmart, "saving", true);
  assert.equal(allowed(walmart, "saving", consents.get("walmart")), true);
  // Saving alone is not a sync: that is its own choice.
  assert.equal(maySync(walmart, consents.get("walmart")), false);
  consents.set(walmart, "automation", true);
  assert.equal(maySync(walmart, consents.get("walmart")), true);

  consents.set(walmart, "automation", false);
  assert.equal(standingAnswer(walmart, "automation", consents.get("walmart")), false);
  assert.equal(maySync(walmart, consents.get("walmart")), false);
  // One retailer's answer is not another's.
  assert.deepEqual(consents.get("amazon"), {});
});

test("a sync needs the pages saved, so turning saving off turns syncing off", () => {
  const consents = fresh();
  consents.set(walmart, "saving", true);
  consents.set(walmart, "automation", true);
  consents.set(walmart, "saving", false);
  assert.equal(maySync(walmart, consents.get("walmart")), false);
});

test("a choice is about the terms as they were: when their date changes it is asked again", () => {
  const consents = fresh();
  const choice = consents.set(walmart, "automation", true, new Date("2026-10-03T12:00:00Z"));
  assert.deepEqual(choice, { answer: true, at: "2026-10-03T12:00:00.000Z", termsUpdated: walmart.terms.updated });

  const revised = { ...walmart, terms: { ...walmart.terms, updated: "2027-01-15" } };
  assert.equal(standingAnswer(revised, "automation", consents.get("walmart")), null);
  assert.equal(allowed(revised, "automation", consents.get("walmart")), false);
  // A no does not carry over either: it was a no to the old words.
  consents.set(walmart, "saving", false);
  assert.equal(standingAnswer(revised, "saving", consents.get("walmart")), null);
});

test("what is on disk and not a choice is no choice", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-consent-"));
  const junk = createConsents({ dir, seal: () => Buffer.from("sealed:" + JSON.stringify({ walmart: { saving: { answer: "yes" }, automation: true }, "../x": {} })), open });
  junk.set({ code: "amazon", terms: amazon.terms }, "saving", true);
  const back = createConsents({ dir, seal, open });
  assert.deepEqual(back.get("walmart"), {});
  assert.equal(allowed(walmart, "saving", back.get("walmart")), false);
});

// A choice changes whether the app acts, never how. The pacing, the limits, the agent marker and
// the stop at a refusal live in files that do not know a choice exists, and this holds them there.
test("how a sync behaves does not read the member's choice", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["sync-plan.mjs", "retailers.mjs", "uploader.mjs", "html.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "\.\/consent\.mjs"|standingAnswer|maySync|allowed\(/, file);
  }
  const plan = await import("./sync-plan.mjs");
  assert.equal(plan.PAUSE_BETWEEN_ORDERS_MS, 5_000);
  assert.equal(plan.MAX_ORDERS_PER_RUN, 20);
  assert.equal(plan.MAX_LIST_PAGES_PER_RUN, 10);
  assert.equal(amazon.agent, "SageFinDesktop");
  assert.equal(walmart.agent, undefined);
});
