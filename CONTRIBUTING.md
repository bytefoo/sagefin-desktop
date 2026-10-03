# Contributing

SageFin Desktop is a small project with one maintainer. Bug reports and pull requests are welcome.

## Reporting a problem or asking for something

Open [an issue](https://github.com/bytefoo/sagefin-desktop/issues). Say which version (the first
line of the menu bar or tray icon's menu), which system, and what you did and saw.

**Do not paste a saved page or a screenshot of your orders.** Issues are public, and a retailer's
page is your own purchases.

A security problem does not go in an issue: report it privately, as [SECURITY.md](SECURITY.md)
describes.

## Sending a change

1. Fork the repository and make a branch from `main`.
2. Make the change, with its tests (below).
3. Open a pull request into `main`. Say what changed and why, and how you checked it.

A pull request is merged by the maintainer, as one squashed commit, once its checks pass: the
tests, the fuzz tests, a packaged build that starts, and CodeQL.

## What a change needs

- **Tests.** Logic that can be decided without Electron goes in `lib/`, with a test beside it in
  `lib/*.test.mjs`. `lib/` imports nothing from Electron, so `npm test` runs with nothing
  installed; keep it that way. `main/` only carries out what `lib/` decided. A change to how a
  retailer's page or address is read should hold under `npm run fuzz` too.
- **The readme, when behaviour changes.** Its section "What it does, and what it deliberately does
  not" is a promise to the people who use the app and to the retailers. A change to any of it
  changes the readme in the same pull request.
- **Made-up data only.** No real order pages, order numbers, names or tokens, in tests, fixtures,
  commits or the pull request itself. A fixture built from a real page is real data.
- **No new dependencies in the app** without a reason in the pull request. It ships two, Electron
  and `electron-updater`; build and test tools are a lighter matter.
- **Pinned actions.** A GitHub Action is referenced by its full commit, with the version in a
  comment, as the existing workflows do.

## Running it

```bash
npm ci
npm test
npm run fuzz
npm start
```

The readme's [Run](README.md#run), [Test](README.md#test) and [Build](README.md#build) sections
have the rest.

## Licence

Contributions are accepted under the project's [MIT licence](LICENSE).
