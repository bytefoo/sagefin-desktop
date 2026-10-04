// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { belowMinimum, releaseVersion, runningVersion, versionLabel } from "./version.mjs";

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

test("a copy older than SageFin's minimum is below it, and one at or above it is not", () => {
  assert.equal(belowMinimum("0.1.32", "0.1.33"), true);
  assert.equal(belowMinimum("0.1.33", "0.1.33"), false);
  assert.equal(belowMinimum("0.1.44", "0.1.33"), false);
  // Compared as numbers: as text, "0.1.9" sorts after "0.1.33".
  assert.equal(belowMinimum("0.1.9", "0.1.33"), true);
  assert.equal(belowMinimum("0.2.0", "0.1.33"), false);
  assert.equal(belowMinimum("0.9.9", "1.0.0"), true);
});

test("a run from source is compared by the version it is marked with", () => {
  assert.equal(belowMinimum("0.1.46 (development)", "0.1.33"), false);
  assert.equal(belowMinimum("0.1.20 (development)", "0.1.33"), true);
});

// Stopping for a reason the app cannot read would be worse than the old copy carrying on.
test("a minimum that is missing or unreadable stops nothing", () => {
  for (const minimum of [null, undefined, "", "latest", "1.2", "1.2.3.4", "v0.1.33"]) assert.equal(belowMinimum("0.1.1", minimum), false, String(minimum));
  assert.equal(belowMinimum("unknown", "0.1.33"), false);
});
