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
| macOS (Apple Silicon) | [SageFin-Desktop-mac-arm64.dmg](https://github.com/bytefoo/sagefin-desktop/releases/latest/download/SageFin-Desktop-mac-arm64.dmg) | Open it and drag SageFin Desktop to Applications |
| Windows | [SageFin-Desktop-win-x64.exe](https://github.com/bytefoo/sagefin-desktop/releases/latest/download/SageFin-Desktop-win-x64.exe) | "Windows protected your PC" → More info → Run anyway |
| Linux | [SageFin-Desktop-linux-x86_64.AppImage](https://github.com/bytefoo/sagefin-desktop/releases/latest/download/SageFin-Desktop-linux-x86_64.AppImage) | Mark it executable and run it |

Every version, with each file's SHA-256, is on [Releases](https://github.com/bytefoo/sagefin-desktop/releases).

These are early test builds. **The macOS app is signed with a Developer ID and notarized by
Apple**, so it opens as any downloaded app does (earlier releases were not, and need Open
Anyway in System Settings → Privacy & Security). **The Windows and Linux builds are not code-signed
yet**, which is why those systems warn about them. A warning you are asked to click through is a
reason to be careful: every build here is made by the [release workflow](.github/workflows/release.yml)
from this source, and you can check the file you downloaded against the SHA-256 on its release.

The app opens SageFin, where you need an account.

**Updates.** The app updates itself: it downloads a new version in the background and installs it
the next time it quits, or sooner if you choose Restart to Update from the tray icon (the menu bar
icon on a Mac). On macOS that starts with the first signed release that has it turned on; a copy
from an earlier release, signed or not, has its updater off, so download the newest build once and
drag it over the old one in Applications. From then on it updates itself, as long as it runs from
Applications rather than from the disk image.

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
  `setUpHistory(code)` opens a retailer's history for the member to set up
  ([below](#setting-up-your-history)), and `setBankHistory({ start, locked })` is the page handing over
  where the household's bank history starts, which it read with the member's own sign-in, for the
  strip that setup shows. The app never asks SageFin for it. `changeHowFarBack(code, day)` and
  `startHistoryOver(code)` are the retailers window's other two ways of setting a history up again
  (the `history-again` capability), answered only straight after a press on the page; the app
  checks the retailer and that the day is a real one no later than today.
  It exists only on a SageFin origin, and the main process checks the caller's frame and origin
  again before answering. Settings → Retail sync in the web app is where it shows. The same calls
  also answer under their older names (`stores()`, `openStore`, `syncStore`, `onStoresChanged`),
  for a web app that has not yet changed to the new ones.
- **If the site cannot be reached**, a local page says so and offers to try again.

A development run can open another site: `SAGEFIN_DESKTOP_SITE=test npm start`, or the Develop
menu. A packaged app opens production. Each site has its own browser profile.

The retailers window (Retailers → Retailers on This Computer) is the app's own page: what is saved here,
a button to open each retailer, and each retailer's history: whether it is set up, how far back, how
many orders are still to read, how many are set aside, how many wait to be listed again (below), and
the ways to set it up again.

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

On Windows and Linux the main window's menu bar is always shown, at the top of the window, so its
Retailers menu is somewhere a member can see; everything in it is also on the tray icon. macOS
keeps its menu at the top of the screen. Pop-ups, the unlock window and a retailer's window still
hide theirs until Alt is pressed.
- **The main window has Back and Forward.** View menu: Cmd+[ and Cmd+] on macOS, Alt+Left and
  Alt+Right elsewhere; the trackpad swipe on macOS (when System Settings allows swiping between
  pages); the mouse back and forward buttons on Windows. Each is greyed out when there is nowhere
  to go. They act on the SageFin window only, never a retailer's. `lib/history-nav.mjs` decides.
- **Starting with the computer is off by default**, and offered only in a packaged app on macOS
  and Windows (a development run would register Electron itself). Not exercised yet: nothing is
  packaged build has been run with it. On macOS 13 and later the system does not say that a start was a login start,
  so the window shows; on Windows a login start carries `--hidden` and stays in the tray.

The two choices are in `preferences.json` beside the captures folder, in the clear: neither is a
secret.

## Setting up your history

A retailer's history is loaded once, by the member, and kept up after that by small runs. The app
does not page back through years of orders by itself: Your Payments at Amazon has no address for
"after this point", so a run could only ever start again from the top, and on 2026-10-24 the first
run that scrolled it thirty times met Amazon's robot check, where ten never had. Walmart's terms
prohibit software gathering its pages, and the less of the history a run reads, the better.

- **Setup is the member's own browsing.** Set up history (in the retailers window, or Settings →
  Retail sync in SageFin) opens the retailer's history page, Your Payments or Purchase history, and
  the member scrolls down, or presses Next page, as far back as they want. The app saves what their
  browsing loads, exactly as it saves any page they open; nothing is pressed or scrolled for them.
- **A strip says how far.** Above the retailer's page, in a view of the app's own (the retailer's
  page is never drawn on or changed to make room): "Setting up your Amazon history · back to March 14,
  2025 · 96 orders so far", and where the household's bank history in SageFin starts, since an order
  older than that has nothing to match. Once the history reaches it, the strip says that covers all
  of it. The date is what the signed-in SageFin page handed over; when the household is locked in
  private mode and none was handed over, the strip says it cannot show it rather than guess.
  **Done** ends setup and closes the window. Closing the window instead keeps what was seen and how
  far it got, and setting up again carries on from there.
- **A robot check during setup is the member's.** It is their browsing, so the strip says to answer
  it in the window and carry on. A run never does (below).
- **Each order goes on a to-do list.** The charges and totals in the list reach SageFin at once,
  inside the saved list. What is left is each order's own page, for its items: the order's number,
  what the list said that its page's address depends on (at Walmart, whether it was bought in a
  store, and its group id) and a fingerprint go on a to-do list kept on this computer, sealed like
  everything else (`lib/history.mjs`, in the sync state). The address itself is not kept: a run
  builds it from those each time it opens the order. An order already read in the state the
  list shows is skipped, and the strip says how many were.
- **Setting it up again**, in the retailers window: *go further back* is setup again, skipping what
  was read, and trying again any order it passes that was set aside (below); *change how far back* takes the to-do list's orders older than a date off it, so they are
  never opened (its date box starts at how far back the history reads now: the last day given, or
  the oldest date setup reached, which the bridge also reports as `readsBackTo`); *start over* forgets the to-do list and every order and charge read here, and opens
  setup. None of them removes anything from SageFin: an order already there is removed only there.
- **A version that lists more asks for setup again.** A sync stops at the first charge it has read
  before, so an order an older version left out of the list (at Amazon, every digital order before
  v0.1.88) sits below charges already read, where no sync reaches. Its charges reached SageFin; its
  page never went on the to-do list. Such a setup is outdated (`listingVersion` in
  `lib/retailers.mjs`): each sync's result says to set the history up again, back as far as before,
  and that setup starts its count from nothing, so the strip says the bank history is covered only
  once the member's scrolling reaches it again. It skips what was read, and puts on the to-do list
  what the older version left out. Start over is not needed, and costs no more: before opening
  anything a sync asks SageFin about as much of the to-do list as one question carries, so orders
  this computer read before Start over are skipped rather than opened again.

## Syncing a retailer

**Sync now** in Settings → Retail sync opens a retailer's orders list, reads it until it is caught
up, then opens the next orders on the to-do list, one at a time. Each page is saved by the same
code that saves it when the member opens it; the sync only does the opening, from the member's
computer, in a window signed in by the member.

That window shows while the sync runs when the member may be needed at it: the first sync of a
retailer on a computer, and any sync after a run that did not reach its end. After a run that
finished, the next Sync now works out of the way, as the daily sync does. The card says what it is
doing, the window appears by itself if the retailer asks for a person, and Open shows it to anyone
who wants to watch (`showWindowForMemberSync` in `lib/sync-plan.mjs`).

- **Slowly, and not many.** Five seconds between pages, and twenty orders in a run, the newest on
  the to-do list first (`lib/sync-plan.mjs`, `nextToOpen` in `lib/history.mjs`). Listing stops as
  soon as the run is caught up, and never goes further than ten pages of Purchase history or five
  scrolls of Your Payments (`listPagesPerRun` in `lib/retailers.mjs`). A daily run usually reads one
  list page and opens none or one order.
- **Caught up, at Amazon, is the first charge already read.** Your Payments is newest first, and a
  refund, a late charge or a hold that has been charged arrives as a new row at the top. So a run
  reads the list until it meets a charge it has read before, and stops there. A charge is
  remembered as a SHA-256 of its orders, date and amount, kept here and never sent; a row still
  marked Pending is not a charge yet.
- **Caught up, at Walmart, is past an order already read and past thirty days.** An order there
  changes in place for weeks after it is placed (late shipments, substitutions, refunds), rather
  than arriving as a new row. So a run presses Next page until it has reached an order it knows
  *and* is past the thirty days in which orders still change (`settledListing`). Purchase history
  pages by a cursor the page holds, not by its address (loading `/orders?page=2` afresh shows the
  first five again), so a run goes to the next page the way a person does, by pressing the page's
  own **Next page** button, and reads the orders from the request the page then makes.
- **A backlog is cleared a run at a time.** A run that opens its full twenty with more left on the
  to-do list is followed an hour later rather than a day later, and so on until the list is empty: a
  long history is read over a day or so, each run as slow and as small as any other (`catchingUp` in
  `lib/sync-plan.mjs`).
- **Only what is new or changed.** The app remembers each order it has read with a fingerprint of
  the few list fields that change when the order does, and an order that has changed goes back on
  the to-do list. The whole list entry cannot be used: Walmart reorders parts of it on every load.
  At Amazon it is the order's charges, each a date and an amount, taken from every row of the order
  the run saw on any page of the list, and leaving out a charge still marked Pending.
- **A robot check stops the run at once.** The run ends, says so, and stops the schedule. It does
  not bring its window forward to ask anybody to answer the check, and does not wait for anyone to.
  Two order pages in a row that are not the order also end it, and say so. A page with no order on
  it (Walmart's header and nothing else) is not the order: the order is not counted as read, and
  stays on the to-do list. Neither is saved or sent: an order's page is kept only with an order on
  it (`keepsPage` in `lib/retailers.mjs`).
- **When a retailer is having problems, the run waits and tries again.** Walmart's "Sorry... We're
  having technical issues" page, Amazon's "Sorry! Something went wrong" page, or an order page
  answered with a server error (a 5xx, other than Amazon's 503, which is a refusal), says nothing
  about the order: it is not counted as a miss, not saved, and stays on the to-do list.
  Two such pages in a row pause the run ("Walmart is having technical issues, so the sync has
  paused"), and it is tried again by itself 20 minutes later, then an hour, then three hours, after
  which the schedule is the member's again (`notePause` in `lib/sync-plan.mjs`). A pause is not a
  refusal and does not stop the schedule; a retry starts only where a scheduled run would.
- **An order whose page never shows it is set aside, not opened forever.** Each run that finds no
  order on an order's page counts it against that order, and the next run opens it after every
  order that has not missed, so two such pages cannot end each run before it reaches the orders
  behind them. After three runs it is set aside: no run opens it again, and the card says how many
  are (`MAX_MISSES`, `nextToOpen` in `lib/history.mjs`). Its charges and total reached SageFin with
  the list; only its items are not read. It is tried again when the list shows it changed (a new
  fingerprint, or a new address, as an in-store purchase's became), or when the member's own
  browsing passes it while setting up the history. An order whose page is the retailer's error page
  every time is set aside the same way, after five runs that found it (`MAX_TROUBLES`): a run counts
  it once however often it opens the order, and opens an order with more of these after those with
  fewer, so two such orders cannot pause every run, and a day of the retailer's trouble is spread
  across the to-do list rather than setting aside the first orders on it.
- **An in-store Walmart purchase opens at its own address.** An order is taken to be one
  when Purchase history marks it `isInStore: true` or gives its type as `IN_STORE` (it does both,
  and an online order neither), and its page is filled only at `?groupId=…&storePurchase=true`; the app builds that
  address from what the list said, with the order number digits only and the group id digits or hex only, as
  it does every address it opens (`orderUrl` in `lib/retailers.mjs`). It builds it when the run
  opens the order, never from an address kept on the to-do list, so a version that built one wrongly
  does not leave every later version opening it.
- **An order kept by an older version is addressed from what it kept.** Up to v0.1.80 the to-do
  list kept each order's address, and v0.1.76 kept an in-store purchase's as an online order's,
  which Walmart cannot fill. Reading such a list, the app works out each order's facts from its
  address and number (`legacyFacts`): one ending `storePurchase=true` is an in-store purchase; one
  with a number shorter than any in-store purchase's is an online order, which every version
  addressed the same way; and a number of 20 digits or more with no `storePurchase` is taken to be
  an in-store purchase with group id `0`, because on 2026-10-26 every in-store purchase in Purchase
  history had a 20- or 21-digit number and group id `0`, and every online order 15 digits. Such an
  order opens at `?groupId=0&storePurchase=true` on the next run, with the misses counted against
  its old address dropped, so one set aside for that address comes back. If that page is empty too,
  three runs set it aside again like any other, and the list showing it later with its real facts
  (a run that reaches it, or setting up the history again past it) gives it a new address and no
  misses. Only an entry that still cannot be addressed (its kept address is not the order's own)
  waits for the list, is not opened and is not counted as set aside; the card says how many wait. Choosing Purchase
  history's own **In-store** filter while setting up (its address is `/orders?filterIds=in-store`)
  should reach them sooner: it is a Purchase history page, saved and listed like the rest, though
  not yet tried with the app. The app never loads that page itself.
- **A sign-in page stops the schedule on that computer.** A run that meets the retailer's sign-in
  page ends, shows the window, and is not repeated by the schedule: a run each hour that loads a
  sign-in page and leaves is a pattern a retailer could fairly read as a robot's. The next run is
  the member's own Sync now, once they have signed in. Unlike being turned away, this is the one
  computer's: another of the member's computers that is still signed in carries on
  (`scheduleStopped` in `lib/sync-plan.mjs`).
- **Turned away is final until the member says otherwise.** A robot check (by address or by its
  content), or any page answered with a refusal status (Walmart's 412 and 418, Amazon's 503), ends the
  run and stops the daily schedule. The orders list answered with any error status is a refusal
  too; only an order page's server error is the retailer having problems (above). The next run is the member's own Sync now; one of theirs that
  finishes starts the schedule again. A run never asks the member to complete a check for it: an
  agent never answers a CAPTCHA, and neither does a person on its behalf.
- **Daily, once the member has done it once.** After a sync the member started has finished, the
  app repeats it while it is running, in a window kept out of the way unless the retailer
  needs the member. It never starts a retailer's schedule by itself.
- **When, and how often, is the member's to choose.** With nothing chosen a retailer syncs again a
  day after its last sync finished. In SageFin's Retail sync settings the member can pick an hour
  of the day and how often: daily, every two or three days, or weekly. Never more often than
  daily, and an answer that asks for more is ignored, except while a backlog is cleared (above).
  The hour is on this computer's own clock.
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
retailer's terms prohibit permitted. It is kept for you, the person connected, and not for the
computer: see the next section.

## Whose memory it is

What a sync remembers (how far back the history is set up, the to-do list, the orders already
read) and the pages waiting to be sent belong to one SageFin household. Your choices about a
retailer's terms belong to you. So the app keeps each under whoever it belongs to
(`lib/owner.mjs`), not under the computer.

- **Who is connected is the credential.** SageFin binds the credential the signed-in page hands
  the app to one household and one person, and the page may say which (`householdId` and `userId`,
  beside the token; ids only, and anything else is ignored). Where the page does not say, the
  credential itself stands for both, so a new credential is treated as somebody new.
- **Another household starts with nothing.** A household deleted and made again, a member who
  moves to another household, or someone else connecting the computer: the retailers show no
  history set up, an empty to-do list and no pages waiting, and the first sync reads as a first
  sync does. The app never sends one household's waiting pages with another's credential
  (`lib/uploader.mjs`), and never takes an order as read because it was read for another household.
- **The last household's memory is kept for it,** sealed, when it can come back (the page said
  which household it was): move back, and its history and waiting pages are where they were. Memory
  known only by a credential that has been replaced can never be claimed, and is let go when the
  new one connects; the retailers window then says how many waiting pages were let go and not sent.
- **Your choices go with you.** Connected to another household, they still hold; someone else
  connecting the computer is asked for their own.
- **Losing the connection changes nothing.** The memory stays with the household it was for, and
  is not handed to whoever connects next.
- **Before the computer was ever connected**, what was kept is the first household's to connect.
- **Updating from a version that kept memory per computer:** at the first start with a
  credential, each retailer's memory is kept only where SageFin said it held what this computer
  read under exactly that credential, and no page from before is still waiting for that retailer.
  Anything else cannot be shown to be this household's, so it is let go: the retailer shows its
  history as not set up, and pages saved before the update and never sent are let go and not sent.
  Your choices are kept where some memory was, and asked again otherwise.

The memory of the browsing itself is not anyone's in this sense: each retailer's window keeps its
own sign-in, and what you call an account at Amazon (`lib/account-names.mjs`) names that sign-in on
this computer. Neither changes when the household does.

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
    Amazon sent it, with scripts, styles and images removed, and the answers to the one request
    Your Payments itself makes as it is scrolled (`get-transactions`), as Amazon sent them. Those
    are read from outside the page, through the DevTools protocol, as Walmart's are.
- **Nothing on a retailer's page is wrapped, injected or changed.**
- **Outside a sync it makes no request of its own to a retailer.** It saves what the member's own
  browsing loads.
- **It makes three requests by itself, and none carries anything from a page.**
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
    The answer also carries, for a household in private mode, whether it is locked and whether
    your bank has new activity (`privateMode`). That is a reason to ask you, never an unlock: see
    [Private mode on this computer](#private-mode-on-this-computer).
  - *To SageFin, when its window is shown, and only on a computer that holds a private household's
    key*: whether that household is locked (`GET /api/v1/private/status`), on the window's own
    sign-in. It sends nothing but the request, and the answer only decides whether the app's own
    unlock window may open, which it then does only if the page offers no way in of its own.
  - *To GitHub, once an hour, and when you choose Check for Updates*, to ask whether this
    repository has published a newer version (`lib/updates.mjs`). That fetches a small public file and sends nothing about the member,
    their account or their orders.
- **During a sync it asks SageFin which of the listed orders another of your computers has
  already read** (`lib/read-orders.mjs`), so a second computer does not open the order
  pages the first one opened. This is the one request, apart from sending the saved pages
  themselves, that carries something taken from a page. What it carries is a key per order: a
  SHA-256 over the retailer, the order number and the app's fingerprint of what the orders list
  showed. No order number in the clear, no item, price, date or address. The key is not a secret
  from SageFin, which already holds the order numbers in the pages this app sends it; it is there
  so this request carries nothing else. The app sends the keys of the orders this computer has
  read and the keys of the orders listed in front of it, and is told which of those it asked
  about are known. Those it skips; an order that has changed since has a different key and is
  opened again. SageFin answers only from computers of the same member on the same retailer
  account. With no answer the app opens what its own record says to. One limit worth knowing: a
  key says a computer *read* an order, not that the page has finished arriving at SageFin, so a
  computer that read orders and then could not send them delays those orders until it can.
  The answer also says how many keys SageFin holds, from this computer and from your computers
  on the same account, and a sync's first question asks only that, with nothing sent. That is
  how the app learns SageFin has lost what it read: restoring a household from a backup deletes
  the keys, and resetting one deletes the connection they were kept under, along with the orders
  this app sent. If SageFin holds none of this computer's keys under the connection it last held
  them for, or, under a new connection, none of the account's, the app forgets what it has read
  for that retailer, as **Start over** does, and the sync ends there without opening the
  retailer. Set the history up again to send the older orders back. A connection you revoke and
  replace keeps its keys at SageFin, so connecting again does not make the app forget.
- **A sync only moves between pages.** It loads the orders list and each order's page, one at a
  time and slowly. Where a list has no address for its later pages it does what a person does to
  see more: presses Purchase history's own Next button at Walmart, and at Amazon scrolls the
  payments list to its end, which is what makes the list fetch more. It never signs in, fills in a form, changes anything in
  the account, or composes a request the retailer's page would not make itself.
- **It does not disguise itself.** The user agent is Electron's own
  (`sagefin-desktop/<version> … Electron/…`). During an Amazon sync it also ends
  `Agent/SageFinDesktop`, which Amazon's terms ask of software acting by itself.
- **It stops at a robot check or a refusal**, says so, and does not try again by itself. It never
  answers a check, never waits for one to be answered, and never asks the member to answer one on a
  sync's behalf. During the member's own setup of their history, a check is theirs to answer, as on
  any page they open. A retailer's own error page is not a refusal: the run pauses, and is tried
  again a little later, at most three times in a row ([Syncing a retailer](#syncing-a-retailer)).
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
- **A page is filed under the SageFin the app was showing** when it was saved, and under the
  household its memory was for, and is sent only there, with that household's credential
  ([Whose memory it is](#whose-memory-it-is)). A stand-in page (`SAGEFIN_DESKTOP_RETAILER_FIXTURE`) is only ever sent to a local SageFin.

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
run opens it, then the details page of each order on the to-do list. Its later charges have no
address. Since Amazon rebuilt the page (seen on 2026-10-20), the list fetches more charges by itself
when its end is scrolled into view, with a request of its own (`get-transactions`, seen on
2026-10-24) whose answer is the next twenty charges as JSON: amount, date, order, status, payment
method, and a cursor. So a run scrolls to the end of the list the way a person does, and reads that
answer; the app never sends the request itself, and never uses the cursor, only sees whether there
is one. The request is the page's own, under the run's marked user agent. If it is refused, the run
stops and so does its schedule. A run starts from the top every time, since the list has no address
to resume at, and stops at the first charge it has read before. An order is opened at
`/gp/your-account/order-details`, the page SageFin's reader was proved against, not at the address
the answer gives (the printable summary for a retail order, another page for a digital one). A
digital order (D01-…: a Kindle book, a Prime Video rental, an app, a subscription or a membership)
is opened there too: Amazon draws it as the same order-details page, with its date, what was bought,
its total and how it was paid, which for a subscription bought in an iPhone app is "Billed through
Apple App Store". It counts towards the same twenty pages a run, and is stripped and sent like any
other order's page.

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
| `lib/sync-plan.mjs` | When a scheduled run is due, and what is remembered between runs |
| `lib/history.mjs` | Setting up the history, the to-do list of orders, when a run is caught up, the strip's words, and setting it up again |
| `renderer/strip.html`, `main/strip-preload.cjs` | The strip above a retailer's page during setup: the app's own page, in its own view, with Done |
| `lib/background.mjs` | What closing the window does, and starting with the computer |
| `lib/check-in.mjs` | The five-minute check-in with SageFin: what is sent, and what the answer permits |
| `lib/read-orders.mjs` | Asking SageFin which listed orders another computer has read: the key sent per order, and what the answer skips |
| `lib/consent.mjs` | The member's choices per retailer, and the gate they are |
| `lib/owner.mjs` | Whose memory it is: which household a sync's memory and waiting pages are for, whose choices apply, and what a change of either does |
| `lib/updates.mjs` | Where the app can update itself, and when it may restart to do it |
| `main/updates.mjs` | Looks for a newer release on GitHub, downloads it, and installs it on quit |
| `lib/html.mjs` | Makes a retailer's HTML page small enough to send |
| `lib/private-protocol.mjs` | SageFin's private-mode bytes, as a holder needs them: what it signs, seals and opens, the key envelope, the add-a-device check. Held to SageFin's own test vectors (`fixtures/private-mode-vectors.json`) |
| `lib/private-mode.mjs` | When the key may be used, what the prompt says, the notification's limits, and unlocking, Sync and lock and adding this computer |
| `lib/qr.mjs` | The QR code the phone scans to add this computer, made here at level M; every module held to the library SageFin's web app draws its codes with |
| `lib/first-holder.mjs` | For a member with no phone: making the household private on this computer, its recovery codes, and adding a device from here |
| `main/private-mode.mjs` | The unlock window, the menu items and the notification |
| `main/key-store.mjs`, `native/macos/` | The keys in the Mac's Secure Enclave, behind Touch ID |
| `lib/key-helper.mjs`, `native/windows/` | Which helper a system has; the keys in a Windows computer's TPM, behind Windows Hello |

`lib/` imports nothing from Electron, so its tests run with nothing installed.

## Private mode on this computer

**Not released yet:** this is on its way to a release, and until it is in one, nothing below
happens on any computer: a private household's window is unlocked by the member's phone, the way a
browser's is. The macOS key helper is built and signed with the app by the release workflow
(`native/macos/build.sh`): a small bundle in the app's `Contents/Helpers`, `SageFinKeys.app`, with
its own copy of the app's Developer ID provisioning profile, because macOS honours the keychain
entitlement it needs only with one. A build without the signing secrets (a fork, a pull request)
leaves the helper out, and that Mac holds no key. The Windows key helper is built by the same
workflow (`native/windows/build.sh`) into the app's resources folder, `sagefin-keys.exe`, and is
not code-signed, as the Windows installer is not.

In SageFin's private mode a household's data is encrypted with a key only its members' devices
hold. On a Mac or a Windows computer this app can be one of those devices, so its own window opens
without reaching for the phone. What it holds itself to, in this source:

- **The key lives in the computer's security chip, or the computer holds none.** On a Mac, two
  keys made in the Secure Enclave by a small helper (`native/macos/SageFinKeys.swift`): one to
  agree a key with, one to sign with. They cannot leave the Enclave, and each use needs Touch ID or
  the login password, asked by macOS itself. On Windows, the same two keys made in the TPM by a
  helper of its own (`native/windows/`), which cannot leave the TPM, and each use needs Windows
  Hello; how, and where that is weaker than the Mac, is [below](#on-windows-what-the-tpm-and-windows-hello-protect).
  Linux holds none. **The operating system's keychain alone is never used for this key**: it keeps
  a value from other people's accounts, not from a program running as you.
- **It asks you every time.** Each unlock is one prompt, one key agreement and one signature, with
  a sentence from a fixed list in `lib/private-mode.mjs`. Making a household private here asks
  twice, and adding a device once (below). Never while the screen is locked, the
  window hidden or behind another, or another prompt is showing.
- **The page may ask; only the operating system's prompt approves.** The window shows SageFin's
  web app, which SageFin's server serves, so nothing the page asks for counts as you. The page may
  ask the bridge six things: whether this computer holds a key of the household it names (a yes
  or no; no key, device id or anything else comes back); to unlock this window, which is what its
  **Unlock with Touch ID on this computer** (or **Windows Hello**) button does; to show the app's
  unlock window; to start adding this computer as the menu does; and to open the app's own
  **Make This Household Private…** or **Add a Device…** window, as the menu does, after which
  everything happens in that window and nothing on the page. An unlock the page asks for
  goes straight to Touch ID or Windows Hello, and on approval is the same unlock the unlock
  window's own button runs (`unlockAskedByPage`): this window only, with the fixed sentence for
  it, and only for the household this computer holds a key of. The page sends nothing that is
  put in the prompt or the request, and hears back only how it ended (`unlocked`, `cancelled`,
  `refused`, `failed` or `not-now`). The last five asks are carried out only straight after a
  real press on the page (`navigator.userActivation`, which a script cannot fake), with its window
  in front and the screen unlocked, with no prompt or unlock window already showing, and never
  twice within ten seconds (`whyIgnorePageAsk`), so a page cannot keep a prompt in front of you.
  A page can therefore put the prompt in front of you once after you pressed something on it;
  it can never answer it. Unlocking also starts from the app's own unlock window (a page from the
  app's own files, `renderer/unlock.html`), which the menu's **Unlock SageFin…** opens.
- **The unlock window opens by itself only where the page offers no way in.** When the window
  comes up locked on a computer that holds the household's key, the app waits up to eight seconds
  (`unlockWindowOnShow`). SageFin's locked page asks whether this computer holds a key as it
  appears, and then draws its own way in: the one-press Touch ID or Windows Hello button, or your
  phone's code. So once it has asked, during this load of the page, nothing opens over it. A page
  that has not asked by then, from a web app older than that, gets the unlock window as before, so
  nobody is left without a way in. Asking changes nothing else: the answer is the same yes or no,
  and the page's other asks keep every limit above.
- **It unlocks its own window, and Sync and lock, and no other session.** The app asks SageFin for an
  unlock on the window's own sign-in, checks the answer says that sign-in asked, and approves it
  on the same sign-in. It never takes a request id from anywhere else, so it can never let in a
  browser somewhere else: your phone approves those. It never replaces your recovery codes or
  gives another member a key, and it adds a device only for a member who has no phone (below).
  SageFin's server refuses this computer's approval of anything else too.
- **New bank activity is a question.** When the check-in says your household is locked and your
  bank has new activity, the app shows a notification, "Your bank has new activity". It shows one
  per locked period and never two within six hours, and it counts these itself, so SageFin cannot
  make it ask more often. Clicking it opens the unlock window for a Sync and lock, and Touch ID
  or Windows Hello approves that. Nothing unlocks while you are away.
- **Adding this computer is your phone's to approve.** From the menu, Use This Computer to Unlock
  SageFin, or Add this computer on SageFin's locked page, which asks the app to open the same
  thing: the app makes its two keys and shows a QR code for your phone to scan (Settings →
  Security → Devices → Add a device), with the same code beside it to type if the camera cannot
  read it, then twelve characters that both screens show. Add it only
  if they match. Your phone signs what the computer is and where its keys are, and SageFin keeps
  that. Removing the computer on your phone stops it unlocking.
- **With no phone, this computer can be the first.** From the menu, **Make This Household
  Private…** (or SageFin's Settings page, which asks the app to open the same window): the app
  checks SageFin says the household may go private, makes two new keys in the security chip and
  four recovery codes, and shows the codes once. You write them down and type one back; they are
  never sent, never stored, and forgotten when the window closes. Then Touch ID or Windows Hello
  asks twice (`lib/first-holder.mjs`): once to sign the household's new holders (this computer,
  what it is and where its keys are, and the four codes, `setup-holders-v2`), and once to open the
  new key from SageFin's draft and prove it, after checking that draft holds exactly this computer
  and those four codes. Your household is then private and locked, and this computer unlocks it.
  **SageFin then opens only in this app's window on a computer that holds the key**: no browser,
  no phone notifications, and bank syncs wait until you unlock here. Losing the only computer
  without the recovery codes loses the household. A recovery code brings it back on a phone.
- **Adding a device from a computer**, for a member with no phone. **Add a Device…** asks for the
  code the new phone or computer shows under its QR code, reads its keys and commitment, and only
  then sends this computer's half of the check. When the new device reveals its half, and it
  opens what the device committed to, both screens show twelve characters; you confirm each group
  in turn, and Touch ID or Windows Hello asks once before this computer signs the device by its
  name and keys (a computer also by what it is and whose it is, `holder-add-v2`). Once you have a
  phone that holds the key, SageFin refuses this from a computer: the phone adds devices then.
- **A record of every use stays on this computer** (`private-mode/private-mode.json` beside the
  captures folder): when, what for, and how it ended. SageFin cannot erase it. That file holds
  which household and which device this computer is, and its notices. None of these is a secret.

### On Windows: what the TPM and Windows Hello protect

Windows has no single place that does what a Mac's Secure Enclave does for this. Its TPM can make
a P-256 key that never leaves it, but the only lock it puts on that key is a password; Windows
Hello asks for your face, fingerprint or PIN, but its keys are RSA, sign only, and cannot agree a
key. The helper (`native/windows/`) joins the two:

- It makes a Windows Hello key, and the two P-256 keys in the TPM (through Windows's Platform
  Crypto Provider), neither of which can be exported. The TPM uses each P-256 key only with a
  password, and **the passwords are stored nowhere**: each is derived (HKDF-SHA-256) from a
  signature the Windows Hello key makes over a fixed sentence.
- Each use starts a new helper process, which asks Windows Hello for that signature. Windows
  shows its own prompt and signs only after you answer it; the helper then derives the passwords,
  does one agreement and one signature, and exits. A program that cannot get past Windows Hello
  cannot get the signature, and without it the TPM refuses the keys: the TPM checks the password,
  not this app. Every use of a TPM key is silent, so a missing or wrong password is refused rather
  than answered by Windows's older "password for this key" box, which is not Windows Hello.
- Adding this computer asks Windows Hello twice: once to make its key (that approval also covers
  the signature that sets the TPM passwords), and once to sign the request to be added.
- It refuses over Remote Desktop, and on a computer whose Windows Hello key Windows cannot vouch
  is in its TPM, and then the computer holds no key.

**What this does not protect, and the Mac does:**

- **The passwords pass through the helper's memory each time.** On a Mac the Secure Enclave checks
  Touch ID itself and nothing leaves it. On Windows the derived passwords exist, for the moment of
  one use, in a program running as you. Malware already running as you that read them then could
  use the keys afterwards without Windows Hello. It still could not take the keys off this
  computer: they stay in the TPM, and the TPM limits how fast passwords can be guessed.
- **It relies on Windows Hello's signatures coming out the same each time.** RSA signatures of the
  kind Windows Hello makes (PKCS#1 v1.5) are deterministic, but Microsoft does not promise that
  Windows Hello's will stay so. If one ever changes, the keys stop opening. A check value kept
  beside the keys (`%LOCALAPPDATA%\SageFin Desktop Keys`, not a secret) notices before the TPM is
  asked, so a wrong password never counts against the TPM's lockout; you then add the computer
  again from your phone. Nothing is lost: your other devices still unlock.
- **Removing or resetting Windows Hello removes the key.** Windows deletes Windows Hello keys with
  the PIN, and the TPM keys cannot open without it. The computer then holds no key, and you add
  it again from your phone.
- **Windows Hello's prompt does not say what it is for.** It shows Windows's own words. The
  sentence from `lib/private-mode.mjs` is on the app's unlock window, in front of it, when that
  window started it; when the locked page's own Unlock with Windows Hello button did, what says
  what for is that button, which only ever unlocks this window.
- **The helper is not code-signed**, as the installer is not.

To check it on a Windows computer with a TPM and Windows Hello set up, at the computer itself:

```bash
native/windows/build.sh --self-test   # the TPM side, with throwaway keys; no prompt
node native/windows/hello-check.mjs   # three Windows Hello prompts, each to approve
```

## Updating itself

The update feed is this repository's latest published release: the release workflow attaches a
small manifest per system (`latest.yml`, `latest-linux.yml`, `latest-mac.yml`) naming the version,
the installer and its SHA-512, which the app checks the download against. The app looks once an hour while it runs;
Check for Updates, on the tray icon and in the Retailers menu, looks now, and says what it found. An update is never installed
during a sync; the tray says it is waiting. Windows and Linux builds are not code-signed, so there is
no signature to check beyond that hash, fetched over HTTPS from GitHub.

On macOS the download is the release's `.zip`, and macOS's own updater (Squirrel.Mac, which
`electron-updater` hands it to) installs it only if the new app, every program inside it included,
is signed to satisfy the running app's *designated requirement*: the bundle id `app.sagefin.desktop`,
a Developer ID certificate issued by Apple, and SageFin's team, `J66FLD86SU`. That check cannot be
turned off, so an update signed by anyone else, or altered after signing, is refused, whatever its
hash. The app turns its updater on only when its own requirement is that one, read at start with
the system's `codesign` (nothing leaves the computer): an ad-hoc signed copy's requirement is its
own code hash, which no other build can meet, so it would download every update and install none.
The release build checks the same of the zip it publishes, before uploading it
(`scripts/mac-build.sh`).

The keys a Mac holds for a private household come through an update unchanged. The Secure
Enclave's keys are bound to the Mac, not the app, and what the keychain holds is their wrapped
form, in the data protection keychain under the access group `J66FLD86SU.app.sagefin.desktop`.
An update replaces the whole app, the key helper in `Contents/Helpers` with it, by one built and
signed the same way: the same team, the same App ID and access group in its entitlements and
provisioning profile, so the new helper reads the items the old one stored. The app's other files,
in `~/Library/Application Support`, are not part of the app and are not touched.

The Mac build is for Apple silicon only, as the key helper is, and there is no Intel build to
update to.

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
