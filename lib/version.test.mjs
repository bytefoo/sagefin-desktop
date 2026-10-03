// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseVersion, runningVersion, versionLabel } from "./version.mjs";

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

test("a release reports its own version, whatever else it is told", () => {
  assert.equal(runningVersion("0.1.33", true), "0.1.33");
  assert.equal(runningVersion("0.1.33", true, "12"), "0.1.33");
});

test("a run from source reports the version its commit would be released as, marked as development", () => {
  assert.equal(runningVersion("0.1.0", false, "35\n"), "0.1.35 (development)");
  assert.equal(runningVersion("0.1.0", false, 35), "0.1.35 (development)");
});

// No git, a shallow checkout, a source archive: the placeholder, still marked, never a bare "0.1.0".
test("where the commits cannot be counted, the placeholder is still marked", () => {
  for (const count of [undefined, "", "0", "abc"]) assert.equal(runningVersion("0.1.0", false, count), "0.1.0 (development)", String(count));
});

test("the label is the app's name and the running version", () => {
  assert.equal(versionLabel("0.1.22"), "SageFin Desktop 0.1.22");
  assert.equal(versionLabel("0.1.35 (development)"), "SageFin Desktop 0.1.35 (development)");
});
