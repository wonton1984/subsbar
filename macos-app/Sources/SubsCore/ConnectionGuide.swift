import Foundation

/// User-facing projection of a provider's connection story. Pure presentation:
/// registry/manifest data is read, never changed, and reader ids never reach the default view.
public struct ConnectionGuide: Equatable, Sendable {
    public enum Kind: String, Sendable {
        /// Log in with the provider's own CLI/app, then let SubsBar detect it.
        case login
        /// Needs an API key.
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
    /// Only set for commands confirmed in the repository's provider docs or by the product owner.
    public let command: String?

    static let loginProviders: Set<String> = ["codex", "claude", "droid", "antigravity", "devin", "grok", "ollama", "copilot"]
    static let apiKeyProviders: Set<String> = ["kimi", "openrouter", "zai", "commandcode", "opencode"]
    static let commands: [String: (command: String, text: String)] = [
        "codex": ("codex login", "在终端运行 codex login，按提示在浏览器完成登录。"),
        "grok": ("grok login", "在终端运行 grok login，按提示完成登录。"),
        "ollama": ("ollama signin", "在终端运行 ollama signin，按提示完成登录。")
    ]

    public init(manifest: Wire, name: String) {
        let id = manifest["providerId"].text
        providerID = id; self.name = name
        if !manifest["supported"].bool {
            kind = .unsupported; primaryTitle = "尚不支持"; command = nil
            instruction = "\(name) 暂时无法读取用量，后续版本支持。"
            return
        }
        let kinds = Set(manifest["credentialReaders"].array.flatMap { $0["credentialKinds"].array.map(\.text) })
        if Self.loginProviders.contains(id) { kind = .login }
        else if Self.apiKeyProviders.contains(id) { kind = .apiKey }
        else if id == "cursor" { kind = .appSession }
        else { kind = kinds.contains("api-key") ? .apiKey : .login }
        switch kind {
        case .login:
            primaryTitle = "登录 \(name)"
            if let known = Self.commands[id] { command = known.command; instruction = known.text + "完成后回到这里点「我已完成，检测连接」。" }
            else { command = nil; instruction = "请先在 \(name) 官方应用或命令行中完成登录，然后回到这里点「我已完成，检测连接」。" }
        case .apiKey:
            primaryTitle = "粘贴 API Key"; command = nil
            instruction = "\(name) 使用 API Key 连接。应用内保存密钥即将提供；目前请先在本机配置好密钥，再点「检测连接」。"
        case .appSession:
            primaryTitle = "登录 \(name)"; command = nil
            instruction = "请先在 \(name) 应用中登录，SubsBar 会读取本机登录状态。完成后点「我已完成，检测连接」。"
        case .unsupported:
            primaryTitle = "尚不支持"; command = nil; instruction = ""
        }
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
