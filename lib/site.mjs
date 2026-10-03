// @ts-check
// Which SageFin the app opens, and what its main window may do while showing it.
//
// The main window loads the real web app, so the app's interface is the site's own. That makes
// one question matter more than any other: is this page SageFin? Everything here answers it, or
// decides where a link goes, and none of it imports Electron — `node --test` runs it bare.

/**
 * @typedef {object} Site
 * @property {string} key     Short name, used for the browser profile.
 * @property {string} label   What a person calls it.
 * @property {string} origin  Exactly this origin is SageFin. Nothing else is.
 * @property {(host: string) => boolean} isAuthHost
 *   Hosts sign-in passes through as a full page: the instance's own Clerk pages. Neither hosted
 *   instance offers a social sign-in, so no provider's host is listed.
 */

/** @param {string[]} suffixes */
const hostIn = (...suffixes) => (/** @type {string} */ host) =>
  suffixes.some((s) => (s.startsWith(".") ? host.endsWith(s) : host === s));

/**
 * The same three sites the browser extension answers to, and no others.
 * @type {Site[]}
 */
export const SITES = [
  {
    key: "prod",
    label: "SageFin",
    origin: "https://my.sagefin.app",
    // No social sign-in host: the sign-in page offers an email code and nothing else. If a
    // provider is ever turned on, its host is added here on purpose.
    isAuthHost: hostIn("clerk.sagefin.app", "accounts.sagefin.app"),
  },
  {
    key: "test",
    label: "SageFin (test)",
    origin: "https://my-test.sagefin.app",
    isAuthHost: hostIn("clerk.my-test.sagefin.app", "accounts.my-test.sagefin.app"),
  },
  {
    key: "local",
    label: "SageFin (local)",
    origin: "http://localhost:3000",
    isAuthHost: hostIn(".clerk.accounts.dev", ".accounts.dev"),
  },
];

/**
 * The site named by a setting, or production when the setting is absent or names anything else.
 * A typo must not be able to point the app at a site that is not SageFin.
 * @param {string | undefined | null} value  A site key or its origin.
 */
export function resolveSite(value) {
  const wanted = (value ?? "").trim().replace(/\/+$/, "");
  return SITES.find((s) => s.key === wanted || s.origin === wanted) ?? SITES[0];
}

/** @param {string} url */
function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True when a page at this URL is the site itself: same scheme, host and port, compared as an
 * origin. `my.sagefin.app.example.com` and `http://my.sagefin.app` are not.
 * @param {string} url
 * @param {Site} site
 */
export function isSite(url, site) {
  return parse(url)?.origin === site.origin;
}

/**
 * Where a navigation of the main window goes.
 *
 * - `allow`: the site itself, or a sign-in page it hands off to.
 * - `external`: any other web page. It opens in the member's own browser; the app is not one.
 * - `deny`: anything that is not a web page at all.
 *
 * @param {string} url
 * @param {Site} site
 * @returns {"allow" | "external" | "deny"}
 */
export function decideNavigation(url, site) {
  const u = parse(url);
  if (!u) return "deny";
  if (u.origin === site.origin) return "allow";
  if (u.protocol === "https:" && site.isAuthHost(u.hostname)) return "allow";
  if (u.protocol === "https:" || u.protocol === "http:") return "external";
  return "deny";
}

/**
 * What a request for a new window becomes.
 *
 * - `popup`: a window a script opened with features, which is how a bank's sign-in is shown
 *   during account linking and how a sign-in provider's is. It gets a plain window with no bridge.
 * - `main`: a link to the site itself; it loads in the main window instead of a second one.
 * - `external`: a link to anywhere else, in the member's own browser.
 *
 * @param {{ url: string, disposition: string }} request
 * @param {Site} site
 * @returns {"popup" | "main" | "external" | "deny"}
 */
export function decideWindowOpen({ url, disposition }, site) {
  const u = parse(url);
  if (!u) return "deny";
  if (disposition === "new-window") return u.protocol === "https:" ? "popup" : "deny";
  if (u.origin === site.origin) return "main";
  if (u.protocol === "https:" || u.protocol === "http:") return "external";
  return "deny";
}
