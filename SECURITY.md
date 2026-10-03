# Security

SageFin Desktop holds retailer sign-ins on your computer and sends saved order pages to SageFin, so a
flaw here matters.

## Reporting a vulnerability

Report it privately through GitHub: open
[a private vulnerability report](https://github.com/bytefoo/sagefin-desktop/security/advisories/new)
(**Security → Report a vulnerability** on this repository). Only the maintainers can read it. Please
do not open a public issue or pull request for it.

Say what you found, how to reproduce it, and which version or commit.

## What happens next

This is a small project with one maintainer, so these are honest targets, not guarantees:

- **Within 3 days:** a reply saying the report has been read.
- **Within 14 days:** whether it is confirmed, and what the plan is.
- **Within 90 days of the report:** a fix released and the advisory published, with credit to you
  unless you would rather not be named. If a fix needs longer, you will be told why before then;
  after 90 days you are free to publish what you found.

Please keep the details private until the fix is released or the 90 days are up, whichever is first.

## Supported versions

Only the [latest release](https://github.com/bytefoo/sagefin-desktop/releases/latest) is fixed.
There are no maintenance branches: a fix ships as the next release, and on Windows and Linux the
app updates itself to it.

## What is in scope

- Anything that lets a page other than SageFin's reach the app's bridge, a saved page, or the
  upload token.
- Anything that sends a saved page, a retailer sign-in or the token anywhere but the SageFin site it
  was saved under.
- Anything that makes the app load or act on a retailer's pages beyond what the readme says it does.

A problem in SageFin's servers or web app is not in this repository, but report it the same way.
