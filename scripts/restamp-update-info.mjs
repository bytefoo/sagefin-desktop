// @ts-check
// Usage: node scripts/restamp-update-info.mjs <dist/file> <dist/latest-mac.yml>
// After a file electron-builder already hashed has changed (the release workflow staples the disk
// image's notarization ticket to it), writes its block map again and puts its new SHA-512 and size
// into the update manifest. lib/update-info.test.mjs holds the rule.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
// electron-builder's own block map writer, so the file is the one it would have written.
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";
import { restampUpdateInfo } from "../lib/update-info.mjs";

const [file, manifest] = process.argv.slice(2);
if (!file || !manifest) throw new Error("usage: restamp-update-info.mjs <file> <manifest>");
const { sha512, size } = await buildBlockMap(file, "gzip", `${file}.blockmap`);
if (typeof size !== "number" || !sha512) throw new Error("the block map writer returned no hash or size");
writeFileSync(manifest, restampUpdateInfo(readFileSync(manifest, "utf8"), path.basename(file), sha512, size));
console.log(`${path.basename(file)}: ${size} bytes, block map and ${path.basename(manifest)} restamped`);
