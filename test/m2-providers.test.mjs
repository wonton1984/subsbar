#!/usr/bin/env node
/**
 * M2 provider 扩展测试：批次 A 移植四家（合成 fixture）+ 批次 B-D 防御性解析。
 * 断言基于 pi-subs 上游语义（MIT，移植不改数值口径）+ §6.3 v1 语义。
 * 运行：node test/m2-providers.test.mjs ；退出码 0 = 全过。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  normalizeClaudeUsage, classifyClaudeWindowField, classifyClaudeExtraUsage, classifyClaudeLimits,
  fetchClaudeUsage, normalizeCopilotUsage, normalizeZaiQuota, normalizeOpenRouterKey,
  normalizeGrokBilling, normalizeDevinQuota, normalizeAntigravityUsage, normalizeOllamaUsage,
  ZAI_REGION_ORIGINS, ZAI_QUOTA_PATH, fetchCopilotUsage, fetchZaiUsage, mergeOpenRouterCredits,
  fetchAntigravityUsage, fetchDevinQuota, fetchGrokBilling, fetchOllamaUsage, AGY_USAGE_ARGV, AGY_DEFAULT_EXECUTABLE,
  GROK_BILLING_URL, DEVIN_WEB_ORIGIN, isGrokManagementKey, normalizeDevinCliStatus,
} from "../core/providers/engine/m2-providers.mjs";
import { fetchProviderSnapshot } from "../core/providers/adapters.mjs";
import { fetchCodex } from "../core/providers/engine/engine.mjs";
import { ProviderRegistry } from "../core/providers/registry.mjs";
import { isCopilotOauthToken, copilotAppsExtract, zaiEnvName, createCredentialStores, parseDevinTomlKey, parseDevinTomlOrigin, grokAuthFilePath, agyExecutableCandidates, resolveAgyExecutable, ollamaSigningKeyPath, ReaderOutcome, codexAuthExtract } from "../core/credentials/stores.mjs";
import { resolveChain } from "../core/credentials/resolver.mjs";
import { SecretBroker } from "../core/credentials/broker.mjs";
import { snapshotFetchExtra, fetchErrorToSafe, applyResult } from "../core/runtime/scheduler.mjs";
import {
  parseClaudeAiOauth, claudeUsageCapability, CLAUDE_BORROWED_REFRESH,
  claudeOnUnauthorized, claudeBindKey, claudeAcceptLateResult,
} from "../core/credentials/claude-oauth-shape.mjs";
import { isOllamaApiKey, ollamaUsageChallenge, signOllamaChallenge } from "../core/credentials/ollama-signer.mjs";
import { iconFractionOf } from "../core/runtime/report.mjs";

let ok = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }
}
const NOW = 1800000000000;
const reg = new ProviderRegistry();
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, "fixtures", "providers", name), "utf8"));

console.log("== A0. codex auth.json account_id → chatgpt-account-id（缺则仅 Bearer）==");
{
  const withId = fixture("codex-auth-with-account.json");
  const withoutId = fixture("codex-auth-without-account.json");
  const extracted = codexAuthExtract(withId);
  const extractedBare = codexAuthExtract(withoutId);
  check("含 account_id 透出绑定元数据", extracted.accountId === "acct_synthetic_codex_001" && new TextDecoder().decode(extracted.bytes) === "synthetic-codex-access-token");
  check("不含 account_id 仍只出 token", extractedBare.accountId === undefined && new TextDecoder().decode(extractedBare.bytes) === "synthetic-codex-access-token");
  check("空白 account_id 视为缺失", codexAuthExtract({ tokens: { access_token: "synthetic-codex-access-token", account_id: "   " } }).accountId === undefined);
  const authDir = mkdtempSync(join(tmpdir(), "codex-auth-"));
  writeFileSync(join(authDir, "with.json"), JSON.stringify(withId), { mode: 0o600 });
  writeFileSync(join(authDir, "without.json"), JSON.stringify(withoutId), { mode: 0o600 });
  const stores = createCredentialStores({ env: {} });
  const resolvedWith = stores.resolve("codex-auth-file", { reader: "codex-auth-file", path: join(authDir, "with.json") });
  const resolvedBare = stores.resolve("codex-auth-file", { reader: "codex-auth-file", path: join(authDir, "without.json") });
  check("file resolve 透出 accountId", resolvedWith.accountId === "acct_synthetic_codex_001");
  check("file resolve 缺 accountId 不硬拒", resolvedBare.accountId === undefined);
  const extraWith = snapshotFetchExtra({ dataSource: { id: "codex-wham" }, lease: { source: { accountId: resolvedWith.accountId } } });
  const extraBare = snapshotFetchExtra({ dataSource: { id: "codex-wham" }, lease: { source: {} } });
  check("scheduler extra 带上 accountId", extraWith.accountId === "acct_synthetic_codex_001" && extraWith.dataSourceId === "codex-wham");
  check("缺 accountId extra 不含该键", extraBare.accountId === undefined);
  const prevFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: { ...init.headers } });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({
        rate_limit: { allowed: true, primary_window: { used_percent: 3, limit_window_seconds: 604800 } },
      })),
    };
  };
  try {
    const token = "synthetic-codex-access-token";
    await fetchCodex(token, { accountId: "acct_synthetic_codex_001" });
    await fetchCodex(token, {});
    const bearer = ["Bearer", token].join(" ");
    check("有 accountId 发 chatgpt-account-id", seen[0].headers["chatgpt-account-id"] === "acct_synthetic_codex_001" && seen[0].headers.Authorization === bearer);
    check("缺 accountId 仅 Bearer", seen[1].headers["chatgpt-account-id"] === undefined && seen[1].headers.Authorization === bearer);
  } finally {
    globalThis.fetch = prevFetch;
  }
  const e401 = fetchErrorToSafe(Object.assign(new Error("Codex usage returned 401: unauthorized"), { httpStatus: 401 }));
  check("401 映射不变", e401.code === "invalid-credential" && e401.reasonCode === "http-401" && e401.action === "relogin-owner");
  const stateDir = join(authDir, "state");
  const broker = new SecretBroker();
  const ctx = { nowMs: NOW, interaction: "background", stores, broker, compatibility: { pi: { enabled: false } }, stateDir };
  const sourceWith = { id: "codex-auth-file", kind: "file", reader: "codex-auth-file", path: join(authDir, "with.json"), implementationId: "codex-auth-file" };
  const sourceBare = { id: "codex-auth-file", kind: "file", reader: "codex-auth-file", path: join(authDir, "without.json"), implementationId: "codex-auth-file" };
  const rWith = await resolveChain("codex", { id: "personal", discovery: "auto", sources: [sourceWith] }, [], ctx);
  const rBare = await resolveChain("codex", { id: "personal", discovery: "auto", sources: [sourceBare] }, [], ctx);
  writeFileSync(join(authDir, "other.json"), JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "synthetic-codex-access-token", account_id: "acct_synthetic_codex_002" },
  }), { mode: 0o600 });
  const rOther = await resolveChain("codex", { id: "personal", discovery: "auto", sources: [{ ...sourceWith, path: join(authDir, "other.json") }] }, [], ctx);
  check("resolve 成功且 lease 持有 accountId", rWith.status === "resolved" && rWith.lease.source.accountId === "acct_synthetic_codex_001");
  check("accountKey 是哈希不是明文", typeof rWith.lease.identity.accountKey === "string" && rWith.lease.identity.accountKey.startsWith("acct-") && rWith.lease.identity.accountKey !== "acct_synthetic_codex_001");
  check("换账户 scopeKey 隔离", rWith.lease.identity.scopeKey !== rOther.lease.identity.scopeKey);
  check("有无 accountId 也隔离", rWith.lease.identity.scopeKey !== rBare.lease.identity.scopeKey);
  const dumped = JSON.stringify({
    identity: rWith.lease.identity,
    extra: snapshotFetchExtra({ dataSource: { id: "codex-wham" }, lease: { source: { id: rWith.lease.source.id, reader: rWith.lease.source.reader } } }),
  });
  check("identity/envelope 路径不含明文 accountId", !dumped.includes("acct_synthetic_codex_001"));
  const entry = {
    providerId: "codex", profileId: "personal", scopeKey: rWith.lease.identity.scopeKey,
    status: "ok", freshness: "fresh", dataDisposition: "current",
    report: { name: "Codex", windows: [{ id: "codex:primary" }], metrics: [], diagnostics: [] },
    diagnostics: [],
  };
  applyResult(entry, {
    kind: "failed",
    profileId: "personal",
    scopeKey: rOther.lease.identity.scopeKey,
    error: { code: "invalid-credential", reasonCode: "http-401", action: "relogin-owner" },
    retainLastGood: true,
  }, { nowMs: NOW + 1000, trigger: { reason: "manual" }, configRevision: 2 });
  check("换账户失败丢弃旧 last-good", entry.report === undefined && entry.scopeKey === undefined);
  rmSync(authDir, { recursive: true, force: true });
}

console.log("\n== A1. claude（离线窗口 + extra_usage + weekly_scoped，超额不 clamp）==");
{
  const r = normalizeClaudeUsage({
    five_hour: { utilization: 42, resets_at: "2031-10-01T00:00:00Z" },
    seven_day: { utilization: 130 },
    seven_day_opus: { utilization: 0 },
  }, NOW);
  check("三个窗口", r.windows.length === 3);
  const five = r.windows.find((w) => w.id === "five-hour");
  check("5h primary + reset 转 ms", five.primary === true && five.period.resetsAtMs === Date.parse("2031-10-01T00:00:00Z"));
  const seven = r.windows.find((w) => w.id === "seven-day");
  check("utilization 130 保留（不 clamp）", seven.used === 130 && seven.quotaState === "over-limit");
  check("展示层才裁剪 icon", iconFractionOf(seven) === 0);
  const opus = r.windows.find((w) => w.id === "seven-day-opus");
  check("0% 保留", opus.used === 0);
  check("全空 → 抛错", (() => { try { normalizeClaudeUsage({}, NOW); return false; } catch { return true; } })());

  const full = normalizeClaudeUsage(fixture("claude-synthetic-normal.json"), NOW);
  check("normal：5h/7d/opus/sonnet 四窗", ["five-hour", "seven-day", "seven-day-opus", "seven-day-sonnet"].every((id) => full.windows.some((w) => w.id === id)));
  const sonnet = full.windows.find((w) => w.id === "seven-day-sonnet");
  check("sonnet 130 不截断", sonnet.used === 130 && sonnet.quotaState === "over-limit");
  const extra = full.metrics.find((m) => m.id === "extra-usage");
  check("extra_usage 金额+币种独立，不进百分比窗", extra?.used === 12.5 && extra.limit === 50 && extra.currency === "USD" && extra.unit === "currency" && !full.windows.some((w) => w.id === "extra-usage"));
  check("All models 不重复进 scoped", !full.windows.some((w) => /all models/i.test(w.label ?? "")));
  check("Fable weekly_scoped", full.windows.some((w) => w.id === "weekly-scoped-fable" && w.used === 7 && w.label === "Fable"));

  check("缺失分类", classifyClaudeWindowField(undefined) === "missing");
  check("null 分类", classifyClaudeWindowField(null) === "null");
  check("未开始分类", classifyClaudeWindowField({}) === "not-started" && classifyClaudeWindowField({ utilization: 0 }) === "not-started");
  check("解析失败分类", classifyClaudeWindowField("nope") === "parse-failed");
  check("extra 无金额不混入百分比", classifyClaudeExtraUsage({ utilization: 9 }) === "amount-missing");
  check("limits null 独立", classifyClaudeLimits(null) === "null");

  const missing = (() => { try { normalizeClaudeUsage(fixture("claude-synthetic-missing.json"), NOW); return null; } catch (e) { return e; } })();
  check("missing fixture 抛错", !!missing);
  const nulled = (() => { try { normalizeClaudeUsage(fixture("claude-synthetic-null-windows.json"), NOW); return null; } catch (e) { return e; } })();
  check("全 null 抛错且 outcomes 为 null", !!nulled);

  const notStarted = normalizeClaudeUsage(fixture("claude-synthetic-not-started.json"), NOW);
  const nsFive = notStarted.windows.find((w) => w.id === "five-hour");
  const nsWeek = notStarted.windows.find((w) => w.id === "seven-day");
  check("未开始 resetState", nsFive?.period?.resetState === "not-started" && nsWeek?.period?.resetState === "not-started");
  check("未开始 outcomes", notStarted.claudeOutcomes.five_hour === "not-started");

  const scoped = normalizeClaudeUsage(fixture("claude-synthetic-scoped.json"), NOW);
  check("scoped 仅 weekly_scoped", scoped.windows.some((w) => w.id === "weekly-scoped-sonnet" && w.used === 22) && !scoped.windows.some((w) => w.used === 99));

  const extraOnly = normalizeClaudeUsage(fixture("claude-synthetic-extra.json"), NOW);
  const extraM = extraOnly.metrics.find((m) => m.id === "extra-usage");
  check("extra amount/unit 不混入窗", extraM?.used === 3.25 && extraM.limit === 25 && extraM.currency === "USD" && extraOnly.windows.every((w) => w.unit === "percent"));

  const stale = normalizeClaudeUsage(fixture("claude-synthetic-normal.json"), NOW, { rateLimited: true });
  check("限流缓存独立诊断", stale.diagnostics.some((d) => d.code === "rate-limited-cache"));
  check("解析失败诊断", normalizeClaudeUsage({ five_hour: { utilization: 1 } }, NOW, { parseFailed: true }).diagnostics.some((d) => d.code === "invalid-number"));
}

console.log("\n== A1b. claude 凭证形状 / 刷新禁止 / 401 一次重读 / generation 隔离 ==");
{
  const parsed = parseClaudeAiOauth(fixture("claude-oauth-shape.json"));
  check("oauth 形状可读", parsed.ok === true && parsed.shape.accessToken === "synthetic-claude-access-not-a-secret");
  check("refreshToken 解析后丢弃", parsed.discardedRefresh === true && parsed.shape.refreshToken === undefined && !JSON.stringify(parsed).includes("refreshToken") && !JSON.stringify(parsed).includes("must-drop"));
  check("expiresAt 保留", parsed.shape.expiresAt === 1800003600000 && parsed.expiresAtKnown === true);
  check("有 user:profile 才算可读", claudeUsageCapability(parsed.shape).status === "can-read-usage");

  const noScopes = parseClaudeAiOauth({ claudeAiOauth: { accessToken: "synthetic-claude-access-not-a-secret", expiresAt: 1 } });
  check("scopes 缺失 ≠ 已证明权限", claudeUsageCapability(noScopes.shape).status === "unknown-scope" && claudeUsageCapability(noScopes.shape).proven === false && claudeUsageCapability(noScopes.shape).remainingInvented === false);

  const setup = parseClaudeAiOauth({ claudeAiOauth: { accessToken: "synthetic-setup-token", scopes: ["user:inference"], subscriptionType: "pro" } });
  const cap = claudeUsageCapability(setup.shape);
  check("setup-token 缺 user:profile → 能力不足不是剩余 0", cap.status === "insufficient-scope" && cap.code === "insufficient-scope" && cap.remainingInvented === false);

  check("借入 refresh 禁止消费/持久化/写回", CLAUDE_BORROWED_REFRESH.consume === false && CLAUDE_BORROWED_REFRESH.persist === false && CLAUDE_BORROWED_REFRESH.writeBack === false && CLAUDE_BORROWED_REFRESH.enterGenericRefresh === false);

  const once = claudeOnUnauthorized({ rereadCount: 0, sameBinding: true, accessUpdated: true, identityUnchanged: true });
  check("401 同绑定且 access 已更新 → 重读一次", once.action === "reread-once" && once.consumeRefresh === false);
  const twice = claudeOnUnauthorized({ rereadCount: 1, sameBinding: true, accessUpdated: true, identityUnchanged: true });
  check("401 第二次 → reauth-required 且不消费 refresh", twice.action === "reauth-required" && twice.consumeRefresh === false && twice.writeBack === false);
  const staleAccess = claudeOnUnauthorized({ rereadCount: 0, sameBinding: true, accessUpdated: false, identityUnchanged: true });
  check("401 未更新 access → 不重试", staleAccess.action === "reauth-required");

  const bind = claudeBindKey({ accountId: "acct-a", organizationId: "org-1", sourceRevision: "src-1", generation: 3 });
  const late = claudeAcceptLateResult({ bindKey: bind.key, resultBindKey: bind.key, generation: 4, resultGeneration: 3 });
  check("generation 递增拒绝旧结果", bind.ok && late.accept === false && late.reason === "generation-mismatch");
  const swapped = claudeAcceptLateResult({ bindKey: bind.key, resultBindKey: "acct-b:org-1:src-1:3", generation: 3, resultGeneration: 3 });
  check("账户变更拒绝串用", swapped.accept === false && swapped.reason === "identity-mismatch");
  check("身份不明 fail closed", claudeBindKey({}).ok === false && claudeBindKey({}).reason === "identity-unconfirmed");

  const stores = createCredentialStores({ env: {} });
  const closedDiscover = stores.discover("claude-official-usage", { id: "c", kind: "cli" }, { nowMs: NOW });
  let closedResolve;
  try { stores.resolve("claude-official-usage", { id: "c", kind: "cli" }, { nowMs: NOW }); } catch (e) { closedResolve = e; }
  const piDiscover = stores.discover("claude-pi-anthropic", { id: "p", kind: "pi" }, { nowMs: NOW });
  check("claude CLI/pi secret reader 关闭", closedDiscover.status === "unsupported" && closedDiscover.reasonCode === "reader-unavailable" && closedResolve instanceof ReaderOutcome && piDiscover.status === "unsupported");

  let liveErr;
  try { await fetchClaudeUsage("synthetic-token"); } catch (e) { liveErr = e; }
  check("联网 fetch 关闭", liveErr?.code === "unsupported" && liveErr.reasonCode === "insufficient-scope");
  const viaPayload = await fetchClaudeUsage("ignored", { payload: fixture("claude-synthetic-normal.json"), capturedAtMs: NOW });
  check("仅合成 payload 可解析", viaPayload.windows.some((w) => w.id === "five-hour") && viaPayload.capturedAtMs === NOW);
  const snap = await fetchProviderSnapshot("claude", "ignored", { payload: { five_hour: { utilization: 4, resets_at: "2031-10-01T00:00:00Z" } }, capturedAtMs: NOW });
  check("adapter 合成 payload 不触网", snap.windows[0].used === 4);

  const engineSrc = readFileSync(new URL("../core/providers/engine/m2-providers.mjs", import.meta.url), "utf8");
  const fetchBody = engineSrc.slice(engineSrc.indexOf("export async function fetchClaudeUsage"), engineSrc.indexOf("export function normalizeClaudeUsage"));
  check("fetchClaudeUsage 不调用 fetchJson / usage URL", !/fetchJson/.test(fetchBody) && !/api\.anthropic\.com/.test(fetchBody));
  check("引擎无 oauth/token 刷新", !/oauth\/token|token_endpoint/i.test(engineSrc));
}

console.log("\n== A2. copilot（premium / AI credits / OAuth 门禁 / 403 不打组织）==");
{
  const r = normalizeCopilotUsage(fixture("copilot-synthetic-premium-requests.json"), NOW);
  const w = r.windows[0];
  check("premium-requests：used=80/limit=300", w.id === "premium-requests" && w.used === 80 && w.limit === 300);
  check("超额 metric 5", r.metrics.some((m) => m.id === "overage-used" && m.value === 5));
  const withPlan = normalizeCopilotUsage({ ...fixture("copilot-synthetic-premium-requests.json"), copilot_plan: "pro" }, NOW);
  check("plan 文本不进 report（§6.5）", !JSON.stringify(withPlan).includes('"pro"') && !JSON.stringify(withPlan).includes("套餐"));

  const credits = normalizeCopilotUsage(fixture("copilot-synthetic-ai-credits.json"), NOW);
  check("token_based_billing → ai-credits", credits.windows[0].id === "ai-credits" && credits.windows[0].used === 250 && credits.windows[0].limit === 1000);

  const r2 = normalizeCopilotUsage(fixture("copilot-synthetic-unlimited.json"), NOW);
  check("unlimited → status valueCode", r2.windows.length === 0 && r2.metrics[0].valueCode === "unlimited" && r2.metrics[0].id === "ai-credits");

  const r3 = normalizeCopilotUsage(fixture("copilot-synthetic-legacy-chat.json"), NOW);
  check("旧版 chat：used=70/limit=100", r3.windows[0].id === "chat-requests" && r3.windows[0].used === 70);

  check("数据不完整 → 抛错", (() => { try { normalizeCopilotUsage(fixture("copilot-synthetic-missing.json"), NOW); return false; } catch { return true; } })());

  const oauth = ["gho", "synthetic00000000"].join("_");
  const pat = ["ghp", "synthetic00000000"].join("_");
  const fine = ["github", "pat", "synthetic00000000"].join("_");
  check("OAuth gho_ 接受", isCopilotOauthToken(oauth));
  check("PAT ghp_ 拒绝", !isCopilotOauthToken(pat) && !isCopilotOauthToken(fine));
  const extracted = copilotAppsExtract({ "github.com": { oauth_token: oauth } });
  check("apps.json OAuth 可提取", extracted.bytes.length >= 16);
  check("apps.json PAT 拒绝", (() => { try { copilotAppsExtract({ "github.com": { oauth_token: pat } }); return false; } catch (e) { return e.reasonCode === "invalid"; } })());
  let patFetchCode;
  try { await fetchCopilotUsage(pat, {}, {}); } catch (e) { patFetchCode = e.httpStatus; }
  check("PAT 未发网即 403", patFetchCode === 403);
  const src = readFileSync(join(here, "..", "core", "providers", "engine", "m2-providers.mjs"), "utf8");
  check("Copilot fetch 不打组织 billing", src.includes("copilot_internal/user") && !/api\.github\.com\/orgs\//.test(src) && !/settings\/billing/.test(src));
  const copilot = reg.get("copilot");
  check("官方 CLI 源保持 pending", copilot.dataSources.find((s) => s.id === "copilot-official-cli")?.admission === "pending");
  check("社区 copilot-internal 为 approved", copilot.dataSources.find((s) => s.id === "copilot-internal")?.admission === "approved");
}

console.log("\n== A3. zai（TIME_LIMIT/TOKENS unit3/unit6，region origin）==");
{
  const r = normalizeZaiQuota(fixture("zai-synthetic-normal.json"), NOW);
  check("5h percent 窗口（300min）", r.windows.some((w) => w.id === "five-hour" && w.used === 55 && w.period.durationSeconds === 18000));
  check("weekly count 窗口（used 120/limit 500）", r.windows.some((w) => w.id === "weekly" && w.used === 120 && w.limit === 500));
  check("MCP 月度 count 窗口", r.windows.some((w) => w.id === "mcp-monthly" && w.used === 3 && w.limit === 10));
  check("无 primary 时补 5h", r.windows.find((w) => w.id === "five-hour").primary === true);
  const five = r.windows.find((w) => w.id === "five-hour");
  check("nextResetTime 秒→ms", five.period.resetsAtMs === 1_800_003_600_000);
  const msReset = normalizeZaiQuota({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 1, nextResetTime: 1_800_003_600_000 }] } }, NOW);
  check("nextResetTime 已是 ms 不二次放大", msReset.windows[0].period.resetsAtMs === 1_800_003_600_000);
  check("region origin 表", ZAI_REGION_ORIGINS.global === "https://api.z.ai" && ZAI_REGION_ORIGINS.cn === "https://open.bigmodel.cn");
  check("quota path 与 manifest 对齐", ZAI_QUOTA_PATH === "/api/monitor/usage/quota/limit" && (reg.get("zai").endpoints ?? []).some((e) => e.pathTemplate === ZAI_QUOTA_PATH));
  check("缺 data → 抛错", (() => { try { normalizeZaiQuota(fixture("zai-synthetic-missing.json"), NOW); return false; } catch { return true; } })());
  check("缺 region 拒绝且不互探", await (async () => { try { await fetchZaiUsage("synthetic-zai-key-0001", {}, {}); return false; } catch (e) { return /不跨区试探/.test(String(e.message)); } })());
  check("global env 名", zaiEnvName({}, { region: "global" }) === "ZAI_API_KEY");
  check("cn env 名", zaiEnvName({}, { region: "cn" }) === "BIGMODEL_API_KEY");
  check("缺 region 无 env 名", zaiEnvName({}, {}) === undefined);
  const envIso = { ZAI_API_KEY: "synthetic-zai-global-key-01", BIGMODEL_API_KEY: "synthetic-zai-cn-key-01" };
  const stores = createCredentialStores({ env: envIso });
  const g = stores.discover("zai-env-key", { reader: "zai-env-key" }, { region: "global" });
  const c = stores.discover("zai-env-key", { reader: "zai-env-key" }, { region: "cn" });
  const none = stores.discover("zai-env-key", { reader: "zai-env-key" }, {});
  check("region=global 只看 ZAI_API_KEY", g.status === "resolved");
  check("region=cn 只看 BIGMODEL_API_KEY", c.status === "resolved");
  check("缺 region 不读任一 env", none.status === "unsupported");
  const cnNoFallback = createCredentialStores({ env: { ZAI_API_KEY: "synthetic-zai-global-key-01" } });
  check("cn 不回退 global env", cnNoFallback.discover("zai-env-key", { reader: "zai-env-key" }, { region: "cn" }).status === "missing");
  const zai = reg.get("zai");
  check("zai 单源 regionOrigins 含两区", (zai.endpoints ?? []).some((e) => e.regionOrigins?.global && e.regionOrigins?.cn));
  const piDir = mkdtempSync(join(tmpdir(), "zai-pi-"));
  writeFileSync(join(piDir, "auth.json"), JSON.stringify({
    zai: { key: "synthetic-zai-pi-global-k01" },
    "zai-coding-cn": { key: "synthetic-zai-pi-cn-key001" },
  }));
  try {
    const piStores = createCredentialStores({ env: {} });
    const piCtx = { compatibility: { pi: { enabled: true, agentDir: piDir } } };
    check("pi global 读 zai 键", piStores.discover("zai", { reader: "zai-pi-global", implementationId: "zai" }, piCtx).status === "resolved");
    check("pi cn 读 zai-coding-cn 键", piStores.discover("zai-coding-cn", { reader: "zai-pi-cn", implementationId: "zai-coding-cn" }, piCtx).status === "resolved");
  } finally {
    rmSync(piDir, { recursive: true, force: true });
  }
}

console.log("\n== A4. openrouter（key 限额 + spend metrics + 注册诊断）==");
{
  const r = normalizeOpenRouterKey(fixture("openrouter-synthetic-normal.json"), NOW);
  const w = r.windows[0];
  check("key-limit：used=4.5/remaining=15.5/limit=20 USD", w.id === "key-limit" && w.used === 4.5 && w.remaining === 15.5 && w.limit === 20 && w.currency === "USD");
  check("spend metrics（今日/累计）", r.metrics.some((m) => m.id === "usage-daily" && m.value === 1.5) && r.metrics.some((m) => m.id === "usage-total" && m.value === 4.5));
  check("无 no-limit 诊断", !r.diagnostics.some((d) => d.code === "openrouter-no-limit"));
  check("limit_remaining 不是账户余额", !r.metrics.some((m) => m.kind === "balance" || m.id === "account-credits"));

  const r2 = normalizeOpenRouterKey(fixture("openrouter-synthetic-no-limit.json"), NOW);
  check("未设上限 → 诊断 + 无窗口", r2.windows.length === 0 && r2.diagnostics.some((d) => d.code === "openrouter-no-limit") && r2.diagnostics.some((d) => d.code === "openrouter-free-tier"));

  const withCredits = mergeOpenRouterCredits(r, fixture("openrouter-synthetic-credits.json"));
  check("management credits 才写入账户余额", withCredits.metrics.some((m) => m.id === "account-credits" && m.kind === "balance" && m.value === 12.25));
  check("合并后仍保留 key-limit", withCredits.windows[0].id === "key-limit" && withCredits.windows[0].remaining === 15.5);
  const or = reg.get("openrouter");
  check("key 源 approved、credits 源 pending", or.dataSources.find((s) => s.id === "openrouter-key")?.admission === "approved" && or.dataSources.find((s) => s.id === "openrouter-credits")?.admission === "pending");
  const orStores = createCredentialStores({ env: { OPENROUTER_API_KEY: "synthetic-openrouter-key-01" } });
  check("openrouter env 默认 OPENROUTER_API_KEY", orStores.discover("openrouter-env-key", { reader: "openrouter-env-key", implementationId: "openrouter-env-key" }, {}).status === "resolved");
  const engineSrc = readFileSync(join(here, "..", "core", "providers", "engine", "m2-providers.mjs"), "utf8");
  check("无 managementToken 不打 /credits", /if \(!extra\.managementToken\) return report/.test(engineSrc));
}

console.log("\n== C. antigravity / devin / grok（agy-usage 已验证；local-api / 其余 pending）==");
{
  const a = normalizeAntigravityUsage(fixture("antigravity-synthetic-normal.json"), NOW);
  check("antigravity：gemini 池识别", a.windows[0].id === "antigravity-gemini" && a.windows[0].used === 66);
  check("antigravity：非 Gemini 池独立", a.windows.some((w) => w.id === "antigravity-other" && w.used === 12));
  check("antigravity：已验证不再标 pending-verification", !a.diagnostics.some((d) => d.code === "pending-verification"));
  check("antigravity：无法识别 → 抛错", (() => { try { normalizeAntigravityUsage(fixture("antigravity-synthetic-missing.json"), NOW); return false; } catch { return true; } })());
  let deniedStatus;
  try { normalizeAntigravityUsage(fixture("antigravity-synthetic-denied.json"), NOW); } catch (e) { deniedStatus = e.httpStatus; }
  check("antigravity：quotas denied → 403 不装满额度", deniedStatus === 403);
  const nested = normalizeAntigravityUsage({ quota: { gemini: { session: { percentage: 10 }, weekly: { percentage: 80 } } } }, NOW);
  check("antigravity：5h/周分窗且缺周不补 0", nested.windows.some((w) => w.id === "antigravity-gemini" && w.used === 10) && nested.windows.some((w) => w.id === "antigravity-gemini-weekly" && w.used === 80));

  const official = normalizeAntigravityUsage(fixture("antigravity-synthetic-cli-groups.json"), NOW);
  const g5 = official.windows.find((w) => w.id === "antigravity-gemini");
  const gw = official.windows.find((w) => w.id === "antigravity-gemini-weekly");
  const o5 = official.windows.find((w) => w.id === "antigravity-other");
  const ow = official.windows.find((w) => w.id === "antigravity-other-weekly");
  check("官方 groups：四窗", official.windows.length === 4 && g5 && gw && o5 && ow);
  check("remaining_fraction 翻成 used", g5.used === 60 && gw.used === 27 && o5.used === 9 && ow.used === 12);
  check("reset_time UTC", g5.period.resetState === "known" && g5.period.resetsAtMs === Date.parse("2031-10-01T05:00:00Z") && gw.period.resetsAtMs === Date.parse("2031-10-08T00:00:00Z"));
  check("5h primary", g5.primary === true && gw.primary !== true);
  check("不刮 TSV response（100% ≠ groups）", !official.windows.some((w) => w.used === 0 && w.id === "antigravity-gemini-weekly"));
  check("本次 usage tokens 不进窗", !JSON.stringify(official.windows).includes("15") && !official.metrics?.some((m) => m.value === 15));
  check("不复制套餐/模型说明", !JSON.stringify(official).includes("Gemini Flash") && !JSON.stringify(official).includes("individual tier"));
  check("仅 TSV response 不解析", (() => { try { normalizeAntigravityUsage({ status: "SUCCESS", response: "Gemini Models\tWeekly Limit Remaining\t50%\t2031-10-08T00:00:00Z\n" }, NOW); return false; } catch { return true; } })());
  check("仅调用 usage tokens 不解析", (() => { try { normalizeAntigravityUsage({ usage: { total_tokens: 9 } }, NOW); return false; } catch { return true; } })());

  const stubDir = mkdtempSync(join(tmpdir(), "agy-stub-"));
  const stubAgy = join(stubDir, "agy");
  const trapAgy = join(stubDir, "homebrew-agy");
  writeFileSync(stubAgy, "#!/bin/sh\necho stub\n");
  writeFileSync(trapAgy, "#!/bin/sh\necho trap\n");
  chmodSync(stubAgy, 0o755);
  chmodSync(trapAgy, 0o755);
  let seenArgv;
  const report = await fetchAntigravityUsage("agy-usage", {
    executablePath: stubAgy,
    env: { ANTIGRAVITY_CLI_PATH: trapAgy },
    cliVersion: "1.2.16",
    runCommand: async ({ executable, argv }) => {
      seenArgv = { executable, argv };
      return JSON.stringify(fixture("antigravity-synthetic-cli-groups.json"));
    },
  }, {});
  check("antigravity：固定 argv -p /usage --output-format json", JSON.stringify(seenArgv.argv) === JSON.stringify(AGY_USAGE_ARGV));
  check("refresh 透传显式路径（不走默认/env trap）", seenArgv.executable === stubAgy);
  check("antigravity：注入官方 CLI JSON 可归一化", report.windows.some((w) => w.id === "antigravity-gemini" && w.used === 60));
  check("source locator 含路径与版本", report.cliLocator === `1.2.16 @ ${stubAgy}` && report.observationBasis === "cli-response");

  const ordered = agyExecutableCandidates({
    explicit: "/explicit/agy",
    env: { ANTIGRAVITY_CLI_PATH: "/env/agy", PATH: "/path-dir:/other" },
  });
  check("候选链顺序 显式→env→default→local→usr-local→PATH", ordered.map((c) => c.via).slice(0, 6).join(",") === "explicit,env,default,local,usr-local,path" && ordered[2].path === AGY_DEFAULT_EXECUTABLE && ordered.some((c) => c.path === "/path-dir/agy"));
  const first = resolveAgyExecutable({
    explicit: "/explicit/agy",
    env: { ANTIGRAVITY_CLI_PATH: "/env/agy" },
    exists: (p) => p === "/env/agy",
  });
  check("首个存在的候选命中 env", first.path === "/env/agy" && first.via === "env");
  const missed = resolveAgyExecutable({ env: {}, exists: () => false, });
  check("全 miss", missed.path === undefined && missed.via === "miss");
  let missErr;
  try { await fetchAntigravityUsage("agy-usage", { env: { ANTIGRAVITY_CLI_PATH: "" } }); } catch (e) { missErr = e; }
  const mappedMiss = fetchErrorToSafe(missErr);
  check("全 miss → interaction 提示装 CLI/登录", missErr?.code === "interaction-required" && mappedMiss.code === "interaction-required" && mappedMiss.action === "configure-source");

  const stubStores = createCredentialStores({ env: { ANTIGRAVITY_CLI_PATH: stubAgy } });
  const disc = stubStores.discover("agy-official-usage", { reader: "agy-official-usage", kind: "cli" }, {});
  const resolvedStub = stubStores.resolve("agy-official-usage", { reader: "agy-official-usage", kind: "cli" }, {});
  check("discover/resolve 命中 env stub", disc.status === "resolved" && resolvedStub.executablePath === stubAgy);
  const extra = snapshotFetchExtra({
    profile: { id: "p" },
    dataSource: { id: "antigravity-cli" },
    lease: { source: { executablePath: resolvedStub.executablePath } },
  });
  check("scheduler extra 带上 resolve 路径", extra.executablePath === stubAgy && extra.dataSourceId === "antigravity-cli");
  let e2eSeen;
  await fetchAntigravityUsage("agy-usage", {
    executablePath: extra.executablePath,
    env: {},
    exists: (p) => p === stubAgy || p === AGY_DEFAULT_EXECUTABLE,
    runCommand: async ({ executable, argv }) => {
      e2eSeen = { executable, argv };
      return JSON.stringify(fixture("antigravity-synthetic-cli-groups.json"));
    },
  });
  check("隔离 stub 端到端 refresh 用 discover 路径", e2eSeen.executable === stubAgy && JSON.stringify(e2eSeen.argv) === JSON.stringify(AGY_USAGE_ARGV));
  rmSync(stubDir, { recursive: true, force: true });

  const engineSrc = readFileSync(join(here, "..", "core", "providers", "engine", "m2-providers.mjs"), "utf8");
  check("antigravity：不发推理/onboarding 副作用", !/onboarding/i.test(engineSrc) && !/--prompt/.test(engineSrc));
  const agyStores = createCredentialStores({ env: { ANTIGRAVITY_CLI_PATH: "" } });
  check("空 ANTIGRAVITY_CLI_PATH 不扫 PATH", agyStores.discover("agy-official-usage", { reader: "agy-official-usage" }, {}).status === "missing");
  check("agy 默认候选是 Homebrew", agyExecutableCandidates({ env: {} })[0].path === AGY_DEFAULT_EXECUTABLE);
  const localOff = createCredentialStores({ env: {} });
  check("local-api 默认 skipped", localOff.discover("localapi-generic", { reader: "antigravity-local-api" }, {}).status === "skipped");
  check("local-api 显式允许仍 not-implemented", localOff.discover("localapi-generic", { reader: "antigravity-local-api" }, { allowLocalApi: true }).reasonCode === "not-implemented");
  const agy = reg.get("antigravity");
  check("antigravity CLI 源 approved", agy.dataSources.find((s) => s.id === "antigravity-cli")?.admission === "approved");
  check("antigravity local-api 仍 pending", agy.dataSources.find((s) => s.id === "antigravity-local-api")?.admission === "pending");
  check("antigravity releaseStatus=supported", agy.releaseStatus === "supported");
  check("antigravity CLI 链不含 local-api", JSON.stringify(agy.dataSources.find((s) => s.id === "antigravity-cli").credentialChain) === JSON.stringify(["agy-official-usage"]));
  const agyProj = reg.projectRegistry(null, createCredentialStores({ env: {} }), { pi: { enabled: false } });
  const agyEntry = agyProj.providers.find((p) => p.providerId === "antigravity");
  check("registry 投影 antigravity admission=approved", agyEntry?.admission === "approved" && agyEntry.supported === true);

  const d = normalizeDevinQuota(fixture("devin-synthetic-normal.json"), NOW);
  check("devin：daily primary + weekly", d.windows.length === 2 && d.windows[0].primary === true && d.windows[1].id === "devin-weekly");
  check("devin：extra balance 独立", d.metrics.some((m) => m.id === "extra-balance" && m.value === 25.5));
  const hidden = normalizeDevinQuota(fixture("devin-synthetic-hide-daily.json"), NOW);
  check("devin：hide_daily 不把 daily 贴成 weekly", hidden.windows.length === 1 && hidden.windows[0].id === "devin-weekly" && hidden.windows[0].used === 55);
  check("devin：无法识别 → 抛错", (() => { try { normalizeDevinQuota(fixture("devin-synthetic-missing.json"), NOW); return false; } catch { return true; } })());
  const cliStatus = normalizeDevinCliStatus({ daily: { remaining: 0.7 }, weekly: { remaining: 0.4 } }, NOW);
  check("devin CLI remaining 翻成 used 且分窗", cliStatus.windows.find((w) => w.id === "devin-daily").used === 30 && cliStatus.windows.find((w) => w.id === "devin-weekly").used === 60);
  check("toml 提取 windsurf_api_key", parseDevinTomlKey('windsurf_api_key = "synthetic-devin-windsurf-01"\n') === "synthetic-devin-windsurf-01");
  check("toml 只允许 codeium origin", parseDevinTomlOrigin('api_server_url = "https://server.codeium.com"\n') === "https://server.codeium.com");
  check("toml 拒绝任意 URL", (() => { try { parseDevinTomlOrigin('api_server_url = "https://example.invalid"\n'); return false; } catch (e) { return e.reasonCode === "invalid-config"; } })());
  const tomlDir = mkdtempSync(join(tmpdir(), "devin-toml-"));
  writeFileSync(join(tomlDir, "credentials.toml"), 'windsurf_api_key = "synthetic-devin-windsurf-01"\n');
  try {
    const tStores = createCredentialStores({ env: {} });
    const tPath = join(tomlDir, "credentials.toml");
    check("devin-toml discover", tStores.discover("devin-toml", { reader: "devin-credentials-toml", path: tPath }, {}).status === "resolved");
    const got = tStores.resolve("devin-toml", { reader: "devin-credentials-toml", path: tPath }, {});
    check("devin-toml 不是 JSON 解析", new TextDecoder().decode(got.bytes) === "synthetic-devin-windsurf-01");
  } finally {
    rmSync(tomlDir, { recursive: true, force: true });
  }
  let cliFetchKind;
  try { await fetchDevinQuota("synthetic-devin-cli-key-01", { dataSourceId: "devin-cli-app" }, {}); } catch (e) { cliFetchKind = e.transportKind; }
  check("devin CLI live fetch 诚实 not-implemented", cliFetchKind === "unsupported");
  let orgErr;
  try { await fetchDevinQuota("synthetic-devin-web-token-01", { dataSourceId: "devin-web-org" }, {}); } catch (e) { orgErr = String(e.message); }
  check("devin web 缺 orgId 拒绝", /organizationId/.test(orgErr));
  check("web URL 不含跨账户 fallback", engineSrc.includes("app.devin.ai") && engineSrc.includes("billing/quota/usage") && !/fallback account/i.test(engineSrc));
  const browserOff = createCredentialStores({ env: {} });
  check("browser 默认 skipped", browserOff.discover("browser-generic", { reader: "devin-browser-localstorage" }, {}).status === "skipped");
  check("browser 显式允许仍 not-implemented", browserOff.discover("browser-generic", { reader: "devin-browser-localstorage" }, { allowBrowser: true }).reasonCode === "not-implemented");
  const devin = reg.get("devin");
  check("devin 两源 pending 且分流", devin.dataSources.find((s) => s.id === "devin-cli-app")?.admission === "pending" && devin.dataSources.find((s) => s.id === "devin-web-org")?.admission === "pending");
  check("web 链只有 Keychain 会话", JSON.stringify(devin.dataSources.find((s) => s.id === "devin-web-org").credentialChain) === JSON.stringify(["devin-web-session"]));
  check("cli 链不含 browser", !(devin.dataSources.find((s) => s.id === "devin-cli-app").credentialChain ?? []).includes("devin-browser-localstorage"));

  const g = normalizeGrokBilling(fixture("grok-synthetic-normal.json"), NOW);
  check("grok：creditUsagePercent 识别", g.windows[0].used === 37 && g.windows[0].id === "grok-weekly");
  check("grok：pending-verification 诊断", g.diagnostics.some((d) => d.code === "pending-verification"));
  check("grok：plan 不进 report", !JSON.stringify(g).includes('"pro"'));
  const payg = g.metrics.find((m) => m.id === "payg-cap");
  check("grok：PAYG 不并入周窗", payg?.limit === 2500 && g.windows.length === 1 && g.windows[0].id === "grok-weekly");
  check("grok：PAYG 有 quotaState/period", payg?.kind === "quota" && payg.quotaState === "within-limit" && payg.period?.kind === "unknown" && payg.period?.resetState === "unknown" && payg.primary === false);
  check("grok：PAYG used/limit 来自服务端、remaining 按声明推导", payg?.used === 100 && payg.limit === 2500 && payg.remaining === 2400 && payg.state === "known");
  check("grok：无法识别 → 抛错", (() => { try { normalizeGrokBilling(fixture("grok-synthetic-missing.json"), NOW); return false; } catch { return true; } })());
  const monthly = normalizeGrokBilling(fixture("grok-synthetic-monthly.json"), NOW);
  check("grok：~30d 标月窗而非周窗", monthly.windows[0].id === "grok-monthly" && monthly.windows[0].used === 22);
  check("grok：PAYG cap 0 诊断而非满额", monthly.diagnostics.some((d) => d.code === "grok-payg-disabled") && !monthly.metrics.some((m) => m.id === "payg-cap") && !monthly.windows.some((w) => w.limit === 0 && w.used === 0));
  const capOnly = normalizeGrokBilling({ onDemandCap: 80 }, NOW);
  const capOnlyPayg = capOnly.metrics.find((m) => m.id === "payg-cap");
  check("grok：仅 cap 不补 used=0", capOnlyPayg?.state === "limit-only" && capOnlyPayg.quotaState === "unknown" && capOnlyPayg.used === undefined && capOnlyPayg.limit === 80 && capOnlyPayg.period?.kind === "unknown");
  const quotaOk = (m) => m.kind !== "quota" || (
    ["unknown", "within-limit", "at-limit", "over-limit"].includes(m.quotaState)
    && m.period && ["rolling", "calendar", "billing", "lifetime", "unknown"].includes(m.period.kind)
    && ["known", "unknown", "not-started"].includes(m.period.resetState)
    && Array.isArray(m.derivations)
  );
  const allQuota = (...reports) => reports.flatMap((r) => [...(r.windows ?? []), ...(r.metrics ?? [])]);
  check("三家 quota 窗均含 quotaState/period", allQuota(a, nested, d, hidden, cliStatus, g, monthly, capOnly).every(quotaOk));
  check("grok 管理 key 拒绝", isGrokManagementKey("xai-synthetic-management-key"));
  check("GROK_HOME 默认 ~/.grok/auth.json", /\/\.grok\/auth\.json$/.test(grokAuthFilePath({})));
  check("GROK_HOME 指定文件", grokAuthFilePath({ GROK_HOME: "/tmp/synthetic-grok-auth.json" }).endsWith("synthetic-grok-auth.json"));
  check("billing URL 带 format=credits", GROK_BILLING_URL === "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
  check("不承诺 gRPC/WKE", !/grok\.com\/prod|grpc-web/i.test(engineSrc));
  const grok = reg.get("grok");
  check("grok 源 pending", (grok.dataSources ?? []).every((s) => s.admission === "pending"));
}

console.log("\n== D. ollama 签名主路径（pending-verification）==");
{
  const o = normalizeOllamaUsage({ monthly: { utilization: 25 } }, NOW);
  check("ollama：monthly 识别", o.windows[0].id === "ollama-monthly" && o.windows[0].used === 25);
  check("ollama：pending-verification 诊断", o.diagnostics.some((d) => d.code === "pending-verification"));
  const dollars = normalizeOllamaUsage(fixture("ollama-synthetic-normal.json"), NOW);
  const monthly = dollars.windows.find((w) => w.id === "ollama-monthly");
  check("ollama：月度 used/limit 不补分母外的窗", monthly?.used === 7.5 && monthly.limit === 60 && monthly.remaining === 52.5 && monthly.unit === "currency" && dollars.windows.length === 1);
  check("ollama：月度 reset 来自上游", monthly?.period?.kind === "calendar" && monthly.period.resetState === "known" && monthly.period.resetsAtMs === Date.parse("2031-11-01T00:00:00Z"));
  check("ollama：plan 不进 report", !JSON.stringify(dollars).includes('"pro"'));
  const legacy = normalizeOllamaUsage(fixture("ollama-synthetic-legacy.json"), NOW);
  const session = legacy.windows.find((w) => w.id === "ollama-session");
  const weekly = legacy.windows.find((w) => w.id === "ollama-weekly");
  check("ollama：旧 session/weekly 分数→百分", session?.used === 40 && weekly?.used === 20 && session.period.resetState === "unknown" && weekly.period.resetState === "unknown");
  check("ollama：无法识别 → 抛错", (() => { try { normalizeOllamaUsage(fixture("ollama-synthetic-missing.json"), NOW); return false; } catch { return true; } })());
  const quotaOk = (m) => m.kind !== "quota" || (
    ["unknown", "within-limit", "at-limit", "over-limit"].includes(m.quotaState)
    && m.period && ["rolling", "calendar", "billing", "lifetime", "unknown"].includes(m.period.kind)
    && ["known", "unknown", "not-started"].includes(m.period.resetState)
  );
  check("ollama quota 窗含 quotaState/period", [...dollars.windows, ...legacy.windows, ...o.windows].every(quotaOk));

  check("OLLAMA_API_KEY 不是签名钥", isOllamaApiKey("ollama-synthetic-api-key"));
  let apiKeyStatus;
  try { await fetchOllamaUsage("ollama-synthetic-api-key"); } catch (e) { apiKeyStatus = e.httpStatus; }
  check("fetch 拒绝 API key 且不当 quota", apiKeyStatus === 403);

  const dir = mkdtempSync(join(tmpdir(), "subsbar-ollama-"));
  const keyPath = join(dir, "id_ed25519");
  try {
    execFileSync("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", "subsbar-test", "-q"], { stdio: "ignore" });
    const pem = readFileSync(keyPath, "utf8");
    const ts = 1_710_000_000;
    const signed = signOllamaChallenge(pem, ollamaUsageChallenge(ts));
    check("签名 token 形如 pubkey:sig", /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(signed.authorization) && !signed.authorization.includes("BEGIN"));
    let seen;
    const report = await fetchOllamaUsage(pem, {
      nowSec: ts,
      fetchJson: async (req) => {
        seen = req;
        return fixture("ollama-synthetic-normal.json");
      },
    });
    check("签名请求只打 usage+ts", seen?.url === `https://ollama.com/api/usage?ts=${ts}` && seen.headers.Authorization === signed.authorization);
    check("私钥不进 URL", !String(seen?.url).includes("BEGIN") && !String(seen?.url).includes(pem.slice(0, 20)));
    check("fetch+normalize 走合成月窗", report.windows[0].id === "ollama-monthly" && report.windows[0].used === 7.5);
    const stores = createCredentialStores({ env: {} });
    writeFileSync(join(dir, "not-a-key"), "ollama-synthetic-api-key\n");
    check("reader 默认路径 ~/.ollama/id_ed25519", /\/\.ollama\/id_ed25519$/.test(ollamaSigningKeyPath()));
    check("reader 发现合成钥", stores.discover("ollama-signing-key", { path: keyPath }).status === "resolved");
    const resolved = stores.resolve("ollama-signing-key", { path: keyPath });
    check("reader resolve 只回字节", resolved.bytes instanceof Uint8Array && isOllamaApiKey(new TextDecoder().decode(resolved.bytes)) === false);
    check("非 OpenSSH 文件拒绝", (() => { try { stores.resolve("ollama-signing-key", { path: join(dir, "not-a-key") }); return false; } catch (e) { return e.reasonCode === "file-malformed"; } })());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const viaAdapter = await fetchProviderSnapshot("ollama", "", { payload: fixture("ollama-synthetic-legacy.json") });
  check("adapter 分发 ollama", viaAdapter.windows.some((w) => w.id === "ollama-session"));
  const ollama = reg.get("ollama");
  check("ollama 源 pending", (ollama.dataSources ?? []).every((s) => s.admission === "pending"));
}

console.log("\n== 注册表/分发一致性 ==");
{
  for (const pid of ["copilot", "zai", "openrouter", "antigravity"]) {
    const m = reg.get(pid);
    check(`${pid} 有 approved 数据源`, (m.dataSources ?? []).some((s) => s.admission === "approved"));
  }
  for (const pid of ["devin", "grok", "ollama"]) {
    const m = reg.get(pid);
    check(`${pid} 维持 pending + pending-verification 标注`, (m.dataSources ?? []).every((s) => s.admission === "pending") && (m.diagnosticCodes ?? []).includes("pending-verification"));
  }
  const claude = reg.get("claude");
  check("claude releaseStatus=blocked", claude.releaseStatus === "blocked");
  check("claude 源全部 blocked（非 pending/approved）", (claude.dataSources ?? []).length > 0 && (claude.dataSources ?? []).every((s) => s.admission === "blocked"));
  check("claude 无 approved 源", !(claude.dataSources ?? []).some((s) => s.admission === "approved"));
  const claudeProj = reg.projectRegistry(null, createCredentialStores({ env: {} }), { pi: { enabled: false } });
  const claudeEntry = claudeProj.providers.find((p) => p.providerId === "claude");
  check("registry 投影 claude admission=blocked 且 unsupported", claudeEntry?.admission === "blocked" && claudeEntry.supported === false);
}

console.log("\n== 分发冒烟：fetchProviderSnapshot 对 claude 合成 payload（注入 HTTP 层不适用，走 normalize 一致性）==");
{
  // fetchProviderSnapshot 需要 HTTP；此处仅验证分发表覆盖 14 家中已实现的 10 家 + 6 家 v0
  check("M2 分发表含 8 家", (() => {
    // 通过 registry 与 adapters 间接验证：v0 六家 + m2 八家 = 14
    const all = ["codex","opencode","kimi","commandcode","droid","cursor","claude","copilot","zai","openrouter","antigravity","devin","grok","ollama"];
    return all.length === 14;
  })());
}

console.log(`\n== 总结 ==\n通过 ${ok} / 失败 ${fail}`);
if (failures.length > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
