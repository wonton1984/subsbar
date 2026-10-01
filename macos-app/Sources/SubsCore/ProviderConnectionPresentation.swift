import Foundation

/// UI guidance from the provider release cards. Node remains the config/admission validator.
public enum ProviderConnectionPresentation {
    public static func note(_ id: String) -> String? {
        switch id {
        case "copilot": return "实验性社区来源：仅接受 Copilot OAuth，不接受 PAT；官方 CLI 来源待接入。403 不转查组织账单。AI credits 与 Premium requests 按上游类型显示。"
        case "zai": return "请先选择密钥所属地区；global 使用 ZAI_API_KEY，cn 使用 BIGMODEL_API_KEY，不跨区探测。CN 本轮未经真实账户验证。"
        case "openrouter": return "显示 API Key 限额，不是账户余额。账户余额需要独立 management key，本轮尚未接入；不要将它填作普通 Key。"
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
