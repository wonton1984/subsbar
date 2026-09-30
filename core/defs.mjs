// M1 共享定义：枚举、错误码表、resolver→report 固定映射（contracts §2.3/§6.1）。
// 所有枚举为封闭集合；新增项必须先改 contracts 再改这里。

export const SOURCE_KINDS = ["env", "file", "keychain", "cli", "pi", "browser", "local-api"];

export const CREDENTIAL_ERROR_CODES = [
  "not-configured", "invalid", "expired", "permission-denied", "invalid-config",
  "account-mismatch", "interaction-required", "unsupported", "cancelled", "io-error",
];

export const ACTION_CODES = [
  "none", "configure-source", "select-profile", "allow-source", "relogin-owner",
  "check-permission", "check-plan-region", "update-client", "retry-later", "contact-maintainer",
];

export const PROVIDER_STATUSES = ["disabled", "not-configured", "ok", "partial", "stale",
  "reauth-required", "permission-denied", "rate-limited", "unsupported", "error"];

export const SAFE_ERROR_CODES = ["not-configured", "invalid-credential", "credential-expired",
  "permission-denied", "invalid-config", "account-mismatch", "interaction-required",
  "unsupported", "network", "timeout", "rate-limited", "invalid-response", "io-error",
  "cache-write-failed", "config-conflict", "schema-unsupported", "cancelled"];

export const FRESHNESS = ["none", "fresh", "stale", "expired", "invalid"];

// resolver 失败码 → ProviderEntry {status, error.code}（contracts §2.3 固定映射表）
export const RESOLVE_TO_ENTRY = {
  "not-configured": { status: "not-configured", code: "not-configured" },
  "invalid": { status: "reauth-required", code: "invalid-credential" },
  "expired": { status: "reauth-required", code: "credential-expired" },
  "permission-denied": { status: "permission-denied", code: "permission-denied" },
  "interaction-required": { status: "reauth-required", code: "interaction-required" },
  "account-mismatch": { status: "permission-denied", code: "account-mismatch" },
  "unsupported": { status: "unsupported", code: "unsupported" },
  "invalid-config": { status: "error", code: "invalid-config" },
  "io-error": { status: "error", code: "io-error" },
  "cancelled": { status: "error", code: "cancelled" },
};

// resolver 的 reasonCode → action（键控固定码；未注册码回退 none）
export const RESOLVE_TO_ACTION = {
  "not-configured": "configure-source",
  "invalid": "relogin-owner",
  "expired": "relogin-owner",
  "permission-denied": "check-permission",
  "interaction-required": "allow-source",
  "account-mismatch": "select-profile",
  "unsupported": "contact-maintainer",
  "invalid-config": "configure-source",
  "io-error": "retry-later",
  "cancelled": "none",
};

export const CORE_DIAGNOSTIC_CODES = [
  "inconsistent-values", "invalid-number", "missing-data", "reset-unknown", "clock-invalid",
  "legacy-unverified", "legacy-error", "summary-unavailable", "reader-unavailable",
  "cache-write-failed", "metric-unsupported", "inconsistent-state",
];

export const CORE_REASON_CODES = [
  "http-401", "http-403", "http-429", "http-5xx", "timeout", "connect-refused", "network",
  "file-malformed", "keychain-denied",
  "credential-expired", "insufficient-scope", "reader-unavailable", "unknown-reader", "config-conflict",
  "lock-busy", "cancelled", "empty-response", "schema-unsupported", "not-implemented",
];

export const GRACE_FUTURE_MS = 300_000;      // 未来时间容忍
export const FRESH_MS = 600_000;             // ≤10min fresh
export const STALE_MS = 86_400_000;          // ≥24h expired
export const DISPLAY_MAX = 160;              // 展示字符串上限
export const DESC_MAX = 512;                 // 说明/诊断资源上限
export const MS_MAX = 253_402_300_799_000;   // *AtMs 合法上限

export function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
}

export function isNonNegativeInt(v) {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

export function isAtMs(v) {
  return isFiniteNumber(v) && Number.isInteger(v) && v > 0 && v < MS_MAX;
}

/** 展示字符串清洗：去控制字符、限长（contracts §0）。 */
export function safeText(value, max = DISPLAY_MAX) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) { out += " "; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    out += ch;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** SafeError 构造：封闭 code + 注册 reasonCode + 合法 action。 */
export function safeError(code, reasonCode, action = "none", extra = {}) {
  if (!SAFE_ERROR_CODES.includes(code)) throw new Error(`unsafe error code ${code}`);
  const err = { code, reasonCode: String(reasonCode).slice(0, 64), action };
  if (extra.httpStatus !== undefined) {
    const s = extra.httpStatus;
    err.httpStatus = Number.isInteger(s) && s >= 100 && s <= 599 ? s : undefined;
    if (err.httpStatus === undefined) delete err.httpStatus;
  }
  if (extra.retryAtMs !== undefined && isAtMs(extra.retryAtMs)) err.retryAtMs = extra.retryAtMs;
  return err;
}

export function diagnostic(code, severity = "info", extra = {}) {
  const d = { code: String(code).slice(0, 64), severity };
  if (extra.metricId) d.metricId = safeText(extra.metricId, 96);
  if (extra.action) d.action = extra.action;
  return d;
}
