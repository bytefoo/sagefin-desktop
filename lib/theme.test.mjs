import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// The home window carries a copy of the web app's design tokens, light and dark. The web app's
// stylesheet is not in this repository, so the values cannot be held to their source here; what can
// be held is that the two themes cover each other.

const desktop = readFileSync(path.join(import.meta.dirname, "..", "renderer", "home.css"), "utf8");

/** The custom properties declared in a block of CSS, comments dropped. */
function tokens(block) {
  const found = new Map();
  for (const match of block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1], match[2].trim().replace(/\s+/g, " "));
  }
  return found;
}

const light = tokens(desktop.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1] ?? "");
const dark = tokens(desktop.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/)?.[1] ?? "");

test("the dark theme overrides every colour the light one declares", () => {
  // An empty read would agree with anything.
  assert.ok(light.size >= 10, `only ${light.size} light tokens were read from home.css`);
  assert.deepEqual([...light.keys()].filter((t) => !t.startsWith("--type-") && !dark.has(t)), []);
});
