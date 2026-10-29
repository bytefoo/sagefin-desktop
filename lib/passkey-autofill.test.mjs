import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The preload cannot import, so the function lives there; this reads it out between its markers.
const source = readFileSync(new URL("../main/shell-preload.cjs", import.meta.url), "utf8");
const match = /\/\/ <passkey-autofill>\r?\n([\s\S]*?)\/\/ <\/passkey-autofill>/.exec(source);
assert.ok(match, "the markers are in main/shell-preload.cjs");
const patch = new Function(`${match[1]}; return patchPasskeyAutofill;`)();

const fake = () => {
  const PKC = function () {};
  PKC.isConditionalMediationAvailable = async () => true;
  PKC.getClientCapabilities = async () => ({ conditionalGet: true, conditionalCreate: true, userVerifyingPlatformAuthenticator: true });
  return PKC;
};

test("conditional mediation reads as unavailable, so the page keeps its own passkey button", async () => {
  const PKC = fake();
  patch(PKC);
  assert.equal(await PKC.isConditionalMediationAvailable(), false);
});

test("client capabilities say no conditionalGet and keep everything else", async () => {
  const PKC = fake();
  patch(PKC);
  assert.deepEqual(await PKC.getClientCapabilities(), {
    conditionalGet: false,
    conditionalCreate: true,
    userVerifyingPlatformAuthenticator: true,
  });
});

test("a browser without these methods is left without them, and nothing throws", () => {
  const PKC = function () {};
  patch(PKC);
  assert.equal("isConditionalMediationAvailable" in PKC, false);
  assert.equal("getClientCapabilities" in PKC, false);
  patch(undefined);
});

test("the preload runs it in the page's world and leaves isolation on", () => {
  assert.match(source, /webFrame\.executeJavaScript/);
  assert.doesNotMatch(source, /contextIsolation:\s*false/);
});
