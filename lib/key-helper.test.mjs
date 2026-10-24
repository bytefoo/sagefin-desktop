import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { helperPath, presenceName } from "./key-helper.mjs";

const where = { packaged: true, resourcesPath: path.join("App", "resources"), sourceRoot: "src" };

test("a Mac's helper is the bundle in Contents/Helpers, or what build.sh built", () => {
  assert.equal(helperPath({ ...where, platform: "darwin" }), path.join("App", "Helpers", "SageFinKeys.app", "Contents", "MacOS", "sagefin-keys"));
  assert.equal(helperPath({ ...where, platform: "darwin", packaged: false }), path.join("src", "native", "macos", "build", "SageFinKeys.app", "Contents", "MacOS", "sagefin-keys"));
});

test("Windows' helper is the program in resources, or what build.sh built", () => {
  assert.equal(helperPath({ ...where, platform: "win32" }), path.join("App", "resources", "sagefin-keys.exe"));
  assert.equal(helperPath({ ...where, platform: "win32", packaged: false }), path.join("src", "native", "windows", "build", "sagefin-keys.exe"));
});

test("Linux, and anything else, has no helper and holds no key", () => {
  assert.equal(helperPath({ ...where, platform: "linux" }), null);
  assert.equal(helperPath({ ...where, platform: "freebsd" }), null);
});

test("the prompt is named as the system names it", () => {
  assert.equal(presenceName("darwin"), "Touch ID");
  assert.equal(presenceName("win32"), "Windows Hello");
});
