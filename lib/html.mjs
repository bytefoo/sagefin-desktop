// @ts-check
// A store's page HTML, made small enough to send: the parts no order is ever read from removed.

/**
 * The page without its scripts, styles, inline images, noscript blocks and comments.
 *
 * What it removes is defined by `stripByPatterns` below, and it returns exactly what that does. It
 * is not written that way because a pattern that finds an opening with no end after it reads to the
 * end of the page, gives up, and does the same from the next opening: a page of openings that never
 * close took time with the square of its size, minutes at the size SageFin accepts, with the app
 * not answering meanwhile. Here an opening with no end after it ends the search, since no later
 * opening has one either, so the page is read once per kind of block.
 *
 * This is not a sanitizer and its output is never shown as a page. It is sent to SageFin, which
 * reads orders out of it as text; markup that survives is only more text to read.
 *
 * @param {string} html
 */
export function stripHtml(html) {
  let text = String(html || "");
  for (const [open, close] of BLOCKS) text = withoutBlocks(text, open, close);
  return text;
}

// Each of the five patterns, as where a block opens and where it ends. Removed one kind after
// another, in the patterns' order, because that is what the patterns do: a style block that only
// appears once a script has been taken out of the middle of its tag is removed too.
/** @type {[RegExp, RegExp][]} */
const BLOCKS = [
  [/<script\b/gi, /<\/script>/gi],
  [/<style\b/gi, /<\/style>/gi],
  [/<svg\b/gi, /<\/svg>/gi],
  [/<noscript\b/gi, /<\/noscript>/gi],
  [/<!--/g, /-->/g],
];

/**
 * @param {string} text
 * @param {RegExp} open
 * @param {RegExp} close
 */
function withoutBlocks(text, open, close) {
  /** @type {string[]} */
  const kept = [];
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const opening = open.exec(text);
    if (!opening) break;
    // The end is looked for after the opening, never inside it: `<!-->` is not a whole comment.
    close.lastIndex = open.lastIndex;
    if (!close.exec(text)) break;
    kept.push(text.slice(from, opening.index));
    from = close.lastIndex;
  }
  if (from === 0) return text;
  kept.push(text.slice(from));
  return kept.join("");
}

/**
 * The definition of what is removed, and not what the app runs.
 *
 * SageFin's Amazon page parser was proved against pages stripped exactly this way (by the
 * browser extension this app replaced), so the five patterns are kept as they were rather than
 * improved on. lib/html.test.mjs pins them, and holds `stripHtml` to the same output.
 *
 * @param {string} html
 */
export function stripByPatterns(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** The largest payload SageFin accepts. The server refuses anything larger. */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
