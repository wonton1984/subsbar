import SwiftUI
import AppKit
import SubsCore

@MainActor func quotaColor(_ fraction: Double?) -> NSColor {
    switch Cache.band(fraction) { case .green: .systemGreen; case .orange: .systemOrange; case .red: .systemRed; case .gray: .systemGray }
}
enum PopoverLayout {
    static let width: CGFloat = 360
    @MainActor static func width(for model: AppModel) -> CGFloat { CGFloat(OverviewLayout(count: model.sections.cards.count, single: model.config["ui"]["overviewMode"].text == "single").width) }
    static let fallbackChrome: CGFloat = 120
}
private struct DetailsHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
private struct ChromeHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value += nextValue() }
}
private extension View {
    func measuredChrome() -> some View { background(GeometryReader { Color.clear.preference(key: ChromeHeightKey.self, value: $0.size.height) }) }
}
struct PopoverView: View {
    @ObservedObject var model: AppModel
    var single: Bool { model.config["ui"]["overviewMode"].text == "single" }
    var spacing: CGFloat { model.config["ui"]["density"].text == "comfortable" ? 10 : 7 }
    var body: some View {
        let sections = model.sections
        VStack(alignment: .leading, spacing: 0) {
            header(sections).measuredChrome()
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: spacing) {
                    if let error = model.globalError { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.band(.orange)).fixedSize(horizontal: false, vertical: true) }
                    if model.loading { ProgressView("读取配置…").controlSize(.small) }
                    if single {
                        if model.selected.isEmpty { Text("选择一个订阅显示紧凑视图。").foregroundStyle(.secondary) }
                        else { ProviderCardView(model: model, card: model.card(model.selected, single: true), single: true) }
                    } else {
                        let layout = OverviewLayout(count: sections.cards.count)
                        ForEach(Array(layout.rows(sections.cards).enumerated()), id: \.offset) { _, row in
                            HStack(alignment: .top, spacing: spacing) {
                                ForEach(row, id: \.self) { id in
                                    ProviderCardView(model: model, card: model.card(id, single: false), single: false, compact: layout.columns == 2)
                                        .frame(maxWidth: .infinity, alignment: .topLeading)
                                }
                                if layout.columns == 2 && row.count == 1 { Color.clear.frame(maxWidth: .infinity).frame(height: 0) }
                            }
                        }
                        if sections.cards.isEmpty && !model.loading {
                            Text("尚未启用订阅。点击下方「添加订阅」选择要添加的订阅并连接；不会自动读取凭证或发起网络请求。").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        if !sections.available.isEmpty { AddSubscriptionSection(model: model, ids: sections.available).padding(.top, 4) }
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { Color.clear.preference(key: DetailsHeightKey.self, value: $0.size.height) })
            }
            .scrollIndicators(.automatic)
            .onPreferenceChange(DetailsHeightKey.self) { value in Task { @MainActor in model.measureDetails(value) } }
            Divider()
            footer.measuredChrome()
        }
        .onPreferenceChange(ChromeHeightKey.self) { value in Task { @MainActor in model.measureChrome(value + 2) } }
        .font(.system(size: 11))
        .frame(width: PopoverLayout.width(for: model), height: model.height)
    }
    func header(_ sections: ProviderSections) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                AppMark()
                VStack(alignment: .leading, spacing: 0) {
                    Text("SubsBar").font(.system(size: 13, weight: .semibold))
                    Text(subtitle(sections)).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                HeaderButton(symbol: single ? "rectangle.grid.1x2" : "rectangle", help: single ? "切换到卡片总览" : "切换到单家紧凑视图") {
                    model.patchUI(.object(["overviewMode": .string(single ? "cards" : "single")]))
                }.disabled(model.saving || model.document == nil)
                if model.refreshing { ProgressView().controlSize(.small).frame(width: 22, height: 22).help("刷新中") }
                else {
                    HeaderButton(symbol: "arrow.clockwise", help: "手动刷新（遵守限频与重试时间）") { model.refresh() }
                        .disabled(model.document == nil || model.saving)
                }
                Button { model.openSettings?(nil) } label: {
                    Label("设置", systemImage: "gearshape").font(.system(size: 11))
                }.buttonStyle(.bordered).controlSize(.small).help("连接与显示设置")
            }
            if ProviderNavigation.visible(ui: model.config["ui"]) { ProviderSelector(model: model) }

        }.padding(.horizontal, 10).padding(.vertical, 8)
    }
    func subtitle(_ sections: ProviderSections) -> String {
        guard model.document != nil else { return "正在连接数据引擎" }
        let attention = sections.cards.map { model.card($0, single: false) }.filter { $0.issue != nil || $0.needsRepair || $0.tone == .critical }.count
        return "\(sections.cards.count) 个订阅" + (attention > 0 ? " · \(attention) 个需关注" : "")
    }
    var footer: some View {
        HStack(spacing: 8) {
            Text(model.receipt ?? " ").foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail).help(model.receipt ?? "")
            Spacer()
            if model.refreshing { Button("取消刷新") { model.cancelRefresh() } }
            Button("退出") { NSApp.terminate(nil) }
        }.controlSize(.small).padding(.horizontal, 10).padding(.vertical, 7)
    }
}

private struct HeaderButton: View {
    let symbol: String
    let help: String
    let action: () -> Void
    var body: some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 12, weight: .medium)).frame(width: 22, height: 22).contentShape(Rectangle()) }
            .buttonStyle(.borderless).help(help).accessibilityLabel(help)
    }
}

/// SubsBar's own mark: stacked usage bars, no third-party artwork.
private struct AppMark: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Capsule().fill(Palette.band(.green)).frame(width: 14, height: 3)
            Capsule().fill(Palette.band(.orange)).frame(width: 10, height: 3)
            Capsule().fill(Palette.band(.red)).frame(width: 6, height: 3)
        }
        .frame(width: 24, height: 24)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// All enabled subscriptions are directly reachable; rows wrap without a scroll container.
struct ProviderSelector: View {
    @ObservedObject var model: AppModel
    var ids: [String] { model.enabled.map { $0["providerId"].text } }
    var body: some View {
        VStack(alignment: .leading, spacing: ProviderNavigation.spacing) {
            ForEach(Array(ProviderNavigation.rows(ids, width: Double(PopoverLayout.width(for: model) - 20)).enumerated()), id: \.offset) { _, row in
                HStack(spacing: ProviderNavigation.spacing) {
                    ForEach(row, id: \.self) { id in
                        let selected = ProviderNavigation.selected(id, ui: model.config["ui"])
                        Button { model.patchUI(ProviderNavigation.focus(id)) } label: {
                            HStack(spacing: 3) {
                                Text(selected ? "●" : "○").font(.system(size: 8))
                                Text(model.name(id)).font(.system(size: 10, weight: selected ? .semibold : .regular)).lineLimit(2).minimumScaleFactor(0.8)
                            }.frame(width: ProviderNavigation.chipWidth, height: 32)
                                .background(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 5))
                                .foregroundStyle(selected ? Color.accentColor : Color.primary)
                        }.buttonStyle(.plain).help("查看 " + model.name(id))
                            .accessibilityLabel("查看 " + model.name(id))
                            .accessibilityAddTraits(selected ? [.isSelected] : [])
                            .disabled(model.saving || model.loading || model.document == nil)
                    }
                }
            }
        }.padding(.vertical, 2)
    }
}
