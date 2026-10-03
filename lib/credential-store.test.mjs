import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { asCredential, createCredentialStore } from "./credential-store.mjs";

const seal = (plaintext) => Buffer.from(`sealed:${[...plaintext].reverse().join("")}`);
const open = (sealed) => [...Buffer.from(sealed).toString().slice("sealed:".length)].reverse().join("");

const GOOD = { secret: `sfin_${"a1".repeat(24)}`, tokenId: "0199a8b2-1c3d-7e4f-8a5b-6c7d8e9f0a1b", name: "SageFin Desktop (Mac)" };

function store(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-desktop-cred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, credentials: createCredentialStore({ dir, seal, open }) };
}

test("only a SageFin token, with its id and name, is a credential", () => {
  assert.deepEqual(asCredential({ ...GOOD, extra: "dropped" }), GOOD);

  for (const bad of [
    null,
    "sfin_abc",
    {},
    { ...GOOD, secret: "password123" },
    { ...GOOD, secret: "sfin_short" },
    { ...GOOD, secret: `sfmcp_${"a1".repeat(24)}` },
    { ...GOOD, tokenId: "not-a-guid" },
    { ...GOOD, name: "" },
    { ...GOOD, name: 7 },
  ]) {
    assert.equal(asCredential(bad), null, JSON.stringify(bad));
  }
});

test("a credential comes back as it was stored, and is not on disk in the clear", (t) => {
  const { dir, credentials } = store(t);

  credentials.set("prod", GOOD);

  assert.deepEqual(credentials.get("prod"), GOOD);
  const [file] = readdirSync(dir);
  assert.ok(!readFileSync(path.join(dir, file), "utf8").includes(GOOD.secret));
  if (process.platform !== "win32") assert.equal(statSync(path.join(dir, file)).mode & 0o077, 0);
});

// A test credential cannot post to production, because it is filed under test.
test("each site has its own credential", (t) => {
  const { credentials } = store(t);
  const other = { ...GOOD, secret: `sfin_${"b2".repeat(24)}` };

  credentials.set("prod", GOOD);
  credentials.set("test", other);

  assert.deepEqual(credentials.get("prod"), GOOD);
  assert.deepEqual(credentials.get("test"), other);
  assert.equal(credentials.get("local"), null);

  credentials.clear("prod");
  assert.equal(credentials.get("prod"), null);
  assert.deepEqual(credentials.get("test"), other);
});

test("a credential that cannot be opened or read is no credential", (t) => {
  const { dir, credentials } = store(t);

  writeFileSync(path.join(dir, "credential-prod.bin"), "not sealed by us");
  assert.equal(credentials.get("prod"), null);

  writeFileSync(path.join(dir, "credential-test.bin"), seal(JSON.stringify({ secret: "nope" })));
  assert.equal(credentials.get("test"), null);
});

test("a site key cannot name another file", (t) => {
  const { credentials } = store(t);
  for (const key of ["../x", "prod/../../x", "", "PROD", "a.b"]) {
    assert.throws(() => credentials.set(key, GOOD), /Not a site key/, key);
  }
});
