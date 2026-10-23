# SageFin Desktop

The Electron client for SageFin (https://sagefin.app). This repository is **public**; SageFin's
servers and web app are in a separate private repository.

## Because it is public

- Nothing private goes in: no real order data, no captured retailer pages, no tokens, no internal
  hostnames beyond the three sites in `lib/site.mjs`, and no references to private issues.
- Test data is made up. A fixture built from a real page is real data.
- A retailer's page a development run saves is the member's own purchases. Never commit or paste one.

## Commands

```bash
npm test
```

runs `lib/*.test.mjs` with nothing installed: `lib/` imports nothing from Electron, and that is a
rule, not a coincidence. Logic that can be decided without Electron goes in `lib/` with a test;
`main/` only carries the decisions out.

```bash
npm run typecheck
```

checks every file that starts `// @ts-check` against the types its comments declare, strictly
(`tsconfig.json`). Nothing is compiled: the app runs the JavaScript as written. A file without the
comment is not checked, which today is most tests, the two preloads and the renderer scripts. A
new file in `lib/` or `main/` starts with it.

```bash
npm run fuzz
```

runs `fuzz/*.fuzz.js`: the same readers against generated pages and addresses, with fast-check,
which does have to be installed (`npm ci`). That is why they are not in `lib/`. A property there is
a promise the readme makes, held for any input; when one fails, fast-check prints the smallest
input that breaks it, and that input becomes an example in the matching `lib/*.test.mjs` with the
fix. The files end `.js`, not `.mjs`, because OpenSSF Scorecard only looks for fuzzing in `.js`.

```bash
npm start
```

runs the app (`SAGEFIN_DESKTOP_SITE=test` or `local` for another SageFin; a packaged app opens
production only).

```bash
npm run pack
```

builds the app into `dist/` without an installer. A release is the release workflow run by hand
on `main`: it builds all three systems and **publishes** the release when they all succeed, versioned `<major>.<minor>` from
`package.json` plus the commit count as the patch (`lib/version.mjs`). Do not bump the patch by
hand, and do not push `v*` tags: publishing creates the tag. A run is a public release, with the
download page on sagefin.app pointing at it, so do not start one to test something.

To try a change to macOS signing, entitlements or the key helper, run the **mac-test-build**
workflow on the branch (`gh workflow run mac-test-build.yml --ref <branch>`): the macOS build as a
release makes it, signed, notarized and checked, kept as the run's artifact and published nowhere.
**verify-mac-signing** checks the six signing secrets fit together, after one is replaced. Both
print nothing secret, and anything added to them must not either: no secret, and nothing made
from one (a decoded file, a password, a key's contents). The key helper is a bundle in the app's
`Contents/Helpers` with its own copy of the provisioning profile, signed by `native/macos/build.sh`
before electron-builder runs, which `mac.signIgnore` stops it re-signing; see `scripts/mac-build.sh`.

The Windows key helper (`native/windows/`, C# compiled ahead of time to one native program) is
built by `native/windows/build.sh` on Windows with the .NET 10 SDK and Visual Studio's C++ tools,
and carried into the app's resources by `win.extraResources`. CI builds it and checks it starts;
no hosted runner has Windows Hello, so a change to it is checked on a real Windows computer, at
its screen: `native/windows/build.sh --self-test` (no prompt), then
`node native/windows/hello-check.mjs` (three Windows Hello prompts). It is not code-signed.

## What the app must not do

The readme's "What it does, and what it deliberately does not" is the contract with the member,
and with the retailers' terms. In particular: no request of its own to a retailer outside a sync; exactly three requests of
its own elsewhere, all listed in the readme and none carrying anything from a page (the
five-minute check-in with SageFin in `lib/check-in.mjs`, the update check to GitHub, and, on a
computer that holds a private household's key, whether that household is locked when the window
is shown), so a fourth, or a new field on the check-in, changes the readme in the same PR; during a sync, and only then,
it asks SageFin which listed orders another of the member's computers has read
(`lib/read-orders.mjs`), sending a SHA-256 per order and never an order number, a fingerprint or
anything else from a page in the clear; the check-in's answer
may start a sync the member asked for from the web, which runs as a scheduled one does and under
the same conditions (`shouldStartRequested`), and may never carry anything else for the app to do,
except that a private household's `privateMode` may make it show one notification asking the member
(lib/private-mode.mjs counts them); a household key is used only after the member approves the
operating system's own prompt, started from the app's own unlock window or menu and never from the
page, and only for this window's own unlock or Sync and lock (`lib/private-mode.mjs`); a sync only moves
between pages (loading them, and, where a list's later pages have no address, doing what a person
does to see more: pressing Purchase history's own Next button at Walmart, scrolling the payments
list to its end at Amazon); what a retailer's terms prohibit is off until the member chooses it, and a choice changes
whether the app acts, never how (`lib/consent.mjs`);
it stops at a robot check or a refusal and does not retry; it never solves or asks the
member to solve a check for an agent run; Amazon runs carry `Agent/SageFinDesktop`; a stand-in
fixture page is never sent to a non-local SageFin. A change to any of these changes the readme in
the same pull request.

## Two things the server depends on

`lib/html.mjs`'s five strip patterns and `MAX_CAPTURE_BYTES` mirror the server. Its source is not
here, so the tests pin them; changing either needs the matching server change.

The patterns are `stripByPatterns`, which is the definition and is not what runs. `stripHtml` is
what runs: the same removal, in time that grows with the page and not with its square. A test and
a fuzz property hold the two to the same output, so a change to one is a change to both.

## Landing work

Pull requests into `main`, squash-merged.
