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
 * The version the running app reports: in the tray, to the web page it shows, and to SageFin.
 *
 * A release reports its own. Run from source, the app's version is package.json's placeholder,
 * which matches no release: showing "0.1.0" beside a real "0.1.33" reads as a very old copy. So a
 * run from source reports the version a release cut from its commit would get, marked as what it
 * is, and falls back to the marked placeholder where the commits cannot be counted.
 * @param {string} base      `app.getVersion()`.
 * @param {boolean} packaged `app.isPackaged`.
 * @param {string | number | undefined} [commits]  `git rev-list --count HEAD`, from source only.
 */
export function runningVersion(base, packaged, commits) {
  if (packaged) return base;
  try {
    return `${releaseVersion(base, commits)} (development)`;
  } catch {
    return `${base} (development)`;
  }
}

/**
 * What the app calls itself where it shows its version: the tray icon and its menu.
 * @param {string} running  `runningVersion`'s answer.
 */
export function versionLabel(running) {
  return `SageFin Desktop ${running}`;
}
