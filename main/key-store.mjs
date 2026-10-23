// @ts-check
// The two keys this computer holds for a private SageFin household, in its own security chip.
//
// On a Mac they are made in the Secure Enclave by a small helper, `native/macos/SageFinKeys.swift`,
// built and signed with the app, and they never leave it: the helper returns public keys, one raw
// agreement and one signature, and nothing else. Each use needs Touch ID or the login password,
// asked by macOS's own sheet, with the sentence this app passes from lib/private-mode.mjs's fixed
// list; one approval allows one agreement and one signature, and ends after thirty seconds.
//
// Windows and Linux have no helper. There this computer holds no key, and its window is unlocked
// by the member's phone as a browser's is. Windows is allowed by SageFin once a TPM key can be
// made to need Windows Hello for each use; that has not been shown yet.
//
// What does not live here: nothing reads the operating system's keychain for a household key, and
// `safeStorage` is never used for one. It protects a value from other people's accounts on this
// computer, not from a program running as the member, which is the difference between a lock on
// the key and a gate in front of it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

/** How long one approval may be used for, after the person approved it. */
const APPROVAL_LASTS_MS = 30_000;

/**
 * Where the helper is: a bundle in the app's Contents/Helpers when packaged (Resources is its
 * sibling), or what `native/macos/build.sh` built, from source. Only a signed build's helper can
 * use the keychain: one built from source without signing answers every request "keychain".
 */
function helperPath() {
  const program = path.join("SageFinKeys.app", "Contents", "MacOS", "sagefin-keys");
  return app.isPackaged
    ? path.join(process.resourcesPath, "..", "Helpers", program)
    : path.join(import.meta.dirname, "..", "native", "macos", "build", program);
}

/**
 * The key store for this computer, or one that says it holds no hardware keys.
 * @param {string} service  Names this site's keys, so test and production keys never mix.
 * @returns {import("../lib/private-mode.mjs").KeyStore & { hardwareKeys: boolean }}
 */
export function openKeyStore(service) {
  const helper = helperPath();
  if (process.platform !== "darwin" || !existsSync(helper)) return noKeys();

  /**
   * One request to the helper: a JSON line in, a JSON line out. The helper is started for each
   * request and exits after it, so nothing of an approval outlives the request that used it.
   * @param {Record<string, unknown>[]} steps
   * @returns {Promise<any[]>}
   */
  const run = (steps) =>
    new Promise((resolve, reject) => {
      const child = spawn(helper, [service], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => child.kill(), APPROVAL_LASTS_MS + 60_000);
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.stdin.on("error", () => {}); // The helper ended before reading; `close` answers it.
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const answers = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
          const failed = answers.find((a) => a.error);
          if (failed) reject(new Error(failed.error));
          // A helper that ended with no answer, or not cleanly, did not say "no keys": macOS may
          // have stopped it before it ran (a signature or entitlement it refused).
          else if (code !== 0 || answers.length === 0) reject(new Error("failed"));
          else resolve(answers);
        } catch {
          reject(new Error("failed"));
        }
      });
      child.stdin.end(steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    });

  const keysOf = (/** @type {any} */ a) => ({ agreementPublicKey: Buffer.from(a.agreementPublicKey, "base64"), signingPublicKey: Buffer.from(a.signingPublicKey, "base64") });

  return {
    hardwareKeys: true,
    async publicKeys() {
      const [answer] = await run([{ op: "public-keys" }]);
      return answer?.agreementPublicKey ? keysOf(answer) : null;
    },
    async create() {
      const [answer] = await run([{ op: "create" }]);
      return keysOf(answer);
    },
    /**
     * One approval over one helper process: the helper shows macOS's prompt with `prompt` and
     * answers nothing until the person approves it; then it takes one agreement and one signature,
     * in that order, and exits. The signature's bytes depend on what the agreement opened, which
     * is why the two are steps of one conversation rather than one request.
     * @template T
     * @param {string} prompt
     * @param {(session: import("../lib/private-mode.mjs").PresenceSession) => Promise<T>} use
     */
    async withPresence(prompt, use) {
      // A conversation over one helper process, kept open for one approval only.
      const child = spawn(helper, [service, "--approve", prompt], { stdio: ["pipe", "pipe", "ignore"] });
      const lines = /** @type {string[]} */ ([]);
      /** @type {((line: string) => void)[]} */
      const waiting = [];
      let buffered = "";
      child.stdout.on("data", (chunk) => {
        buffered += chunk;
        let at;
        while ((at = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          const next = waiting.shift();
          if (next) next(line);
          else lines.push(line);
        }
      });
      // A helper that cannot start, or ends without answering (killed, crashed, refused by macOS),
      // fails whatever is still waiting for it, so a request never stays open on a dead process.
      let gone = false;
      const end = () => {
        gone = true;
        for (const next of waiting.splice(0)) next("");
      };
      child.on("error", end);
      child.on("close", end);
      child.stdin.on("error", () => {}); // A write after the helper ended; `close` answers it.
      const ask = (/** @type {Record<string, unknown>} */ step) =>
        new Promise((resolve, reject) => {
          const take = (/** @type {string} */ line) => {
            let answer;
            try {
              answer = JSON.parse(line);
            } catch {
              return reject(new Error("failed"));
            }
            if (answer.error) reject(new Error(answer.error));
            else resolve(answer);
          };
          if (!gone) child.stdin.write(JSON.stringify(step) + "\n");
          const ready = lines.shift();
          if (ready !== undefined) take(ready);
          else if (gone) take("");
          else waiting.push(take);
        });
      const ended = setTimeout(() => child.kill(), APPROVAL_LASTS_MS);
      try {
        // The helper answers this only once the person has approved macOS's prompt.
        await ask({ op: "presence" });
        return await use({
          agree: async (peer) => Buffer.from(/** @type {any} */ (await ask({ op: "agree", peer: Buffer.from(peer).toString("base64") })).agreement, "base64"),
          sign: async (bytes) => Buffer.from(/** @type {any} */ (await ask({ op: "sign", bytes: Buffer.from(bytes).toString("base64") })).signature, "base64"),
        });
      } finally {
        clearTimeout(ended);
        child.stdin.end();
        child.kill();
      }
    },
  };
}

/** @returns {import("../lib/private-mode.mjs").KeyStore & { hardwareKeys: boolean }} */
function noKeys() {
  return {
    hardwareKeys: false,
    publicKeys: async () => null,
    create: async () => {
      throw new Error("This computer cannot hold a key.");
    },
    withPresence: async () => {
      throw new Error("This computer cannot hold a key.");
    },
  };
}
