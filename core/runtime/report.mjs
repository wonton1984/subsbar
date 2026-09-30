// Usage report v1 归一化（contracts §6.2/§6.3/§7）。纯函数、无磁盘/网络。
// 这是 Node 与 Swift 共享数值语义的唯一真源：Swift 不重复实现归一化，
// 共享 golden 向量经本模块产出 v1-wire 期望值（见 core/cli.mjs golden）。
import { isFiniteNumber, isAtMs, safeText, diagnostic } from "../defs.mjs";

const PCT_TOLERANCE_ABS = 0.001;

function num(v) {
  // 通用协议数字：拒绝 NaN/Infinity/布尔/字符串/超界；null/undefined = 缺失。
  if (v === undefined || v === null) return undefined;
  if (!isFiniteNumber(v)) return undefined;
  return v;
}

/**
 * 归一化一个 quota 窗口（§6.3 判定 1-8）。
 * fields: {unit, currency?, used?, remaining?, limit?, resetsAtMs?, period?{...}}
 * rule:   manifest MetricRule 投影 {id, metricId, label?, unit, currency?, derivations:[], scope}
 * 返回 QuotaMetric（含 state/quotaState/derivations/diagnostics）。
 */
export function normalizeQuota(rule, fields) {
  const diagnostics = [];
  const derivations = [];
  let { unit, currency } = fields;
  let used = num(fields.used);
  let remaining = num(fields.remaining);
  let limit = num(fields.limit);

  if (unit === "percent") {
    // 判定1：percent 有 reported used（0 也算）→ limit 规范化为 100 标尺
    if (used !== undefined) {
      if (limit === undefined) {
        limit = 100;
        derivations.push({ field: "limit", formula: "used-plus-remaining" }); // 标尺补全：记录推导
      }
      const metric = finish({ used, limit });
      metric.label = safeText(rule.label ?? rule.metricId, 160);
      metric.diagnostics = diagnostics;
      return metric;
    }
    return finishEmpty();
  }

  // 非 percent：判定2-4
  const derivationAllowed = (f) => Array.isArray(rule.derivations) && rule.derivations.includes(f);
  const inconsistent = used !== undefined && remaining !== undefined && limit !== undefined &&
    Math.abs(used + remaining - limit) > Math.max(PCT_TOLERANCE_ABS, limit * PCT_TOLERANCE_ABS);

  if (inconsistent) {
    diagnostics.push(diagnostic("inconsistent-values", "warning"));
    // 判定4：保留原事实，百分比用 used/limit；不挑更绿色的值
  }
  if (remaining !== undefined && limit !== undefined && remaining > limit && used === undefined) {
    diagnostics.push(diagnostic("inconsistent-values", "warning"));
    // 判定4：不可推导负 used；比例未知
  }
  if (used === undefined && remaining !== undefined && limit !== undefined &&
      remaining >= 0 && remaining <= limit && limit > 0 && derivationAllowed("used-from-limit-remaining")) {
    used = limit - remaining;
    derivations.push({ field: "used", formula: "limit-minus-remaining" });
  }
  if (limit === undefined && used !== undefined && remaining !== undefined &&
      derivationAllowed("limit-from-used-remaining")) {
    limit = used + remaining;
    derivations.push({ field: "limit", formula: "used-plus-remaining" });
  }
  if (remaining === undefined && used !== undefined && limit !== undefined && limit > 0 &&
      derivationAllowed("remaining-from-limit-used")) {
    remaining = Math.max(0, limit - used);
    derivations.push({ field: "remaining", formula: "max-zero-limit-minus-used" });
  }

  const metric = finish({ used, remaining, limit, isPercentScale: false });
  metric.label = safeText(rule.label ?? rule.metricId, 160);
  if (unit === "currency") {
    if (rule.currency) metric.currency = rule.currency;
    else if (currency) metric.currency = String(currency).toUpperCase();
    else metric.state = stateOf(used, remaining, limit), metric.unit = "currency", fixCurrencyless(metric);
  }
  metric.diagnostics = [...diagnostics, ...(fields.diagnostics ?? [])];
  return metric;

  function finishEmpty() {
    const m = finish({ used: undefined, remaining: undefined, limit: undefined });
    m.label = safeText(rule.label ?? rule.metricId, 160);
    m.diagnostics = [diagnostic("missing-data", "info")];
    return m;
  }

  function finish({ used: u, remaining: r, limit: l, isPercentScale: pctScale }) {
    const state = stateOf(u, r, l);
    const quotaState = quotaStateOf(u, l);
    const metric = {
      id: rule.metricId ?? rule.id,
      ruleId: rule.id,
      label: "",
      kind: "quota",
      state,
      unit,
      scope: rule.scope ?? "subscription",
      provenance: derivations.length > 0 ? "derived" : "reported",
      sourceEndpointIds: rule.sourceEndpointIds ?? [],
      quotaState,
      derivations,
      period: fields.period ?? { kind: "unknown", resetState: "unknown" },
      diagnostics: [],
    };
    if (u !== undefined) metric.used = u;
    if (r !== undefined) metric.remaining = r;
    if (l !== undefined) metric.limit = pctScale && l === 100 && fields.limit === undefined ? 100 : l;
    if (metric.currency) { /* currency set by caller */ }
    // provenance：部分字段推导、部分 reported 时仍整体 derived（字段级区分见 derivations 列表）
    return metric;
  }

  function fixCurrencyless(m) {
    // unit=currency 无币种：保留数值事实，但不冠货币；diagnostic 由 adapter 层负责
    void m;
  }
}

function stateOf(used, remaining, limit) {
  const known = [used, remaining, limit].filter((v) => v !== undefined);
  if (known.length === 0) return "unknown";
  if (known.length === 1) {
    if (remaining !== undefined) return "remaining-only";
    if (used !== undefined) return "used-only";
    return "limit-only";
  }
  return "known";
}

function quotaStateOf(used, limit) {
  if (used !== undefined && limit !== undefined && limit > 0) {
    if (used < limit) return "within-limit";
    if (used === limit) return "at-limit";
    return "over-limit";
  }
  return "unknown";
}

/** 判定3/6：usedPercent（可>100，不裁剪）与图标 remaining fraction。 */
export function usedPercentOf(metric) {
  if (!metric || metric.kind !== "quota") return undefined;
  const { used, limit, unit } = metric;
  if (unit === "percent") {
    if (used !== undefined) return used;
    return undefined;
  }
  if (used !== undefined && limit !== undefined && limit > 0) return (used / limit) * 100;
  return undefined;
}

export function iconFractionOf(metric) {
  const pct = usedPercentOf(metric);
  if (pct === undefined) return undefined;
  return Math.min(1, Math.max(0, 1 - pct / 100));
}

/** freshness（§6.3）：remote/cli 用 observed ?? captured；local-snapshot 必须 observed；legacy 见 §7。 */
export function freshnessOf({ observedAtMs, capturedAtMs, observationBasis }, nowMs) {
  if (observationBasis === "legacy-import") {
    if (isAtMs(capturedAtMs) || isAtMs(observedAtMs)) return "expired"; // 合法时间→固定 expired
    return "invalid";
  }
  const basis = observationBasis === "local-snapshot" ? observedAtMs : (observedAtMs ?? capturedAtMs);
  if (!isAtMs(basis)) return "invalid";
  if (basis > nowMs + 300_000) return "invalid"; // 未来>300s
  const age = Math.max(0, nowMs - basis);
  if (age <= 600_000) return "fresh";
  if (age < 86_400_000) return "stale";
  return "expired";
}

/** v0 legacy 窗口转换（§7）：resetsAt 秒→resetsAtMs；usd→currency+USD；含 CmdCode「（剩余）」支路。 */
export function legacyWindowToMetric(w, { nowMs }) {
  const warnings = [];
  const unit = w.unit === "usd" ? "currency" : w.unit;
  const currency = w.unit === "usd" ? "USD" : w.currency;
  const resetsAtMs = typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > 0
    ? w.resetsAt * 1000 : undefined;
  const isCmdCodeBalance = w.id === "monthly-credits" &&
    typeof w.label === "string" && w.label.endsWith("（剩余）");
  let metric;
  if (isCmdCodeBalance) {
    // 旧形态：余额写在 limit；v1 → remaining-only，删除 used/limit
    metric = normalizeQuota(
      { id: "legacy-" + (w.id ?? "window"), metricId: w.id, unit: "currency", currency, derivations: [], scope: "subscription" },
      { unit: "currency", currency, remaining: num(w.remaining) ?? num(w.limit), period: { kind: "billing", resetState: resetsAtMs ? "known" : "unknown", resetsAtMs } },
    );
    metric.state = "remaining-only";
    delete metric.used; delete metric.limit;
    metric.quotaState = "unknown";
  } else {
    metric = normalizeQuota(
      { id: "legacy-" + (w.id ?? "window"), metricId: w.id, unit, currency, derivations: [], scope: "subscription" },
      { unit, currency, used: num(w.used), remaining: num(w.remaining), limit: num(w.limit), period: { kind: "unknown", resetState: resetsAtMs ? "known" : "unknown", resetsAtMs } },
    );
  }
  metric.provenance = "legacy-unverified";
  if (w.id === undefined || w.id === null) metric.id = "legacy-window-0";
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(metric.id)) {
    metric.id = "legacy-window-0";
    warnings.push(diagnostic("legacy-unverified", "warning"));
  }
  metric.diagnostics = [...(metric.diagnostics ?? []), ...warnings, diagnostic("legacy-unverified", "warning")];
  return metric;
}
