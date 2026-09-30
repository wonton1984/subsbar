// Refresh 协调器（contracts §5/§6.1）：leader 锁、逐 provider 任务隔离、
// 退避/Retry-After、usage-v1 cache 原子写、RefreshReceipt。
import { existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { LockBackend } from "./lock.mjs";
import { ConfigStore } from "../config/store.mjs";
import { resolveStateDirs } from "../config/paths.mjs";
import { resolveChain } from "../credentials/resolver.mjs";
import { SecretBroker } from "../credentials/broker.mjs";
import { createCredentialStores } from "../credentials/stores.mjs";
import { ProviderRegistry } from "../providers/registry.mjs";
import { v0ReadAuth, v0ResolveCredential, fetchProviderSnapshot, snapshotHasData } from "../providers/adapters.mjs";
import { safeError, diagnostic, isAtMs } from "../defs.mjs";
import { legacyWindowToMetric } from "./report.mjs";
import { parseStrictJson } from "./json-strict.mjs";

const BATCH_LIMIT_MS = 120_000;
const LOSER_WAIT_MS = 2_000;

export class RefreshCoordinator {
  constructor({ configPath, env = process.env }) {
    this.configPath = configPath;
    this.env = env;
    this.registry = new ProviderRegistry();
  }

  dirs() { return resolveStateDirs({ env: this.env }); }

  loadConfigOrNull() {
    try {
      const store = new ConfigStore(this.configPath ?? defaultConfigPath(this.env));
      return store.load(); // null = 无配置
    } catch {
      return null; // 配置损坏 → 全体 error/invalid-config（C01/§4.2）
    }
  }

  /** 读取持久化 usage cache（v1）。 */
  readUsageCache() {
    const { usageCacheFile } = this.dirs();
    if (!existsSync(usageCacheFile)) return null;
    try {
      const parsed = parseStrictJson(readFileSync(usageCacheFile, "utf8"));
      if (parsed?.schemaVersion !== 1 || parsed?.kind !== "usage") return null;
      return tolerateUnknown(parsed);
    } catch { return null; }
  }

  /** 读取 runtime 私有 state（退避/身份映射）。 */
  readRuntimeState() {
    const { runtimeStateFile } = this.dirs();
    try {
      return parseStrictJson(readFileSync(runtimeStateFile, "utf8"));
    } catch { return {}; }
  }

  /**
   * 执行一批刷新（§5.1/5.2/5.3）。返回 UsageEnvelopeV1（含 request receipt）。
   * v1 实现：v0 引擎桥接——已配置凭证来自 v0 resolveCredential（pi 默认环境），
   * 但调度/隔离/落盘/错误语义全部按 v1 契约执行。
   */
  async refresh(trigger, signal = new AbortController().signal) {
    const dirs = this.dirs();
    const locks = new LockBackend(dirs.stateDir);
    const startedAt = Date.now();
    const requestId = `req-${randomBytes(8).toString("hex")}`;
    const requested = trigger.providerIds ?? null;

    const lease = await locks.acquire("refresh-leader", LOSER_WAIT_MS, signal, { reason: trigger.reason });
    if (lease.status === "busy") {
      // loser：不发请求，返回当前快照 + deferred receipt（§5.2）
      const env = this.buildEnvelope({ nowMs: Date.now(), config: this.loadConfigOrNull(), runtime: this.readRuntimeState() });
      env.request = {
        requestId, outcome: "deferred",
        requestedProviderIds: requested ?? env.providers.map((p) => p.providerId),
        completedProviderIds: [],
        cachePersisted: false,
      };
      for (const p of env.providers) {
        if (requested && !requested.includes(p.providerId)) continue;
        p.attempt = { ...p.attempt, state: "deferred", deferredReason: "busy", reason: trigger.reason };
      }
      return env;
    }

    try {
      const storeLease = await locks.acquire("store", 5_000, signal, { reason: "refresh-commit" });
      if (storeLease.status === "busy") {
        const env = this.buildEnvelope({ nowMs: Date.now(), config: this.loadConfigOrNull(), runtime: this.readRuntimeState() });
        env.request = { requestId, outcome: "deferred", requestedProviderIds: requested ?? [], completedProviderIds: [], cachePersisted: false };
        return env;
      }
      try {
        return await this.runBatch({ trigger, requested, requestId, signal, startedAt, dirs, storeLease });
      } finally {
        await storeLease.release();
      }
    } finally {
      await lease.release();
    }
  }

  async runBatch({ trigger, requested, requestId, signal, startedAt, dirs, storeLease }) {
    void storeLease;
    const cfgLoaded = this.loadConfigOrNull();
    const runtime = this.readRuntimeState();
    const nowMs = Date.now();
    const providers = [];
    const completed = [];
    const concurrency = Math.max(1, Math.min(6, cfgLoaded?.config?.runtime?.maxConcurrency ?? 3));
    const runtimeByProvider = runtime.providers ?? {};

    const targets = this.registry.order.filter((id) => {
      if (requested && !requested.includes(id)) return false;
      return true;
    });

    const results = new Map();
    let idx = 0;
    const auth = v0ReadAuth();
    const broker = new SecretBroker();
    const stores = createCredentialStores({ env: this.env });

    const worker = async () => {
      for (;;) {
        const my = idx++;
        if (my >= targets.length) return;
        const providerId = targets[my];
        if (signal.aborted || Date.now() - startedAt > BATCH_LIMIT_MS) {
          results.set(providerId, { kind: "deferred", reason: signal.aborted ? "cancelled" : "batch-budget" });
          continue;
        }
        results.set(providerId, await this.refreshProvider(providerId, { cfgLoaded, runtime: runtimeByProvider, auth, broker, stores, nowMs, signal, dirs, trigger }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker));

    // 组装 envelope：registry 顺序 + 有效 providerOrder
    const envelope = this.buildEnvelope({ nowMs: Date.now(), config: cfgLoaded, runtime });
    for (const entry of envelope.providers) {
      const r = results.get(entry.providerId);
      if (!r) continue;
      completed.push(entry.providerId);
      applyResult(entry, r, { nowMs: Date.now(), trigger, configRevision: cfgLoaded?.config?.revision ?? 0 });
      // 退避状态持久化
      const prev = runtimeByProvider[entry.providerId] ?? {};
      let nextEligibleAtMs = r.nextEligibleAtMs;
      if (r.kind === "failed") {
        const failures = (prev.consecutiveFailures ?? 0) + 1;
        const interval = Math.max(cfgLoaded?.config?.runtime?.refreshIntervalSeconds ?? 300, this.registry.get(entry.providerId)?.refresh?.minimumIntervalSeconds ?? 60);
        const backoffAt = Date.now() + computeBackoffMs(failures, interval);
        const serverAt = r.error?.retryAtMs;
        nextEligibleAtMs = typeof serverAt === "number" ? Math.max(backoffAt, serverAt) : backoffAt;
        runtimeByProvider[entry.providerId] = { ...prev, consecutiveFailures: failures, nextEligibleAtMs, lastAttemptAtMs: Date.now() };
      } else if (r.kind === "success" || r.kind === "partial") {
        runtimeByProvider[entry.providerId] = { ...prev, consecutiveFailures: 0, nextEligibleAtMs: undefined, lastAttemptAtMs: Date.now() };
      } else {
        runtimeByProvider[entry.providerId] = { ...prev, nextEligibleAtMs, lastAttemptAtMs: Date.now() };
      }
    }
    envelope.request = {
      requestId,
      outcome: receiptOutcome(envelope.providers, requested, results),
      requestedProviderIds: requested ?? envelope.providers.map((p) => p.providerId),
      completedProviderIds: completed,
      cachePersisted: false,
    };
    envelope.request.cachePersisted = this.persist(dirs, envelope, runtimeByProvider);
    return envelope;
  }

  /** 单 provider 任务边界：resolve → fetch → normalize；异常按家收敛（§5.1）。 */
  async refreshProvider(providerId, { cfgLoaded, runtime, auth, broker, stores, nowMs, signal, dirs, trigger }) {
    void dirs;
    const manifest = this.registry.get(providerId);
    const provCfg = cfgLoaded?.config?.providers?.[providerId];
    if (!manifest) return { kind: "failed", error: safeError("unsupported", "not-implemented", "contact-maintainer") };
    if (!provCfg?.enabled) return { kind: "noop-disabled" };

    const dataSource = this.registry.selectDataSource(manifest, provCfg.dataSource, { allowCommunity: !!provCfg.allowCommunityEndpoints });
    if (!dataSource) return { kind: "failed", error: safeError("unsupported", "insufficient-scope", "contact-maintainer"), retainLastGood: true };
    if (dataSource.admission !== "approved") return { kind: "failed", error: safeError("unsupported", "insufficient-scope", "contact-maintainer"), retainLastGood: true };

    // 退避/Retry-After 检查（§5.3）：点击不绕过
    const st = runtime[providerId];
    const nextEligible = st?.nextEligibleAtMs;
    if (isAtMs(nextEligible) && nowMs < nextEligible) {
      return { kind: "deferred", reason: "backoff", nextEligibleAtMs: nextEligible, retainLastGood: true };
    }

    const profile = (provCfg.profiles ?? []).find((p) => p.id === provCfg.activeProfile) ?? { id: "default", discovery: "auto", sources: [] };
    const chain = buildChain(manifest, dataSource);
    const ctx = {
      nowMs, signal, interaction: trigger.interaction ?? "background",
      stores, broker, compatibility: cfgLoaded?.config?.compatibility, stateDir: this.dirs().stateDir,
    };
    let resolved;
    try {
      resolved = await resolveChain(providerId, profile, chain, ctx);
    } catch {
      return { kind: "failed", error: safeError("io-error", "io-error", "retry-later"), retainLastGood: true };
    }
    if (resolved.status !== "resolved") {
      return { kind: "failed", error: resolveErrorToSafe(resolved), retainLastGood: true };
    }

    // v0 桥接 fetch：lease token → v0 fetcher → v0 report → SnapshotReport
    let report;
    try {
      const bytes = await broker.withSecret(resolved.lease.access, providerId, async (b) => b);
      const token = new TextDecoder().decode(bytes);
      const extra = { region: profile.region, organizationId: profile.organizationId ?? provCfg?.profiles?.find((p) => p.id === profile.id)?.organizationId };
      report = await withTimeout(fetchProviderSnapshot(providerId, token, extra, { signal }), manifest.refresh.taskTimeoutSeconds * 1000, signal);
    } catch (e) {
      if (signal.aborted) return { kind: "cancelled", retainLastGood: true };
      return { kind: "failed", error: fetchErrorToSafe(e), retainLastGood: true };
    } finally {
      broker.drop(resolved.lease.access);
    }

    if (!snapshotHasData(report)) {
      return { kind: "failed", error: safeError("invalid-response", "empty-response", "retry-later"), retainLastGood: true, report };
    }
    const partial = (report.diagnostics ?? []).length > 0;
    return {
      kind: partial ? "partial" : "success",
      report,
      dataSourceId: dataSource.id,
      scopeKey: resolved.lease.identity.scopeKey,
      reader: resolved.lease.source.reader,
      credentialSourceId: resolved.lease.source.id,
      identityAssurance: resolved.lease.identity.assurance,
    };
  }

  /** 组装完整 envelope（disabled/not-configured 条目照列，§6.1）。 */
  buildEnvelope({ nowMs, config, runtime }) {
    const cachePrev = this.readUsageCache();
    const prevByProvider = new Map((cachePrev?.providers ?? []).map((p) => [p.providerId, p]));
    const providers = [];
    for (const id of this.registry.order) {
      const m = this.registry.get(id);
      const pcfg = config?.config?.providers?.[id];
      const prev = prevByProvider.get(id);
      const base = {
        providerId: id,
        profileId: pcfg?.enabled ? (pcfg.activeProfile ?? undefined) : undefined,
        status: "disabled",
        freshness: "none",
        dataDisposition: "none",
        attempt: { state: "never", reason: undefined },
        diagnostics: [],
      };
      if (!pcfg?.enabled) { providers.push(base); continue; }
      const st = runtime?.providers?.[id];
      // 未执行本次 attempt 时：投影上次持久化条目（保留其 report/status/last-good）
      const source = prev;
      if (source && source.status !== "disabled") {
        providers.push({ ...source, attempt: { ...source.attempt } });
        continue;
      }
      providers.push({
        ...base,
        status: "not-configured",
        error: safeError("not-configured", "not-configured", "configure-source"),
        lastAttemptAtMs: st?.lastAttemptAtMs,
      });
    }
    return {
      schemaVersion: 1,
      kind: "usage",
      contextId: config?.contextId ?? "context-default",
      generatedAtMs: nowMs,
      cacheRevision: config?.config?.revision ?? 0,
      providers,
      diagnostics: [],
    };
  }

  persist(dirs, envelope, runtimeByProvider) {
    try {
      mkdirSync(dirs.cacheDir, { recursive: true, mode: 0o700 });
      mkdirSync(dirs.stateDir, { recursive: true, mode: 0o700 });
      const persistent = { ...envelope };
      delete persistent.request; // §6.1：request 仅本次调用
      const { writeFileSync, renameSync } = fsPair();
      const writeAtomic = (file, obj) => {
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
        renameSync(tmp, file);
      };
      writeAtomic(dirs.usageCacheFile, persistent);
      writeAtomic(dirs.runtimeStateFile, { providers: runtimeByProvider, savedAtMs: Date.now() });
      return true;
    } catch {
      return false; // cache-write-failed：调用方置 cachePersisted=false（C13）
    }
  }
}

function fsPair() { return { writeFileSync: globalThis.__m1w.writeFileSync, renameSync: globalThis.__m1w.renameSync }; }
import { writeFileSync as _w2, renameSync as _r2 } from "fs";
globalThis.__m1w = { writeFileSync: _w2, renameSync: _r2 };

function receiptOutcome(providers, requested, results) {
  const relevant = providers.filter((p) => !requested || requested.includes(p.providerId));
  if (relevant.every((p) => p.status === "disabled")) return "no-op";
  const deferred = relevant.some((p) => p.attempt?.state === "deferred");
  const cancelled = [...results.values()].some((r) => r.kind === "cancelled");
  const failed = [...results.values()].some((r) => r.kind === "failed");
  const partial = [...results.values()].some((r) => r.kind === "partial");
  const success = [...results.values()].some((r) => r.kind === "success");
  if (cancelled) return "cancelled";
  if (deferred) return "deferred";
  if (success && (failed || partial)) return "partial";
  if (success && !failed && !partial) return "updated";
  if (failed) return "failed";
  return "unchanged";
}

function applyResult(entry, r, { nowMs, trigger, configRevision = 0 }) {
  r.configRevision = configRevision;
  entry.attempt = {
    state: r.kind === "success" ? "succeeded" : r.kind === "partial" ? "partial"
      : r.kind === "failed" ? "failed" : r.kind === "cancelled" ? "cancelled" : "deferred",
    id: undefined, startedAtMs: nowMs, finishedAtMs: nowMs, reason: trigger.reason,
    deferredReason: r.kind === "deferred" ? (r.reason === "busy" ? "busy" : r.reason === "cancelled" ? undefined : "backoff") : undefined,
  };
  entry.lastAttemptAtMs = nowMs;
  entry.configRevision = r.configRevision;
  if (r.kind === "success" || r.kind === "partial") {
    entry.status = r.kind === "partial" ? "partial" : "ok";
    entry.freshness = "fresh";
    entry.dataDisposition = "current";
    entry.lastSuccessAtMs = nowMs;
    entry.scopeKey = r.scopeKey;
    entry.source = {
      dataSourceId: r.dataSourceId, grade: "C", transport: "https",
      credentialSourceId: r.credentialSourceId, reader: r.reader,
      identityAssurance: r.identityAssurance,
    };
    entry.report = r.report;
    delete entry.error;
  } else if (r.kind === "failed") {
    entry.error = r.error;
    if (r.retainLastGood && entry.report) {
      entry.status = entry.status === "not-configured" ? "error" : entry.status; // 保留原 status/last-good
      entry.dataDisposition = "last-good";
    } else {
      entry.status = "error";
      entry.freshness = "none";
      entry.dataDisposition = "none";
    }
  } else if (r.kind === "deferred") {
    entry.nextEligibleAtMs = r.nextEligibleAtMs;
  }
}

function resolveErrorToSafe(resolved) {
  const map = {
    "not-configured": ["not-configured", "not-configured", "configure-source"],
    "invalid": ["reauth-required", "invalid-credential", "relogin-owner"],
    "expired": ["reauth-required", "credential-expired", "relogin-owner"],
    "permission-denied": ["permission-denied", "keychain-denied", "check-permission"],
    "interaction-required": ["reauth-required", "interaction-required", "allow-source"],
    "account-mismatch": ["permission-denied", "account-mismatch", "select-profile"],
    "unsupported": ["unsupported", "reader-unavailable", "contact-maintainer"],
    "invalid-config": ["invalid-config", "invalid-config", "configure-source"],
    "io-error": ["io-error", "io-error", "retry-later"],
    "cancelled": ["cancelled", "cancelled", "none"],
  };
  const [code, reasonCode, action] = map[resolved.code] ?? ["error", "io-error", "retry-later"];
  return safeError(code, resolved.reasonCode ?? reasonCode, resolved.action ?? action);
}

function fetchErrorToSafe(e) {
  const msg = String(e?.message ?? e);
  const retryAfter = e?.retryAfterHeader;
  if (/returned 401/.test(msg)) return safeError("reauth-required", "http-401", "relogin-owner");
  if (/returned 403/.test(msg)) return safeError("permission-denied", "http-403", "check-plan-region");
  if (/returned 429/.test(msg)) {
    const retryAtMs = parseRetryAfter(retryAfter);
    const err = safeError("rate-limited", "http-429", "retry-later", { httpStatus: 429 });
    if (retryAtMs) err.retryAtMs = retryAtMs;
    return err;
  }
  const m5 = msg.match(/returned (5\d\d)/);
  if (m5) return safeError("network", "http-5xx", "retry-later", { httpStatus: parseInt(m5[1], 10) });
  if (/timed out|timeout/i.test(msg)) return safeError("timeout", "http-5xx", "retry-later");
  return safeError("network", "http-5xx", "retry-later");
}

function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error("cancelled"), { aborted: true })); };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function buildChain(manifest, dataSource) {
  return (dataSource.credentialChain ?? []).map((rid) => {
    const decl = (manifest.credentialReaders ?? []).find((r) => r.id === rid);
    return { id: rid, kind: decl?.kind ?? "file", reader: rid, implementationId: decl?.implementationId ?? rid, purpose: decl?.purposes?.[0] ?? "primary", originOfChoice: "discovered" };
  });
}

function defaultConfigPath(env) {
  const { resolveConfigPath } = require0();
  function require0() { return { resolveConfigPath: globalThis.__m1cfgPath }; }
  return globalThis.__m1cfgPath({ env });
}
import { resolveConfigPath as _rcp } from "../config/paths.mjs";
globalThis.__m1cfgPath = _rcp;


// ---------------------------------------------------------------------------
// C22 读侧宽容：未知 metric 枚举隔离为 unsupported，不当作 known；未知 status 标注协议未知
// ---------------------------------------------------------------------------

const KNOWN_METRIC_KINDS = new Set(["quota", "balance", "spend", "counter", "status"]);
const KNOWN_UNITS = new Set(["percent", "count", "tokens", "requests", "credits", "currency", "none"]);
const KNOWN_STATES = new Set(["known", "remaining-only", "used-only", "limit-only", "unknown"]);

export function tolerateUnknown(envelope) {
  for (const p of envelope.providers ?? []) {
    const report = p.report;
    if (!report) continue;
    for (const arrName of ["windows", "metrics"]) {
      const arr = report[arrName];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (!m || typeof m !== "object") continue;
        const bad = !KNOWN_METRIC_KINDS.has(m.kind) || !KNOWN_UNITS.has(m.unit) ||
          (m.state !== undefined && !KNOWN_STATES.has(m.state));
        if (bad) {
          arr[i] = {
            id: m.id ?? `metric-${i}`, ruleId: m.ruleId ?? "unknown", label: m.label ?? "",
            kind: "status", unit: "none", scope: m.scope ?? "local",
            provenance: "reported", sourceEndpointIds: [],
            state: "known", valueCode: "unavailable",
            diagnostics: [{ code: "metric-unsupported", severity: "warning" }],
          };
        }
      }
    }
    if (p.status && !["disabled", "not-configured", "ok", "partial", "stale", "reauth-required", "permission-denied", "rate-limited", "unsupported", "error"].includes(p.status)) {
      p.status = "error";
      p.error = safeError("schema-unsupported", "schema-unsupported", "contact-maintainer");
      p.diagnostics = [...(p.diagnostics ?? []), { code: "metric-unsupported", severity: "warning" }];
    }
  }
  return envelope;
}

// ---------------------------------------------------------------------------
// C11 退避：max(effectiveInterval, min(3600, 300*2^(n-1)*(1+j))) 秒；Retry-After 解析
// ---------------------------------------------------------------------------

/** 指数退避（秒→ms）。n 从 1 开始；j 为 0..0.1 抖动；指数封顶 3600s，不缩短更长 effectiveInterval。 */
export function computeBackoffMs(consecutiveFailures, effectiveIntervalSeconds, { jitter = Math.random() * 0.1, nowMs = Date.now() } = {}) {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const exp = Math.min(3600, 300 * Math.pow(2, n - 1) * (1 + jitter));
  return (Math.max(effectiveIntervalSeconds, exp)) * 1000;
}

/** Retry-After 解析：秒数或 HTTP date；非法/缺失 → undefined（§5.3）。 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const v = typeof value === "string" ? value.trim() : value;
  if (/^\d+$/.test(String(v))) {
    const sec = parseInt(v, 10);
    return sec >= 0 ? nowMs + sec * 1000 : undefined;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) && t > 0 ? t : undefined;
}


// ---------------------------------------------------------------------------
// C18 手动 legacy 导入编排（§7）：用户显式触发；源文件只读；幂等（源内容 token 记忆）
// ---------------------------------------------------------------------------

/**
 * 导入 pi v0 缓存（{[provider]: {report, fetchedAt}}）为只读历史条目。
 * 返回 {envelope, importedProviderIds, sourceToken, changed}；不写 usage cache，
 * 落 runtime state 的 legacyImport 键（历史查看视图专用，不参与活动投影）。
 */
export function importLegacyCache({ sourcePath, runtime, nowMs = Date.now() }) {
  const { existsSync, readFileSync } = fsPair2();
  if (!existsSync(sourcePath)) {
    return { changed: false, importedProviderIds: [], sourceToken: undefined, envelope: { schemaVersion: 1, kind: "usage", contextId: "context-legacy", generatedAtMs: nowMs, cacheRevision: 0, providers: [], diagnostics: [{ code: "legacy-error", severity: "warning" }] } };
  }
  const rawText = readFileSync(sourcePath, "utf8");
  let legacy;
  try { legacy = parseStrictJson(rawText); } catch { return legacyFailure(nowMs); }
  if (!legacy || typeof legacy !== "object" || Array.isArray(legacy) || legacy.schemaVersion !== undefined) {
    return legacyFailure(nowMs); // §7：非 v0 结构不猜
  }
  const { createHash } = cryptoMod();
  const sourceToken = createHash("sha256").update(rawText, "utf8").digest("hex").slice(0, 32);
  const importedProviderIds = [];
  const providers = [];
  for (const [providerId, entry] of Object.entries(legacy)) {
    if (!entry || typeof entry !== "object" || !entry.report) continue;
    const windows = [];
    for (const w of Array.isArray(entry.report.windows) ? entry.report.windows : []) {
      windows.push(legacyWindowToMetric(w, { nowMs }));
    }
    const metrics = [];
    for (const m of Array.isArray(entry.report.metrics) ? entry.report.metrics : []) {
      if (Number.isFinite(m?.value)) {
        metrics.push({ id: `legacy-metric-${metrics.length}`, ruleId: "legacy-metric", label: String(m.label ?? "").slice(0, 160), kind: m.unit === "usd" ? "balance" : "counter", unit: m.unit === "usd" ? "currency" : "count", currency: m.unit === "usd" ? "USD" : undefined, scope: "subscription", provenance: "legacy-unverified", sourceEndpointIds: [], state: "known", value: m.value, diagnostics: [] });
      }
    }
    const fetchedAtMs = Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : undefined;
    providers.push({
      providerId,
      profileId: "legacy",
      status: "error",
      error: safeError("unsupported", "legacy-import", "none"),
      freshness: "expired",
      dataDisposition: "legacy",
      lastSuccessAtMs: fetchedAtMs,
      attempt: { state: "never" },
      source: { dataSourceId: "legacy-import", grade: "D", transport: "legacy", identityAssurance: "unverified-legacy" },
      scopeKey: `legacy-${providerId}-${sourceToken.slice(0, 12)}`,
      report: {
        name: providerId, capturedAtMs: fetchedAtMs, observationBasis: "legacy-import",
        windows, metrics, primaryMetricId: windows[0]?.id, diagnostics: [{ code: "legacy-unverified", severity: "warning" }],
      },
      diagnostics: [],
    });
    importedProviderIds.push(providerId);
  }
  return { changed: true, importedProviderIds, sourceToken, envelope: { schemaVersion: 1, kind: "usage", contextId: "context-legacy", generatedAtMs: nowMs, cacheRevision: 0, providers, diagnostics: [] } };
}

function legacyFailure(nowMs) {
  return { changed: false, importedProviderIds: [], sourceToken: undefined, envelope: { schemaVersion: 1, kind: "usage", contextId: "context-legacy", generatedAtMs: nowMs, cacheRevision: 0, providers: [], diagnostics: [{ code: "legacy-error", severity: "warning" }] } };
}

function fsPair2() { return globalThis.__m1fsPair; }
import { existsSync as _e2, readFileSync as _r2b } from "fs";
import { createHash as _ch } from "crypto";
globalThis.__m1fsPair = { existsSync: _e2, readFileSync: _r2b, createHash: _ch };
function cryptoMod() { return { createHash: globalThis.__m1fsPair.createHash }; }
