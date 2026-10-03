// @ts-check
// Development only: where in a saved page a name appears, without what it holds.
//
// A reader for a retailer's page is written against the page as the retailer really sends it, and
// a fixture kept in a repository has had the member's own details taken out. So when the question
// is "where does this page say whose account it is", the answer has to come from a real page, and
// must not carry the account with it. This prints the paths to matching keys and the shape of what
// is there (its type and size), and never a value.

/**
 * The paths to every key matching `pattern` in a JSON payload, each with the type and size of its
 * value. Array positions are written `[]`, so a list of a thousand orders is one line.
 *
 * Returns nothing for a payload that is not JSON: an HTML page has no keys to name.
 * @param {string} payload
 * @param {RegExp} pattern  Tested against each key's own name.
 * @param {number} [limit]  The most lines returned.
 * @returns {string[]}
 */
export function keyPaths(payload, pattern, limit = 60) {
  let root;
  try {
    root = JSON.parse(payload);
  } catch {
    return [];
  }

  /** @type {Set<string>} */
  const found = new Set();
  /** @param {unknown} value */
  const shape = (value) => {
    if (value === null) return "null";
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === "string") return `string(${value.length})`;
    if (typeof value === "object") return `object(${Object.keys(value).length})`;
    return typeof value;
  };
  /** @param {unknown} node @param {string} path @param {number} depth */
  const walk = (node, path, depth) => {
    if (found.size >= limit || depth > 40 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      // The first few entries say what the rest are; every entry of a long list says nothing more.
      for (const item of node.slice(0, 3)) walk(item, `${path}[]`, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (pattern.test(key)) found.add(`${here}: ${shape(value)}`);
      if (found.size >= limit) return;
      walk(value, here, depth + 1);
    }
  };
  walk(root, "", 0);
  return [...found];
}

/**
 * The pattern a development setting names, or null when it names none or is not a pattern.
 * @param {string | undefined} setting
 */
export function keyPattern(setting) {
  if (!setting) return null;
  try {
    return new RegExp(setting, "i");
  } catch {
    return null;
  }
}
