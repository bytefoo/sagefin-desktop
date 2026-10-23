// SageFin Desktop's key helper for macOS: the two keys this Mac holds for a private SageFin
// household, made in the Secure Enclave and used only after Touch ID or the login password.
//
// The app (main/key-store.mjs) runs it once per request and talks to it in JSON lines on stdin
// and stdout. It answers public keys, one raw P-256 agreement and one signature, and never a
// private key: the Enclave's keys cannot leave it, and what is kept in the keychain is the
// Enclave's own wrapped form, which opens on this Mac's Enclave and nowhere else.
//
//   sagefin-keys <service>                      then {"op":"public-keys"}, {"op":"create"} or
//                                                 {"op":"probe"}
//   sagefin-keys <service> --approve <sentence>  then {"op":"presence"}, {"op":"agree","peer":…},
//                                                 {"op":"sign","bytes":…}: at most one agreement,
//                                                 then one signature, which ends the approval
//
// One approval is one LAContext, evaluated with the sentence the app passed (from its fixed list),
// then one agreement and one signature with that context, then exit. The Enclave does not enforce
// "each time" by itself: a satisfied context allows every later use, so this program allows one
// of each and ends. It refuses while the screen is locked, which macOS reports as the context
// failing to evaluate.
//
// Built by native/macos/build.sh into SageFinKeys.app, which the signed macOS build carries in
// Contents/Helpers. It is a bundle, not a bare program, because the keychain entitlement it needs
// is one macOS only honours with a provisioning profile, and a profile lives in a bundle.

import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct Failure: Error { let code: String }

func answer(_ object: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ code: String) -> Never {
    answer(["error": code])
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2, !arguments[1].isEmpty else { fail("usage") }
let service = "app.sagefin.desktop.private-mode.\(arguments[1])"

// ── The keychain holds the Enclave's wrapped keys, this device only ──────────────────────────

/// The wrapped key under `account`, nil when there is none. A keychain that cannot be read is a
/// failure, not "no keys": answering it as none would have the app make new keys over old ones.
func stored(_ account: String) throws -> Data? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecUseDataProtectionKeychain as String: true,
    ]
    var item: CFTypeRef?
    switch SecItemCopyMatching(query as CFDictionary, &item) {
    case errSecSuccess:
        guard let data = item as? Data else { throw Failure(code: "keychain") }
        return data
    case errSecItemNotFound:
        return nil
    default:
        throw Failure(code: "keychain")
    }
}

func store(_ account: String, _ data: Data) throws {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecUseDataProtectionKeychain as String: true,
    ]
    SecItemDelete(query as CFDictionary)
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw Failure(code: "keychain") }
}

/// Whether this program may keep items in its keychain, found by writing and removing one that
/// holds no key, and whether this Mac has a Secure Enclave. Reading cannot tell: a program with no
/// keychain entitlement is told an item is not there, exactly as one with it is told on a Mac that
/// holds no keys yet. Writing is refused without the entitlement, so this is what shows the
/// signature, entitlements and profile work together, where no Enclave is there to make keys in.
func probe() throws -> [String: Any] {
    try store("probe", Data("probe".utf8))
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "probe",
        kSecUseDataProtectionKeychain as String: true,
    ]
    guard SecItemDelete(query as CFDictionary) == errSecSuccess else { throw Failure(code: "keychain") }
    return ["keychain": true, "secureEnclave": SecureEnclave.isAvailable]
}

/// Each use of a key needs a person: the Enclave refuses a key operation without a context that
/// Touch ID or the login password satisfied.
func accessControl() throws -> SecAccessControl {
    var error: Unmanaged<CFError>?
    guard let control = SecAccessControlCreateWithFlags(
        nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error)
    else { throw Failure(code: "access-control") }
    return control
}

func x963(_ key: P256.KeyAgreement.PublicKey) -> String { key.x963Representation.base64EncodedString() }
func x963(_ key: P256.Signing.PublicKey) -> String { key.x963Representation.base64EncodedString() }

/// Both public keys, or an empty answer when this Mac holds none. Keys that are stored and will not
/// open are a failure: they were made by another Enclave, or the keychain item is damaged.
func publicKeys() throws -> [String: Any] {
    guard let agreementData = try stored("agreement"), let signingData = try stored("signing") else { return [:] }
    guard let agreement = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: agreementData),
          let signing = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: signingData)
    else { throw Failure(code: "keys-unreadable") }
    return ["agreementPublicKey": x963(agreement.publicKey), "signingPublicKey": x963(signing.publicKey)]
}

func create() throws -> [String: Any] {
    guard SecureEnclave.isAvailable else { throw Failure(code: "no-secure-enclave") }
    let control = try accessControl()
    let agreement = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: control)
    let signing = try SecureEnclave.P256.Signing.PrivateKey(accessControl: control)
    try store("agreement", agreement.dataRepresentation)
    try store("signing", signing.dataRepresentation)
    return ["agreementPublicKey": x963(agreement.publicKey), "signingPublicKey": x963(signing.publicKey)]
}

func readStep() -> [String: Any]? {
    guard let line = readLine(), let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object
}

// ── Without --approve: the public keys, or new keys ───────────────────────────────────────────

if arguments.count == 2 {
    guard let step = readStep(), let op = step["op"] as? String else { fail("usage") }
    do {
        switch op {
        case "public-keys": answer(try publicKeys())
        case "create": answer(try create())
        case "probe": answer(try probe())
        default: fail("usage")
        }
    } catch let failure as Failure {
        fail(failure.code)
    } catch {
        fail("failed")
    }
    exit(0)
}

// ── With --approve: one person, one agreement, one signature ─────────────────────────────────

guard arguments.count == 4, arguments[2] == "--approve", !arguments[3].isEmpty else { fail("usage") }
let sentence = arguments[3]

guard let first = readStep(), first["op"] as? String == "presence" else { fail("usage") }
/// What macOS's prompt answered, set on its queue and read after the semaphore.
final class Approval: @unchecked Sendable { var granted = false }

let context = LAContext()
context.touchIDAuthenticationAllowableReuseDuration = 0
let approval = Approval()
let asked = DispatchSemaphore(value: 0)
// macOS shows: "SageFin Desktop is trying to <sentence>." (the name is this bundle's
// CFBundleDisplayName, in native/macos/Info.plist).
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: sentence) { ok, _ in
    approval.granted = ok
    asked.signal()
}
asked.wait()
guard approval.granted else { fail("cancelled") }
answer(["presence": true])

// Thirty seconds, then the process ends whatever is left, and the context with it.
DispatchQueue.global().asyncAfter(deadline: .now() + 30) { exit(0) }

var agreed = false
var signed = false
while let step = readStep(), let op = step["op"] as? String {
    do {
        switch op {
        case "agree" where !agreed:
            agreed = true
            guard let data = try stored("agreement"), let peerText = step["peer"] as? String, let peer = Data(base64Encoded: peerText)
            else { throw Failure(code: "no-keys") }
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: data, authenticationContext: context)
            let shared = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: peer))
            answer(["agreement": shared.withUnsafeBytes { Data($0) }.base64EncodedString()])
        case "sign" where !signed:
            signed = true
            guard let data = try stored("signing"), let bytesText = step["bytes"] as? String, let bytes = Data(base64Encoded: bytesText)
            else { throw Failure(code: "no-keys") }
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data, authenticationContext: context)
            answer(["signature": try key.signature(for: bytes).rawRepresentation.base64EncodedString()])
        default:
            throw Failure(code: "once")
        }
    } catch let failure as Failure {
        fail(failure.code)
    } catch {
        fail("failed")
    }
    // The signature is the last use of an approval, with or without an agreement before it.
    if signed { break }
}
context.invalidate()
exit(0)
