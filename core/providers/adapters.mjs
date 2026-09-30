// 六家已实现 provider 的 v0 引擎桥接适配器（M1）。
// fetch 复用 scripts/subs.mjs 的既有实现（语义不回归）；
// normalize 把 v0 report 转成 SnapshotReport（resetsAt 秒→毫秒、usd→currency+USD）。
// 八家新增 provider 的 adapter 在 M2 实现；M1 manifest 照列并标 not-implemented。
import { safeText, diagnostic } from "../defs.mjs";
import { normalizeQuota, usedPercentOf, iconFractionOf } from "../runtime/report.mjs";

// C24 依赖方向：core 不得 import scripts/。引擎在 core/providers/engine/engine.mjs
// （纯模块，无顶层执行、无 pie-png 依赖）。
const v0 = await import("./engine/engine.mjs");

export const PROVIDER_NAMES = {
  codex: "Codex", opencode: "OpenCode", kimi: "Kimi", commandcode: "CommandCode",
  droid: "Droid", cursor: "Cursor",
};

/** 凭证获取：v0 引擎的 resolveCredential（兼容 pi 默认环境）。 */
export function v0ResolveCredential(subsId, auth) {
  return v0.resolveCredential(auth, subsId);
}
export function v0ReadAuth() { return v0.readAuthFile(); }

/** v0 fetch 分派。 */
export async function v0Fetch(subsId, token) {
  switch (subsId) {
    case "kimi": return v0.fetchKimi(token);
    case "opencode": return v0.fetchOpenCode(token);
    case "codex": return v0.fetchCodex(token);
    case "commandcode": return v0.fetchCommandCode(token);
    case "droid": return v0.fetchDroid(token);
    case "cursor": return v0.fetchCursor(token);
    default: throw new Error(`no adapter for ${subsId}`);
  }
}

/**
 * v0 report → SnapshotReport（纯转换；数值不改；resetsAt 秒→resetsAtMs；
 * usd → currency+USD；v0 补 0/clamp 的历史行为保留在数据里，不再新造）。
 */
export function v0ReportToSnapshot(providerId, report, { capturedAtMs }) {
  const windows = [];
  const metrics = [];
  const diagnostics = [];
  for (const w of Array.isArray(report?.windows) ? report.windows : []) {
    const unit = w.unit === "usd" ? "currency" : (w.unit ?? "count");
    const currency = w.unit === "usd" ? "USD" : w.currency;
    const resetsAtMs = typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > 0
      ? Math.round(w.resetsAt * 1000) : undefined;
    const metric = normalizeQuota(
      { id: w.id ?? "window", metricId: w.id ?? "window", label: w.label, unit, currency, derivations: [], scope: "subscription" },
      {
        unit, currency,
        used: w.used, remaining: w.remaining, limit: w.limit,
        period: { kind: w.windowMinutes > 0 ? "rolling" : "unknown", durationSeconds: w.windowMinutes > 0 ? w.windowMinutes * 60 : undefined, resetState: resetsAtMs ? "known" : "unknown", resetsAtMs },
      },
    );
    // v0 已含 primary/百分比语义；保留 primary 标记与超额原值
    if (w.primary) metric.primary = true;
    windows.push(metric);
  }
  for (const m of Array.isArray(report?.metrics) ? report.metrics.slice(0, 128) : []) {
    if (typeof m?.value === "string") {
      metrics.push({
        id: safeText(m.label ?? "metric", 96).toLowerCase().replace(/\s+/g, "-") || "metric",
        ruleId: "legacy-metric", label: safeText(m.label ?? "指标", 160), kind: "status",
        unit: "none", scope: "subscription", provenance: "reported", sourceEndpointIds: [],
        state: "known", valueCode: "available", diagnostics: [],
      });
    } else if (Number.isFinite(m?.value)) {
      metrics.push({
        id: safeText(m.label ?? "metric", 96).toLowerCase().replace(/\s+/g, "-") || "metric",
        ruleId: "legacy-metric", label: safeText(m.label ?? "指标", 160), kind: m.unit === "usd" ? "balance" : "counter",
        unit: m.unit === "usd" ? "currency" : "count", currency: m.unit === "usd" ? "USD" : undefined,
        scope: "subscription", provenance: "reported", sourceEndpointIds: [],
        state: "known", value: m.value, diagnostics: [],
      });
    }
  }
  for (const n of Array.isArray(report?.notes) ? report.notes : []) {
    diagnostics.push(diagnostic("missing-data", "info")); // v0 notes 为展示文本，v1 不搬运原文（§6.5）
  }
  const primary = windows.find((w) => w.primary) ?? windows.find((w) => usedPercentOf(w) !== undefined) ?? windows[0];
  return {
    name: safeText(PROVIDER_NAMES[providerId] ?? report?.name ?? providerId, 160),
    capturedAtMs,
    observationBasis: "remote-response",
    windows,
    metrics,
    primaryMetricId: primary && windows.includes(primary) ? primary.id : undefined,
    diagnostics,
  };
}

/** 检查 report 是否有可显示数据（§5.3：必需字段/全部 quota 为空 → invalid-response）。 */
export function snapshotHasData(snapshot) {
  return snapshot.windows.length > 0 || snapshot.metrics.length > 0;
}
