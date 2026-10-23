#!/usr/bin/env bash
# Removes what scripts/mac-signing.sh made: the job's keychain, the certificate, the profile and
# the notarization key. Run whatever happened before it.
set -uo pipefail
work="${RUNNER_TEMP:?}/mac-signing"
if [ -f "$work/signing.keychain-db" ]; then security delete-keychain "$work/signing.keychain-db"; fi
rm -rf "$work"
echo "Signing files removed."
