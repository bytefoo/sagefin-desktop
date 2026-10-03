// @ts-check
// A store's page HTML, made small enough to send: the parts no order is ever read from removed.

/**
 * The page without its scripts, styles, inline images, noscript blocks and comments.
 *
 * SageFin's Amazon page parser was proved against pages stripped exactly this way (by the
 * browser extension this app replaced), so the five patterns are kept as they were rather than
 * improved on. lib/html.test.mjs pins them.
 *
 * This is not a sanitizer and its output is never shown as a page. It is sent to SageFin, which
 * reads orders out of it as text; markup that survives these patterns is only more text to read.
 *
 * @param {string} html
 */
export function stripHtml(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** The largest payload SageFin accepts. The server refuses anything larger. */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
