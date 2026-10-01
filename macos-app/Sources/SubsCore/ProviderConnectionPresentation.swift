import Foundation

/// UI guidance from the provider release cards. Node remains the config/admission validator.
public enum ProviderConnectionPresentation {
    public static func awaitingAdmission(_ manifest: Wire) -> Bool {
        let sources = manifest["dataSources"].array
        return !sources.isEmpty && !sources.contains { $0["admission"].text == "approved" }
    }
    public static func note(_ id: String) -> String? {
        switch id {
        case "copilot": return "实验性社区来源：仅接受 Copilot OAuth，不接受 PAT；官方 CLI 来源待接入。403 不转查组织账单。AI credits 与 Premium requests 按上游类型显示。"
        case "zai": return "请先选择密钥所属地区；global 使用 ZAI_API_KEY，cn 使用 BIGMODEL_API_KEY，不跨区探测。CN 本轮未经真实账户验证。"
        case "openrouter": return "显示 API Key 限额，不是账户余额。账户余额需要独立 management key，本轮尚未接入；不要将它填作普通 Key。"
        case "antigravity": return "待启用：agy CLI 版本及用量输出尚未实测。Gemini 与非 Gemini 池分别显示，缺失窗口不补满；本地 API 会话读取尚未实现。"
        case "devin": return "待启用：CLI 会话与网页组织会话是两种独立来源。CLI 用量读取尚未验证；网页组织来源需手动导入钥匙串及组织 ID，自动浏览器导入尚未实现。日额度与周额度分开显示，不跨账户回退。"
        case "grok": return "待启用：Grok Build 真实账户尚未验证。按上游周期区分周窗和月窗，PAYG 单独显示；不承诺网页 gRPC、WKE 或团队额度支持。"
        default: return nil
        }
    }
    public static func unavailable(manifest: Wire, draft: Wire) -> String? {
        guard manifest["supported"].bool else { return "此订阅尚不可连接" }
        let selected = draft["dataSource"].text
        let sources = manifest["dataSources"].array
        if (selected.isEmpty || selected == "auto"), !sources.isEmpty, !sources.contains(where: { $0["admission"].text == "approved" }) {
            return "暂无已准入用量来源，不可连接。"
        }
        if !selected.isEmpty && selected != "auto" {
            guard let source = manifest["dataSources"].array.first(where: { $0["id"].text == selected }), source["admission"].text == "approved" else {
                return "所选用量来源尚未准入，不可连接；请选择已准入来源。"
            }
        }
        let active = draft["profiles"].array.first { $0["id"] == draft["activeProfile"] }
        for source in active?["sources"].array ?? [] {
            guard let reader = manifest["credentialReaders"].array.first(where: { $0["id"] == source["reader"] }), reader["implemented"].bool else {
                return "指定凭证来源尚不支持，不可连接；请更换来源。"
            }
        }
        return nil
    }
}
