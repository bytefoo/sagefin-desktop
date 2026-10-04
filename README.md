# SageFin Desktop

[![ci](https://github.com/bytefoo/sagefin-desktop/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bytefoo/sagefin-desktop/actions/workflows/ci.yml)
[![codeql](https://github.com/bytefoo/sagefin-desktop/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/bytefoo/sagefin-desktop/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/bytefoo/sagefin-desktop/badge)](https://scorecard.dev/viewer/?uri=github.com/bytefoo/sagefin-desktop)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15189/badge)](https://www.bestpractices.dev/projects/15189)
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
  tells the web app it is running in the desktop app and what the app can do; `retailers()` lists
  each retailer with how many pages are saved here; `openRetailer(code)` opens one; `onRetailersChanged`
  says when to ask again. Names, counts and times only — a saved page's contents never cross it.
  It exists only on a SageFin origin, and the main process checks the caller's frame and origin
  again before answering. Settings → Retail sync in the web app is where it shows. The same calls
  also answer under their older names (`stores()`, `openStore`, `syncStore`, `onStoresChanged`),
  for a web app that has not yet changed to the new ones.
- **If the site cannot be reached**, a local page says so and offers to try again.

A development run can open another site: `SAGEFIN_DESKTOP_SITE=test npm start`, or the Develop
menu. A packaged app opens production. Each site has its own browser profile.

The retailers window (Retailers → Retailers on This Computer) is the app's own page: what is saved here,
and a button to open each retailer.

## Running in the background

A scheduled sync only runs while the app is running, so closing the main window hides it and
leaves the app running (`lib/background.mjs`). The rules:

- **The window can always be brought back.** A menu bar icon on macOS and a tray icon elsewhere
  open the window and quit the app; so do the Dock icon and starting the app again. Where a desktop
  has no tray and no Dock, closing the window closes the app, as before: a hidden window nothing
  can show would be an app nobody can see or quit.
- **It says so once.** The first close that leaves the app running shows a notification.
- **It is a choice.** Retailers → Keep Running When the Window Is Closed, on by default, also in the
  tray menu. Quit always quits.
- **It says which version is running.** The icon's tooltip and the first line of its menu carry
  the version, since the app can run for weeks with its window closed. Run from source, the app
  reports the version a release cut from that commit would get, ending "(development)", in the
  tray, to the web page and in its check-in; package.json's own version is a placeholder that
  matches no release. The window's title names the site whenever it is not production.

On Windows and Linux the menu bar is hidden until Alt is pressed, so the window is only SageFin;
everything in the menu is also on the tray icon. macOS keeps its menu at the top of the screen.
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

That window shows while the sync runs when the member may be needed at it: the first sync of a
retailer on a computer, and any sync after a run that did not reach its end. After a run that
finished, the next Sync now works out of the way, as the daily sync does. The card says what it is
doing, the window appears by itself if the retailer asks for a person, and Open shows it to anyone
who wants to watch (`showWindowForMemberSync` in `lib/sync-plan.mjs`).

- **Slowly, and not many.** Five seconds between pages, at most ten pages of the orders list and
  twenty orders in a run (`lib/sync-plan.mjs`). A daily run usually reads one list page and opens
  none or one order.
- **Three months back, then only what is new.** Purchase history lists five orders a page, and
  pages by a cursor the page holds, not by its address: loading `/orders?page=2` afresh shows the
  first five again. So a run goes to the next page the way a person does, by pressing the page's
  own **Next page** button, and reads the orders from the request the page then makes. It carries
  on until it reaches orders older than 90 days or the end of the history; an older order has no
  bank transaction in SageFin to match. It opens at most twenty orders a run, so a long history is
  caught up over several days. Once caught up, a run stops at the first list page with nothing to
  open. The cost of that is deliberate: a late change to an order
  past the first page, such as a refund, is not seen by a scheduled run.
- **Only what is new or changed.** The app remembers each order it has read with a fingerprint of
  the few list fields that change when the order does. The whole list entry cannot be used:
  Walmart reorders parts of it on every load.
- **It stops for a person.** On the retailer's robot check or a sign-in, the run ends and the window
  is shown. It never retries through either. Two order pages in a row that are not the order also
  end it.
- **A sign-in page stops the schedule on that computer.** A run that meets the retailer's sign-in
  page ends, shows the window, and is not repeated by the schedule: a run each hour that loads a
  sign-in page and leaves is a pattern a retailer could fairly read as a robot's. The next run is
  the member's own Sync now, once they have signed in. Unlike being turned away, this is the one
  computer's: another of the member's computers that is still signed in carries on
  (`scheduleStopped` in `lib/sync-plan.mjs`).
- **Turned away is final until the member says otherwise.** A robot check (by address or by its
  content), or any page answered with a refusal status (Walmart's 412 and 418, Amazon's 503), ends the
  run and stops the daily schedule. The next run is the member's own Sync now; one of theirs that
  finishes starts the schedule again. For a retailer whose terms name agents, the run does not ask the
  member to complete a check for it: an agent never answers a CAPTCHA, and neither does a person on
  its behalf.
- **Daily, once the member has done it once.** After a sync the member started has finished, the
  app repeats it while it is running, in a window kept out of the way unless the retailer
  needs the member. It never starts a retailer's schedule by itself.
- **When, and how often, is the member's to choose.** With nothing chosen a retailer syncs again a
  day after its last sync finished. In SageFin's Retail sync settings the member can pick an hour
  of the day and how often: daily, every two or three days, or weekly. Never more often than
  daily, and an answer that asks for more is ignored. The hour is on this computer's own clock.
  The choice is kept by SageFin, not here, because with several computers the daily sync belongs
  to whichever synced last; it arrives with the check-in answer (`scheduledRunAtMs` in
  `lib/sync-plan.mjs`). Sync now does not move it. The Retail sync page says
  when each retailer last synced, whether you or the schedule started it, and when the next is due.
- **The app reads an order's number and where its page is**, to know what to open. Amounts stay
  inside the page's data, untouched, for SageFin to read.

The retailer window has no address bar, so its title shows where it is, query and all.

## Which account, at a retailer whose pages do not say

SageFin keeps one daily sync per retailer account, and keeps each account's orders apart. For
Walmart it tells accounts apart itself, from Walmart's own pages. Amazon's pages, as the app saves
them, greet the member by first name and name no account. So for Amazon the member may give the
account a name on each computer, in Settings → Retail sync ("Derek's Amazon"). Two computers given
the same name are one account; two given different names are two.

The name is a label the member typed (`lib/account-names.mjs`). It is never read from a page and
never checked against one, it is kept sealed on the computer, and it goes to SageFin with the
check-in. A member with one Amazon account never needs to give one.

## Your choice, per retailer

A retailer's terms of use are between you and the retailer, and they decide whether a tool may
read your account for you. Your account carries the risk, and the orders are yours. So the app
does not decide this in its code. For each retailer it shows you what the terms say, quoted, with
their date and a link (`lib/retailers.mjs`), and where they prohibit something the app can do, it
does that only if you say so (`lib/consent.mjs`).

- **Two choices, both off until you make them:** saving the orders pages you open, and syncing
  (Sync now and the daily schedule). Syncing needs saving.
- **Walmart's terms prohibit both.** The app says so in Walmart's own words and asks.
- **Amazon's terms allow software that says what it is.** A sync names itself an agent on every
  request, so there is nothing to accept, and the app says why.
- **A choice is about the terms as they were.** It is recorded with the date the retailer says its
  terms were updated. When that date changes, the app asks again and stays off until you answer.
- **A choice changes whether the app acts, never how.** The pacing, the stop at the first refusal,
  the agent marker and never answering a robot check are the same whatever you chose.

Your choice covers your own account. It is not legal advice, and it does not make what a
retailer's terms prohibit permitted.

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
    Amazon sent it, with scripts, styles and images removed. The one exception is a payments page
    after the first, which Amazon's own script builds in place: that one is saved as the page then
    shows it, stripped the same way.
- **Nothing on a retailer's page is wrapped, injected or changed.**
- **Outside a sync it makes no request of its own to a retailer.** It saves what the member's own
  browsing loads.
- **It makes two requests by itself, and neither carries anything from a page.**
  - *To SageFin, every five minutes once the computer is connected* (`lib/check-in.mjs`). It sends
    the app's version and, for each retailer, when its last sync here ran and finished, whether the
    member or the schedule started it, which of four ways it ended (finished, turned away, met a
    sign-in page, stopped), how many orders it opened, when the retailer last turned a run
    away, whether the member's choices here let the app sync that retailer by itself, and, for a
    retailer whose pages do not say whose account they are, the name the member gave that account
    on this computer if they gave one. No order, no order number, no address, nothing a retailer's
    page said. The answer is whether this
    computer may start each retailer's scheduled sync: a member with the app on several computers
    gets one daily sync per retailer instead of one per computer, and a retailer that turns one
    computer away is not asked again by the others. Sync now, pressed here, is never asked about.
    With no answer (offline, or a SageFin that does not know the question) the app syncs as it
    would with nobody to ask, and a "no" is only believed for fifteen minutes. The answer also carries when
    the member wants each retailer to sync by itself; a choice, unlike a "no", is remembered until
    the app is next told otherwise or restarted. And it carries the oldest version of the app
    SageFin still lets sync by itself (`belowMinimum` in `lib/version.mjs`): a copy older than
    that starts no scheduled sync and no requested one, says so beside each retailer, and leaves
    Sync now working. A minimum the app cannot read stops nothing.
- **SageFin can ask the app to start a sync, and only the member can make it ask.** The answer to a
  check-in may carry a sync the member asked for from the SageFin web app, signed in, by pressing
  Sync now beside this computer. The app runs it exactly as it runs a scheduled sync: out of the
  way, paced, stopping at the first refusal, never answering a robot check. It starts only where
  a scheduled sync would: the member has already synced that retailer here themselves, their
  choices allow it, the retailer has not turned a run away, and the last run did not meet a
  sign-in page. A request lapses after fifteen minutes and is handed over once, so a computer
  that wakes later does not run an old one. The request names a retailer and nothing else: it
  cannot point the app at an address, and it cannot read anything back.
  - *To GitHub, once an hour, and when you choose Check for Updates*, to ask whether this
    repository has published a newer version (`lib/updates.mjs`). That fetches a small public file and sends nothing about the member,
    their account or their orders.
- **A sync only moves between pages.** It loads the orders list and each order's page, one at a
  time and slowly. Where a list has no address for its later pages it presses the list's own Next
  button: Purchase history's at Walmart, the payments list's at Amazon. It never signs in, fills in a form, changes anything in
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
  there. A stand-in page (`SAGEFIN_DESKTOP_RETAILER_FIXTURE`) is only ever sent to a local SageFin.

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
charges a page, and its next page has no address. The Next Page button belongs to one of Amazon's
payments widgets, whose own script takes the press, fetches the next twenty and replaces the list
where it stands, without loading a page. So a run presses the button the way a person does, waits
for the list on the page to change, and reads it there: the request is the page's own, under the
run's marked user agent, never one the app composes. If that request is refused, the run stops
and so does its schedule. How far back is the same rule as Walmart's,
by the charges' dates. A run cut short starts again from the first page, since these pages have no
address to resume at; the fingerprints make reading them again cheap.

## Layout

| Path | What |
|---|---|
| `main/main.mjs` | The main process: the retailers window, one window per retailer, reading a loaded page |
| `main/shell.mjs` | The main window: loads the site and carries out `lib/site.mjs`'s decisions |
| `main/shell-preload.cjs` | The main window's bridge to the web app, on SageFin origins only |
| `build/` | The app icons a development run shows, and `make-icons.py`, which builds them from the logo. macOS gets its own (`icon-mac.png`): the Dock draws an icon as given, so it carries the rounded shape and margin |
| `main/preload.cjs` | The retailers window's only bridge: `status`, `open`, `onChanged` |
| `lib/site.mjs` | Which origins are SageFin, and where a navigation or a new window goes |
| `renderer/` | The retailers window and the "could not be reached" page, in the web app's own colours and type. No Node, no Electron, a strict CSP |
| `lib/retailers.mjs` | Per retailer: which pages to save, its robot check, its signed-out page |
| `lib/capture-store.mjs` | Captures on disk: one sealed payload and one record each |
| `lib/credential-store.mjs` | The upload-only token, sealed, one per site |
| `lib/uploader.mjs` | Sends saved pages oldest first and acts on the server's status |
| `lib/sync-plan.mjs` | Which orders a sync opens, when a scheduled run is due, and what is remembered between runs |
| `lib/background.mjs` | What closing the window does, and starting with the computer |
| `lib/check-in.mjs` | The five-minute check-in with SageFin: what is sent, and what the answer permits |
| `lib/consent.mjs` | The member's choices per retailer, and the gate they are |
| `lib/updates.mjs` | Where the app can update itself, and when it may restart to do it |
| `main/updates.mjs` | Looks for a newer release on GitHub, downloads it, and installs it on quit |
| `lib/html.mjs` | Makes a retailer's HTML page small enough to send |

`lib/` imports nothing from Electron, so its tests run with nothing installed.

## Updating itself

The update feed is this repository's latest published release: the release workflow attaches a
small manifest per system (`latest.yml`, `latest-linux.yml`) naming the version, the installer and
its SHA-512, which the app checks the download against. The app looks once an hour while it runs;
Check for Updates, on the tray icon and in the Retailers menu, looks now, and says what it found. An update is never installed
during a sync; the tray says it is waiting. Until the builds are code-signed there is no signature to check
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

```bash
npm run typecheck
```

checks the files that start `// @ts-check` against the types their comments declare. CI runs it
too. Nothing is compiled; the app runs the JavaScript as written.

```bash
npm run fuzz
```

runs the code that reads a retailer's page and address against generated ones (`fuzz/`, with
[fast-check](https://fast-check.dev)): that no page makes it throw, that nothing is saved from
anywhere but the retailer over https, and that an order a list names is only ever opened at the
retailer's own order page. It needs `npm ci` first; `npm test` needs nothing installed. CI runs it
too.

`SAGEFIN_DESKTOP_RETAILER_FIXTURE=<file.html>` makes every retailer's window open that local page instead of
the real site, so opening a retailer from the web app can be exercised without loading one. It may
also be a page a local server is serving (`http://localhost:<port>/…`), which is how reading a
page's own requests is exercised.

`SAGEFIN_DESKTOP_LOG_KEYS=<pattern>` prints, for each page as it is saved, the paths to the keys
whose names match the pattern, with the type and size of what is there. It never prints a value.
It is how a reader for a retailer's page is written against the page as the retailer really sends
it, when the fixtures here have had the member's own details taken out. An installed app ignores it.

`SAGEFIN_DESKTOP_SCHEDULE_EVERY_MINUTES=<n>` makes a scheduled sync due that many minutes after the
last finished one, where an installed app waits a day. It exists so the scheduled run can be watched
happening. The app still looks a minute after it starts and hourly after that, so set it and
restart: a retailer whose last sync finished longer ago than that runs at the first look. It is a
real sync of a real retailer, so use it once and take the setting off again. An installed app
ignores it.

A stand-in page is still a retailer's as far as the app's gate goes: saving and syncing wait for
the choice, as they do for the real one.

A development run against a local page instead of a retailer, which saves one capture and quits
(the one run that does not ask):

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

## Problems and changes

Found a bug, or want something the app does not do? Open
[an issue](https://github.com/bytefoo/sagefin-desktop/issues), with the version and your system.
Please do not attach a saved page or a screenshot of your orders: issues are public.

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) says what one needs.

## Security

Please report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

What is checked, and where to see it:

- **Code scanning.** [CodeQL](.github/workflows/codeql.yml) runs on every pull request, every push
  to `main` and weekly. The `codeql` badge above is its last run on `main`; a pull request cannot
  merge with it failing. GitHub shows the individual findings only to maintainers.
- **How the repository is run.** [OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/bytefoo/sagefin-desktop)
  scores it weekly and on every push to `main`, on things such as branch protection, pinned
  dependencies and workflow permissions. The score in the badge above is theirs, not ours, and
  each check behind it can be read there.
- **What the project says of itself.** The
  [OpenSSF Best Practices](https://www.bestpractices.dev/projects/15189) badge is a questionnaire
  the maintainer answers, on how changes, reports, tests and releases are handled. Each answer
  and the evidence given for it can be read there. It is self-certified: nobody else has checked
  it, which is what the Scorecard above is for.
- **Where a download was built.** Releases from the one after v0.1.19 carry a signed build
  provenance: a statement, recorded by GitHub and attached to the release as
  `provenance-<system>.intoto.jsonl`, that the file was built by this repository's
  [release workflow](.github/workflows/release.yml) from the tagged commit. With the
  [GitHub CLI](https://cli.github.com) you can check a file you downloaded:

  ```sh
  gh attestation verify SageFin-Desktop-win-x64.exe --repo bytefoo/sagefin-desktop
  ```

  This is not code signing, and does not change what each system asks on first run.
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
