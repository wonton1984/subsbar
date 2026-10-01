import SwiftUI
import AppKit
import SubsCore

enum Palette {
    static func band(_ band: Band) -> Color {
        switch band {
        case .green: Color(red: 0.16, green: 0.62, blue: 0.47)
        case .orange: Color(red: 0.90, green: 0.55, blue: 0.13)
        case .red: Color(red: 0.86, green: 0.25, blue: 0.24)
        case .gray: Color.secondary
        }
    }
    static func tone(_ tone: CardModel.Tone) -> Color {
        switch tone {
        case .normal: band(.green)
        case .warning: band(.orange)
        case .critical: band(.red)
        case .muted: Color.secondary
        }
    }
    private static let monograms: [Color] = [
        Color(red: 0.27, green: 0.42, blue: 0.78), Color(red: 0.52, green: 0.36, blue: 0.74), Color(red: 0.13, green: 0.55, blue: 0.60),
        Color(red: 0.76, green: 0.38, blue: 0.24), Color(red: 0.36, green: 0.52, blue: 0.30), Color(red: 0.70, green: 0.30, blue: 0.48),
        Color(red: 0.40, green: 0.44, blue: 0.52), Color(red: 0.62, green: 0.50, blue: 0.18)
    ]
    static func monogram(_ id: String) -> Color {
        let seed = id.unicodeScalars.enumerated().reduce(0) { $0 + Int($1.element.value) * ($1.offset + 1) }
        return monograms[seed % monograms.count]
    }
}

/// Provider marks are neutral lettered tiles, never vendor logos.
struct Monogram: View {
    let id: String
    let name: String
    var size: CGFloat = 26
    var letters: String {
        let word = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).first.map(String.init) ?? id
        let capitals = word.filter(\.isUppercase)
        if capitals.count >= 2 { return String(capitals.prefix(2)) }
        return String(word.prefix(2)).capitalized
    }
    var body: some View {
        Text(letters)
            .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Palette.monogram(id).gradient, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// Unified quota bar. Remaining fraction fills from the left; zero keeps a tinted empty track,
/// unknown draws a dashed outline so it can never be read as 0% or 100%.
struct QuotaBar: View {
    let fraction: Double?
    let band: Band
    var dimmed = false
    var height: CGFloat = 6
    var color: Color { dimmed ? .secondary : Palette.band(band) }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                if let fraction {
                    Capsule().fill(color.opacity(fraction <= 0 ? 0.22 : 0.16))
                    if fraction > 0 { Capsule().fill(color).frame(width: max(height, geometry.size.width * fraction)) }
                } else {
                    Capsule().strokeBorder(Color.secondary.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

struct StatusPill: View {
    let text: String
    let tone: CardModel.Tone
    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .foregroundStyle(Palette.tone(tone))
            .background(Palette.tone(tone).opacity(0.13), in: Capsule())
    }
}

struct MetricRowView: View {
    let metric: MetricDisplay
    var detailed = false
    var dimmed = false
    var remainingText: String {
        guard metric.valid else { return "" }
        return metric.fraction.map { "剩余 " + Cache.format($0 * 100) + "%" } ?? "比例未知"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(metric.label).fontWeight(.medium).lineLimit(1)
                if metric.isPrimary && detailed { Text("主").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 4).background(Color.secondary.opacity(0.12), in: Capsule()) }
                Spacer(minLength: 6)
                if metric.showsBar, let reset = detailed ? metric.resetFull : metric.resetShort {
                    Text(reset).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                } else if !metric.showsBar && metric.valid {
                    Text(metric.summary).fontWeight(.semibold).monospacedDigit()
                }

            }
            if metric.showsBar {
                QuotaBar(fraction: metric.fraction, band: metric.band, dimmed: dimmed)
                HStack(spacing: 4) {
                    Text(metric.summary).monospacedDigit().fixedSize(horizontal: false, vertical: true)
                    if !metric.unitLabel.isEmpty { Text(metric.unitLabel).foregroundStyle(.secondary) }
                    Spacer(minLength: 6)
                    Text(remainingText).foregroundStyle(metric.fraction == nil ? .secondary : dimmed ? .secondary : Palette.band(metric.band)).monospacedDigit()
                }.font(.system(size: 10.5))
            } else if !metric.valid {
                Text(metric.summary).foregroundStyle(.secondary)
            }
            if let overage = metric.overage { Text(overage).foregroundStyle(Palette.band(.red)) }
            if metric.inconsistent { Text("数值不一致，比例按已用量计算").foregroundStyle(Palette.band(.orange)) }
        }
        .font(.system(size: 11))
        .accessibilityElement(children: .combine)
    }
}

struct ProviderCardView: View {
    @ObservedObject var model: AppModel
    let card: CardModel
    let single: Bool
    var compact = false
    var dimmed: Bool { !["fresh", "stale"].contains(card.freshness) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if !card.metrics.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    ForEach(card.displayedMetrics(compact: compact)) { metric in
                        MetricRowView(metric: metric, detailed: card.expanded, dimmed: dimmed)
                    }
                }
            }
            if card.primaryHidden && !card.expanded { Text("主指标已隐藏；菜单栏仍按主指标显示").font(.system(size: 10)).foregroundStyle(.secondary) }
            if !compact || card.expanded || card.needsRepair { notices }
            if card.expanded { details }
        }
        .padding(10)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.75), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(model.selected == card.providerID && !single ? Color.accentColor.opacity(0.45) : Color.secondary.opacity(0.14)))
        .font(.system(size: 11))
    }
    var header: some View {
        Button { if !single { model.toggleExpanded(card.providerID) } } label: {
            HStack(spacing: 8) {
                Monogram(id: card.providerID, name: card.name, size: compact ? 20 : 26)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(card.name).font(.system(size: compact ? 11 : 12.5, weight: .semibold)).lineLimit(1)
                        if card.favorite { Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(Palette.band(.orange)) }
                    }
                    Text(card.updated ?? card.placeholder ?? card.statusText).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(card.headline).font(.system(size: compact ? 13 : 15, weight: .semibold, design: .rounded)).monospacedDigit()
                        .foregroundStyle(card.headlineFraction == nil ? .secondary : Palette.band(Cache.band(card.headlineFraction)))
                    StatusPill(text: card.statusText, tone: card.tone)
                }
                if !single {
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(card.expanded ? 90 : 0))
                }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(single ? card.name : card.expanded ? "收起详情" : "展开详情")
        .accessibilityLabel("\(card.name)，菜单栏值 \(card.headline)，\(card.statusText)")
    }
    @ViewBuilder var notices: some View {
        if let issue = card.issue {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Palette.tone(card.tone == .critical ? .critical : .warning))
                VStack(alignment: .leading, spacing: 1) {
                    Text(issue).fixedSize(horizontal: false, vertical: true)
                    if let action = card.action { Text(action).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 4)
                if card.needsRepair { Button("修复") { model.openSettings?(card.providerID) }.controlSize(.small) }
            }
        } else if card.needsRepair {
            HStack { Text(card.placeholder ?? "需要连接").foregroundStyle(.secondary); Spacer(); Button("连接") { model.openSettings?(card.providerID) }.controlSize(.small) }
        } else if let placeholder = card.placeholder, card.metrics.isEmpty {
            Text(placeholder).foregroundStyle(.secondary)
        }
        if let attempt = card.attempt { Text(attempt).foregroundStyle(.secondary) }
        if let note = card.freshnessNote { Label(note, systemImage: "clock.arrow.circlepath").foregroundStyle(.secondary) }
    }
    @ViewBuilder var details: some View {
        Divider()
        VStack(alignment: .leading, spacing: 3) {
            if let manifest = model.providers.first(where: { $0["providerId"].text == card.providerID }),
               let sentence = ConnectionGuide.sourceSentence(manifest: manifest, name: card.name) { Text(sentence) }
            if let source = card.source { Text("数据来自：" + source) }
            if let sampled = card.sampledAtMs { Text("采样：" + Date(timeIntervalSince1970: sampled / 1000).formatted(date: .abbreviated, time: .standard)) }
            if let account = card.accountLabel { Text("账户：" + account) }
            ForEach(Array(card.diagnostics.enumerated()), id: \.offset) { _, text in Text(text) }
        }.font(.system(size: 10)).foregroundStyle(.secondary)
        let actions = compact ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: 6))
        actions {
            Button(card.needsRepair ? "修复连接" : "连接设置") { model.openSettings?(card.providerID) }
            if model.selected != card.providerID { Button("用于默认菜单栏仪表") { model.choose(card.providerID) } }
            Spacer()

        }.controlSize(.small)
    }
}

struct AddSubscriptionSection: View {
    @ObservedObject var model: AppModel
    let ids: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { model.toggleAddSubscription() } label: {
                HStack(spacing: 6) {
                    Image(systemName: model.addSubscriptionExpanded ? "minus.circle" : "plus.circle")
                    Text("添加订阅").font(.system(size: 11, weight: .semibold))
                    Text("\(ids.count)").foregroundStyle(.secondary)
                    Spacer()
                    if model.addSubscriptionExpanded { Text("未启用，不读取凭证").font(.system(size: 10)).foregroundStyle(.tertiary) }
                    else { Image(systemName: "chevron.down").font(.system(size: 9)).foregroundStyle(.tertiary) }
                }
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(model.addSubscriptionExpanded ? "收起可添加订阅" : "展开可添加订阅")
            .accessibilityLabel("添加订阅，\(ids.count) 个未启用，\(model.addSubscriptionExpanded ? "已展开" : "已折叠")")
            if model.addSubscriptionExpanded { LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                ForEach(ids, id: \.self) { id in
                    Button { model.openSettings?(id) } label: {
                        HStack(spacing: 6) {
                            Monogram(id: id, name: model.name(id), size: 18)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(model.name(id)).lineLimit(1)
                                Text(ProviderConnectionPresentation.awaitingAdmission(model.providers.first { $0["providerId"].text == id } ?? .null) ? "待启用" : model.supported(id) ? "连接" : "尚不支持").font(.system(size: 9.5)).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "plus.circle").foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 7).padding(.vertical, 5)
                        .background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .contentShape(Rectangle())
                    }.buttonStyle(.plain).help("打开 \(model.name(id)) 的连接设置")
                }
            } }
        }.font(.system(size: 11))
    }
}
