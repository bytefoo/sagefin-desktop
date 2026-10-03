# Security

SageFin Desktop holds store sign-ins on your computer and sends saved order pages to SageFin, so a
flaw here matters.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this repository. Please
do not open a public issue for it.

Say what you found, how to reproduce it, and which version or commit. You will get a reply as soon
as it has been read; this is a small project, so allow a few days.

## What is in scope

- Anything that lets a page other than SageFin's reach the app's bridge, a saved page, or the
  upload token.
- Anything that sends a saved page, a store sign-in or the token anywhere but the SageFin site it
  was saved under.
- Anything that makes the app load or act on a store's pages beyond what the readme says it does.

A problem in SageFin's servers or web app is not in this repository, but report it the same way.
