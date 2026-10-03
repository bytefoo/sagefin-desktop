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

/**
 * What the app calls itself where it shows its version: the tray icon and its menu.
 *
 * Run from source, the version is package.json's placeholder and matches no release, so the label
 * says so. A number that looks like a release and is not one would be worse than none.
 * @param {string} version   `app.getVersion()`.
 * @param {boolean} packaged `app.isPackaged`.
 */
export function versionLabel(version, packaged) {
  return packaged ? `SageFin Desktop ${version}` : `SageFin Desktop ${version} (development)`;
}
