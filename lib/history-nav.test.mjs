import test from "node:test";
import assert from "node:assert/strict";
import { accelerators, canGo, fromAppCommand, fromSwipe } from "./history-nav.mjs";

test("macOS uses Cmd+[ and Cmd+]; the others use Alt with the arrows", () => {
  assert.deepEqual(accelerators("darwin"), { back: "Cmd+[", forward: "Cmd+]" });
  assert.deepEqual(accelerators("win32"), { back: "Alt+Left", forward: "Alt+Right" });
  assert.deepEqual(accelerators("linux"), { back: "Alt+Left", forward: "Alt+Right" });
});

test("only the browser app commands navigate", () => {
  assert.equal(fromAppCommand("browser-backward"), "back");
  assert.equal(fromAppCommand("browser-forward"), "forward");
  for (const other of ["browser-home", "browser-refresh", "volume-up", "media-play", "", undefined, null, 3]) {
    assert.equal(fromAppCommand(other), null);
  }
});

test("a horizontal swipe navigates and a vertical one does not", () => {
  assert.equal(fromSwipe("left"), "back");
  assert.equal(fromSwipe("right"), "forward");
  for (const other of ["up", "down", "", undefined, null]) assert.equal(fromSwipe(other), null);
});

test("a direction is available only when the history can go that way", () => {
  const history = { canGoBack: () => true, canGoForward: () => false };
  assert.equal(canGo(history, "back"), true);
  assert.equal(canGo(history, "forward"), false);
  assert.equal(canGo(null, "back"), false);
  assert.equal(canGo(undefined, "forward"), false);
});
