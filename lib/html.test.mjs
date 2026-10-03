import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_CAPTURE_BYTES, stripByPatterns, stripHtml } from "./html.mjs";

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

// The patterns say what is removed; the app runs something faster. These are the pages where the
// two could most easily part: blocks inside blocks, a block that only appears once another is gone,
// openings with no end, ends with no opening, and tags in either case. `npm run fuzz` holds the
// same thing over generated pages.
test("what the app runs removes exactly what the five patterns do", () => {
  const pages = [
    "",
    "no markup at all",
    "<script>a</script>b<SCRIPT x>c</ScRiPt>d",
    "<style> <script> </style> kept? </script> after",
    "<sty<script></script>le>.x{}</style>after",
    "<!-<!---->- one --> two",
    "<!--> not a whole comment",
    "<!----> an empty one",
    "<script>never closed <style>a</style> <!-- c --> <svg></svg>",
    "</script><script><script>",
    "<scripts>not a script</scripts><script>is</script>",
    "<script",
    "<script></script",
    "<svg><svg></svg></svg>",
    "<noscript><!-- </noscript> -->x",
    "<!-- <script> --> a </script> b",
    "<\u017Fcript>long s is not s</\u017Fcript><script>\u212A</script>",
    "<script>a</script><script>b</script><script>c",
    "<svg>a</SVG>b<NoScript>c</NOSCRIPT>d<STYLE>e</style>f",
    "<noscripts>not one</noscript><styles>nor this</style><svgs>nor this</svg>",
    "<style> <!-- </style> --> <svg> </svg>",
  ];
  for (const page of pages) assert.equal(stripHtml(page), stripByPatterns(page), JSON.stringify(page));
});

// Written as the patterns, each opening with no end is read to the end of the page: 250 KiB of
// them took over a second, and the time went up with the square of the size. Half a megabyte is
// enough to tell the two apart, a few milliseconds from most of a minute, without a failing run
// taking the minutes a full-sized page would.
test("a page of blocks that never close is stripped in the time it takes to read it", () => {
  const started = performance.now();
  for (const opening of ["<script ", "<style ", "<svg ", "<noscript ", "<!-- "]) {
    const page = opening.repeat(Math.ceil((512 * 1024) / opening.length));
    assert.equal(stripHtml(page), page);
    // One end, before every opening, so "is there an end anywhere" would not have been enough.
    const closed = `${opening.trim() === "<!--" ? "-->" : `</${opening.trim().slice(1)}>`}${page}`;
    assert.equal(stripHtml(closed), closed);
  }
  const took = performance.now() - started;
  assert.ok(took < 5000, `${Math.round(took)} ms`);
});

// The server refuses a larger payload. Its limit is not readable from here, so it is pinned.
test("nothing is sent that SageFin would refuse", () => {
  assert.equal(MAX_CAPTURE_BYTES, 4 * 1024 * 1024);
});
