// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseVersion, versionLabel } from "./version.mjs";

test("a release is package.json's major and minor with the commit count as the patch", () => {
  assert.equal(releaseVersion("0.1.0", "42"), "0.1.42");
  assert.equal(releaseVersion("0.1.0", 43), "0.1.43");
  // The patch in package.json is ignored, whatever it says.
  assert.equal(releaseVersion("2.3.99", "7\n"), "2.3.7");
});

test("it refuses a version or a count it cannot read, and never guesses", () => {
  for (const base of ["0.1", "v0.1.0", "0.1.0-beta", ""]) assert.throws(() => releaseVersion(base, "5"), base);
  // An empty count is what a shallow checkout or a failed git command looks like.
  for (const count of ["", undefined, "0", "abc", "1.5", "-3"]) assert.throws(() => releaseVersion("0.1.0", count), String(count));
});

test("the label names a release's version, and says when the app is run from source", () => {
  assert.equal(versionLabel("0.1.22", true), "SageFin Desktop 0.1.22");
  assert.equal(versionLabel("0.1.0", false), "SageFin Desktop 0.1.0 (development)");
});
