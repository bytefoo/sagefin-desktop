// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { canSelfUpdate, checkAnswer, checkMenuItem, mayRestartToUpdate, updateMenuItem } from "./updates.mjs";

test("the app updates itself on Windows and as a Linux AppImage, and nowhere else yet", () => {
  assert.equal(canSelfUpdate({ platform: "win32", packaged: true, appImage: false }), true);
  assert.equal(canSelfUpdate({ platform: "linux", packaged: true, appImage: true }), true);
  // Unpacked or repackaged on Linux: no single file to swap.
  assert.equal(canSelfUpdate({ platform: "linux", packaged: true, appImage: false }), false);
  // macOS refuses to update an app that is not signed with a Developer ID.
  assert.equal(canSelfUpdate({ platform: "darwin", packaged: true, appImage: false }), false);
  // A development run has nothing installed to replace.
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.equal(canSelfUpdate({ platform, packaged: false, appImage: true }), false);
  }
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
  // macOS, or a development run: looking would find something it cannot install.
  assert.equal(checkMenuItem({ canUpdate: false, version: null, checking: false }), null);
});

test("a check the member asked for is always answered", () => {
  assert.match(checkAnswer({ outcome: "current", running: "0.1.12" }).body, /0\.1\.12 is the newest/);
  assert.match(checkAnswer({ outcome: "found", running: "0.1.12", found: "0.1.13" }).title, /0\.1\.13 is downloading/);
  assert.match(checkAnswer({ outcome: "failed", running: "0.1.12" }).title, /Could not check/);
});
