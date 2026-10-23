// @ts-check
// The update manifest electron-builder writes (latest-mac.yml), restamped after a file in it
// changed. The release workflow staples Apple's notarization ticket to the macOS disk image after
// electron-builder has hashed it, which changes the file; scripts/restamp-update-info.mjs puts the
// new hash and size back so the manifest describes the file that is published.

/**
 * The manifest with `name`'s SHA-512 and size replaced, wherever it names that file: its entry
 * under `files`, and the top-level `sha512` when `path` is that file. Throws when the manifest
 * does not list the file, or lists it without both values: a manifest that still carries the old
 * hash is worse than a release that stops.
 * @param {string} text    The manifest as electron-builder wrote it.
 * @param {string} name    The file's name, as the manifest's `url` gives it.
 * @param {string} sha512  The new SHA-512, base64, as electron-builder writes it.
 * @param {number} size    The new size in bytes.
 */
export function restampUpdateInfo(text, name, sha512, size) {
  const lines = text.split("\n");
  const entry = lines.findIndex((line) => /^ {2}- url: /.test(line) && line.slice("  - url: ".length).trim() === name);
  if (entry < 0) throw new Error(`the manifest does not list ${name}`);
  let stampedHash = false;
  let stampedSize = false;
  for (let i = entry + 1; i < lines.length && /^ {4}\S/.test(lines[i]); i++) {
    if (lines[i].startsWith("    sha512: ")) {
      lines[i] = `    sha512: ${sha512}`;
      stampedHash = true;
    } else if (lines[i].startsWith("    size: ")) {
      lines[i] = `    size: ${size}`;
      stampedSize = true;
    }
  }
  if (!stampedHash || !stampedSize) throw new Error(`the manifest's entry for ${name} has no sha512 or size`);
  const top = lines.findIndex((line) => line.startsWith("path: "));
  if (top >= 0 && lines[top].slice("path: ".length).trim() === name) {
    const hash = lines.findIndex((line) => line.startsWith("sha512: "));
    if (hash < 0) throw new Error(`the manifest names ${name} as its path and has no sha512`);
    lines[hash] = `sha512: ${sha512}`;
  }
  return lines.join("\n");
}
