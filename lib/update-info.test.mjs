// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { restampUpdateInfo } from "./update-info.mjs";

// The shape electron-builder writes for macOS: the zip first, which the updater downloads, then
// the disk image, which people download.
const manifest = [
  "version: 0.1.40",
  "files:",
  "  - url: SageFin-Desktop-mac-arm64.zip",
  "    sha512: ZIPHASH==",
  "    size: 100",
  "  - url: SageFin-Desktop-mac-arm64.dmg",
  "    sha512: OLDHASH==",
  "    size: 200",
  "path: SageFin-Desktop-mac-arm64.zip",
  "sha512: ZIPHASH==",
  "releaseDate: '2026-10-23T12:00:00.000Z'",
  "",
].join("\n");

test("the disk image's entry gets its new hash and size, and nothing else changes", () => {
  const out = restampUpdateInfo(manifest, "SageFin-Desktop-mac-arm64.dmg", "NEWHASH==", 201);
  assert.equal(out, manifest.replace("    sha512: OLDHASH==\n    size: 200", "    sha512: NEWHASH==\n    size: 201"));
});

test("the file the manifest names as its path also gets the top-level hash", () => {
  const out = restampUpdateInfo(manifest, "SageFin-Desktop-mac-arm64.zip", "NEWZIP==", 101);
  assert.match(out, /^ {2}- url: SageFin-Desktop-mac-arm64\.zip\n {4}sha512: NEWZIP==\n {4}size: 101$/m);
  assert.match(out, /^sha512: NEWZIP==$/m);
  assert.match(out, /^ {4}sha512: OLDHASH==$/m);
});

test("a file the manifest does not list, or lists without a hash, stops the release", () => {
  assert.throws(() => restampUpdateInfo(manifest, "SageFin-Desktop-mac-x64.dmg", "X", 1), /does not list/);
  // A name that only starts like a listed one is a different file.
  assert.throws(() => restampUpdateInfo(manifest, "SageFin-Desktop-mac-arm64.dm", "X", 1), /does not list/);
  const noSize = manifest.replace("    size: 200\n", "");
  assert.throws(() => restampUpdateInfo(noSize, "SageFin-Desktop-mac-arm64.dmg", "X", 1), /no sha512 or size/);
});
