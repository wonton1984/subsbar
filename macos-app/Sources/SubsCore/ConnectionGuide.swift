import Foundation

/// User-facing projection of a provider's connection story. Pure presentation:
/// registry/manifest data is read, never changed, and reader ids never reach the default view.
/// Login commands and guidance text come from the registry `login` projection; nothing is hardcoded here.
public struct ConnectionGuide: Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// Log in with the provider's own CLI/app, then let SubsBar detect it.
        case login
        /// Needs an API key pasted into SubsBar's own Keychain item.
        case apiKey
        /// Reads the signed-in desktop app; nothing to do here besides signing in there.
        case appSession
        case unsupported
    }
    public let providerID: String
    public let name: String
    public let kind: Kind
    public let primaryTitle: String
    public let instruction: String
    /// Set only for verified `login.mode == "command"` projections.
    public let command: String?
    /// Official page for guide-only providers.
    public let url: String?
    /// Guide-only text that the maintainers have not verified yet.
    public let unverified: Bool
    /// Final Keychain service supplied by Node registry; never expanded in Swift.
    public let credentialService: String?
    public let credentialReader: String?
    public var canPasteKey: Bool { kind == .apiKey && credentialService != nil }

    public init(manifest: Wire, name: String) {
        let id = manifest["providerId"].text
        providerID = id; self.name = name
        let login = manifest["login"]
        let verifiedCommand: String? = {
            guard login["mode"].text == "command", login["verified"].bool, let program = login["command"].string else { return nil }
            return ([program] + login["args"].array.map(\.text)).map(Self.shellWord).joined(separator: " ")
        }()
        let keyReader = manifest["credentialReaders"].array.first {
            $0["implemented"].bool && $0["owner"].text == "subsbar" && $0["kind"].text == "keychain" &&
            $0["credentialKinds"].array.contains(.string("api-key")) && $0["purposes"].array.contains(.string("primary")) &&
            !$0["id"].text.isEmpty && !$0["credentialService"].text.isEmpty && !$0["credentialService"].text.contains("<")
        }
        credentialService = keyReader?["credentialService"].string
        credentialReader = keyReader?["id"].string
        if !manifest["supported"].bool {
            kind = .unsupported; primaryTitle = "尚不支持"; command = nil; url = nil; unverified = false
            instruction = "\(name) 暂时无法读取用量，后续版本支持。"
            return
        }
        let kinds = Set(manifest["credentialReaders"].array.flatMap { $0["credentialKinds"].array.map(\.text) })
        kind = kinds.contains("api-key") ? .apiKey : .login
        command = verifiedCommand
        let proposedURL = login["url"].string.flatMap(URL.init(string:))
        url = proposedURL?.scheme == "https" && proposedURL?.host != nil ? proposedURL?.absoluteString : nil
        unverified = !login["verified"].bool
        let steps: String
        if let verifiedCommand { steps = "在终端运行 \(verifiedCommand)，按提示完成登录。" }
        else if let note = login["note"].string, !note.isEmpty { steps = note + (login["note"].text.hasSuffix("。") ? "" : "。") }
        else { steps = "请先在 \(name) 官方应用或命令行中完成登录。" }
        switch kind {
        case .login, .appSession:
            primaryTitle = "登录 \(name)"
            instruction = steps + "完成后回到这里点「我已完成，检测连接」。"
        case .apiKey:
            primaryTitle = "粘贴 API Key"
            instruction = (credentialService != nil ? "粘贴 \(name) 的 API Key，只保存在本机钥匙串中。也可按以下指引登录：" : "\(name) 使用 API Key 连接。") + steps
        case .unsupported:
            primaryTitle = "尚不支持"; instruction = ""
        }
    }

    private static func shellWord(_ value: String) -> String {
        let safe = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-")
        if !value.isEmpty && value.unicodeScalars.allSatisfy({ safe.contains($0) }) { return value }
        return "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    /// One sentence for a connected card, from the source discovery actually resolved.
    public static func sourceSentence(manifest: Wire, name: String) -> String? {
        let readers = manifest["credentialReaders"].array
        for profile in manifest["profiles"].array {
            for source in profile["sources"].array where source["availability"].text == "resolved" {
                if let reader = readers.first(where: { $0["id"].text == source["reader"].text }) {
                    return "凭证来源：" + label(reader: reader, name: name)
                }
            }
        }
        return nil
    }

    public static func label(reader: Wire, name: String) -> String {
        switch reader["kind"].text {
        case "cli": return "\(name) 命令行登录"
        case "file": return "\(name) 本机登录信息"
        case "keychain": return reader["owner"].text == "subsbar" ? "SubsBar 已保存的凭证" : "系统钥匙串中的登录信息"
        case "env": return "环境变量中的密钥"
        case "pi": return "Pi 已保存的登录"
        case "local-api": return "本机 \(name) 应用"
        default: return "\(name) 登录"
        }
    }
}
