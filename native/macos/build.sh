#!/usr/bin/env bash
# Builds the key helper, SageFinKeys.swift, into native/macos/build/SageFinKeys.app.
#
#   native/macos/build.sh
#       Compiles it, for checking that it compiles. Not signed beyond the linker's own ad-hoc
#       signature and with no entitlements, so it cannot use the keychain: a build like this is
#       never packaged (electron-builder skips Contents/Helpers when the folder is not there).
#
#   native/macos/build.sh --sign <identity> --profile <file.provisionprofile> [--keychain <file>]
#       Also embeds the profile and signs the bundle with the identity (a name or SHA-1), the
#       hardened runtime, a secure timestamp and SageFinKeys.entitlements. The release workflow
#       runs this before electron-builder, which leaves the bundle's signature as it is.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
identity="" profile="" keychain=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sign) identity="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --keychain) keychain="$2"; shift 2 ;;
    *) echo "usage: $0 [--sign <identity> --profile <file> [--keychain <file>]]" >&2; exit 2 ;;
  esac
done
if [ -n "$identity" ] && [ -z "$profile" ]; then
  echo "--sign needs --profile: without it macOS refuses the keychain entitlement" >&2
  exit 2
fi

bundle="$here/build/SageFinKeys.app"
rm -rf "$here/build"
mkdir -p "$bundle/Contents/MacOS"

# Apple silicon only, as the app is; macOS 13 is the oldest the app's Electron runs on.
swiftc -O -swift-version 5 -warnings-as-errors \
  -target arm64-apple-macos13.0 \
  -o "$bundle/Contents/MacOS/sagefin-keys" "$here/SageFinKeys.swift"

version=$(node -p "require('$root/package.json').version")
cp "$here/Info.plist" "$bundle/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$version" "$bundle/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$version" "$bundle/Contents/Info.plist"
plutil -lint "$bundle/Contents/Info.plist" >/dev/null

if [ -z "$identity" ]; then
  echo "Built $bundle (not signed for use)"
  exit 0
fi

cp "$profile" "$bundle/Contents/embedded.provisionprofile"
codesign --force --options runtime --timestamp \
  --identifier app.sagefin.desktop.keys \
  --entitlements "$here/SageFinKeys.entitlements" \
  --sign "$identity" ${keychain:+--keychain "$keychain"} \
  "$bundle"
codesign --verify --strict --verbose=2 "$bundle"
echo "Built and signed $bundle"
