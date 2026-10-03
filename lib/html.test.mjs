import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_CAPTURE_BYTES, stripHtml } from "./html.mjs";

test("a page loses its scripts, styles, inline images, noscript blocks and comments, and keeps its markup", () => {
  const page = `<html><head><script>var a = "<div>";</script><style>.x{}</style></head>
<body><!-- note --><svg><path d="M0"/></svg><noscript>enable js</noscript>
<div class="order"><span>Order # 111-0000001-0000001</span><SCRIPT type="x">y</SCRIPT></div></body></html>`;

  const stripped = stripHtml(page);

  for (const gone of ["<script", "<SCRIPT", "<style", "<svg", "<noscript", "<!--", "enable js", "var a"]) {
    assert.ok(!stripped.includes(gone), gone);
  }
  assert.match(stripped, /<div class="order"><span>Order # 111-0000001-0000001<\/span><\/div><\/body><\/html>$/);
});

// SageFin's Amazon parser was proved against pages stripped by exactly these five patterns. The
// server's source is not in this repository, so the patterns are pinned here: changing one is a
// change to what the server is sent, and has to be made on both sides.
test("it strips with the five patterns the server's parser was proved against", () => {
  const ours = readFileSync(new URL("./html.mjs", import.meta.url), "utf8");
  const patterns = ours.match(/\.replace\(\/[^\n]+/g) ?? [];
  assert.deepEqual(patterns.map((p) => p.trim()), [
    '.replace(/<script\\b[\\s\\S]*?<\\/script>/gi, "")',
    '.replace(/<style\\b[\\s\\S]*?<\\/style>/gi, "")',
    '.replace(/<svg\\b[\\s\\S]*?<\\/svg>/gi, "")',
    '.replace(/<noscript\\b[\\s\\S]*?<\\/noscript>/gi, "")',
    '.replace(/<!--[\\s\\S]*?-->/g, "");',
  ]);
});

// The server refuses a larger payload. Its limit is not readable from here, so it is pinned.
test("nothing is sent that SageFin would refuse", () => {
  assert.equal(MAX_CAPTURE_BYTES, 4 * 1024 * 1024);
});
