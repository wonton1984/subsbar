// SubsBar 数据引擎（M1：从 scripts/subs.mjs 迁入，C24 依赖方向 core←scripts）。
// 包含 v0 兼容的凭证解析、六家 fetch/normalize、v0 缓存与选择状态。
// 本模块不得 import scripts/ 下任何文件；pie-png（旧插件渲染）不入引擎。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const __engine = true;

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

export const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const BAR_WIDTH = 10;
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function agentDir() {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}
export const CACHE_FILE = join(agentDir(), "subs-bar-cache.json");

function authFile() {
  return join(agentDir(), "auth.json");
}

// ---------------------------------------------------------------------------
// 文本工具：脱敏 / 清洗
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 从文本中抹掉具体 secret（整串 + 前 12 位指纹）。 */
function redactSecrets(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    result = result.split(secret).join("<redacted>");
    if (secret.length > 12) {
      result = result.replace(new RegExp(escapeRegExp(secret.slice(0, 12)), "g"), "<redacted>");
    }
  }
  return result;
}

/** 通用疑似凭证模式擦除（Bearer xxx / eyJ JWT / token=xxx / user_cc key）。 */
export function scrubCredentials(text) {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b((?:api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|authorization)\s*[=:]\s*)\S+/gi,
      "$1[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(/\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b/gi, "[redacted]");
}

function redactError(error, secrets) {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(scrubCredentials(raw), secrets).slice(0, 200);
}

/** 清洗展示文本（去控制字符/压缩空白/截断）。 */
function sanitizeDisplayText(value, maxChars = 160) {
  let result = "";
  for (let i = 0; i < value.length; ) {
    const codePoint = value.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(codePoint);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) result += " ";
      i += ch.length;
      continue;
    }
    result += ch;
    i += ch.length;
  }
  const cleaned = result.replace(/\s+/gu, " ").trim();
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

// ---------------------------------------------------------------------------
// 受限 JSON 请求（超时/体积上限/错误脱敏）
// ---------------------------------------------------------------------------

const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;

function transportError(kind, message, extra = {}) {
  const err = new Error(message);
  err.transportKind = kind;
  if (extra.httpStatus !== undefined) err.httpStatus = extra.httpStatus;
  if (extra.cause !== undefined) err.cause = extra.cause;
  return err;
}

function fetchCauseCode(error) {
  return error?.cause?.code ?? error?.code ?? error?.cause?.cause?.code;
}

const FETCH_CONNECT_REFUSED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const FETCH_TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

export async function fetchJson({ url, headers, description, secrets, timeoutMs, method = "GET", body, signal: callerSignal }) {
  const timeout = timeoutMs ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  // 外部 signal 取消/超时 → 一并中止本请求（B3 修复：之前传入 signal 被忽略）
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  try {
    const response = await fetch(url, {
      method,
      headers: { accept: "application/json", ...headers },
      redirect: "error",
      signal: controller.signal,
      ...(body !== undefined ? { body } : {}),
    });
    const maxBytes = response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES;
    let text = "";
    try {
      const raw = await response.arrayBuffer();
      text = new TextDecoder().decode(raw.byteLength > maxBytes ? raw.slice(0, maxBytes) : raw);
    } catch {
      text = "";
    }
    if (!response.ok) {
      const detail = text.trim().slice(0, 200);
      const err = new Error(`${description} returned ${response.status}${detail ? `: ${detail}` : ""}`);
      err.httpStatus = response.status;
      if (response.status >= 500 && response.status <= 599) err.transportKind = "http-5xx";
      throw err;
    }
    if (timedOut) throw transportError("timeout", `${description} timed out`);
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed;
    } catch {
      throw new Error(`${description} returned invalid JSON`);
    }
  } catch (error) {
    if (error?.transportKind) throw error;
    if (Number.isInteger(error?.httpStatus)) throw error;
    if (timedOut) throw transportError("timeout", `${description} timed out`);
    const code = fetchCauseCode(error);
    if (FETCH_TIMEOUT_CODES.has(code)) throw transportError("timeout", `${description} timed out`, { cause: error });
    if (FETCH_CONNECT_REFUSED.has(code)) throw transportError("connect-refused", `${description} connect-refused`, { cause: error });
    if (error?.name === "AbortError" || controller.signal.aborted) {
      const reason = String(callerSignal?.reason ?? "");
      if (callerSignal?.aborted && /timeout/i.test(reason)) throw transportError("timeout", `${description} timed out`);
      if (callerSignal?.aborted && !timedOut) throw transportError("aborted", `${description} cancelled`);
      throw transportError("timeout", `${description} timed out`);
    }
    if (error?.name === "TypeError" && /fetch failed/i.test(String(error.message))) {
      throw transportError("connect-refused", `${description} connect-refused`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 凭证读取（auth.json 只读）
// ---------------------------------------------------------------------------

export function readAuthFile() {
  try {
    const parsed = JSON.parse(readFileSync(authFile(), "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

const AUTH_KEYS = {
  opencode: ["opencode-go", "opencode"],
  kimi: ["kimi-coding"],
  codex: ["openai-codex"],
  commandcode: ["commandcode"],
  // droid/cursor 凭证不走 auth.json（见文件节点专用解析函数）
};

/**
 * 解析某订阅的凭证。返回 { kind, access, refresh?, expires?, accountId? } 或 undefined。
 * kind: "api-key" | "oauth"
 */
export function resolveCredential(auth, subsId) {
  // droid/cursor：凭证在 auth.json 之外的本地存储（keychain 加密块 / Cursor IDE sqlite）
  if (subsId === "droid") return readDroidCredential();
  if (subsId === "cursor") return readCursorCredential();
  for (const key of AUTH_KEYS[subsId] ?? []) {
    const entry = auth[key];
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "api_key" && typeof entry.key === "string" && entry.key) {
      return { kind: "api-key", access: entry.key };
    }
    if (entry.type === "oauth" && typeof entry.access === "string" && entry.access) {
      return {
        kind: "oauth",
        access: entry.access,
        ...(typeof entry.refresh === "string" ? { refresh: entry.refresh } : {}),
        ...(typeof entry.expires === "number" ? { expires: entry.expires } : {}),
        ...(typeof entry.accountId === "string" ? { accountId: entry.accountId } : {}),
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 通用响应字段解析助手（移植自 pi-subs providers）
// ---------------------------------------------------------------------------

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function asString(value, max = 160) {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, max) || undefined;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asNonnegativeInteger(value) {
  if (typeof value === "string" && !/^\d+$/u.test(value)) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return undefined;
  return n;
}

function asPositiveInteger(value) {
  const n = asNonnegativeInteger(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Kimi For Coding（https://api.kimi.com/coding/v1/usages）
// ---------------------------------------------------------------------------

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const FIXED_POINT_UNITS_PER_CENT = 1_000_000;

export async function fetchKimi(apiKey) {
  const payload = await fetchJson({
    url: KIMI_USAGE_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
    description: "Kimi usage",
    secrets: [apiKey],
  });
  return normalizeKimi(payload, Date.now());
}

function normalizeKimi(payload, capturedAt) {
  const root = asObject(payload);
  if (!root) throw new Error("Kimi usage 响应不是对象。");

  const candidates = [];
  let omitted = false;
  const summary = kimiUsageRow(root.usage, 10_080, "周配额");
  if (summary) candidates.push(summary);
  else if (root.usage !== undefined) omitted = true;

  if (Array.isArray(root.limits)) {
    for (const raw of root.limits) {
      const item = asObject(raw);
      const windowMinutes = kimiWindowMinutes(item?.window);
      const label = asString(item?.name, 80);
      const bucket =
        windowMinutes === undefined
          ? undefined
          : kimiUsageRow(item?.detail, windowMinutes, label ?? kimiDefaultLabel(windowMinutes));
      if (bucket) candidates.push(bucket);
      else omitted = true;
    }
  } else if (root.limits !== undefined) {
    omitted = true;
  }

  const windows = [];
  const byWindow = new Map();
  for (const bucket of candidates) {
    const m = bucket.windowMinutes ?? 0;
    byWindow.set(m, [...(byWindow.get(m) ?? []), bucket]);
  }
  for (const rows of byWindow.values()) {
    if (rows.length === 1) windows.push(rows[0]);
    else omitted = true;
  }
  windows.sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
  for (const w of windows) if (w.id === "five-hour") w.primary = true;
  if (!windows.some((w) => w.primary) && windows.length > 0) {
    windows[windows.length - 1].primary = true;
  }

  const metrics = kimiBoosterWallet(root.boosterWallet);
  if (windows.length === 0 && metrics.length === 0) {
    throw new Error("Kimi usage 响应没有可显示的用量数据。");
  }
  return {
    windows,
    metrics,
    name: "Kimi",
    capturedAt,
    ...(omitted ? { notes: ["部分无法识别的窗口已省略。"] } : {}),
  };
}

function kimiUsageRow(value, windowMinutes, label) {
  const row = asObject(value);
  if (!row) return undefined;
  const limit = asNonnegativeInteger(row.limit);
  const remaining = asNonnegativeInteger(row.remaining);
  const used = asNonnegativeInteger(row.used);
  if (limit === undefined || limit === 0) return undefined;
  const effectiveUsed = used ?? (remaining !== undefined ? Math.max(0, limit - remaining) : undefined);
  if (effectiveUsed === undefined) return undefined;
  const resetsAt = kimiIsoEpoch(row.resetTime);
  const id =
    windowMinutes === 300
      ? "five-hour"
      : windowMinutes === 1_440
        ? "daily"
        : windowMinutes === 10_080
          ? "weekly"
          : `window-${windowMinutes}`;
  return {
    id,
    label,
    used: effectiveUsed,
    remaining: remaining ?? Math.max(0, limit - effectiveUsed),
    limit,
    unit: "count",
    windowMinutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function kimiWindowMinutes(value) {
  const window = asObject(value);
  if (!window) return undefined;
  const duration = asPositiveInteger(window.duration);
  if (duration === undefined) return undefined;
  const multiplier =
    window.timeUnit === "TIME_UNIT_MINUTE"
      ? 1
      : window.timeUnit === "TIME_UNIT_HOUR"
        ? 60
        : window.timeUnit === "TIME_UNIT_DAY"
          ? 1_440
          : window.timeUnit === "TIME_UNIT_WEEK"
            ? 10_080
            : undefined;
  if (multiplier === undefined) return undefined;
  const minutes = duration * multiplier;
  return Number.isSafeInteger(minutes) ? minutes : undefined;
}

function kimiDefaultLabel(minutes) {
  if (minutes === 10_080) return "周配额";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w窗口`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d窗口`;
  if (minutes % 60 === 0) return `${minutes / 60}h窗口`;
  return `${minutes}m窗口`;
}

function kimiBoosterWallet(value) {
  const wallet = asObject(value);
  const balance = asObject(wallet?.balance);
  if (!wallet || !balance || balance.type !== "BOOSTER") return [];
  const totalRaw = asPositiveInteger(balance.amount);
  if (totalRaw === undefined) return [];
  const leftRaw = asNonnegativeInteger(balance.amountLeft) ?? 0;
  const monthlyLimit = kimiMoney(wallet.monthlyChargeLimit);
  const monthlyUsed = kimiMoney(wallet.monthlyUsed);
  const currencies = new Set(
    [monthlyLimit?.currency, monthlyUsed?.currency].filter((c) => c !== undefined),
  );
  if (currencies.size !== 1) return [];
  const currency = currencies.values().next().value;
  if (!currency) return [];
  const total = kimiFixedToMajor(totalRaw);
  const left = kimiFixedToMajor(leftRaw);
  if (total === undefined || left === undefined) return [];
  const metrics = [
    { id: "booster-balance", label: "加速包余额", value: left, unit: "currency", currency },
  ];
  if (monthlyUsed) {
    metrics.push({
      id: "booster-monthly-used",
      label: "加速包本月已用",
      value: monthlyUsed.cents / 100,
      unit: "currency",
      currency,
    });
  }
  return metrics;
}

function kimiMoney(value) {
  const money = asObject(value);
  if (!money) return undefined;
  const cents = asNonnegativeInteger(money.priceInCents);
  if (cents === undefined) return undefined;
  const currency = asString(money.currency, 3);
  if (!currency || !/^[A-Za-z]{3}$/.test(currency)) return undefined;
  return { cents, currency: currency.toUpperCase() };
}

function kimiFixedToMajor(value) {
  const cents = value / FIXED_POINT_UNITS_PER_CENT;
  const roundedCents = cents > 0 && cents < 1 ? 1 : Math.round(cents);
  const major = roundedCents / 100;
  return Number.isSafeInteger(roundedCents) && Number.isFinite(major) ? major : undefined;
}

function kimiIsoEpoch(value) {
  if (typeof value !== "string") return undefined;
  if (
    !/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.test(
      value,
    )
  ) {
    return undefined;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) && millis >= 0 ? Math.floor(millis / 1000) : undefined;
}

// ---------------------------------------------------------------------------
// OpenCode Go（https://opencode.ai/zen/go/v1/usage）
// ---------------------------------------------------------------------------

const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_WINDOWS = [
  { key: "rolling", label: "滚动5h" },
  { key: "weekly", label: "周" },
  { key: "monthly", label: "月" },
];

export async function fetchOpenCode(apiKey) {
  const payload = await fetchJson({
    url: OPENCODE_USAGE_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
    description: "OpenCode usage",
    secrets: [apiKey],
  });
  return normalizeOpenCode(payload, Date.now());
}

function normalizeOpenCode(payload, capturedAt) {
  const usage = asObject(payload.usage);
  if (!usage) throw new Error("OpenCode usage 响应缺少 usage 字段。");
  const notes = [];
  const windows = [];
  for (const w of OPENCODE_WINDOWS) {
    const raw = asObject(usage[w.key]);
    if (!raw) continue;
    const status = asString(raw.status, 80);
    if (status !== "ok" && status !== "rate-limited") {
      notes.push(`${w.label}窗口不可用(${status ?? "unknown"})`);
      continue;
    }
    const used = typeof raw.percent === "number" && Number.isFinite(raw.percent) && raw.percent >= 0
      ? raw.percent
      : undefined;
    if (used === undefined) continue;
    const resetsAt = opencodeEpoch(raw.resetsAt);
    windows.push({
      id: w.key,
      label: w.label,
      used: clampPercent(used),
      limit: 100,
      unit: "percent",
      primary: w.key === "rolling",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  if (windows.length === 0) throw new Error("OpenCode usage 响应没有可显示的用量数据。");
  return {
    windows,
    metrics: [],
    name: "OpenCode",
    capturedAt,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function opencodeEpoch(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

// ---------------------------------------------------------------------------
// OpenAI Codex（https://chatgpt.com/backend-api/wham/usage）
// ---------------------------------------------------------------------------

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// codex CLI 的公共 client_id（社区通行值，auth.openai.com 公开客户端）
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkX67XuORkP4S";

export async function fetchCodex(accessToken, extra = {}) {
  const accountId = typeof extra.accountId === "string" && extra.accountId.trim()
    ? extra.accountId.trim() : undefined;
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const payload = await fetchJson({
    url: CODEX_USAGE_URL,
    headers,
    description: "Codex usage",
    secrets: [accessToken, ...(accountId ? [accountId] : [])],
  });
  return normalizeCodex(payload, Date.now());
}

export function normalizeCodex(payload, capturedAt) {
  const windows = [];
  codexRateLimitGroup(windows, "codex", "Codex", payload.rate_limit, false);
  const additional = Array.isArray(payload.additional_rate_limits)
    ? payload.additional_rate_limits
    : [];
  for (const item of additional) {
    const value = asObject(item);
    if (!value) continue;
    const id = asString(value.metered_feature) ?? asString(value.limit_name);
    if (!id) continue;
    try {
      codexRateLimitGroup(windows, id, asString(value.limit_name) ?? id, value.rate_limit, true);
    } catch {
      // 附加桶失败不影响主数据
    }
  }

  const metrics = [];
  const credits = asObject(payload.credits);
  if (credits?.has_credits === true) {
    if (credits.unlimited === true) {
      metrics.push({ label: "Credits", value: "无限" });
    } else {
      const balance = asNumber(credits.balance);
      if (balance !== undefined) {
        metrics.push({ label: "Credits", value: balance, unit: "count" });
      } else {
        metrics.push({ label: "Credits", value: "可用" });
      }
    }
  } else if (credits?.has_credits === false) {
    metrics.push({ label: "Credits", value: "无" });
  }
  const resetCredits = asObject(payload.rate_limit_reset_credits);
  const resetCount = asNonnegativeInteger(resetCredits?.available_count);
  if (resetCount !== undefined && resetCount > 0) {
    metrics.push({ label: "可用额度重置", value: resetCount, unit: "count" });
  }
  if (windows.length === 0 && metrics.length === 0) {
    throw new Error("Codex usage 响应没有可显示的用量数据。");
  }

  const notes = [];
  const planType = asString(payload.plan_type);
  if (planType) notes.push(`套餐: ${planType}`);
  // 口径说明：响应中唯一用量字段是 rate_limit.primary_window.used_percent（测试 fixture 为合成示例值），
  // 官方 Web 页面有时显示不同数值（口径差异），该口径在 wham 响应中无对应字段（secondary/chatpass/附加桶均不为它），
  // 可能是官方页面另一聚合视图；本层不做硬调，以 wham 原始响应为准。
  notes.push("口径：wham 原始 used_percent");
  if (!windows.some((w) => w.primary)) {
    const first = windows.find((w) => w.id.endsWith(":primary"));
    if (first) first.primary = true;
    else if (windows.length > 0) windows[0].primary = true;
  }
  return {
    windows,
    metrics,
    name: "Codex",
    capturedAt,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

function codexRateLimitGroup(windows, groupId, groupLabel, raw, optional) {
  if (raw === undefined || raw === null) return;
  const details = asObject(raw);
  if (!details) {
    if (optional) return;
    throw new Error("Codex rate limit 不是对象。");
  }
  codexAddWindow(windows, groupId, groupLabel, "primary", details.primary_window);
  codexAddWindow(windows, groupId, groupLabel, "secondary", details.secondary_window);
}

function codexAddWindow(windows, groupId, groupLabel, position, raw) {
  if (raw === undefined || raw === null) return;
  const value = asObject(raw);
  if (!value) throw new Error("Codex rate-limit window 不是对象。");
  const used = asNumber(value.used_percent);
  if (used === undefined) return;
  const seconds = asNumber(value.limit_window_seconds);
  const resetsAt = asNumber(value.reset_at);
  const windowMinutes = seconds !== undefined && seconds > 0 ? Math.ceil(seconds / 60) : undefined;
  windows.push({
    id: `${groupId}:${position}`,
    label: codexWindowLabel(groupId, groupLabel, position, windowMinutes),
    used: clampPercent(used),
    remaining: 100 - clampPercent(used),
    limit: 100,
    unit: "percent",
    primary: false,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  });
}

/** 窗口标签按真实时长生成（响应 limit_window_seconds）。上游 pi-subs 原码硬编码「5h主窗口」，
 * 但实测 codex 主窗口可为 windowMinutes=10080（周窗），故这里按真实时长命名，与上游有意相异：
 * 已知时长映射 300→5h、1440→24h、10080→周；未知时长用中性「主/次窗口」不猜。 */
export function codexWindowLabel(groupId, groupLabel, position, windowMinutes) {
  const scale = windowDurationLabel(windowMinutes);
  const base = `${groupLabel}` || "Codex";
  const role = position === "primary" ? "主窗口" : "次窗口";
  if (scale) return groupId === "codex" ? `${scale}${role}` : `${base}·${scale}${role}`;
  return groupId === "codex" ? role : `${groupLabel}${role}`;
}

function windowDurationLabel(windowMinutes) {
  if (windowMinutes === undefined) return undefined;
  if (windowMinutes === 300) return "5h";
  if (windowMinutes === 1440) return "24h";
  if (windowMinutes === 10080) return "周";
  if (windowMinutes === 43200 || windowMinutes === 44640 || windowMinutes === 43800) return "月";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

// ---------------------------------------------------------------------------
// Command Code（https://api.commandcode.ai/alpha/*）
// ---------------------------------------------------------------------------

const COMMANDCODE_BASE = "https://api.commandcode.ai";
/** 实测 2026-09-30：未鉴权 whoami ~760ms 回 403，源站可达。旧实现 15s AbortController 包住 whoami+credits/subscriptions+summary 三轮，慢响应会被打成 timeout 且 reason=http-5xx。 */
const COMMANDCODE_TASK_TIMEOUT_MS = 60_000;
const COMMANDCODE_REQUEST_TIMEOUT_MS = 20_000;

export async function fetchCommandCode(accessToken, ctx = {}) {
  const started = Date.now();
  try {
    return await fetchCommandCodeOnce(accessToken, ctx);
  } catch (error) {
    const isTimeout = error?.transportKind === "timeout" || /timed out|timeout/i.test(String(error?.message ?? error));
    if (!isTimeout || ctx.signal?.aborted || Date.now() - started > 35_000) throw error;
    return await fetchCommandCodeOnce(accessToken, ctx);
  }
}

async function fetchCommandCodeOnce(accessToken, ctx = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), COMMANDCODE_TASK_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  if (ctx.signal) {
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const headers = { accept: "application/json", Authorization: `Bearer ${accessToken}` };
  const secrets = [accessToken];
  const jsonOpts = { headers, secrets, timeoutMs: COMMANDCODE_REQUEST_TIMEOUT_MS, signal: controller.signal };
  try {
    const whoamiRaw = await fetchJson({
      url: `${COMMANDCODE_BASE}/alpha/whoami`,
      description: "CmdCode whoami",
      ...jsonOpts,
    });
    const account = commandCodeWhoami(whoamiRaw);
    if (!account) throw new Error("Command Code 返回了无法识别的账户响应。");
    const orgId = account.orgId ?? undefined;

    const [creditsRaw, subscriptionRaw] = await Promise.all([
      commandCodeSafe(() =>
        fetchJson({
          url: commandCodeUrl("/alpha/billing/credits", { orgId }),
          description: "CmdCode credits",
          ...jsonOpts,
        }),
      ),
      commandCodeSafe(() =>
        fetchJson({
          url: commandCodeUrl("/alpha/billing/subscriptions", { orgId }),
          description: "CmdCode subscription",
          ...jsonOpts,
        }),
      ),
    ]);

    const unavailable = [];
    const credits = commandCodeCredits(creditsRaw);
    if (!credits) unavailable.push("credits");
    const subscription = commandCodeSubscription(subscriptionRaw);
    if (!subscription) unavailable.push("subscription");

    const summaryRaw = await commandCodeSafe(() =>
      fetchJson({
        url: commandCodeUrl("/alpha/usage/summary", {
          orgId,
          since: subscription?.currentPeriodStart ?? undefined,
        }),
        description: "CmdCode summary",
        ...jsonOpts,
      }),
    );
    const summary = commandCodeSummary(summaryRaw);
    if (!summary) unavailable.push("usage");

    if (!credits && !subscription && !summary) {
      throw new Error("Command Code 没有可识别的用量数据。");
    }
    return commandCodeReport(account, credits, subscription, summary, unavailable, Date.now());
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener?.("abort", onCallerAbort);
  }
}

function commandCodeUrl(path, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return `${COMMANDCODE_BASE}${path}${query ? `?${query}` : ""}`;
}

async function commandCodeSafe(fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { __error: true, message };
  }
}

function isCommandCodeError(value) {
  return typeof value === "object" && value !== null && value.__error === true;
}

function commandCodeWhoami(value) {
  if (!asObject(value)) return null;
  const org = asObject(value.org);
  const user = asObject(value.user);
  const login =
    (org ? asString(org.login) : undefined) ??
    (user ? asString(user.userName) ?? asString(user.name) : undefined);
  if (!login) return null;
  const orgId = org ? asString(org.id) : undefined;
  const keyName = user ? asString(user.keyName) ?? asString(user.displayName) : undefined;
  return { login, orgId: orgId ?? null, ...(keyName ? { keyName } : {}) };
}

function commandCodeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function commandCodeResetAt(value) {
  let ts;
  if (typeof value === "number" && Number.isFinite(value)) ts = value;
  if (typeof value === "string" && value.trim()) {
    ts = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
  }
  if (ts === undefined || !Number.isFinite(ts) || ts <= 0) return null; // 0 = 窗口未激活/无数据（实测 resetAt=0/undefined 且 used=0）
  return ts >= 1e12 ? Math.round(ts / 1000) : ts;
}

export function commandCodeCredits(value) {
  if (isCommandCodeError(value)) return null;
  if (!asObject(value) || !asObject(value.credits)) return null;
  const credits = value.credits;
  const monthly = commandCodeNumber(credits.monthlyCredits);
  const purchased = commandCodeNumber(credits.purchasedCredits);
  const free = commandCodeNumber(credits.freeCredits);
  if (monthly === undefined && purchased === undefined && free === undefined) return null;
  const windowLimits = [];
  for (const [window, entry] of [
    ["fiveHour", asObject(value.windowLimits?.fiveHour)],
    ["weekly", asObject(value.windowLimits?.weekly)],
  ]) {
    if (!entry) continue;
    const used = commandCodeNumber(entry.used);
    const cap = commandCodeNumber(entry.cap);
    if (used === undefined || cap === undefined || (used === 0 && cap === 0)) continue;
    windowLimits.push({ window, used, cap, resetAt: commandCodeResetAt(entry.resetAt) });
  }
  return {
    monthlyCredits: monthly ?? 0,
    purchasedCredits: purchased ?? 0,
    freeCredits: free ?? 0,
    remainingCredits: (monthly ?? 0) + (purchased ?? 0) + (free ?? 0),
    windowLimits,
  };
}

function commandCodeSubscription(value) {
  if (isCommandCodeError(value) || !asObject(value) || !asObject(value.data)) return null;
  const data = value.data;
  const planId = asString(data.planId);
  const status = asString(data.status);
  const currentPeriodStart = asString(data.currentPeriodStart);
  const currentPeriodEnd = asString(data.currentPeriodEnd);
  if (!planId && !status && !currentPeriodStart && !currentPeriodEnd) return null;
  return {
    planId: planId ?? null,
    status: status ?? null,
    currentPeriodStart: currentPeriodStart ?? null,
    currentPeriodEnd: currentPeriodEnd ?? null,
  };
}

function commandCodeSummary(value) {
  if (isCommandCodeError(value) || !asObject(value)) return null;
  const totalCost = commandCodeNumber(value.totalCost);
  const totalCount = commandCodeNumber(value.totalCount);
  if (totalCost === undefined || totalCount === undefined) return null;
  const totalTokens = commandCodeNumber(value.totalTokens) ?? commandCodeNumber(value.tokens);
  return { totalCost, totalCount, ...(totalTokens !== undefined ? { totalTokens } : {}) };
}

// 月度分配额语义修正（实测结论 + pi-commandcode-provider 官方 formatQuota 印证）：
//   credits.monthlyCredits = 月度*剩余*；summary.totalCost = 本周期已用；合成示例：剩余 + 已用 = 分配额（数值见测试 fixture）。
//   used = summary.totalCost（跨加购/免费来源），limit = totalCost + 三类剩余。用户“分配额耗尽”必须显示 100%。
//   子窗口（5h/周）used/cap 由上游真实上报，不能从 summary 反推。
export function commandCodeReport(account, credits, subscription, summary, unavailable, capturedAt) {
  const windows = [];
  const metrics = [];
  const notes = [];
  const round2 = (v) => Math.round(v * 100) / 100;

  if (credits) {
    // 实测：currentPeriodEnd 是真实月度周期结束时间，用它补月度credits倒计时
    const periodEndMs = subscription?.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : NaN;
    const periodResets = Number.isFinite(periodEndMs) && periodEndMs > capturedAt ? Math.floor(periodEndMs / 1000) : undefined;
    // 口径一：有 summary → 用真实已用；limit = 已用 + 剩余（三类 credits 都是剩余口径）
    // 降级口径：summary 缺失时只发 remaining，不输出 used=0/limit=monthlyCredits（会被误解为满余额）；
    // 契约：无 used/limit=undefined 的窗口，渲染层显示「剩 $x」而不算百分比。维护者共同确认。
    const monthlyRemaining = (credits.monthlyCredits ?? 0) + (credits.purchasedCredits ?? 0) + (credits.freeCredits ?? 0);
    const monthlyUsed = summary ? summary.totalCost : undefined;
    const monthlyLimit = monthlyUsed !== undefined ? monthlyUsed + monthlyRemaining : undefined;
    windows.push({
      id: "monthly-credits",
      label: summary ? "月度credits" : "月度credits（剩余）",
      ...(monthlyUsed !== undefined ? { used: round2(monthlyUsed) } : {}),
      ...(monthlyLimit !== undefined ? { limit: round2(monthlyLimit) } : {}),
      ...(summary ? {} : { remaining: round2(monthlyRemaining) }),
      unit: "usd",
      primary: credits.windowLimits.length === 0,
      ...(periodResets ? { resetsAt: periodResets } : {}),
    });
    if (!summary) {
      notes.push("月度口径：summary 不可用，仅显示剩余额度");
    }
    for (const limit of credits.windowLimits) {
      windows.push({
        id: `window-${limit.window}`,
        label: limit.window === "fiveHour" ? "滚动5h" : "周窗口",
        used: round2(limit.used),
        limit: round2(limit.cap),
        unit: "usd",
        primary: limit.window === "fiveHour",
        ...(limit.resetAt !== null ? { resetsAt: limit.resetAt } : {}),
      });
    }
    if (credits.purchasedCredits > 0) {
      metrics.push({ label: "加购credits", value: round2(credits.purchasedCredits), unit: "usd" });
    }
    if (credits.freeCredits > 0) {
      metrics.push({ label: "免费credits", value: round2(credits.freeCredits), unit: "usd" });
    }
  } else {
    notes.push("credits 数据不可用");
  }

  if (subscription) {
    if (subscription.planId) notes.push(`套餐: ${subscription.planId}`);
    if (subscription.status && subscription.status !== "active") {
      notes.push(`状态: ${subscription.status}`);
    }
  }

  if (summary) {
    metrics.push({ label: "本周期消费", value: round2(summary.totalCost), unit: "usd" });
    metrics.push({ label: "本周期请求数", value: summary.totalCount, unit: "count" });
  }
  if (account?.login) notes.push(account.login);
  if (unavailable.length > 0) notes.push(`${unavailable.join("/")}不可用`);

  return {
    windows,
    metrics,
    name: "CmdCode",
    capturedAt,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** Command Code 长效 API key：access 即 key，"刷新" = 校验复用（见 pi-commandcode-provider oauth.ts）。 */
// ---------------------------------------------------------------------------
// droid (Factory) — 凭证在 Keychain "Factory CLI" 的 AES key + ~/.factory/auth.v2.loginkeychain
// （逆向端点，见 notes/droid-cursor-usage-apis.md；token 过期不自动刷新）
// ---------------------------------------------------------------------------

import { execFileSync } from "child_process";
import { createDecipheriv } from "crypto";

const DROID_USAGE_URL = "https://api.factory.ai/api/organization/subscription/usage";
const DROID_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://app.factory.ai",
  Referer: "https://app.factory.ai/",
  "x-factory-client": "web-app",
};

/** 解 JWT 掉 payload（不解签名）。返回 null 非法。 */
export function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    let b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const json = Buffer.from(b64, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 用 Keychain 里的 AES key 解密 ~/.factory/auth.v2.loginkeychain（只读，不解钥回写）。 */
export function readDroidCredential() {
  if (process.env.FACTORY_API_KEY) {
    return { kind: "api-key", access: process.env.FACTORY_API_KEY };
  }
  let raw;
  let key;
  try {
    raw = readFileSync(join(homedir(), ".factory", "auth.v2.loginkeychain"), "utf8");
    key = execFileSync("security", [
      "find-generic-password", "-s", "Factory CLI",
      "-a", "auth-encryption-key-security-cli", "-w",
    ], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return undefined; // droid 未安装/未登录/Keychain 拒绝
  }
  try {
    const [ivB64, tagB64, dataB64] = raw.split(":");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
    const creds = JSON.parse(out);
    if (!creds?.access_token) return undefined;
    // 过期检查（WorkOS JWT ~7天）：不自动刷新，过期提示重登
    const payload = decodeJwtPayload(creds.access_token);
    if (payload?.exp && payload.exp * 1000 < Date.now()) {
      const err = new Error("Droid token 已过期（请重跑 `droid` 登录）");
      err.code = "DROID_TOKEN_EXPIRED";
      throw err;
    }
    return { kind: "oauth", access: creds.access_token };
  } catch (error) {
    if (error?.code === "DROID_TOKEN_EXPIRED") throw error;
    return undefined;
  }
}

export async function fetchDroid(accessToken) {
  const headers = { accept: "application/json", Authorization: `Bearer ${accessToken}`, ...DROID_HEADERS };
  const secrets = [accessToken];
  // 先 GET：多数账户无需要 userId
  let payload;
  try {
    payload = await fetchJson({ url: `${DROID_USAGE_URL}?useCache=true`, headers, description: "Droid usage", secrets });
  } catch (error) {
    if (!/returned 40/.test(String(error.message))) throw error;
    // 403 "Must be manager..." 等 → POST+userId（JWT sub）重试
    const userId = decodeJwtPayload(accessToken)?.sub;
    payload = await fetchJson({
      url: DROID_USAGE_URL,
      headers,
      description: "Droid usage (POST+userId)",
      secrets,
      method: "POST",
      body: JSON.stringify({ useCache: true, ...(userId ? { userId } : {}) }),
    });
  }
  const report = normalizeDroidPayload(payload, Date.now());
  // 滚动窗口（5h/周/月）：与 subscription/usage 月度 billing pool 是不同的东西（droid TUI /limits 显示的）。
  // 端点 reverse-engineered（droid CLI bundle 确认），失败降级为仅 billing pool 窗口。
  try {
    const limits = await fetchJson({ url: `${DROID_BASE}/api/billing/limits`, headers, description: "Droid rate limits", secrets });
    mergeDroidRateLimits(report, limits, Date.now());
  } catch {
    // 端点变动/不可用 → 保留月度 billing pool 窗口，不报错
  }
  return report;
}

const DROID_BASE = "https://api.factory.ai";

/** 把 billing/limits 的滚动窗口合进 SubsReport（standard pool 的 5h/周/月）。primary 只标 5h。 */
export function mergeDroidRateLimits(report, limitsPayload, capturedAt) {
  if (report.provider !== "droid") return;
  const pools = asObject(asObject(limitsPayload?.limits)?.standard);
  if (!pools) {
    // 端点响应异常 → 显式标注滚动额度缺失，不无声消失
    (report.notes ??= []).push("滚动额度数据不可用");
    return;
  }
  report.windows ??= [];
  for (const w of report.windows) w.primary = false;
  // 0% 也是有效状态，不丢弃；倒计时用 secondsRemaining（更准），无则用 windowEnd；上游无重置信息时保持无 resetsAt（不编造）
  const defs = [
    ["fiveHour", "滚动5h", 300],
    ["weekly", "滚动周", 10080],
    ["monthly", "滚动月", undefined],
  ];
  for (const [key, label, windowMinutes] of defs) {
    const bucket = asObject(pools[key]);
    if (!bucket) continue;
    const usedPercent = asNumber(bucket.usedPercent);
    if (usedPercent === undefined) continue; // 仅字段缺失才跳过
    const secondsRemaining = asNumber(bucket.secondsRemaining);
    const windowEnd = asString(bucket.windowEnd, 60);
    let resetsAt;
    if (secondsRemaining !== undefined && secondsRemaining > 0) resetsAt = Math.floor(capturedAt / 1000 + secondsRemaining);
    else if (windowEnd) {
      const ms = Date.parse(windowEnd);
      if (Number.isFinite(ms) && ms > capturedAt) resetsAt = Math.floor(ms / 1000);
    }
    report.windows.unshift({
      id: key,
      label: resetUnknownLabel(label, resetsAt),
      used: Math.min(100, Math.max(0, usedPercent)),
      limit: 100,
      unit: "percent",
      primary: false,
      ...(resetsAt ? { resetsAt } : {}),
      ...(windowMinutes ? { windowMinutes } : {}),
    });
  }
  // primary 只标 5h 滚动窗；无 5h 时回退到 monthly pool（「标准额度」）
  const fiveHour = report.windows.find((w) => w.id === "fiveHour");
  if (fiveHour) fiveHour.primary = true;
  else if (report.windows.length > 0) report.windows[report.windows.length - 1].primary = true;
}

/** 月度 billing pool（subscription/usage）endDate=null 实测常态 → 详情区不能显示假倒计时，直接在 label 标明。 */
function resetUnknownLabel(label, resetsAt) {
  return label; // 标签不改字，缺 resetsAt 时详情区自然无倒计时；保全调研语义由测试覆盖
}

/** 解析两种响应变体：嵌套 usage.standard/premium 与 legacy 顶层 used/allowance。 */
export function normalizeDroidPayload(payload, capturedAt) {
  const usage = asObject(payload?.usage);
  const standardBucket = asObject(usage?.standard) ?? asObject(payload?.standard);
  const premiumBucket = asObject(usage?.premium) ?? asObject(payload?.premium);
  const windows = [];
  const notes = [];
  const addBucket = (bucket, id, label, primary) => {
    if (!bucket) return;
    // 变体1: userTokens/totalAllowance；变体2: used/allowance
    let used;
    let limit;
    if (bucket.userTokens !== undefined || bucket.totalAllowance !== undefined) {
      used = asNumber(bucket.userTokens ?? bucket.used ?? 0);
      limit = asNumber(bucket.totalAllowance ?? bucket.allowance ?? bucket.basicAllowance ?? 0);
    } else if (bucket.used !== undefined || bucket.allowance !== undefined) {
      used = asNumber(bucket.used ?? 0);
      limit = asNumber(bucket.allowance ?? 0);
    }
    if (limit === undefined || limit <= 0) return;
    const resetsMs = asNumber(usage?.endDate ?? payload?.endDate ?? null);
    windows.push({
      id,
      label,
      used: used ?? 0,
      limit,
      unit: "count",
      primary,
      ...(resetsMs !== undefined && resetsMs > 0 ? { resetsAt: Math.floor(resetsMs / 1000) } : {}),
    });
  };
  addBucket(standardBucket, "standard", "标准额度", true);
  addBucket(premiumBucket, "premium", "Premium额度", false);
  const overage = asNumber(usage?.orgOverageUsed ?? null);
  if (overage !== undefined && overage > 0) {
    notes.push(`超额 ${overage}`);
  }
  if (windows.length === 0) {
    throw new Error("Droid usage 响应没有可显示的额度数据。");
  }
  if (typeof payload?.userId === "string" && payload.userId) notes.push(payload.userId.slice(0, 12) + "…");
  return { provider: "droid", name: "Droid", capturedAt, windows, metrics: [], ...(notes.length ? { notes } : {}) };
}

// ---------------------------------------------------------------------------
// Cursor — 每次轮询重新读 state.vscdb 里的 JWT（只读，SDK 自会路由 session token）
// 主用 REST /api/usage-summary；401 时兜底 Connect-RPC GetCurrentPeriodUsage。
// ---------------------------------------------------------------------------

const CURSOR_VSCDB = join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
const CURSOR_REST_URL = "https://cursor.com/api/usage-summary";
const CURSOR_RPC_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export function readCursorCredential() {
  try {
    const jwt = execFileSync("sqlite3", [CURSOR_VSCDB, "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken';"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (!jwt || !jwt.includes(".")) return undefined;
    return { kind: "oauth", access: jwt };
  } catch {
    return undefined;
  }
}

/** Cursor cookie userId = JWT sub 最后「|」后面的段。 */
export function cursorCookieUserId(jwt) {
  const sub = decodeJwtPayload(jwt)?.sub;
  if (typeof sub !== "string" || !sub) return null;
  const parts = sub.split("|");
  const last = parts[parts.length - 1] ?? sub;
  return last || null;
}

export async function fetchCursor(jwt) {
  const secrets = [jwt];
  const userId = cursorCookieUserId(jwt);
  const headers = {
    accept: "application/json",
    Origin: "https://cursor.com",
    ...(userId ? { Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${jwt}` } : {}),
  };
  let payload;
  try {
    payload = await fetchJson({ url: CURSOR_REST_URL, headers, description: "Cursor usage", secrets });
    const legacy = asObject(payload?.individualUsage);
    if (!legacy?.plan && !legacy?.overall) {
      throw new Error("Cursor usage 响应缺少 individualUsage。");
    }
  } catch (error) {
    if (!/returned 40/.test(String(error.message))) throw error;
    // 兜底 Connect-RPC（Bearer JWT）
    payload = await fetchJson({
      url: CURSOR_RPC_URL,
      headers: { accept: "application/json", "Content-Type": "application/json", "Connect-Protocol-Version": "1", Authorization: `Bearer ${jwt}` },
      description: "Cursor usage (Connect-RPC)",
      secrets,
      method: "POST",
      body: JSON.stringify({}),
    });
  }
  return normalizeCursorPayload(payload, Date.now());
}

/** 防御性解析：plan shape（现）与 overall shape（legacy）两套，缺字段跳过。金额 cents → $。 */
export function normalizeCursorPayload(payload, capturedAt) {
  const windows = [];
  const metrics = [];
  const notes = [];
  const membership = asString(payload?.membershipType, 40);
  if (membership) notes.push(membership);

  // Connect-RPC shape: planUsage + billingCycleEnd(ms string)
  const planUsage = asObject(payload?.planUsage);
  const cycleEndMsRpc = asNumber(payload?.billingCycleEnd ?? null);
  const legacy = asObject(payload?.individualUsage);
  const plan = asObject(legacy?.plan);
  const onDemand = asObject(legacy?.onDemand);
  const overall = asObject(legacy?.overall);
  const cycleEndIso = asString(payload?.billingCycleEnd, 60);

  // 主窗口：总量百分比（两个 shape 语义一致）
  const totalPercent =
    asNumber(plan?.totalPercentUsed) ??
    asNumber(planUsage?.totalPercentUsed) ??
    asNumber(overall?.used ?? null);
  if (totalPercent !== undefined && Number.isFinite(totalPercent)) {
    const resetsAt = normalizeCursorReset(cycleEndIso) ?? (cycleEndMsRpc !== undefined && cycleEndMsRpc > 0 ? Math.floor(cycleEndMsRpc / 1000) : undefined);
    windows.push({
      id: "usage",
      label: "总量",
      used: Math.round(totalPercent * 100) / 100,
      limit: 100,
      unit: "percent",
      primary: true,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const addPercentWindow = (value, id, label) => {
    if (value === undefined || !Number.isFinite(value)) return;
    windows.push({ id, label, used: Math.round(value * 100) / 100, limit: 100, unit: "percent" });
  };
  addPercentWindow(asNumber(plan?.autoPercentUsed ?? planUsage?.autoPercentUsed), "auto", "内置模型");
  addPercentWindow(asNumber(plan?.apiPercentUsed ?? planUsage?.apiPercentUsed), "api", "API余上");

  // onDemand rail（cents → $）
  const odUsed = asNumber(onDemand?.used ?? null);
  const odLimit = asNumber(onDemand?.limit ?? null);
  if (odLimit !== undefined && odLimit > 0) {
    windows.push({
      id: "on-demand",
      label: "按需付费",
      used: (odUsed ?? 0) / 100,
      limit: odLimit / 100,
      unit: "usd",
    });
  } else if (asNumber(planUsage?.totalSpend) !== undefined) {
    metrics.push({
      id: "period-spend",
      label: "本周期消费",
      value: (planUsage.totalSpend ?? 0) / 100,
      unit: "usd",
    });
  }
  const breakdown = asObject(plan?.breakdown);
  if (breakdown && asNumber(breakdown.bonus) !== undefined && breakdown.bonus > 0) {
    metrics.push({
      id: "bonus",
      label: "赠送额度",
      value: (breakdown.bonus ?? 0) / 100,
      unit: "usd",
    });
  }
  if (windows.length === 0) {
    throw new Error("Cursor usage 响应没有可显示的额度数据。");
  }
  return { provider: "cursor", name: "Cursor", capturedAt, windows, metrics, ...(notes.length ? { notes } : {}) };
}

function normalizeCursorReset(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : undefined;
}

// ---------------------------------------------------------------------------
// 刷新编排
// ---------------------------------------------------------------------------

export const SUBS_ORDER = ["codex", "opencode", "kimi", "commandcode", "droid", "cursor"];

export async function refreshAll(debug) {
  const auth = readAuthFile();
  const now = Date.now();
  const cache = loadCache();
  const results = [];

  await Promise.all(
    SUBS_ORDER.map(async (subsId) => {
      const credential = resolveCredential(auth, subsId);
      if (!credential) {
        results.push({ id: subsId, status: "not-configured" });
        return;
      }
      const accountId = typeof credential.accountId === "string" && credential.accountId.trim()
        ? credential.accountId.trim() : undefined;
      const extra = accountId ? { accountId } : {};
      const secrets = [credential.access, ...(credential.refresh ? [credential.refresh] : []), ...(accountId ? [accountId] : [])];
      try {
        const report = await fetchFor(subsId, credential.access, extra);
        cache[subsId] = { report, fetchedAt: now };
        results.push({ id: subsId, status: "ok" });
      } catch (error) {
        const message = redactError(error, secrets);
        // v1 裁决（contracts §1）：不消费 borrowed refresh——401/403 归 reauth-required，
        // 由 owner 原应用刷新后重读；本引擎不调 token endpoint、不写回任何 auth 文件。
        const entry = cache[subsId];
        if (entry && now - entry.fetchedAt < MAX_CACHE_AGE_MS) {
          results.push({ id: subsId, status: "stale", message });
        } else {
          results.push({ id: subsId, status: "error", message });
        }
      }
    }),
  );

  // 持久化缓存（含刷新得到的新 token？不写回 auth.json —— 它是只读的）
  saveCache(cache);
  return { results, cache };
}

export function fetchFor(subsId, token, extra = {}) {
  if (subsId === "kimi") return fetchKimi(token);
  if (subsId === "opencode") return fetchOpenCode(token);
  if (subsId === "codex") return fetchCodex(token, extra);
  if (subsId === "commandcode") return fetchCommandCode(token);
  if (subsId === "droid") return fetchDroid(token);
  if (subsId === "cursor") return fetchCursor(token);
  throw new Error(`unknown subs id: ${subsId}`);
}

// ---------------------------------------------------------------------------
// 缓存读写
// ---------------------------------------------------------------------------

export function loadCache() {
  try {
    const parsed = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveCache(cache) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    const temp = `${CACHE_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
    renameSync(temp, CACHE_FILE);
  } catch {
    // 缓存写失败不影响主流程
  }
}

function cacheAgeLabel(entry) {
  const minutes = Math.round((Date.now() - entry.fetchedAt) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

const STATE_FILE = join(agentDir(), "subs-bar-state.json");

/** 选中订阅的余量百分比（0-100），无数据 null。 */
function remainingPercent(entry) {
  const primary = pickPrimary(entry?.report?.windows ?? []);
  if (!primary) return null;
  if (primary.unit === "percent") return clampPercent(100 - (primary.used ?? 0));
  const used = primary.used ?? 0;
  const limit = primary.limit ?? 0;
  if (limit <= 0) return null;
  return clampPercent(100 - (used / limit) * 100);
}

/** 读取选择状态（~/.pi/agent/subs-bar-state.json，只存 provider id 字符串）。 */
export function loadSelection() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return typeof parsed?.selected === "string" ? parsed.selected : null;
  } catch {
    return null;
  }
}

export function saveSelection(subsId) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify({ selected: subsId })}\n`, "utf-8");
  } catch {
    // 写失败不影响主流程
  }
}

/** 默认选中：第一个缓存新鲜的订阅（windows 空、只有 metrics 的也可选）。 */
function defaultSelection(cache) {
  const now = Date.now();
  for (const subsId of SUBS_ORDER) {
    const entry = cache[subsId];
    if (entry && entry.report && now - entry.fetchedAt < MAX_CACHE_AGE_MS) {
      return subsId;
    }
  }
  return null;
}

export function pickSelection(cache) {
  const saved = loadSelection();
  if (saved && SUBS_ORDER.includes(saved)) return saved;
  return defaultSelection(cache);
}

/** 选中订阅主窗口：primary 优先，其次第一个有效 used，再否则第一行。 */
function pickPrimary(windows) {
  return windows.find((w) => w.primary) ?? windows.find((w) => w.used !== undefined) ?? windows[0];
}

// ---------------------------------------------------------------------------
