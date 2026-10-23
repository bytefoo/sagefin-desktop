#!/usr/bin/env bash
# Sets up Developer ID signing for a macOS build in GitHub Actions, or decides there is none.
#
# Reads the six signing secrets from the environment: CSC_LINK (the .p12, base64), CSC_KEY_PASSWORD,
# MAC_PROVISIONING_PROFILE (base64), APPLE_API_KEY (the .p8's text), APPLE_API_KEY_ID and
# APPLE_API_ISSUER. With none of them, or on a pull request, the build is ad-hoc signed as it
# always was, so a fork or a pull request still builds. With some and not all, it stops: half a set
# is a mistake, not a choice.
#
# Writes to $GITHUB_ENV, and never a secret: MAC_SIGNED (true or false), and when true
# MAC_IDENTITY (the certificate's SHA-1), CSC_KEYCHAIN (a keychain made for this job, which
# electron-builder signs from), MAC_PROFILE and MAC_API_KEY_FILE (paths). scripts/mac-signing-end.sh
# removes all of it.
set -euo pipefail

names=(CSC_LINK CSC_KEY_PASSWORD MAC_PROVISIONING_PROFILE APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER)
present=0
for name in "${names[@]}"; do
  if [ -n "${!name:-}" ]; then present=$((present + 1)); fi
done

if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ] || [ "$present" -eq 0 ]; then
  echo "MAC_SIGNED=false" >> "$GITHUB_ENV"
  echo "No signing secrets here: the macOS build is ad-hoc signed and not notarized."
  exit 0
fi
if [ "$present" -ne "${#names[@]}" ]; then
  for name in "${names[@]}"; do
    if [ -z "${!name:-}" ]; then echo "::error::$name is not set"; fi
  done
  exit 1
fi

work="$RUNNER_TEMP/mac-signing"
mkdir -p "$work"
chmod 700 "$work"

keychain="$work/signing.keychain-db"
# A random password for a keychain that lives as long as this job; it is never printed.
keychain_password=$(uuidgen)
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
printf '%s' "$CSC_LINK" | base64 -D > "$work/cert.p12"
security import "$work/cert.p12" -k "$keychain" -P "$CSC_KEY_PASSWORD" -f pkcs12 \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
rm -f "$work/cert.p12"
# Lets codesign use the key without a prompt nobody is there to answer.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# Searched as well as the user's own, so codesign and notarytool find the identity's chain.
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

identity=$(security find-identity -v -p codesigning "$keychain" | awk '/"Developer ID Application: / { print $2; exit }')
if [ -z "$identity" ]; then
  echo "::error::CSC_LINK holds no valid Developer ID Application identity"
  exit 1
fi
security find-identity -v -p codesigning "$keychain" | grep 'Developer ID Application'

profile="$work/embedded.provisionprofile"
printf '%s' "$MAC_PROVISIONING_PROFILE" | base64 -D > "$profile"
security cms -D -i "$profile" > "$work/profile.plist"
echo "Profile: $(/usr/libexec/PlistBuddy -c 'Print :Name' "$work/profile.plist"), expires $(/usr/libexec/PlistBuddy -c 'Print :ExpirationDate' "$work/profile.plist")"

api_key="$work/AuthKey.p8"
printf '%s\n' "$APPLE_API_KEY" > "$api_key"
chmod 600 "$api_key"

{
  echo "MAC_SIGNED=true"
  echo "MAC_IDENTITY=$identity"
  echo "CSC_KEYCHAIN=$keychain"
  echo "MAC_PROFILE=$profile"
  echo "MAC_API_KEY_FILE=$api_key"
} >> "$GITHUB_ENV"
echo "Signing with the Developer ID above; the build will be notarized."
