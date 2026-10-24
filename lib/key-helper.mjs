// @ts-check
// Which key helper this computer has, where it is, and what its operating system's prompt is
// called. main/key-store.mjs runs the helper; this decides which one, without Electron.
//
// - macOS: `SageFinKeys.app`, keys in the Secure Enclave, Touch ID or the login password
//   (native/macos/). A bundle in the app's Contents/Helpers, because the keychain entitlement it
//   needs is one macOS only honours with a provisioning profile.
// - Windows: `sagefin-keys.exe`, keys in the TPM, Windows Hello (native/windows/). A plain program
//   in the app's resources folder.
// - Anything else: none, and the computer holds no key.

import path from "node:path";

/**
 * Where this computer's key helper is, or null where there is none for its system.
 * @param {object} where
 * @param {string} where.platform       `process.platform`.
 * @param {boolean} where.packaged      Whether this is a built app (`app.isPackaged`).
 * @param {string} where.resourcesPath  The built app's resources folder (`process.resourcesPath`).
 * @param {string} where.sourceRoot     This repository, for a run from source.
 * @returns {string | null}
 */
export function helperPath({ platform, packaged, resourcesPath, sourceRoot }) {
  if (platform === "darwin") {
    const program = path.join("SageFinKeys.app", "Contents", "MacOS", "sagefin-keys");
    return packaged ? path.join(resourcesPath, "..", "Helpers", program) : path.join(sourceRoot, "native", "macos", "build", program);
  }
  if (platform === "win32") {
    return packaged ? path.join(resourcesPath, "sagefin-keys.exe") : path.join(sourceRoot, "native", "windows", "build", "sagefin-keys.exe");
  }
  return null;
}

/**
 * What the operating system's prompt is called, for the app's own sentences around it.
 * @param {string} platform  `process.platform`.
 */
export function presenceName(platform) {
  return platform === "win32" ? "Windows Hello" : "Touch ID";
}
