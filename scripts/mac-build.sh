#!/usr/bin/env bash
# Builds the macOS app into dist/, after scripts/mac-signing.sh. Never publishes.
#
# Signed (MAC_SIGNED=true): builds and signs the key helper, then has electron-builder sign the app
# with the hardened runtime and the entitlements in build/, embed the provisioning profile,
# notarize the app and staple it, and sign the disk image. The disk image is then notarized and
# stapled here, and its block map and its entry in latest-mac.yml written again, because stapling
# changed the file electron-builder had hashed.
#
# Otherwise: ad-hoc signed as before, with no key helper, so the app holds no key on that Mac.
#
# Extra arguments go to electron-builder (the release passes none; a test build passes none either).
set -euo pipefail

if [ "${MAC_SIGNED:-false}" != "true" ]; then
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never "$@"
  exit 0
fi

: "${MAC_IDENTITY:?}" "${CSC_KEYCHAIN:?}" "${MAC_PROFILE:?}" "${MAC_API_KEY_FILE:?}"
: "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}"

native/macos/build.sh --sign "$MAC_IDENTITY" --profile "$MAC_PROFILE" --keychain "$CSC_KEYCHAIN"

# electron-builder notarizes with APPLE_API_KEY as a path to the key, APPLE_API_KEY_ID and
# APPLE_API_ISSUER.
APPLE_API_KEY="$MAC_API_KEY_FILE" npx electron-builder --mac --publish never \
  -c.mac.identity="$MAC_IDENTITY" \
  -c.mac.hardenedRuntime=true \
  -c.mac.notarize=true \
  -c.mac.provisioningProfile="$MAC_PROFILE" \
  -c.dmg.sign=true \
  "$@"

shopt -s nullglob
dmgs=(dist/SageFin-Desktop-*.dmg)
if [ "${#dmgs[@]}" -ne 1 ]; then
  echo "::error::expected one disk image in dist/, found ${#dmgs[@]}"
  exit 1
fi
dmg="${dmgs[0]}"

result=$(xcrun notarytool submit "$dmg" --key "$MAC_API_KEY_FILE" --key-id "$APPLE_API_KEY_ID" \
  --issuer "$APPLE_API_ISSUER" --wait --output-format json)
id=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
status=$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
echo "Disk image notarization $id: $status"
if [ "$status" != "Accepted" ]; then
  # Apple's log lists what it refused and where; it names files in the build, nothing secret.
  [ -n "$id" ] && xcrun notarytool log "$id" --key "$MAC_API_KEY_FILE" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" || true
  echo "::error::Apple did not accept the disk image"
  exit 1
fi
xcrun stapler staple "$dmg"
node scripts/restamp-update-info.mjs "$dmg" dist/latest-mac.yml
