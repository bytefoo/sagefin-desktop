// @ts-check
// A release's version (the release workflow, scripts/version.mjs).

/**
 * `<major>.<minor>` from package.json's version, with the number of commits on main as the patch.
 * It goes up with every merge, so two releases never share a version and none is bumped by hand.
 * The updater compares versions as semver, which is why the count is the patch and not a suffix.
 *
 * Throws on anything it cannot read: a release with a guessed version is worse than none.
 * @param {string} base     package.json's version, whose patch is ignored.
 * @param {string | number | undefined} commits  `git rev-list --count HEAD`.
 */
export function releaseVersion(base, commits) {
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(String(base));
  if (!m) throw new Error(`package.json version "${base}" is not <major>.<minor>.<patch>.`);
  const count = String(commits ?? "").trim();
  if (!/^[1-9]\d*$/.test(count)) throw new Error(`"${count}" is not a commit count.`);
  return `${m[1]}.${m[2]}.${count}`;
}
