// M2 新增 provider 引擎（批次 A 移植自 pi-subs MIT；批次 B-D 防御性解析）。
// 全部输出 SnapshotReport（contracts §6.2），经 normalizeQuota 归一化：
// 不做 clamp/补 0（§1 v1 裁决），超额原值保留，缺失即 unknown。
// 批次 B-D 的响应字段名未经真实账号验证 —— 状态 pending-verification，
// manifest admission 保持 pending（refresh 拒绝执行），fixture 为乐观形状。
import { fetchJson } from "./engine.mjs";
import { normalizeQuota, usedPercentOf, iconFractionOf } from "../../runtime/report.mjs";
import { diagnostic, safeText } from "../../defs.mjs";

// ---------------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------------

function asObject(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; }
function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function asNonNegative(v) {
  const n = asNumber(v);
  return n === undefined || n < 0 ? undefined : n;
}
function isoToMs(v) {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
function epochSecToMs(v) {
  const n = asNonNegative(v);
  return n === undefined ? undefined : Math.round(n * 1000);
}
function metric(rule, fields) {
  const m = normalizeQuota(rule, fields);
  return m;
}
function quotaOut(m) {
  return m;
}
function buildReport(providerId, name, { capturedAtMs, windows, metrics = [], primaryMetricId, diagnostics = [] }) {
  const primary = windows.find((w) => w.primary) ?? windows.find((w) => usedPercentOf(w) !== undefined);
  return {
    name: safeText(name, 160),
    capturedAtMs,
    observationBasis: "remote-response",
    windows,
    metrics,
    primaryMetricId: primaryMetricId ?? (primary ? primary.id : undefined),
    diagnostics,
  };
}
const RULE = (id, metricId, unit, extra = {}) => ({ id, metricId, unit, derivations: [], scope: "subscription", ...extra });

// ---------------------------------------------------------------------------
// 批次 A — claude（端点未公开接口，OAuth 来源政策准入 UNVERIFIED，见 manifest approvalNote）
// ---------------------------------------------------------------------------

export async function fetchClaudeUsage(token, extra = {}, ctx = {}) {
  const payload = await fetchJson({
    url: "https://api.anthropic.com/api/oauth/usage",
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "SubsBar" },
    description: "Claude usage",
    secrets: [token],
    signal: ctx.signal,
  });
  return normalizeClaudeUsage(payload, Date.now());
}

export function normalizeClaudeUsage(payload, capturedAtMs) {
  const windows = [];
  const add = (id, label, raw, primary) => {
    const o = asObject(raw);
    if (!o) return;
    const used = asNumber(o.utilization);
    if (used === undefined) return;
    const resetsAtMs = isoToMs(o.resets_at);
    windows.push(quotaOut(metric(RULE("claude-" + id, id, "percent"), {
      unit: "percent", used,
      period: { kind: "rolling", resetState: resetsAtMs ? "known" : "unknown", resetsAtMs },
    })));
    windows[windows.length - 1].primary = !!primary;
    windows[windows.length - 1].label = label;
  };
  add("five-hour", "5h窗口", payload.five_hour, true);
  add("seven-day", "周窗口", payload.seven_day);
  add("seven-day-opus", "周Opus", payload.seven_day_opus);
  if (windows.length === 0) throw new Error("Claude usage 响应没有可显示的用量数据。");
  return buildReport("claude", "Claude", { capturedAtMs, windows });
}

// ---------------------------------------------------------------------------
// 批次 A — copilot（copilot_internal/user 社区来源；官方 SDK 能力未桥接，见 manifest）
// ---------------------------------------------------------------------------

export async function fetchCopilotUsage(token, extra = {}, ctx = {}) {
  const payload = await fetchJson({
    url: "https://api.github.com/copilot_internal/user",
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/json",
      "Editor-Version": "SubsBar/0.1", "Editor-Plugin-Version": "subsbar", "User-Agent": "SubsBar",
    },
    description: "Copilot usage",
    secrets: [token],
    signal: ctx.signal,
  });
  return normalizeCopilotUsage(payload, Date.now());
}

export function normalizeCopilotUsage(payload, capturedAtMs) {
  const diagnostics = [];
  const snapshots = asObject(payload.quota_snapshots);
  const premium = asObject(snapshots?.premium_interactions);
  const windows = [];
  const metrics = [];
  const resetsAtMs = isoToMs(payload.quota_reset_date_utc ?? payload.quota_reset_date ?? payload.limited_user_reset_date);
  const period = { kind: "calendar", resetState: resetsAtMs ? "known" : "unknown", resetsAtMs };

  if (premium) {
    const tokenBilling = premium.token_based_billing === true;
    const id = tokenBilling ? "ai-credits" : "premium-requests";
    const label = tokenBilling ? "AI credits" : "Premium requests";
    if (premium.unlimited === true) {
      metrics.push({ id, ruleId: id, label, kind: "status", unit: "none", scope: "subscription", provenance: "reported", sourceEndpointIds: [], state: "known", valueCode: "unlimited", diagnostics: [] });
    } else {
      const entitlement = asNonNegative(premium.entitlement);
      const rawRemaining = asNumber(premium.remaining) ?? asNumber(premium.quota_remaining);
      if (entitlement === undefined || rawRemaining === undefined) {
        throw new Error("Copilot 配额数据不完整。");
      }
      const overage = Math.max(asNonNegative(premium.overage_count) ?? 0, Math.max(0, -rawRemaining));
      if (overage > 0) {
        metrics.push({ id: "overage-used", ruleId: "overage-used", label: "超额使用", kind: "counter", unit: "count", scope: "subscription", provenance: "reported", sourceEndpointIds: [], state: "known", value: overage, diagnostics: [] });
      }
      windows.push(quotaOut(metric(RULE("copilot-" + id, id, "count", { derivations: ["used-from-limit-remaining", "remaining-from-limit-used", "limit-from-used-remaining"] }), {
        unit: "count", used: asNonNegative(premium.credits_used) ?? Math.max(0, entitlement - rawRemaining),
        remaining: Math.max(0, rawRemaining), limit: entitlement, period,
      })));
      windows[windows.length - 1].primary = true;
      windows[windows.length - 1].label = label;
    }
  } else {
    const limited = asObject(payload.limited_user_quotas);
    const monthly = asObject(payload.monthly_quotas);
    const remaining = asNonNegative(limited?.chat);
    const entitlement = asNonNegative(monthly?.chat);
    if (remaining === undefined || entitlement === undefined) {
      throw new Error("Copilot usage 响应没有支持的配额字段。");
    }
    windows.push(quotaOut(metric(RULE("copilot-chat-requests", "chat-requests", "count", { derivations: ["used-from-limit-remaining", "remaining-from-limit-used", "limit-from-used-remaining"] }), {
      unit: "count", used: Math.max(0, entitlement - remaining), remaining, limit: entitlement, period,
    })));
    windows[windows.length - 1].primary = true;
    windows[windows.length - 1].label = "Chat requests";
  }
  void diagnostics;
  return buildReport("copilot", "Copilot", { capturedAtMs, windows, metrics });
}

// ---------------------------------------------------------------------------
// 批次 A — zai（官方插件口径同源接口；CN/Global 由 profile.region 决定 origin）
// ---------------------------------------------------------------------------

export const ZAI_REGION_ORIGINS = { global: "https://api.z.ai", cn: "https://open.bigmodel.cn" };

export async function fetchZaiUsage(token, extra = {}, ctx = {}) {
  const origin = ZAI_REGION_ORIGINS[extra.region];
  if (!origin) throw new Error("Z.AI 需要明确 region（global/cn），不跨区试探。");
  const payload = await fetchJson({
    url: `${origin}/api/monitor/usage/quota/limit`,
    headers: { Authorization: token },
    description: "Z.AI quota",
    secrets: [token],
    signal: ctx.signal,
  });
  return normalizeZaiQuota(payload, Date.now());
}

export function normalizeZaiQuota(payload, capturedAtMs) {
  const data = asObject(payload.data);
  if (!data) throw new Error("Z.AI quota 响应缺少 data 字段。");
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const windows = [];
  const addPercent = (id, label, limit, windowMinutes, primary = false) => {
    const used = asNonNegative(limit.percentage);
    if (used === undefined) return;
    const resetsAtMs = epochSecToMs(limit.nextResetTime);
    const m = quotaOut(metric(RULE("zai-" + id, id, "percent"), {
      unit: "percent", used,
      period: { kind: "rolling", durationSeconds: windowMinutes * 60, resetState: resetsAtMs ? "known" : "unknown", resetsAtMs },
    }));
    m.primary = primary; m.label = label; m.id = id;
    windows.push(m);
  };
  const addCount = (id, label, limit, windowMinutes, primary = false) => {
    const used = asNonNegative(limit.currentValue);
    const quota = asNonNegative(limit.usage);
    if (used === undefined || quota === undefined) return;
    const resetsAtMs = epochSecToMs(limit.nextResetTime);
    const m = quotaOut(metric(RULE("zai-" + id, id, "count", { derivations: ["remaining-from-limit-used"] }), {
      unit: "count", used, remaining: Math.max(0, quota - used), limit: quota,
      period: { kind: "rolling", ...(windowMinutes ? { durationSeconds: windowMinutes * 60 } : {}), resetState: resetsAtMs ? "known" : "unknown", resetsAtMs },
    }));
    m.primary = primary; m.label = label; m.id = id;
    windows.push(m);
  };
  for (const raw of limits) {
    const limit = asObject(raw);
    if (!limit) continue;
    const type = typeof limit.type === "string" ? limit.type : "";
    const unit = asNonNegative(limit.unit);
    const isPlan = type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT";
    if (type === "TIME_LIMIT") addCount("mcp-monthly", "MCP月度", limit);
    else if (isPlan && unit === 3) addPercent("five-hour", "5h窗口", limit, 300);
    else if (isPlan && unit === 6) {
      if (asNonNegative(limit.currentValue) !== undefined && asNonNegative(limit.usage) !== undefined) addCount("weekly", "周窗口", limit, 10080);
      else addPercent("weekly", "周窗口", limit, 10080);
    }
  }
  if (windows.length === 0) throw new Error("Z.AI quota 响应没有可显示的用量数据。");
  if (!windows.some((w) => w.primary)) {
    const first = windows.find((w) => w.id === "five-hour") ?? windows[0];
    if (first) first.primary = true;
  }
  return buildReport("zai", "Z.AI", { capturedAtMs, windows });
}

// ---------------------------------------------------------------------------
// 批次 A — openrouter（普通 key 限额；management key 是另一个 purpose，不混用）
// ---------------------------------------------------------------------------

export async function fetchOpenRouterUsage(token, extra = {}, ctx = {}) {
  const payload = await fetchJson({
    url: "https://openrouter.ai/api/v1/key",
    headers: { Authorization: `Bearer ${token}` },
    description: "OpenRouter key",
    secrets: [token],
    signal: ctx.signal,
  });
  return normalizeOpenRouterKey(payload, Date.now());
}

export function normalizeOpenRouterKey(payload, capturedAtMs) {
  const data = asObject(payload.data);
  if (!data) throw new Error("OpenRouter key 响应缺少 data 字段。");
  const diagnostics = [];
  const windows = [];
  const metrics = [];
  const limit = asNonNegative(data.limit);
  const remaining = asNonNegative(data.limit_remaining);
  const periodName = typeof data.limit_reset === "string" ? data.limit_reset : undefined;
  if (limit !== undefined) {
    const m = quotaOut(metric(RULE("openrouter-key-limit", "key-limit", "currency", { currency: "USD", derivations: ["used-from-limit-remaining", "remaining-from-limit-used"] }), {
      unit: "currency", currency: "USD",
      ...(remaining !== undefined ? { used: Math.max(0, limit - remaining), remaining } : {}),
      limit,
      period: { kind: "unknown", resetState: "unknown" },
    }));
    m.primary = true;
    m.label = periodName ? `Key限额(${periodName})` : "Key限额";
    windows.push(m);
  }
  const addUsage = (id, label, value) => {
    const usage = asNonNegative(value);
    if (usage === undefined) return;
    metrics.push({ id, ruleId: id, label, kind: "spend", unit: "currency", currency: "USD", scope: "api-key", provenance: "reported", sourceEndpointIds: [], state: "known", value: usage, period: { kind: "unknown", resetState: "unknown" }, diagnostics: [] });
  };
  addUsage("usage-daily", "今日", data.usage_daily);
  addUsage("usage-weekly", "本周", data.usage_weekly);
  addUsage("usage-monthly", "本月", data.usage_monthly);
  addUsage("usage-total", "累计", data.usage);
  if (data.limit === null || data.limit === undefined) diagnostics.push(diagnostic("openrouter-no-limit", "info"));
  if (data.is_free_tier === true) diagnostics.push(diagnostic("openrouter-free-tier", "info"));
  if (windows.length === 0 && metrics.length === 0) throw new Error("OpenRouter key 响应没有可显示的用量数据。");
  return buildReport("openrouter", "OpenRouter", { capturedAtMs, windows, metrics, diagnostics });
}

// ---------------------------------------------------------------------------
// 批次 B-D — 防御性解析（字段名未经真实账号验证；pending-verification）
// 策略：探测多种已文档化形状的百分位/用量字段；一个都识别不出 → 无数据错误。
// ---------------------------------------------------------------------------

function probePercentWindows(payload, candidates) {
  const windows = [];
  for (const c of candidates) {
    const o = asObject(c.pick ? c.pick(payload) : payload[c.key]);
    if (!o) continue;
    const used = asNumber(o.creditUsagePercent) ?? asNumber(o.usedPercent) ?? asNumber(o.utilization) ?? asNumber(o.percentage) ?? asNumber(o.percent);
    if (used === undefined) continue;
    const resetsAtMs = isoToMs(o.resets_at) ?? isoToMs(o.reset_at) ?? isoToMs(o.resetTime) ?? isoToMs(o.reset_time);
    const m = quotaOut(metric(RULE("def-" + c.id, c.id, "percent"), {
      unit: "percent", used,
      period: { kind: "rolling", resetState: resetsAtMs ? "known" : "unknown", resetsAtMs },
    }));
    m.primary = !!c.primary; m.label = c.label; m.id = c.id;
    windows.push(m);
  }
  return windows;
}

// — grok：cli-chat-proxy /v1/billing?format=credits（creditUsagePercent 已见于 CodexBar #3181）—
export async function fetchGrokBilling(token, extra = {}, ctx = {}) {
  const payload = await fetchJson({
    url: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    headers: { Authorization: `Bearer ${token}` },
    description: "Grok billing",
    secrets: [token],
    signal: ctx.signal,
  });
  return normalizeGrokBilling(payload, Date.now());
}

export function normalizeGrokBilling(payload, capturedAtMs) {
  const credits = asObject(payload.credits) ?? asObject(payload.data?.credits) ?? payload;
  const windows = probePercentWindows(credits, [
    { id: "grok-weekly", label: "共享周窗", pick: (p) => p, primary: true },
  ]);
  const plan = typeof payload.plan === "string" ? payload.plan : undefined;
  if (windows.length === 0) throw new Error("Grok billing 响应没有可识别的用量字段（pending-verification）。");
  const report = buildReport("grok", "Grok", { capturedAtMs, windows, diagnostics: [diagnostic("pending-verification", "warning")] });
  void plan; // plan 文本不进 report（§6.5），如需展示走注册 diagnostic
  return report;
}

// — devin：app.devin.ai /api/{orgId}/billing/quota/usage（网页会话 + org ID，§2.5 高风险）—
export async function fetchDevinQuota(token, extra = {}, ctx = {}) {
  if (!extra.organizationId) throw new Error("Devin 网页 org quota 需要 organizationId。");
  const payload = await fetchJson({
    url: `https://app.devin.ai/api/${encodeURIComponent(extra.organizationId)}/billing/quota/usage`,
    headers: { Authorization: `Bearer ${token}` },
    description: "Devin quota",
    secrets: [token],
    signal: ctx.signal,
  });
  return normalizeDevinQuota(payload, Date.now());
}

export function normalizeDevinQuota(payload, capturedAtMs) {
  const windows = probePercentWindows(payload, [
    { id: "devin-daily", label: "日额度", pick: (p) => p.daily ?? p, primary: true },
    { id: "devin-weekly", label: "周额度", pick: (p) => p.weekly },
  ]);
  if (windows.length === 0) throw new Error("Devin quota 响应没有可识别的用量字段（pending-verification）。");
  return buildReport("devin", "Devin", { capturedAtMs, windows, diagnostics: [diagnostic("pending-verification", "warning")] });
}

// — antigravity：agy 官方 /usage 非交互 JSON（S26；本地 server RPC 不在 M2）—
export async function fetchAntigravityUsage(_token, extra = {}, ctx = {}) {
  void _token;
  throw new Error("Antigravity v1 走官方 agy CLI 会话（capabilityId 路径），HTTP adapter 未启用（pending-verification）。");
}

export function normalizeAntigravityUsage(payload, capturedAtMs) {
  const quotaRoot = asObject(payload.quota) ?? asObject(payload.data?.quota) ?? payload;
  const windows = probePercentWindows(quotaRoot, [
    { id: "antigravity-gemini", label: "Gemini 池", pick: (p) => p.gemini ?? p, primary: true },
    { id: "antigravity-other", label: "非 Gemini 池", pick: (p) => p.other },
  ]);
  if (windows.length === 0) throw new Error("Antigravity usage 响应没有可识别的用量字段（pending-verification）。");
  return buildReport("antigravity", "Antigravity", { capturedAtMs, windows, diagnostics: [diagnostic("pending-verification", "warning")] });
}

// — ollama：签名 GET ollama.com/api/usage（签名能力经 broker；本函数只做归一化）—
export function normalizeOllamaUsage(payload, capturedAtMs) {
  const usage = asObject(payload) ?? {};
  const windows = probePercentWindows(usage, [
    { id: "ollama-monthly", label: "月度额度", pick: (p) => p.monthly ?? p, primary: true },
    { id: "ollama-weekly", label: "周额度", pick: (p) => p.weekly },
  ]);
  const metrics = [];
  if (windows.length === 0) throw new Error("Ollama usage 响应没有可识别的用量字段（pending-verification）。");
  return buildReport("ollama", "Ollama Cloud", { capturedAtMs, windows, metrics, diagnostics: [diagnostic("pending-verification", "warning")] });
}
