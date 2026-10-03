import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_ACCOUNT_NAME, cleanAccountName, createAccountNames } from "./account-names.mjs";

function names(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "sagefin-desktop-names-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A stand-in seal that is at least not the plain text.
  const seal = (s) => Buffer.from(Buffer.from(s).toString("base64"));
  const open = (b) => Buffer.from(Buffer.from(b).toString(), "base64").toString();
  return { dir, store: createAccountNames({ dir, seal, open }) };
}

test("a name is kept tidy: trimmed, single-spaced, and no longer than SageFin takes", () => {
  assert.equal(cleanAccountName("  Derek's   Amazon \n"), "Derek's Amazon");
  assert.equal(cleanAccountName("x".repeat(200))?.length, MAX_ACCOUNT_NAME);
});

test("nothing, and anything that is not text, is no name", () => {
  for (const value of ["", "   ", null, undefined, 7, {}, ["Derek"]]) assert.equal(cleanAccountName(value), null, String(value));
});

test("a name is remembered per site and retailer, sealed", (t) => {
  const { dir, store } = names(t);

  assert.equal(store.set("prod", "amazon", " Derek's Amazon "), "Derek's Amazon");

  assert.equal(store.get("prod", "amazon"), "Derek's Amazon");
  assert.equal(store.get("test", "amazon"), null);
  assert.equal(store.get("prod", "walmart"), null);
  for (const file of readdirSync(dir)) {
    assert.ok(!readFileSync(path.join(dir, file), "utf8").includes("Derek"), `${file} holds the name in the clear`);
  }
});

test("giving nothing takes the name away, and leaves the others", (t) => {
  const { store } = names(t);
  store.set("prod", "amazon", "Derek's Amazon");
  store.set("test", "amazon", "Test account");

  assert.equal(store.set("prod", "amazon", "  "), null);

  assert.equal(store.get("prod", "amazon"), null);
  assert.equal(store.get("test", "amazon"), "Test account");
});

test("a file that cannot be read is no names, and a bad key is the caller's mistake", (t) => {
  const { dir, store } = names(t);
  writeFileSync(path.join(dir, "account-names.bin"), "garbage");

  assert.equal(store.get("prod", "amazon"), null);
  assert.throws(() => store.get("../x", "amazon"), /Not an account name key/);
  assert.throws(() => store.set("prod", "Amazon!", "x"), /Not an account name key/);
});
