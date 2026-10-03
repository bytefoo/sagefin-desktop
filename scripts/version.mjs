// @ts-check
// The version a release is built as: <major>.<minor> from package.json, and the number of commits
// on main as the patch. Prints it. Used by the release workflow; lib/version.test.mjs holds the rule.
import { readFileSync } from "node:fs";
import { releaseVersion } from "../lib/version.mjs";

const base = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
console.log(releaseVersion(base, process.argv[2]));
