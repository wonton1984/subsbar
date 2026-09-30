import Foundation
import Security

/// Keychain write channel (IPC freeze rev5 §7): Swift writes, Node reads with the same naming.
/// service is the final registry value; account = providerID:profileID, content = key only.
/// Errors are fixed codes; neither the key nor Keychain detail is ever put in a message.
public protocol CredentialStore: Sendable {
    func save(service: String, account: String, label: String, secret: Data) throws
}

public struct CredentialWriter: Sendable {
    public let store: CredentialStore
    public init(store: CredentialStore) { self.store = store }

    public static func account(providerID: String, profileID: String) -> String { "\(providerID):\(profileID)" }

    /// Form edit only: Node still performs schema validation and the CAS write.
    public static func connectionDraft(_ draft: Wire, guide: ConnectionGuide, profileID: String) throws -> Wire {
        guard guide.canPasteKey, let service = guide.credentialService, let reader = guide.credentialReader, !profileID.isEmpty else { throw LocalFailure("credential-unsupported") }
        var profiles = draft["profiles"].array
        let index = profiles.firstIndex { $0["id"].text == profileID }
        var profile = index.map { profiles[$0] } ?? .object(["id": .string(profileID), "allowBrowser": .bool(false), "allowLocalApi": .bool(false)])
        let source = Wire.object(["id": .string("subsbar-saved-key"), "kind": .string("keychain"), "reader": .string(reader), "purpose": .string("primary"), "service": .string(service), "account": .string(account(providerID: guide.providerID, profileID: profileID))])
        profile = profile.setting("allowKeychain", .bool(true)).setting("discovery", .string("only")).setting("sources", .array([source]))
        if let index { profiles[index] = profile } else { profiles.append(profile) }
        return draft.setting("enabled", .bool(true)).setting("activeProfile", .string(profileID)).setting("profiles", .array(profiles))
    }

    /// Trims surrounding whitespace/newlines from the pasted text; an empty key is rejected before touching the store.
    public func save(guide: ConnectionGuide, profileID: String, key: String) throws {
        guard guide.canPasteKey, let service = guide.credentialService, !profileID.isEmpty else { throw LocalFailure("credential-unsupported") }
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 4096, !trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw LocalFailure("credential-invalid")
        }
        do {
            try store.save(service: service, account: Self.account(providerID: guide.providerID, profileID: profileID),
                           label: "SubsBar credential", secret: Data(trimmed.utf8))
        } catch { throw LocalFailure("credential-save-failed") }
    }
}

public struct SecurityKeychainStore: CredentialStore {
    public init() {}
    public func save(service: String, account: String, label: String, secret: Data) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
        var add = query
        add[kSecValueData as String] = secret
        add[kSecAttrLabel as String] = label
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        var status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: secret, kSecAttrLabel as String: label] as CFDictionary)
        }
        guard status == errSecSuccess else { throw LocalFailure("keychain-write-failed") }
    }
}
