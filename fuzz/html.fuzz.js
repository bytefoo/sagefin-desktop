// stripHtml against pages nobody wrote. It is not a sanitizer and these do not ask it to be one:
// they hold what the app relies on, which is that it only ever removes, and that what an order is
// read from comes through untouched.

import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { stripHtml } from "../lib/html.mjs";

const PIECES = ["<script", "</script>", "<style", "</style>", "<svg", "</svg>", "<noscript", "</noscript>", "<!--", "-->", "<SCRIPT>", "</SCRIPT >", "<div>", ">", "<", " ", "\n"];
const page = fc.array(fc.oneof(fc.constantFrom(...PIECES), fc.string()), { maxLength: 60 }).map((parts) => parts.join(""));

test("a stripped page is never longer, and nothing makes stripping throw", () => {
  fc.assert(
    fc.property(fc.oneof(page, fc.string({ unit: "binary" })), (html) => {
      assert.ok(stripHtml(html).length <= html.length);
    }),
  );
});

test("a page with no markup is sent as it was", () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary" }).map((s) => s.replaceAll("<", "")), (text) => {
      assert.equal(stripHtml(text), text);
    }),
  );
});

// The parts an order is read from are what sits between the removed blocks.
test("what is outside a removed block survives, and what is inside one does not", () => {
  const kept = fc.string().map((s) => s.replaceAll("<", "").replaceAll("-->", ""));
  const inside = fc.string().map((s) => s.replaceAll("<", "").replaceAll("-->", ""));
  const block = fc.tuple(fc.constantFrom("script", "style", "svg", "noscript", "SCRIPT", "comment"), inside).map(([tag, body]) =>
    tag === "comment" ? `<!--${body}-->` : `<${tag} type="x">${body}</${tag}>`,
  );

  fc.assert(
    fc.property(fc.array(fc.tuple(kept, block), { maxLength: 20 }), kept, (pairs, tail) => {
      const html = pairs.map(([text, removed]) => text + removed).join("") + tail;
      assert.equal(stripHtml(html), pairs.map(([text]) => text).join("") + tail);
    }),
  );
});
