import SwiftUI
import AppKit
import SubsCore

@MainActor func quotaColor(_ fraction: Double?) -> NSColor {
    switch Cache.band(fraction) { case .green: .systemGreen; case .orange: .systemOrange; case .red: .systemRed; case .gray: .systemGray }
}
struct UsageRow: View {
    let window: UsageWindow
    let now: Date
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(window.label).fontWeight(.medium).fixedSize(horizontal: false, vertical: true)
                Spacer()
                if window.effectiveUsed == nil, window.limit == nil, let remaining = window.remaining {
                    Text(window.unit.lowercased() == "usd" ? "剩 $" + String(format: "%.2f", remaining) : "剩余 \(Cache.format(remaining)) \(window.unit)").monospacedDigit()
                } else {
                    Text("已用 \(window.effectiveUsed.map(Cache.format) ?? "—") / \(window.limit.map(Cache.format) ?? "总额未知") \(window.unit == "percent" ? "%" : window.unit)").monospacedDigit()
                }
            }
            if let fraction = window.fraction {
                ProgressView(value: 1 - fraction).controlSize(.small).tint(Color(nsColor: quotaColor(fraction)))
            } else { Text("比例未知").font(.system(size: 10)).foregroundStyle(.secondary) }
            Text(Cache.countdown(window.resetsAt, now: now)).font(.system(size: 10)).foregroundStyle(.secondary).monospacedDigit()
        }
    }
}
private struct DetailsHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
struct PopoverView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            buttons
            Divider()
            HStack(alignment: .firstTextBaseline) {
                Text(model.provider.name).font(.system(size: 14, weight: .bold))
                Spacer()
                Text("剩余 \(model.fraction.map { Cache.format($0 * 100) + "%" } ?? "未知")").font(.system(size: 13, weight: .medium)).foregroundStyle(Color(nsColor: quotaColor(model.fraction)))
            }
            ScrollView {
                details.frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 10)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: DetailsHeightKey.self, value: geometry.size.height)
                    })
            }.scrollIndicators(.hidden)
                .onPreferenceChange(DetailsHeightKey.self) { value in
                    Task { @MainActor in model.measureDetails(value) }
                }
            Divider()
            footer
        }.font(.system(size: 11)).padding(10).frame(width: 350, height: model.height)
    }
    private var buttons: some View {
        HStack(spacing: 3) {
            ForEach(Provider.all) { provider in
                Button { model.choose(provider.id) } label: {
                    Text(provider.name).font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(!provider.supported ? Color.secondary : model.selected == provider.id ? Color.white : Color.primary)
                        .padding(.horizontal, 5).padding(.vertical, 5)
                        .background(model.selected == provider.id ? (provider.supported ? Color.accentColor : Color.secondary.opacity(0.2)) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(model.selected == provider.id ? Color.accentColor : .clear, lineWidth: 1))
                }.buttonStyle(.plain)
                    .help(provider.id == "commandcode" ? "CommandCode" : provider.name)
                    .accessibilityLabel(provider.id == "commandcode" ? "CommandCode" : provider.name)
                    .accessibilityValue(model.selected == provider.id ? "已选择" : "未选择")
            }
        }
    }
    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.provider.supported {
                Text("未接入：用量接口和凭证接入尚未完成").foregroundStyle(.secondary)
            } else {
                if let error = model.globalError ?? model.snapshot.error { Text("✗ \(error)").foregroundStyle(.red) }
                if let message = model.outcomes[model.selected] { Text(message).foregroundStyle(message == "已更新" ? Color.secondary : Color.red).font(.system(size: 10)) }
                if let message = model.snapshot.diagnostics[model.selected] { Text("✗ \(message)").foregroundStyle(.orange).font(.system(size: 10)) }
                if let entry = model.entry {
                    if model.selected == "droid" && !entry.windows.isEmpty && entry.windows.allSatisfy({ ["标准额度", "高级额度", "Premium额度"].contains($0.label) }) {
                        Text("5 小时 / 每周额度尚未由数据源提供；以下仅为总额度").font(.system(size: 10)).foregroundStyle(.orange)
                    }
                    Text(model.cacheStatus + (entry.main.map { " · 主窗口：\($0.label)" } ?? "")).font(.system(size: 10)).foregroundStyle(.secondary)
                    if let error = entry.error { Text("✗ \(error)").foregroundStyle(.red) }
                    ForEach(entry.warnings, id: \.self) { Text("✗ \($0)").font(.system(size: 10)).foregroundStyle(.orange) }
                    ForEach(entry.windows) { UsageRow(window: $0, now: model.now) }
                    ForEach(entry.metrics) { metric in HStack { Text(metric.label); Spacer(); Text(metric.value).monospacedDigit() } }
                    ForEach(Array(entry.notes.enumerated()), id: \.offset) { _, note in Text(note).font(.system(size: 10)).foregroundStyle(.secondary) }
                    if entry.windows.isEmpty && entry.metrics.isEmpty { Text("暂无额度数据").foregroundStyle(.secondary) }
                } else { Text("暂无可用缓存").foregroundStyle(.secondary) }
            }
        }.textSelection(.enabled)
    }
    private var footer: some View {
        HStack(spacing: 6) {
            Button(model.refreshing ? "刷新中…" : "手动刷新") { model.refresh() }.disabled(model.refreshing)
                .help("刷新已接入的六家订阅；旧刷新服务加载时暂停刷新")
            if model.refreshing { ProgressView().controlSize(.small) }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 2) {
                Text("缓存时间 · \(age)").foregroundStyle(.secondary)
                Text(model.entry?.fetchedAt?.formatted(date: .abbreviated, time: .standard) ?? "未知")
            }.font(.system(size: 10))
            Button("退出") { NSApp.terminate(nil) }
        }.controlSize(.small)
    }
    private var age: String {
        guard let date = model.entry?.fetchedAt else { return "未知" }
        let delta = model.now.timeIntervalSince(date)
        guard delta >= -300 else { return "时钟异常" }
        return "\(Int(max(0, delta) / 60)) 分钟前"
    }
}
