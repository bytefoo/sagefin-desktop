// SageFin Desktop's key helper for macOS: the two keys this Mac holds for a private SageFin
// household, made in the Secure Enclave and used only after Touch ID or the login password.
//
// The app (main/key-store.mjs) runs it once per request and talks to it in JSON lines on stdin
// and stdout. It answers public keys, one raw P-256 agreement and one signature, and never a
// private key: the Enclave's keys cannot leave it, and what is kept in the keychain is the
// Enclave's own wrapped form, which opens on this Mac's Enclave and nowhere else.
//
//   sagefin-keys <service>                      then {"op":"public-keys"} or {"op":"create"}
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
// NOT BUILT OR RUN YET. It needs the app to be signed with a Developer ID and the keychain
// entitlement, a build step in the release workflow, and a run on a Mac with Touch ID.

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

func stored(_ account: String) -> Data? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecReturnData as String: true,
        kSecUseDataProtectionKeychain as String: true,
    ]
    var item: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess ? item as? Data : nil
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

func publicKeys() -> [String: Any] {
    guard let agreementData = stored("agreement"), let signingData = stored("signing"),
          let agreement = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: agreementData),
          let signing = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: signingData)
    else { return [:] }
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
        case "public-keys": answer(publicKeys())
        case "create": answer(try create())
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
let context = LAContext()
context.touchIDAuthenticationAllowableReuseDuration = 0
var approved = false
let asked = DispatchSemaphore(value: 0)
// macOS shows: "SageFin Desktop is trying to <sentence>."
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: sentence) { ok, _ in
    approved = ok
    asked.signal()
}
asked.wait()
guard approved else { fail("cancelled") }
answer(["presence": true])

// Thirty seconds, then the context is spent whatever is left.
DispatchQueue.global().asyncAfter(deadline: .now() + 30) {
    context.invalidate()
    exit(0)
}

var agreed = false
var signed = false
while let step = readStep(), let op = step["op"] as? String {
    do {
        switch op {
        case "agree" where !agreed:
            agreed = true
            guard let data = stored("agreement"), let peerText = step["peer"] as? String, let peer = Data(base64Encoded: peerText)
            else { throw Failure(code: "no-keys") }
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: data, authenticationContext: context)
            let shared = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: peer))
            answer(["agreement": shared.withUnsafeBytes { Data($0) }.base64EncodedString()])
        case "sign" where !signed:
            signed = true
            guard let data = stored("signing"), let bytesText = step["bytes"] as? String, let bytes = Data(base64Encoded: bytesText)
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
