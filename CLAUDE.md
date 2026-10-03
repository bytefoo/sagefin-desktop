# SageFin Desktop

The Electron client for SageFin (https://sagefin.app). This repository is **public**; SageFin's
servers and web app are in a separate private repository.

## Because it is public

- Nothing private goes in: no real order data, no captured store pages, no tokens, no internal
  hostnames beyond the three sites in `lib/site.mjs`, and no references to private issues.
- Test data is made up. A fixture built from a real page is real data.
- A store's page a development run saves is the member's own purchases. Never commit or paste one.

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

## What the app must not do

The readme's "What it does, and what it deliberately does not" is the contract with the member,
and with the stores' terms. In particular: no request of its own to a retailer or to SageFin outside a sync (the
update check to GitHub is the one exception, and the readme says so); a sync only moves
between pages (loading them, and pressing a list's own Next button where its later pages have no
address: Purchase history at Walmart, the payments list at Amazon); what a retailer's terms prohibit is off until the member chooses it, and a choice changes
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
