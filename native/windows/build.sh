#!/usr/bin/env bash
# Builds the Windows key helper (Program.cs, Tpm.cs, SelfTest.cs) into
# native/windows/build/sagefin-keys.exe: one native x64 program, compiled ahead of time with
# .NET's Native AOT, so the computer needs no .NET installed. Run on Windows, in Git Bash, with
# the .NET 10 SDK and Visual Studio's C++ build tools (Native AOT links with them).
#
#   native/windows/build.sh              builds it
#   native/windows/build.sh --self-test  builds it, then runs its own check of the TPM side,
#                                        which shows no prompt (sagefin-keys --self-test)
#
# The program is not code-signed, as the Windows installer is not: there is no Windows signing
# certificate yet. electron-builder carries it into the app's resources folder (package.json's
# win.extraResources), and main/key-store.mjs runs it from there.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
self_test=""
case "${1:-}" in
  "") ;;
  --self-test) self_test=1 ;;
  *) echo "usage: $0 [--self-test]" >&2; exit 2 ;;
esac

# Native AOT finds the linker with vswhere, which Visual Studio installs but does not put on PATH.
PATH="$PATH:/c/Program Files (x86)/Microsoft Visual Studio/Installer"

version=$(cd "$root" && node -p "require('./package.json').version")
rm -rf "$here/build" "$here/bin" "$here/obj"
dotnet publish "$here/SageFinKeys.csproj" -c Release -o "$here/build" \
  -p:Version="$version" -p:DebugType=none -p:DebugSymbols=false --nologo
rm -rf "$here/bin" "$here/obj"
test -f "$here/build/sagefin-keys.exe"
echo "Built $here/build/sagefin-keys.exe"

if [ -n "$self_test" ]; then
  "$here/build/sagefin-keys.exe" --self-test
fi
