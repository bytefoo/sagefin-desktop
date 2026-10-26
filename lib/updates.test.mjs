// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { canSelfUpdate, checkAnswer, checkMenuItem, macRequirementUpdatable, mayRestartToUpdate, updateMenuItem } from "./updates.mjs";

// What `codesign -d -r-` prints for a release signed with SageFin's Developer ID, and for the
// ad-hoc signed copies earlier releases were.
const DEVELOPER_ID =
  'designated => identifier "app.sagefin.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = J66FLD86SU';
const AD_HOC = 'designated => cdhash H"0123456789abcdef0123456789abcdef01234567"';

test("the app updates itself on Windows, as a Linux AppImage, and on macOS when signed by SageFin's team", () => {
  assert.equal(canSelfUpdate({ platform: "win32", packaged: true, appImage: false }), true);
  assert.equal(canSelfUpdate({ platform: "linux", packaged: true, appImage: true }), true);
  // Unpacked or repackaged on Linux: no single file to swap.
  assert.equal(canSelfUpdate({ platform: "linux", packaged: true, appImage: false }), false);
  assert.equal(canSelfUpdate({ platform: "darwin", packaged: true, appImage: false, macRequirement: `Executable=/x\n${DEVELOPER_ID}\n` }), true);
  // Squirrel.Mac would refuse every update to an ad-hoc copy, and to one whose signature could not be read.
  assert.equal(canSelfUpdate({ platform: "darwin", packaged: true, appImage: false, macRequirement: AD_HOC }), false);
  assert.equal(canSelfUpdate({ platform: "darwin", packaged: true, appImage: false, macRequirement: null }), false);
  assert.equal(canSelfUpdate({ platform: "darwin", packaged: true, appImage: false }), false);
  // A development run has nothing installed to replace.
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.equal(canSelfUpdate({ platform, packaged: false, appImage: true, macRequirement: DEVELOPER_ID }), false);
  }
  assert.equal(canSelfUpdate({ platform: "freebsd", packaged: true, appImage: false }), false);
});

test("only SageFin's Developer ID requirement counts as one a later release can satisfy", () => {
  assert.equal(macRequirementUpdatable(DEVELOPER_ID), true);
  assert.equal(macRequirementUpdatable(DEVELOPER_ID.replace("J66FLD86SU", '"J66FLD86SU"')), true);
  assert.equal(macRequirementUpdatable(AD_HOC), false);
  assert.equal(macRequirementUpdatable(""), false);
  assert.equal(macRequirementUpdatable(undefined), false);
  // Another team, another app, or another kind of certificate.
  assert.equal(macRequirementUpdatable(DEVELOPER_ID.replace("J66FLD86SU", "ABCDE12345")), false);
  assert.equal(macRequirementUpdatable(DEVELOPER_ID.replace("J66FLD86SU", "J66FLD86SU1")), false);
  assert.equal(macRequirementUpdatable(DEVELOPER_ID.replace('"app.sagefin.desktop"', '"app.sagefin.desktop.keys"')), false);
  assert.equal(macRequirementUpdatable(DEVELOPER_ID.replace("100.6.1.13", "100.6.1.12")), false);
  assert.equal(macRequirementUpdatable(DEVELOPER_ID.replace("anchor apple generic", "anchor trusted")), false);
  // A requirement that also accepts a code hash is not one the team alone controls.
  assert.equal(macRequirementUpdatable(`${DEVELOPER_ID} or cdhash H"00"`), false);
  // Only the designated line counts.
  assert.equal(macRequirementUpdatable(`host => ${DEVELOPER_ID.slice("designated => ".length)}`), false);
});

test("it never restarts into an update during a sync", () => {
  assert.equal(mayRestartToUpdate({ downloaded: true, syncing: 0 }), true);
  assert.equal(mayRestartToUpdate({ downloaded: true, syncing: 1 }), false);
  assert.equal(mayRestartToUpdate({ downloaded: false, syncing: 0 }), false);
});

test("the tray says an update is ready, and why it is waiting when it is", () => {
  assert.equal(updateMenuItem({ version: null, syncing: 0 }), null);
  assert.deepEqual(updateMenuItem({ version: "0.1.12", syncing: 0 }), { label: "Restart to Update to 0.1.12", enabled: true });
  assert.deepEqual(updateMenuItem({ version: "0.1.12", syncing: 2 }), {
    label: "Update 0.1.12 installs after the sync",
    enabled: false,
  });
});

test("the tray offers a check only where one could lead to an update", () => {
  assert.deepEqual(checkMenuItem({ canUpdate: true, version: null, checking: false }), { label: "Check for Updates", enabled: true });
  // One at a time: a second click while the first is out would only ask twice.
  assert.deepEqual(checkMenuItem({ canUpdate: true, version: null, checking: true }), { label: "Checking for Updates…", enabled: false });
  // An update is already waiting: Restart to Update is the line to show.
  assert.equal(checkMenuItem({ canUpdate: true, version: "0.1.12", checking: false }), null);
  // A development run, or a Mac copy not signed by SageFin's team: looking would find something it cannot install.
  assert.equal(checkMenuItem({ canUpdate: false, version: null, checking: false }), null);
});

test("a check the member asked for is always answered", () => {
  assert.match(checkAnswer({ outcome: "current", running: "0.1.12" }).body, /0\.1\.12 is the newest/);
  assert.match(checkAnswer({ outcome: "found", running: "0.1.12", found: "0.1.13" }).title, /0\.1\.13 is downloading/);
  assert.match(checkAnswer({ outcome: "failed", running: "0.1.12" }).title, /Could not check/);
});
