// M2 新增 provider 引擎（批次 A 移植自 pi-subs MIT；批次 B 起逐家接入）。
// 全部输出 SnapshotReport（contracts §6.2），经 normalizeQuota 归一化：
// 不做 clamp/补 0（§1 v1 裁决），超额原值保留，缺失即 unknown。
// 批次 C-D 的响应字段名未经真实账号验证 —— 状态 pending-verification，
// manifest admission 保持 pending（refresh 拒绝执行），fixture 为乐观形状。
import { execFile } from "child_process";
import { existsSync, statSync } from "fs";
import { fetchJson } from "./engine.mjs";
import { normalizeQuota, usedPercentOf, iconFractionOf } from "../../runtime/report.mjs";
import { diagnostic, safeText } from "../../defs.mjs";
import { isCopilotOauthToken } from "../../credentials/stores.mjs";
import {
  isOllamaApiKey, ollamaUsageChallenge, ollamaUsageUrl, signOllamaChallenge,
} from "../../credentials/ollama-signer.mjs";

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
  if (n === undefined) return undefined;
  return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
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
// 批次 A — claude（2026-10-02：admission blocked。normalize 仅供离线形状测试，refresh 拒绝执行）
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
// 批次 B — copilot：社区 copilot_internal/user 只接受 Copilot OAuth；
// 官方 CLI 会话另有 pending 源。403 不得改打组织 billing。
// ---------------------------------------------------------------------------

export const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

export async function fetchCopilotUsage(token, extra = {}, ctx = {}) {
  void extra;
  if (!isCopilotOauthToken(token)) {
    const err = new Error("Copilot usage returned 403: credential is not Copilot OAuth");
    err.httpStatus = 403;
    throw err;
  }
  const payload = await fetchJson({
    url: COPILOT_USAGE_URL,
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
// 批次 B — zai：region 必填；global/cn origin 不互探；CN 本轮未实测。
// ---------------------------------------------------------------------------

export const ZAI_REGION_ORIGINS = { global: "https://api.z.ai", cn: "https://open.bigmodel.cn" };
export const ZAI_QUOTA_PATH = "/api/monitor/usage/quota/limit";

export async function fetchZaiUsage(token, extra = {}, ctx = {}) {
  const origin = ZAI_REGION_ORIGINS[extra.region];
  if (!origin) throw new Error("Z.AI 需要明确 region（global/cn），不跨区试探。");
  const payload = await fetchJson({
    url: `${origin}${ZAI_QUOTA_PATH}`,
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
// 批次 B — openrouter：普通 key /api/v1/key 为主路径。
// /credits 需 management key；本轮调度不解析第二凭证。limit_remaining 不是账户余额。
// ---------------------------------------------------------------------------

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";

export async function fetchOpenRouterUsage(token, extra = {}, ctx = {}) {
  const payload = await fetchJson({
    url: OPENROUTER_KEY_URL,
    headers: { Authorization: `Bearer ${token}` },
    description: "OpenRouter key",
    secrets: [token],
    signal: ctx.signal,
  });
  const report = normalizeOpenRouterKey(payload, Date.now());
  if (!extra.managementToken) return report;
  try {
    const credits = await fetchJson({
      url: OPENROUTER_CREDITS_URL,
      headers: { Authorization: `Bearer ${extra.managementToken}` },
      description: "OpenRouter credits",
      secrets: [extra.managementToken],
      signal: ctx.signal,
    });
    return mergeOpenRouterCredits(report, credits);
  } catch {
    report.diagnostics = [...(report.diagnostics ?? []), diagnostic("openrouter-credits-unavailable", "info")];
    return report;
  }
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

/** management-key /credits。不得把 key.limit_remaining 写入这里。 */
export function mergeOpenRouterCredits(report, payload) {
  const data = asObject(payload?.data) ?? asObject(payload);
  if (!report || !data) return report;
  const total = asNonNegative(data.total_credits);
  if (total === undefined) return report;
  report.metrics = [...(report.metrics ?? [])];
  report.metrics.push({
    id: "account-credits", ruleId: "account-credits", label: "账户余额",
    kind: "balance", unit: "currency", currency: "USD", scope: "subscription",
    provenance: "reported", sourceEndpointIds: ["openrouter-credits"],
    state: "known", value: total, diagnostics: [],
  });
  return report;
}

// ---------------------------------------------------------------------------
// 批次 C — antigravity / devin / grok（字段名未经真实账号验证；admission 保持 pending）
// ---------------------------------------------------------------------------

function probePercentWindows(payload, candidates) {
  const windows = [];
  for (const c of candidates) {
    const o = asObject(c.pick ? c.pick(payload) : payload[c.key]);
    if (!o) continue;
    const used = usedPercentField(o);
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

/** 显式百分位优先；仅 fraction/remainingFraction 时按 0..1 换算。缺字段不补 0/100。 */
function usedPercentField(o) {
  const explicit = asNumber(o.creditUsagePercent) ?? asNumber(o.usedPercent) ?? asNumber(o.utilization)
    ?? asNumber(o.percentage) ?? asNumber(o.percent);
  if (explicit !== undefined) return explicit;
  const usedFrac = asNumber(o.fraction) ?? asNumber(o.usageFraction) ?? asNumber(o.usedFraction);
  if (usedFrac !== undefined && usedFrac <= 1) return usedFrac * 100;
  const remainingFrac = asNumber(o.remainingFraction);
  if (remainingFrac !== undefined && remainingFrac <= 1) return roundPercent((1 - remainingFrac) * 100);
  const rem = asNumber(o.remaining);
  if (rem !== undefined && rem <= 1) return roundPercent((1 - rem) * 100);
  if (rem !== undefined && rem <= 100) return roundPercent(100 - rem);
  return undefined;
}

function roundPercent(n) {
  return Math.round(n * 1e6) / 1e6;
}

function deniedQuotaError(message, httpStatus = 403) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  return err;
}

function isQuotaDenied(payload) {
  const err = asObject(payload?.error) ?? payload?.error;
  const text = typeof err === "string" ? err : (typeof err?.message === "string" ? err.message : typeof payload?.message === "string" ? payload.message : "");
  const code = typeof err === "object" && err ? String(err.code ?? err.status ?? "") : String(payload?.code ?? payload?.status ?? "");
  return /quota.?denied|quotas denied|permission.?denied/i.test(text) || /QUOTA.?DENIED/i.test(code);
}

function isNoOrganizations(message) {
  return /no organizations found/i.test(String(message ?? ""));
}

function encodePathSegment(id) {
  if (typeof id !== "string" || !id || id.length > 128) return undefined;
  if (/[\\/]|:|\.\./.test(id)) return undefined;
  return encodeURIComponent(id);
}

// — grok：cli-chat-proxy /v1/billing?format=credits。不写回 auth.json、不轮换借用 token、不承诺网页 gRPC/WKE。—
export const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export function isGrokManagementKey(token) {
  return typeof token === "string" && /^xai-/.test(token);
}

export async function fetchGrokBilling(token, extra = {}, ctx = {}) {
  void extra;
  if (isGrokManagementKey(token)) throw deniedQuotaError("Grok billing returned 403: management key is not a subscription token", 403);
  const payload = await fetchJson({
    url: GROK_BILLING_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-xai-token-auth": "xai-grok-cli",
    },
    description: "Grok billing",
    secrets: [token],
    signal: ctx.signal,
  });
  return normalizeGrokBilling(payload, Date.now());
}

function grokPeriodMeta(config, credits) {
  const start = isoToMs(config?.currentPeriod?.start) ?? isoToMs(config?.billingPeriodStart) ?? isoToMs(credits?.period_start);
  const end = isoToMs(config?.currentPeriod?.end) ?? isoToMs(config?.billingPeriodEnd) ?? isoToMs(credits?.resets_at)
    ?? isoToMs(credits?.reset_at);
  let kind = "unknown";
  let id = "grok-weekly";
  let label = "共享周窗";
  let durationSeconds;
  if (start !== undefined && end !== undefined && end > start) {
    durationSeconds = Math.round((end - start) / 1000);
    const days = durationSeconds / 86400;
    if (days >= 25 && days <= 40) { kind = "calendar"; id = "grok-monthly"; label = "月窗口"; }
    else if (days >= 5 && days <= 10) { kind = "rolling"; id = "grok-weekly"; label = "共享周窗"; }
    else { kind = "unknown"; id = "grok-credits"; label = "额度窗口"; }
  }
  return { kind, id, label, durationSeconds, resetsAtMs: end, resetState: end ? "known" : "unknown" };
}

export function normalizeGrokBilling(payload, capturedAtMs) {
  const credits = asObject(payload.credits) ?? asObject(payload.data?.credits) ?? asObject(payload.config) ?? payload;
  const config = asObject(payload.config) ?? asObject(credits.config) ?? {};
  const period = grokPeriodMeta(config, credits);
  const used = usedPercentField(credits) ?? usedPercentField(config) ?? usedPercentField(payload);
  const diagnostics = [diagnostic("pending-verification", "warning")];
  const windows = [];
  const metrics = [];
  if (used !== undefined) {
    const m = quotaOut(metric(RULE("grok-" + period.id, period.id, "percent"), {
      unit: "percent", used,
      period: { kind: period.kind, durationSeconds: period.durationSeconds, resetState: period.resetState, resetsAtMs: period.resetsAtMs },
    }));
    m.primary = true; m.label = period.label; m.id = period.id;
    windows.push(m);
  }
  const cap = asNonNegative(payload.onDemandCap?.val) ?? asNonNegative(payload.onDemandCap) ?? asNonNegative(credits.onDemandCap);
  const paygUsed = asNonNegative(payload.onDemandUsed?.val) ?? asNonNegative(payload.onDemandUsed);
  if (cap === 0) diagnostics.push(diagnostic("grok-payg-disabled", "info"));
  else if (cap !== undefined) {
    // 上限来自服务端 cap；无 used 时不补 0。周期上游未给则显式 unknown，不借用周/月窗。
    const payg = quotaOut(metric(RULE("grok-payg", "payg-cap", "credits", {
      derivations: paygUsed !== undefined ? ["remaining-from-limit-used"] : [],
      sourceEndpointIds: ["grok-billing"],
    }), {
      unit: "credits",
      ...(paygUsed !== undefined ? { used: paygUsed } : {}),
      limit: cap,
      period: { kind: "unknown", resetState: "unknown" },
    }));
    payg.primary = false;
    payg.label = "PAYG上限";
    payg.id = "payg-cap";
    metrics.push(payg);
  }
  const plan = typeof payload.plan === "string" ? payload.plan : typeof payload.subscription_tier_display === "string" ? payload.subscription_tier_display : undefined;
  void plan;
  if (windows.length === 0 && metrics.length === 0) throw new Error("Grok billing 响应没有可识别的用量字段（pending-verification）。");
  return buildReport("grok", "Grok", { capturedAtMs, windows, metrics, diagnostics });
}

// — devin：CLI/App 与 web-org 分流。禁止跨账户 fallback；daily 不贴成 weekly。—
export const DEVIN_WEB_ORIGIN = "https://app.devin.ai";
export const DEVIN_CLI_ORIGIN = "https://server.codeium.com";

export function isDevinWebSource(extra = {}) {
  const id = extra.dataSourceId ?? extra.source;
  return id === "devin-web-org" || id === "web-org";
}

export async function fetchDevinQuota(token, extra = {}, ctx = {}) {
  if (extra.payload && !isDevinWebSource(extra)) return normalizeDevinCliStatus(extra.payload, Date.now());
  if (!isDevinWebSource(extra) && extra.dataSourceId === "devin-cli-app") {
    const err = new Error("Devin CLI GetUserStatus Connect framing unverified this round");
    err.transportKind = "unsupported";
    throw err;
  }
  const org = extra.organizationId;
  const enc = encodePathSegment(org);
  if (!enc) throw new Error("Devin 网页 org quota 需要 organizationId。");
  let payload;
  try {
    payload = await fetchJson({
      url: `${DEVIN_WEB_ORIGIN}/api/${enc}/billing/quota/usage`,
      headers: { Authorization: `Bearer ${token}`, "x-cog-org-id": org, Accept: "application/json" },
      description: "Devin quota",
      secrets: [token],
      signal: ctx.signal,
    });
  } catch (e) {
    if (isNoOrganizations(e?.message)) {
      throw deniedQuotaError("Devin quota returned 403: No organizations found for auth1 user (check org ID / session)", 403);
    }
    throw e;
  }
  return normalizeDevinQuota(payload, Date.now());
}

function addDevinWindow(windows, id, label, raw, primary) {
  const o = asObject(raw);
  if (!o) return;
  const used = usedPercentField(o);
  if (used === undefined) return;
  const resetsAtMs = isoToMs(o.resets_at) ?? isoToMs(o.reset_at) ?? isoToMs(o.resetTime) ?? epochSecToMs(o.resetAt);
  const m = quotaOut(metric(RULE("devin-" + id, id, "percent"), {
    unit: "percent", used,
    period: { kind: "rolling", resetState: resetsAtMs ? "known" : "unknown", resetsAtMs },
  }));
  m.primary = !!primary; m.label = label; m.id = id;
  windows.push(m);
}

export function normalizeDevinQuota(payload, capturedAtMs) {
  const hideDaily = payload.hide_daily_quota === true;
  const windows = [];
  if (!hideDaily) addDevinWindow(windows, "devin-daily", "日额度", payload.daily, true);
  addDevinWindow(windows, "devin-weekly", "周额度", payload.weekly, hideDaily || windows.length === 0);
  if (windows.length === 0 && !asObject(payload.weekly) && !asObject(payload.daily)) {
    const fallback = probePercentWindows(payload, [
      { id: "devin-daily", label: "日额度", pick: (p) => p.daily ?? p, primary: true },
      { id: "devin-weekly", label: "周额度", pick: (p) => p.weekly },
    ]);
    windows.push(...fallback);
  }
  const metrics = [];
  const extraBal = asNonNegative(payload.extra_balance) ?? asNonNegative(payload.extraBalance) ?? asNonNegative(asObject(payload.extra)?.balance);
  if (extraBal !== undefined) {
    metrics.push({
      id: "extra-balance", ruleId: "extra-balance", label: "额外余额", kind: "balance",
      unit: "currency", currency: "USD", scope: "organization", provenance: "reported",
      sourceEndpointIds: ["devin-org-quota"], state: "known", value: extraBal, diagnostics: [],
    });
  }
  if (windows.length === 0 && metrics.length === 0) throw new Error("Devin quota 响应没有可识别的用量字段（pending-verification）。");
  return buildReport("devin", "Devin", { capturedAtMs, windows, metrics, diagnostics: [diagnostic("pending-verification", "warning")] });
}

/** CLI GetUserStatus 形状：remaining 百分位翻成已用；不得把 daily 写入 weekly。 */
export function normalizeDevinCliStatus(payload, capturedAtMs) {
  const root = asObject(payload) ?? {};
  const windows = [];
  addDevinWindow(windows, "devin-daily", "日额度", root.daily ?? root.dailyQuota, true);
  addDevinWindow(windows, "devin-weekly", "周额度", root.weekly ?? root.weeklyQuota, windows.length === 0);
  if (windows.length === 0) throw new Error("Devin CLI status 响应没有可识别的用量字段（pending-verification）。");
  return buildReport("devin", "Devin", { capturedAtMs, windows, diagnostics: [diagnostic("pending-verification", "warning")] });
}

// — antigravity：已登录 agy 非交互 /usage；local-api 仅 loopback 且须显式 allowLocalApi。—
export const AGY_USAGE_ARGV = ["-p", "/usage", "--output-format", "json"];
export const AGY_USAGE_MAX_BYTES = 65536;
export const AGY_USAGE_TIMEOUT_MS = 15_000;
export const AGY_DEFAULT_EXECUTABLE = "/opt/homebrew/bin/agy";

export function defaultAgyRun({ executable, argv, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    if (typeof executable !== "string" || !executable || !existsSync(executable)) {
      reject(Object.assign(new Error("Antigravity CLI executable missing"), { transportKind: "unsupported" }));
      return;
    }
    try {
      if (!statSync(executable).isFile()) {
        reject(Object.assign(new Error("Antigravity CLI executable missing"), { transportKind: "unsupported" }));
        return;
      }
    } catch {
      reject(Object.assign(new Error("Antigravity CLI executable missing"), { transportKind: "unsupported" }));
      return;
    }
    const child = execFile(executable, argv, {
      timeout: timeoutMs ?? AGY_USAGE_TIMEOUT_MS,
      maxBuffer: maxBytes ?? AGY_USAGE_MAX_BYTES,
      encoding: "utf8",
      windowsHide: true,
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin:/opt/homebrew/bin",
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      },
    }, (err, stdout) => {
      if (err) {
        const e = new Error("Antigravity CLI usage failed");
        e.transportKind = err.killed ? "timeout" : "network";
        reject(e);
        return;
      }
      resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
    });
    if (signal) {
      const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function fetchAntigravityUsage(_token, extra = {}, ctx = {}) {
  void _token;
  if (extra.payload) {
    if (isQuotaDenied(extra.payload)) throw deniedQuotaError("Antigravity usage returned 403: quotas denied", 403);
    return normalizeAntigravityUsage(extra.payload, Date.now());
  }
  if (extra.localApi) {
    const err = new Error("Antigravity local-api CSRF/loopback session unverified this round");
    err.transportKind = "unsupported";
    throw err;
  }
  const run = extra.runCommand ?? defaultAgyRun;
  const stdout = await run({
    executable: extra.executablePath ?? AGY_DEFAULT_EXECUTABLE,
    argv: AGY_USAGE_ARGV,
    timeoutMs: extra.timeoutMs ?? AGY_USAGE_TIMEOUT_MS,
    maxBytes: AGY_USAGE_MAX_BYTES,
    signal: ctx.signal,
  });
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new Error("Antigravity CLI usage returned invalid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Antigravity CLI usage returned invalid JSON");
  if (isQuotaDenied(payload)) throw deniedQuotaError("Antigravity usage returned 403: quotas denied", 403);
  return normalizeAntigravityUsage(payload, Date.now());
}

function addAntigravityPool(windows, id, label, raw, primary) {
  const o = asObject(raw);
  if (!o) return;
  const session = asObject(o.session) ?? asObject(o.five_hour) ?? asObject(o.fiveHour);
  const weekly = asObject(o.weekly) ?? asObject(o.seven_day) ?? asObject(o.sevenDay);
  if (session || weekly) {
    if (session) addAntigravityWindow(windows, id, label, session, primary);
    if (weekly) addAntigravityWindow(windows, id + "-weekly", label + "·周", weekly, false);
    return;
  }
  addAntigravityWindow(windows, id, label, o, primary);
}

function addAntigravityWindow(windows, id, label, raw, primary) {
  const o = asObject(raw);
  if (!o) return;
  const used = usedPercentField(o);
  if (used === undefined) return;
  const resetsAtMs = isoToMs(o.resets_at) ?? isoToMs(o.reset_at) ?? isoToMs(o.resetTime);
  const m = quotaOut(metric(RULE("agy-" + id, id, "percent"), {
    unit: "percent", used,
    period: { kind: "rolling", resetState: resetsAtMs ? "known" : "unknown", resetsAtMs },
  }));
  m.primary = !!primary; m.label = label; m.id = id;
  windows.push(m);
}

export function normalizeAntigravityUsage(payload, capturedAtMs) {
  if (isQuotaDenied(payload)) throw deniedQuotaError("Antigravity usage returned 403: quotas denied", 403);
  const quotaRoot = asObject(payload.quota) ?? asObject(payload.data?.quota) ?? asObject(payload.quotas) ?? payload;
  const windows = [];
  addAntigravityPool(windows, "antigravity-gemini", "Gemini 池", quotaRoot.gemini ?? quotaRoot.session, true);
  addAntigravityPool(windows, "antigravity-other", "非 Gemini 池", quotaRoot.other ?? quotaRoot.claude ?? quotaRoot.nonGemini);
  if (windows.length === 0) {
    const probed = probePercentWindows(quotaRoot, [
      { id: "antigravity-gemini", label: "Gemini 池", pick: (p) => p.gemini ?? p, primary: true },
      { id: "antigravity-other", label: "非 Gemini 池", pick: (p) => p.other },
    ]);
    windows.push(...probed);
  }
  if (windows.length === 0) throw new Error("Antigravity usage 响应没有可识别的用量字段（pending-verification）。");
  if (!windows.some((w) => w.primary) && windows[0]) windows[0].primary = true;
  return buildReport("antigravity", "Antigravity", { capturedAtMs, windows, diagnostics: [diagnostic("pending-verification", "warning")] });
}

// — ollama：签名 GET ollama.com/api/usage（request-signer；普通 API key 不替代 quota）。—
export const OLLAMA_USAGE_URL = "https://ollama.com/api/usage";

function ollamaUsedPercent(o) {
  const shared = usedPercentField(o);
  if (shared !== undefined) return shared;
  const usageN = asNumber(o.usage);
  if (usageN !== undefined && usageN <= 1) return usageN * 100;
  if (usageN !== undefined && usageN <= 100) return usageN;
  return undefined;
}

function addOllamaWindow(windows, id, label, raw, primary, periodKind, durationSeconds) {
  if (windows.some((w) => w.id === id)) return;
  const o = asObject(raw);
  if (!o) return;
  const resetsAtMs = isoToMs(o.resets_at) ?? isoToMs(o.reset_at) ?? isoToMs(o.resetTime) ?? isoToMs(o.reset_time);
  const usedAmt = asNonNegative(o.used) ?? asNonNegative(o.used_credits) ?? asNonNegative(o.spend);
  const limitAmt = asNonNegative(o.limit) ?? asNonNegative(o.included) ?? asNonNegative(o.quota);
  const usedPct = ollamaUsedPercent(o);
  const period = {
    kind: periodKind,
    ...(durationSeconds ? { durationSeconds } : {}),
    resetState: resetsAtMs ? "known" : "unknown",
    resetsAtMs,
  };
  let m;
  if (usedAmt !== undefined && limitAmt !== undefined) {
    m = quotaOut(metric(RULE("ollama-" + id, id, "currency", { derivations: ["remaining-from-limit-used"] }), {
      unit: "currency", currency: "USD", used: usedAmt, remaining: Math.max(0, limitAmt - usedAmt), limit: limitAmt, period,
    }));
  } else if (usedPct !== undefined) {
    m = quotaOut(metric(RULE("ollama-" + id, id, "percent"), { unit: "percent", used: usedPct, period }));
  } else {
    return;
  }
  m.primary = !!primary;
  m.label = label;
  m.id = id;
  windows.push(m);
}

export async function fetchOllamaUsage(token, extra = {}, ctx = {}) {
  if (extra.payload) return normalizeOllamaUsage(extra.payload, Date.now());
  if (isOllamaApiKey(token) && !extra.signRequest) {
    throw deniedQuotaError("Ollama usage returned 403: OLLAMA_API_KEY cannot replace quota", 403);
  }
  const ts = extra.nowSec ?? Math.floor(Date.now() / 1000);
  const challenge = ollamaUsageChallenge(ts);
  let authorization;
  try {
    authorization = extra.signRequest ? extra.signRequest(challenge) : signOllamaChallenge(token, challenge).authorization;
  } catch {
    throw deniedQuotaError("Ollama usage returned 403: signing key unreadable or encrypted", 403);
  }
  const fetchFn = extra.fetchJson ?? fetchJson;
  let payload;
  try {
    payload = await fetchFn({
      url: extra.url ?? ollamaUsageUrl(ts),
      headers: { Authorization: authorization, Accept: "application/json" },
      description: "Ollama usage",
      secrets: [token, authorization],
      signal: ctx.signal,
    });
  } catch (e) {
    if (e?.httpStatus === 401) {
      throw deniedQuotaError("Ollama usage returned 401: signing key is not linked to an ollama.com account", 401);
    }
    throw e;
  }
  return normalizeOllamaUsage(payload, Date.now());
}

export function normalizeOllamaUsage(payload, capturedAtMs) {
  const root = asObject(payload) ?? {};
  const usage = asObject(root.usage) ?? root;
  const windows = [];
  addOllamaWindow(windows, "ollama-monthly", "月度额度", usage.monthly ?? root.monthly, true, "calendar");
  addOllamaWindow(windows, "ollama-session", "会话额度", usage.session ?? usage.hourly ?? root.session ?? root.hourly, windows.length === 0, "rolling", 18_000);
  addOllamaWindow(windows, "ollama-weekly", "周额度", usage.weekly ?? root.weekly, windows.length === 0, "rolling", 604_800);
  const limits = Array.isArray(root.limits) ? root.limits : Array.isArray(usage.limits) ? usage.limits : [];
  for (const raw of limits) {
    const o = asObject(raw);
    if (!o) continue;
    const name = String(o.name ?? o.type ?? o.id ?? o.kind ?? "").toLowerCase();
    if (/month/.test(name)) addOllamaWindow(windows, "ollama-monthly", "月度额度", o, windows.length === 0, "calendar");
    else if (/session|hour/.test(name)) addOllamaWindow(windows, "ollama-session", "会话额度", o, windows.length === 0, "rolling", 18_000);
    else if (/week/.test(name)) addOllamaWindow(windows, "ollama-weekly", "周额度", o, windows.length === 0, "rolling", 604_800);
  }
  if (windows.length === 0) {
    windows.push(...probePercentWindows(usage, [
      { id: "ollama-monthly", label: "月度额度", pick: (p) => p.monthly ?? p, primary: true },
      { id: "ollama-session", label: "会话额度", pick: (p) => p.session },
      { id: "ollama-weekly", label: "周额度", pick: (p) => p.weekly },
    ]));
  }
  if (windows.length === 0) throw new Error("Ollama usage 响应没有可识别的用量字段（pending-verification）。");
  if (!windows.some((w) => w.primary) && windows[0]) windows[0].primary = true;
  return buildReport("ollama", "Ollama Cloud", { capturedAtMs, windows, diagnostics: [diagnostic("pending-verification", "warning")] });
}
