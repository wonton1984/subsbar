import SwiftUI
import AppKit
import SubsCore

@MainActor func quotaColor(_ fraction: Double?) -> NSColor {
    switch Cache.band(fraction) { case .green: .systemGreen; case .orange: .systemOrange; case .red: .systemRed; case .gray: .systemGray }
}
private struct DetailsHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
struct MetricRow: View {
    let metric: V1Metric
    let now: Date
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(metric.label).fontWeight(.medium)
            Text(metric.summary).monospacedDigit().fixedSize(horizontal: false, vertical: true)
            if metric.kind == "quota" {
                if let fraction = metric.fraction {
                    ProgressView(value: 1 - fraction).tint(Color(nsColor: quotaColor(fraction)))
                    if (metric.usedPercent ?? 0) > 100 { Text("超额 · 已用 \(Cache.format(metric.usedPercent!))%").foregroundStyle(.red) }
                } else { Text("比例未知").foregroundStyle(.secondary) }
                Text(metric.reset(at: now)).foregroundStyle(.secondary)
            }
            if metric.inconsistent { Text("数值不一致，比例按已用量计算").foregroundStyle(.orange) }
        }.font(.system(size: 11)).accessibilityElement(children: .combine)
    }
}
struct ProviderCard: View {
    @ObservedObject var model: AppModel
    let id: String
    let single: Bool
    var entry: V1Provider? { model.usage?.providers.first { $0.id == id } }
    var preferences: Wire { model.config["ui"]["cards"][id] }
    var expanded: Bool { single || preferences["expanded"].bool }
    var metrics: [V1Metric] {
        guard let entry else { return [] }
        let all = entry.windows + entry.metrics
        let hidden = preferences["hiddenMetricIds"].array.map(\.text)
        let order = preferences["metricOrder"].array.map(\.text)
        return all.filter { !hidden.contains($0.id) }.sorted { (order.firstIndex(of: $0.id) ?? 999) < (order.firstIndex(of: $1.id) ?? 999) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button {
                    model.patchUI(.object(["cards": .object([id: .object(["expanded": .bool(!expanded)])])]))
                } label: { Image(systemName: expanded ? "chevron.down" : "chevron.right") }.buttonStyle(.plain).disabled(single)
                Button { model.choose(id) } label: {
                    Text((preferences["favorite"].bool ? "★ " : "") + model.name(id)).font(.system(size: 13, weight: .bold))
                }.buttonStyle(.plain).help("将此订阅用于菜单栏饼图")
                Spacer()
                Button("连接") { model.openSettings?(id) }.controlSize(.small)
            }
            if !model.config["providers"][id]["enabled"].bool { Text("未启用").foregroundStyle(.secondary) }
            else if let entry {
                HStack {
                    Text(Presentation.status(entry.status))
                    Spacer()
                    Text("剩余 \(entry.iconFraction(at: model.now).map { Cache.format($0 * 100) + "%" } ?? "未知")")
                }.foregroundStyle(Color(nsColor: quotaColor(entry.iconFraction(at: model.now))))
                if let issue = entry.issue { Text(issue).foregroundStyle(.orange) }
                if entry.raw["error"]["action"].string != nil { Text(Presentation.action(entry.raw["error"]["action"].text)).foregroundStyle(.secondary) }
                if let attempt = entry.attemptMessage { Text(attempt).foregroundStyle(.secondary) }
                if entry.report.isObject {
                    let freshness = entry.freshness(at: model.now)
                    if freshness != "fresh" { Text(freshness == "stale" ? "上次数据 · 已陈旧" : "历史或时间异常数据 · 比例不用于菜单栏").foregroundStyle(.secondary) }
                    if model.config["ui"]["showAccountLabel"].bool,
                       let label = model.config["providers"][id]["profiles"].array.first(where: { $0["id"].text == entry.profile })?["label"].string {
                        Text(Presentation.text(label)).foregroundStyle(.secondary)
                    }
                    if expanded {
                        Text("来源：" + Presentation.text(entry.raw["source"]["dataSourceId"].text)).foregroundStyle(.secondary)
                        if let timestamp = V1Metric.timestamp(entry.report["observedAtMs"]) ?? V1Metric.timestamp(entry.report["capturedAtMs"]) {
                            Text("采样：" + Date(timeIntervalSince1970: timestamp / 1000).formatted(date: .abbreviated, time: .standard)).foregroundStyle(.secondary)
                        }
                        ForEach(metrics) { MetricRow(metric: $0, now: model.now) }
                        ForEach(Array(entry.report["diagnostics"].array.enumerated()), id: \.offset) { _, item in Text(Presentation.diagnostic(item["code"].text)).foregroundStyle(.secondary) }
                    } else if let primary = entry.primary, metrics.contains(where: { $0.id == primary.id }) {
                        MetricRow(metric: primary, now: model.now)
                    } else if let value = metrics.first(where: { $0.kind != "quota" }) {
                        MetricRow(metric: value, now: model.now)
                    }
                } else { Text("暂无用量数据；连接状态保持可见").foregroundStyle(.secondary) }
            } else { Text("暂无用量数据").foregroundStyle(.secondary) }
        }.padding(8).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(model.selected == id ? Color.accentColor.opacity(0.35) : .clear))
    }
}
struct PopoverView: View {
    @ObservedObject var model: AppModel
    var single: Bool { model.config["ui"]["overviewMode"].text == "single" }
    var body: some View {
        VStack(alignment: .leading, spacing: model.config["ui"]["density"].text == "comfortable" ? 12 : 7) {
            HStack {
                Text("SubsBar").font(.headline)
                Spacer()
                Button("设置") { model.openSettings?(nil) }
            }
            if single {
                Picker("订阅", selection: Binding(get: { model.selected }, set: { model.choose($0) })) {
                    Text("未选择").tag("")
                    ForEach(Array(model.providers.enumerated()), id: \.offset) { _, row in Text(model.name(row["providerId"].text)).tag(row["providerId"].text) }
                }.labelsHidden()
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if let error = model.globalError { Text(error).foregroundStyle(.orange) }
                    if model.loading { ProgressView("读取配置…") }
                    if single && !model.selected.isEmpty { ProviderCard(model: model, id: model.selected, single: true) }
                    else {
                        ForEach(Array(model.enabled.enumerated()), id: \.offset) { _, row in ProviderCard(model: model, id: row["providerId"].text, single: false) }
                        if model.enabled.isEmpty { Text("尚未启用订阅。打开设置，选择来源并连接；不会自动读取凭证或发起网络请求。").foregroundStyle(.secondary) }
                    }
                    if let receipt = model.receipt { Text(receipt).foregroundStyle(.secondary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(GeometryReader { Color.clear.preference(key: DetailsHeightKey.self, value: $0.size.height) })
            }.scrollIndicators(.hidden).onPreferenceChange(DetailsHeightKey.self) { value in Task { @MainActor in model.measureDetails(value) } }
            Divider()
            HStack {
                Button(model.refreshing ? "刷新中…" : "手动刷新") { model.refresh() }.disabled(model.refreshing || model.document == nil)
                if model.refreshing { Button("取消") { model.cancelRefresh() } }
                Spacer()
                Button("退出") { NSApp.terminate(nil) }
            }.controlSize(.small)
        }.font(.system(size: 11)).padding(10).frame(width: 350, height: model.height)
    }
}
