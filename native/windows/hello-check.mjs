// @ts-check
// The Windows helper with Windows Hello, checked by a person at the computer: three Windows Hello
// prompts, each to be approved. Run after native/windows/build.sh, on a Windows computer with a
// TPM and Windows Hello set up, at its own screen (not over Remote Desktop):
//
//   node native/windows/hello-check.mjs
//
// It talks to the helper exactly as main/key-store.mjs does, under the site name `selftest-hello`,
// so no real site's keys are touched, and deletes what it made at the end, whatever happened:
//
//   1. create          prompt 1: Windows Hello makes its key, and the TPM keys are made
//   2. approve         prompt 2: a new process, straight after; one agreement, one signature
//   3. approve again   prompt 3: the same keys open again, so the signature is the same each time
//
// What it cannot see is whether a prompt was shown; the person can. It does see how long each
// approval took, and a use that came back faster than a person can answer is reported as not
// prompted, which is the failure this exists to catch: Windows reuses the approval that made the
// key for the signature straight after it, and nothing may reuse it for a use.

import { spawn } from "node:child_process";
import { createECDH, createPublicKey, verify } from "node:crypto";
import path from "node:path";

const helper = path.join(import.meta.dirname, "build", "sagefin-keys.exe");
const SERVICE = "selftest-hello";
/** Faster than this, nobody looked at a prompt and answered it. */
const TOO_FAST_MS = 700;

let failed = 0;
/** @param {string} check @param {boolean} ok @param {string} [detail] */
const report = (check, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${check}${detail ? `: ${detail}` : ""}`);
};

/**
 * One helper process: each step is written once the previous one is answered, as the app does.
 * @param {string[]} args
 * @param {Record<string, unknown>[]} steps
 * @returns {Promise<{ answers: any[], ms: number[] }>}
 */
function conversation(args, steps) {
  return new Promise((resolve) => {
    const child = spawn(helper, args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    const answers = /** @type {any[]} */ ([]);
    const ms = /** @type {number[]} */ ([]);
    let buffered = "";
    let at = Date.now();
    const next = () => {
      const step = steps[answers.length];
      if (!step) return child.stdin.end();
      at = Date.now();
      child.stdin.write(JSON.stringify(step) + "\n");
    };
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const answer = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        ms.push(Date.now() - at);
        answers.push(answer);
        if (answer.error) child.stdin.end();
        else next();
      }
    });
    child.stdin.on("error", () => {});
    child.on("close", () => resolve({ answers, ms }));
    next();
  });
}

/** A public key in the helper's form (65 bytes, 0x04, X, Y) as a key node can verify with. */
const ecKey = (/** @type {Buffer} */ x963) =>
  createPublicKey({ key: { kty: "EC", crv: "P-256", x: x963.subarray(1, 33).toString("base64url"), y: x963.subarray(33).toString("base64url") }, format: "jwk" });

/** One approval: presence, then an agreement with a fresh peer, then a signature, each checked. */
async function approval(/** @type {string} */ label, /** @type {{ agreementPublicKey: string, signingPublicKey: string }} */ keys) {
  const peer = createECDH("prime256v1");
  const peerPublic = peer.generateKeys();
  const bytes = Buffer.from(`hello-check ${label} ${Date.now()}`);
  const { answers, ms } = await conversation([SERVICE, "--approve", "check SageFin Desktop's Windows key helper"], [
    { op: "presence" },
    { op: "agree", peer: peerPublic.toString("base64") },
    { op: "sign", bytes: bytes.toString("base64") },
  ]);
  const [presence, agreed, signed] = answers;
  report(`${label}: Windows Hello approved`, presence?.presence === true, presence?.error ?? `${ms[0]} ms`);
  if (presence?.presence) report(`${label}: Windows Hello asked (took longer than a person needs)`, ms[0] >= TOO_FAST_MS, `${ms[0]} ms`);
  const expected = peer.computeSecret(Buffer.from(keys.agreementPublicKey, "base64"));
  report(`${label}: the agreement matches`, !!agreed?.agreement && Buffer.from(agreed.agreement, "base64").equals(expected), agreed?.error ?? `${ms[1]} ms`);
  const signature = signed?.signature ? Buffer.from(signed.signature, "base64") : null;
  report(
    `${label}: the signature verifies`,
    !!signature && verify("sha256", bytes, { key: ecKey(Buffer.from(keys.signingPublicKey, "base64")), dsaEncoding: "ieee-p1363" }, signature),
    signed?.error ?? `${ms[2]} ms`,
  );
}

try {
  const probe = (await conversation([SERVICE], [{ op: "probe" }])).answers[0];
  report("the helper runs", !!probe && !probe.error, JSON.stringify(probe));
  if (probe?.remoteSession) throw new Error("This is a Remote Desktop session: run it at the computer.");
  if (!probe?.tpm || !probe?.windowsHello) throw new Error("This computer has no TPM or no Windows Hello.");

  await conversation([SERVICE], [{ op: "delete" }]);
  const before = (await conversation([SERVICE], [{ op: "public-keys" }])).answers[0];
  report("no keys before", !!before && !before.error && !before.agreementPublicKey, JSON.stringify(before));

  console.log("\nPrompt 1 of 3: Windows Hello, to make the key. Approve it.");
  const made = await conversation([SERVICE], [{ op: "create" }]);
  const keys = made.answers[0];
  report("create: two public keys", !!keys?.agreementPublicKey && !!keys?.signingPublicKey, keys?.error ?? `${made.ms[0]} ms`);
  if (!keys?.agreementPublicKey) throw new Error("Nothing was made.");

  const read = (await conversation([SERVICE], [{ op: "public-keys" }])).answers[0];
  report("public-keys reads the same keys back, without asking", read?.agreementPublicKey === keys.agreementPublicKey && read?.signingPublicKey === keys.signingPublicKey);

  console.log("\nPrompt 2 of 3: Windows Hello again, straight after making the key. Approve it.");
  await approval("first use, straight after create", keys);

  console.log("\nPrompt 3 of 3: Windows Hello once more. Approve it.");
  await approval("second use", keys);
} catch (e) {
  report("the check ran to the end", false, e instanceof Error ? e.message : String(e));
} finally {
  const deleted = (await conversation([SERVICE], [{ op: "delete" }])).answers[0];
  const after = (await conversation([SERVICE], [{ op: "public-keys" }])).answers[0];
  report("the test keys and the Windows Hello test key are deleted", deleted?.deleted === true && !!after && !after.agreementPublicKey);
}
console.log(failed === 0 ? "\nPassed." : `\n${failed} failed.`);
process.exitCode = failed === 0 ? 0 : 1;
