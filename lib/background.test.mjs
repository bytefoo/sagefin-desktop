// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_PREFERENCES, HIDDEN_ARG, asPreferences, canOpenAtLogin, closeAction, createPreferences, startsHidden } from "./background.mjs";

const dir = () => mkdtempSync(path.join(tmpdir(), "sagefin-prefs-"));

test("a first run keeps running in the background and does not start with the computer", () => {
  assert.deepEqual(createPreferences({ dir: dir() }).get(), { keepRunning: true, openAtLogin: false, toldAboutBackground: false });
});

test("a choice survives a restart, and changing one leaves the others", () => {
  const d = dir();
  createPreferences({ dir: d }).set({ openAtLogin: true });
  const again = createPreferences({ dir: d });
  assert.deepEqual(again.get(), { ...DEFAULT_PREFERENCES, openAtLogin: true });
  again.set({ keepRunning: false });
  assert.deepEqual(createPreferences({ dir: d }).get(), { keepRunning: false, openAtLogin: true, toldAboutBackground: false });
});

test("a file that is not preferences reads as the defaults, key by key", () => {
  const d = dir();
  writeFileSync(path.join(d, "preferences.json"), "not json");
  assert.deepEqual(createPreferences({ dir: d }).get(), DEFAULT_PREFERENCES);
  assert.deepEqual(asPreferences({ keepRunning: "no", openAtLogin: true, extra: 1 }), { ...DEFAULT_PREFERENCES, openAtLogin: true });
  assert.deepEqual(asPreferences(null), DEFAULT_PREFERENCES);
  // Nothing but the three keys is ever written back.
  createPreferences({ dir: d }).set({ openAtLogin: true });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(d, "preferences.json"), "utf8"))).sort(), [
    "keepRunning",
    "openAtLogin",
    "toldAboutBackground",
  ]);
});

test("closing the window hides it only when the member chose that and can get it back", () => {
  const on = { quitting: false, keepRunning: true };
  assert.equal(closeAction({ ...on, platform: "darwin", hasTray: false }), "hide"); // the Dock icon
  assert.equal(closeAction({ ...on, platform: "win32", hasTray: true }), "hide");
  // A Linux desktop with no tray: a hidden window could not be shown or quit.
  assert.equal(closeAction({ ...on, platform: "linux", hasTray: false }), "close");
  assert.equal(closeAction({ ...on, keepRunning: false, platform: "darwin", hasTray: true }), "close");
  // Quit means quit, whatever the setting.
  assert.equal(closeAction({ ...on, quitting: true, platform: "darwin", hasTray: true }), "close");
});

test("starting with the computer is offered only where it would start this app", () => {
  assert.equal(canOpenAtLogin({ platform: "darwin", packaged: true }), true);
  assert.equal(canOpenAtLogin({ platform: "win32", packaged: true }), true);
  assert.equal(canOpenAtLogin({ platform: "linux", packaged: true }), false);
  // A development run would register Electron itself.
  assert.equal(canOpenAtLogin({ platform: "darwin", packaged: false }), false);
});

test("the window stays away only when the computer started the app", () => {
  const mac = { platform: "darwin", hasTray: true };
  assert.equal(startsHidden({ ...mac, openedAtLogin: true, argv: [] }), true);
  assert.equal(startsHidden({ openedAtLogin: false, argv: ["app.exe", HIDDEN_ARG], platform: "win32", hasTray: true }), true);
  assert.equal(startsHidden({ ...mac, openedAtLogin: false, argv: ["app"] }), false);
  // Started at login with nowhere to bring the window back from: show it.
  assert.equal(startsHidden({ openedAtLogin: true, argv: [], platform: "win32", hasTray: false }), false);
});
