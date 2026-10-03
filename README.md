# SageFin Desktop

[![ci](https://github.com/bytefoo/sagefin-desktop/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bytefoo/sagefin-desktop/actions/workflows/ci.yml)
[![codeql](https://github.com/bytefoo/sagefin-desktop/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/bytefoo/sagefin-desktop/actions/workflows/codeql.yml)
[![latest release](https://img.shields.io/github/v/release/bytefoo/sagefin-desktop)](https://github.com/bytefoo/sagefin-desktop/releases/latest)
[![licence: MIT](https://img.shields.io/github/license/bytefoo/sagefin-desktop)](LICENSE)

[SageFin](https://sagefin.app) as a desktop app. Its main window is the real web app, loaded from
the site, so a member can use it instead of a browser. Beside that, it does the one thing a browser
tab cannot: it opens a retailer in its own window, the member signs in there themselves, and it saves
what the retailer's own orders pages contain and sends them to SageFin, which matches each order to
the bank transaction that paid for it. Electron; Walmart and Amazon today.

It exists because a desktop app is the one client that can show a retailer's real page from the
member's own computer and connection. SageFin's servers never contact the retailer and never hold
a retailer sign-in.

**The source is public so you can read what it does with your retailer sign-ins before you run it.**
The short version is under [What it does, and what it deliberately does not](#what-it-does-and-what-it-deliberately-does-not).
SageFin's servers and web app are not open source; this app is their client.

## Install

**You only need this app for retail sync.** Everything else in SageFin works in a browser and on
the phone, with nothing to install.

Download the latest build for your system:

| System | Download | First run |
|---|---|---|
| macOS (Apple Silicon) | [SageFin-Desktop-mac-arm64.dmg](https://github.com/bytefoo/sagefin-desktop/releases/latest/download/SageFin-Desktop-mac-arm64.dmg) | Open it once, then System Settings → Privacy & Security → Open Anyway |
| Windows | [SageFin-Desktop-win-x64.exe](https://github.com/bytefoo/sagefin-desktop/releases/latest/download/SageFin-Desktop-win-x64.exe) | "Windows protected your PC" → More info → Run anyway |
| Linux | [SageFin-Desktop-linux-x86_64.AppImage](https://github.com/bytefoo/sagefin-desktop/releases/latest/download/SageFin-Desktop-linux-x86_64.AppImage) | Mark it executable and run it |

Every version, with each file's SHA-256, is on [Releases](https://github.com/bytefoo/sagefin-desktop/releases).

These are early test builds and **are not code-signed yet**, which is why each system warns about
them. A warning you are asked to click through is a reason to be careful: every build here is made
by the [release workflow](.github/workflows/release.yml) from this source, and you can check the
file you downloaded against the SHA-256 on its release.

The app opens SageFin, where you need an account.

**Updates.** On Windows and Linux the app updates itself: it downloads a new version in the
background and installs it the next time it quits, or sooner if you choose Restart to Update from
the tray icon. On macOS it cannot yet, because macOS only updates an app signed with a Developer
ID; download the new build and install it over the old one.

## Privacy and terms

The app sends the orders pages it saves to SageFin, so what happens to them is SageFin's to answer
for, not this repository's:

- [SageFin's privacy policy](https://sagefin.app/privacy) says what is kept from a retailer's
  orders, for how long, and how to delete it.
- [SageFin's terms of use](https://sagefin.app/terms) cover your use of SageFin, this app included.
- [Retail orders in SageFin](https://sagefin.app/help/retail-orders) explains the feature, and
  what each retailer's own terms say about software like this. Using the app with a retailer is
  your decision to make with those terms in front of you.

The MIT licence below covers this source code only.

## The main window

It loads `https://my.sagefin.app` and nothing is rebuilt: sign-in, the sidebar, fonts and themes
are the site's own, and a web deploy changes the app's interface too.

- **Only SageFin is SageFin.** `lib/site.mjs` lists the three origins the app will open
  (production, test, local) and decides every
  navigation. The window stays on the site and its own sign-in pages; any other link opens in the
  member's browser.
- **A script's pop-up gets a plain window.** That is how a bank's sign-in arrives during account
  linking. It has no preload, so no bridge.
- **The bridge is small and says nothing a retailer's page said.** `window.sagefinDesktop.info()`
  tells the web app it is running in the desktop app and what the app can do; `stores()` lists
  each retailer with how many pages are saved here; `openStore(code)` opens one; `onStoresChanged`
  says when to ask again. Names, counts and times only — a saved page's contents never cross it.
  It exists only on a SageFin origin, and the main process checks the caller's frame and origin
  again before answering. Settings → Retail sync in the web app is where it shows.
- **If the site cannot be reached**, a local page says so and offers to try again.

A development run can open another site: `SAGEFIN_DESKTOP_SITE=test npm start`, or the Develop
menu. A packaged app opens production. Each site has its own browser profile.

The stores window (Stores → Stores on This Computer) is the app's own page: what is saved here,
and a button to open each retailer.

## Running in the background

A scheduled sync only runs while the app is running, so closing the main window hides it and
leaves the app running (`lib/background.mjs`). The rules:

- **The window can always be brought back.** A menu bar icon on macOS and a tray icon elsewhere
  open the window and quit the app; so do the Dock icon and starting the app again. Where a desktop
  has no tray and no Dock, closing the window closes the app, as before: a hidden window nothing
  can show would be an app nobody can see or quit.
- **It says so once.** The first close that leaves the app running shows a notification.
- **It is a choice.** Stores → Keep Running When the Window Is Closed, on by default, also in the
  tray menu. Quit always quits.
- **Starting with the computer is off by default**, and offered only in a packaged app on macOS
  and Windows (a development run would register Electron itself). Not exercised yet: nothing is
  packaged build has been run with it. On macOS 13 and later the system does not say that a start was a login start,
  so the window shows; on Windows a login start carries `--hidden` and stays in the tray.

The two choices are in `preferences.json` beside the captures folder, in the clear: neither is a
secret.

## Syncing a retailer

**Sync now** in Settings → Retail sync opens a retailer's orders list and then the page of each order
it has not already read in its present state, one at a time. Each page is saved by the same code
that saves it when the member opens it; the sync only does the opening, from the member's
computer, in a window signed in by the member.

- **Slowly, and not many.** Five seconds between pages, at most ten pages of the orders list and
  twenty orders in a run (`lib/sync-plan.mjs`). A daily run usually reads one list page and opens
  none or one order.
- **Three months back, then only what is new.** Purchase history lists five orders a page. A run
  pages through it by the numbered addresses the page's own arrows lead to (`/orders?page=2`), as
  full loads, until it reaches orders older than 90 days or the end of the history; an older order
  has no bank transaction in SageFin to match. A long history is caught up over several days: each
  run resumes at the page the last finished one stopped on. Once caught up, a run stops at the
  first list page with nothing to open. The cost of that is deliberate: a late change to an order
  past the first page, such as a refund, is not seen by a scheduled run.
- **Only what is new or changed.** The app remembers each order it has read with a fingerprint of
  the few list fields that change when the order does. The whole list entry cannot be used:
  Walmart reorders parts of it on every load.
- **It stops for a person.** On the retailer's robot check or a sign-in, the run ends and the window
  is shown. It never retries through either. Two order pages in a row that are not the order also
  end it.
- **Turned away is final until the member says otherwise.** A robot check (by address or by its
  content), or any page answered with a refusal status (Walmart's 412 and 418, Amazon's 503), ends the
  run and stops the daily schedule. The next run is the member's own Sync now; one of theirs that
  finishes starts the schedule again. For a retailer whose terms name agents, the run does not ask the
  member to complete a check for it: an agent never answers a CAPTCHA, and neither does a person on
  its behalf.
- **Daily, once the member has done it once.** After a sync the member started has finished, the
  app repeats it every 24 hours while it is running, in a window kept out of the way unless the retailer
  needs the member. It never starts a retailer's schedule by itself.
- **The app reads an order's number and where its page is**, to know what to open. Amounts stay
  inside the page's data, untouched, for SageFin to read.

The retailer window has no address bar, so its title shows where it is, query and all.

## What it does, and what it deliberately does not

Walmart and Amazon are the retailers the app supports today.

- The member opens a retailer, signs in themselves, and looks at their orders. Or they start a sync,
  which opens the same pages for them.
- **It reads only the orders pages `lib/retailers.mjs` names**, and nothing else in the account:
  - *Walmart:* Purchase history and an order's own page. It saves the data the page embeds
    (`__NEXT_DATA__`) once the page has loaded, and the answers to the two orders requests the
    page itself makes as the member scrolls or clicks into an order. Those are read from outside
    the page, through the DevTools protocol.
  - *Amazon:* Your Orders, an order's details and Your Payments. It saves the page's HTML as
    Amazon sent it, with scripts, styles and images removed.
- **Nothing on a retailer's page is wrapped, injected or changed.**
- **Outside a sync it makes no request of its own to a retailer or to SageFin.** It saves what the
  member's own browsing loads. The one request it does make by itself is to GitHub, a few times a
  day, to ask whether this repository has published a newer version (`lib/updates.mjs`). That
  fetches a small public file and sends nothing about the member, their account or their orders.
- **A sync only moves between pages.** It loads the orders list and each order's page, one at a
  time and slowly. On Amazon it also presses the payments list's own Next button, because that
  list has no address for its later pages. It never signs in, fills in a form, changes anything in
  the account, or composes a request the retailer's page would not make itself.
- **It does not disguise itself.** The user agent is Electron's own
  (`sagefin-desktop/<version> … Electron/…`). During an Amazon sync it also ends
  `Agent/SageFinDesktop`, which Amazon's terms ask of software acting by itself.
- **It stops at a robot check or a refusal**, says so, and does not try again by itself. It never
  answers a check, and never asks the member to answer one on a sync's behalf.
- Each retailer has its own persistent browser profile, shared with nothing else. A retailer sign-in
  stays in that profile on the member's computer; SageFin never receives it.

A saved page is sent to SageFin, which reads the orders from it. The app itself reads only what a
sync needs to know which page to open next: an order's number, its date, and a fingerprint of the
few fields that change when the order does. Until a page is sent it waits on the computer, sealed
with the operating system's secret store (`safeStorage`); if that is unavailable, nothing is saved
at all. Once SageFin holds it, the copy here is removed.

## Sending

- **The credential is upload-only**: a token the signed-in web page
  mints and hands over the bridge. It can post saved pages and read nothing back. It is sealed on
  disk, one per site, and only ever used against the site that minted it.
- **Connecting is automatic.** The member is signed in to SageFin inside the app; Settings →
  Retail sync connects the app when it finds it unconnected, once per page load. Disconnecting
  there lets go of the token here and revokes it at SageFin.
- **Sending is automatic too**: after each page saved, on connecting, and at start for anything
  left from last time. One run at a time, oldest first.
- **What the server's answer means** (`lib/uploader.mjs`): 200 and 202 both mean SageFin holds the
  page, so it is removed here; 401 or 403 drops the token and asks the member to connect again; a
  busy or failing server and no connection end the run and keep everything; any other refusal is
  about that one page, which stays while the rest go.
- **A page is filed under the SageFin the app was showing** when it was saved, and is sent only
  there. A stand-in page (`SAGEFIN_DESKTOP_STORE_FIXTURE`) is only ever sent to a local SageFin.

This does not put saving the data inside a retailer's terms of use. Walmart's prohibit storing
order data with any "manual or automatic device". It is the least a tool can do and still be useful.

**Amazon's terms name this kind of software.** Since 2026-08-14 its Conditions of Use define an
"Agent" — software acting autonomously or semi-autonomously for a person — and require one to put
`Agent/<name>` in the user agent of every request, never to imitate human pacing or answer a
CAPTCHA, and to stop when asked. Saving the pages a member opens acts on nothing by itself, so the
Amazon window is an ordinary browser. A sync acts by itself, so for the length of a run the window's
user agent ends `Agent/SageFinDesktop`, which every request the run makes carries, the page's own
included, and the member's own browsing afterwards does not. It does not imitate a person:
the pause between pages is the same for every retailer, there to keep load down, not to look human.

**An Amazon sync reads Your Payments, not Your Orders.** Your Orders reaches the app with each order
card encrypted, for Amazon's scripts to decrypt in the browser (seen on 2026-10-02). Reading the
decrypted page would be going round a measure aimed at software that reads pages, which the Agent
Terms rule out. Your Payments is not encrypted and lists each charge with its order and date, so a
run opens it, then the details page of each order with a new or changed charge. It lists twenty
charges a page, and its next page is a form rather than an address, so a run moves on by submitting
that form the way the page's own Next button does: the request the page itself makes, under
the run's marked user agent, never one the app composes. How far back is the same rule as Walmart's,
by the charges' dates. A run cut short starts again from the first page, since these pages have no
address to resume at; the fingerprints make reading them again cheap.

## Layout

| Path | What |
|---|---|
| `main/main.mjs` | The main process: the stores window, one window per retailer, reading a loaded page |
| `main/shell.mjs` | The main window: loads the site and carries out `lib/site.mjs`'s decisions |
| `main/shell-preload.cjs` | The main window's bridge to the web app, on SageFin origins only |
| `build/` | The app icons a development run shows, and `make-icons.py`, which builds them from the logo. macOS gets its own (`icon-mac.png`): the Dock draws an icon as given, so it carries the rounded shape and margin |
| `main/preload.cjs` | The stores window's only bridge: `status`, `open`, `onChanged` |
| `lib/site.mjs` | Which origins are SageFin, and where a navigation or a new window goes |
| `renderer/` | The stores window and the "could not be reached" page, in the web app's own colours and type. No Node, no Electron, a strict CSP |
| `lib/retailers.mjs` | Per retailer: which pages to save, its robot check, its signed-out page |
| `lib/capture-store.mjs` | Captures on disk: one sealed payload and one record each |
| `lib/credential-store.mjs` | The upload-only token, sealed, one per site |
| `lib/uploader.mjs` | Sends saved pages oldest first and acts on the server's status |
| `lib/sync-plan.mjs` | Which orders a sync opens, when a scheduled run is due, and what is remembered between runs |
| `lib/background.mjs` | What closing the window does, and starting with the computer |
| `lib/updates.mjs` | Where the app can update itself, and when it may restart to do it |
| `main/updates.mjs` | Looks for a newer release on GitHub, downloads it, and installs it on quit |
| `lib/html.mjs` | Makes a retailer's HTML page small enough to send |

`lib/` imports nothing from Electron, so its tests run with nothing installed.

## Updating itself

The update feed is this repository's latest published release: the release workflow attaches a
small manifest per system (`latest.yml`, `latest-linux.yml`) naming the version, the installer and
its SHA-512, which the app checks the download against. An update is never installed during a
sync; the tray says it is waiting. Until the builds are code-signed there is no signature to check
beyond that hash, fetched over HTTPS from GitHub, and macOS does not update at all.

## How it looks

The home window uses the web app's design tokens and shared control styles, copied by hand
because the window loads from disk with no build step.

Three things still differ from the site:

- **Font.** The web loads Geist at build time; this window falls back to the system font unless
  Geist is installed.
- **Theme.** Light or dark follows the operating system, not the web app's toggle.
- **Colour family.** The default one, not neutral.

## Run

```bash
npm install
```

```bash
npm start
```

Captures go to the app's user-data folder (`captures/`), or to `SAGEFIN_DESKTOP_CAPTURES` if set.

## Test

```bash
npm test
```

CI runs the same tests on every push and pull request.

`SAGEFIN_DESKTOP_STORE_FIXTURE=<file.html>` makes every retailer's window open that local page instead of
the real site, so opening a retailer from the web app can be exercised without loading one. It may
also be a page a local server is serving (`http://localhost:<port>/…`), which is how reading a
page's own requests is exercised.

A development run against a local page instead of a retailer, which saves one capture and quits:

```bash
SAGEFIN_DESKTOP_CAPTURES=/tmp/desktop-smoke npx electron . --smoke-fixture=fixtures/order-page.html
```

## Adding a retailer

Add an entry to `lib/retailers.mjs` and its tests. A retailer names its start page, the pages worth
saving (as the capture kinds SageFin's server knows), its robot-check page and its signed-out page.

It also says where a page's data is (`saves`). Walmart's is the `__NEXT_DATA__` its pages embed,
read once the page has loaded. Amazon's is the HTML itself, read from the response as Amazon sent
it, before any script runs, and stripped by `lib/html.mjs`, because that
is what SageFin's Amazon parser was proved against. A retailer window loads nothing until it is
reading responses: the first page would otherwise arrive unread.
The server needs a parser for each `(retailer, kind)` it should read; a capture with no parser is
stored there, not refused.

## Build

```bash
npm run pack
```

builds the app for this computer into `dist/` without making an installer, and `npm run dist` makes
the installer.

A release is made by running the release workflow by hand on `main`. It builds all three systems,
and publishes the release once every build has succeeded. Versions number themselves:
`<major>.<minor>` from `package.json`, and the number of commits on `main` as the patch, so every
merge is a new version. Change `package.json` only to start a new minor or major.

## Security

Please report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

What is checked, and where to see it:

- **Code scanning.** [CodeQL](.github/workflows/codeql.yml) runs on every pull request, every push
  to `main` and weekly. The `codeql` badge above is its last run on `main`; a pull request cannot
  merge with it failing. GitHub shows the individual findings only to maintainers.
- **Secrets.** GitHub secret scanning is on, with push protection: a push containing a recognised
  credential is refused.
- **Dependencies.** Dependabot raises an alert, and a pull request, for a dependency with a known
  vulnerability. The app ships two dependencies, Electron itself and `electron-updater`; everything
  else is build tooling.
- **Releases.** Built and published only by the [release workflow](.github/workflows/release.yml),
  which only a maintainer can start, on GitHub's own runners, with each file's SHA-256 in the
  notes. A version tag, once created, cannot be moved or deleted except by a maintainer, so a
  published version always points at the commit it was built from.

## Licence

[MIT](LICENSE).
