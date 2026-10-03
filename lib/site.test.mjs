import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SITES, decideNavigation, decideWindowOpen, isSite, resolveSite } from "./site.mjs";

const [prod, testSite, local] = SITES;

test("the app opens production unless told one of the other two, by key or by origin", () => {
  assert.equal(resolveSite(undefined), prod);
  assert.equal(resolveSite(""), prod);
  assert.equal(resolveSite("test"), testSite);
  assert.equal(resolveSite("https://my-test.sagefin.app/"), testSite);
  assert.equal(resolveSite("local"), local);
  assert.equal(resolveSite("http://localhost:3000"), local);
});

// A typo, or somebody else's URL, must not be able to point the app at a site that is not SageFin.
test("a setting that names anything else falls back to production", () => {
  for (const value of ["https://example.com", "my.sagefin.app.example.com", "staging", "https://my.sagefin.app.evil.test", "javascript:alert(1)"]) {
    assert.equal(resolveSite(value), prod, value);
  }
});

test("these are the three sites the browser extension answers to", () => {
  assert.deepEqual(
    SITES.map((s) => s.origin),
    ["https://my.sagefin.app", "https://my-test.sagefin.app", "http://localhost:3000"],
  );
});

test("only the exact origin is the site", () => {
  assert.equal(isSite("https://my.sagefin.app/transactions?x=1", prod), true);

  assert.equal(isSite("http://my.sagefin.app/", prod), false);
  assert.equal(isSite("https://my.sagefin.app.example.com/", prod), false);
  assert.equal(isSite("https://my.sagefin.app:8443/", prod), false);
  assert.equal(isSite("https://my-test.sagefin.app/", prod), false);
  assert.equal(isSite("https://sagefin.app/", prod), false);
  assert.equal(isSite("file:///Users/x/index.html", prod), false);
  assert.equal(isSite("not a url", prod), false);
});

test("the main window stays on the site and its own sign-in pages", () => {
  assert.equal(decideNavigation("https://my.sagefin.app/settings", prod), "allow");
  assert.equal(decideNavigation("https://accounts.sagefin.app/sign-in", prod), "allow");
  assert.equal(decideNavigation("https://clerk.sagefin.app/v1/oauth_callback?code=x", prod), "allow");

  assert.equal(decideNavigation("https://my-test.sagefin.app/", testSite), "allow");
  assert.equal(decideNavigation("https://accounts.my-test.sagefin.app/sign-in", testSite), "allow");
  assert.equal(decideNavigation("https://example.clerk.accounts.dev/sign-in", local), "allow");
});

test("any other web page opens in the member's own browser", () => {
  assert.equal(decideNavigation("https://www.walmart.com/", prod), "external");
  assert.equal(decideNavigation("https://plaid.com/legal", prod), "external");
  assert.equal(decideNavigation("http://example.com/", prod), "external");

  // One site's sign-in pages are not another's.
  assert.equal(decideNavigation("https://accounts.sagefin.app/sign-in", testSite), "external");

  // Neither hosted site offers a social sign-in, so a provider's page is just another web page.
  assert.equal(decideNavigation("https://accounts.google.com/o/oauth2/v2/auth", prod), "external");
  assert.equal(decideNavigation("https://accounts.google.com/", testSite), "external");
  assert.equal(decideNavigation("https://my.sagefin.app/", testSite), "external");

  // Lookalikes of a sign-in host.
  assert.equal(decideNavigation("https://accounts.sagefin.app.example.com/", prod), "external");
  assert.equal(decideNavigation("https://evilaccounts.google.com.example.com/", prod), "external");
  assert.equal(decideNavigation("http://accounts.sagefin.app/sign-in", prod), "external");
});

test("something that is not a web page is refused outright", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "sagefin://x", "nonsense"]) {
    assert.equal(decideNavigation(url, prod), "deny", url);
  }
});

test("a script's pop-up gets a plain window, a link does not", () => {
  // How a bank's sign-in arrives during account linking.
  assert.equal(decideWindowOpen({ url: "https://cdn.plaid.com/link/v2/stable/link.html", disposition: "new-window" }, prod), "popup");
  assert.equal(decideWindowOpen({ url: "http://bank.example/login", disposition: "new-window" }, prod), "deny");
  assert.equal(decideWindowOpen({ url: "javascript:alert(1)", disposition: "new-window" }, prod), "deny");

  // A link that asks for a new tab.
  assert.equal(decideWindowOpen({ url: "https://my.sagefin.app/help", disposition: "foreground-tab" }, prod), "main");
  assert.equal(decideWindowOpen({ url: "https://www.walmart.com/orders", disposition: "foreground-tab" }, prod), "external");
  assert.equal(decideWindowOpen({ url: "file:///etc/passwd", disposition: "foreground-tab" }, prod), "deny");
  assert.equal(decideWindowOpen({ url: "nonsense", disposition: "background-tab" }, prod), "deny");
});

// The preload cannot import this module (a sandboxed preload is CommonJS), so it carries its own
// copy of the origins. A copy that drifts would expose the bridge on the wrong site, or hide it on
// the right one.
test("the preload's list of sites is this module's", () => {
  const preload = readFileSync(path.join(import.meta.dirname, "..", "main", "shell-preload.cjs"), "utf8");
  const listed = [...preload.matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual(listed.sort(), SITES.map((s) => s.origin).sort());
});

// The "could not be reached" page restates the origins, because a page on disk cannot import this
// module. A site added here and not there would get a Try again link that does nothing.
test("the unreachable page's Try again link goes only to the sites listed here", () => {
  const page = readFileSync(new URL("../renderer/unreachable.js", import.meta.url), "utf8");
  const listed = JSON.parse(page.match(/const SAGEFIN_ORIGINS = (\[[^\]]*\]);/)?.[1] ?? "[]");
  assert.deepEqual(listed, SITES.map((s) => s.origin));
  assert.match(page, /SAGEFIN_ORIGINS\.includes\(asked\) \? asked : null/);
});
