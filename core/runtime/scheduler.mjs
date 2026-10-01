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
import { safeError, diagnostic, isAtMs, SAFE_ERROR_CODES, ACTION_CODES, RESOLVE_TO_ENTRY, RESOLVE_TO_ACTION, CREDENTIAL_ERROR_CODES } from "../defs.mjs";
import { legacyWindowToMetric } from "./report.mjs";
import { parseStrictJson } from "./json-strict.mjs";

const BATCH_LIMIT_MS = 120_000;
const LOSER_WAIT_MS = 2_000;
/** manual 绕过本地退避后仍防连点（总管 2026-10-01 裁决）。 */
export const MANUAL_MIN_INTERVAL_MS = 30_000;

const DEFERRED_REASONS = new Set(["busy", "not-due", "backoff", "batch-budget", "auth-wait"]);

/** 最近错误白名单中文简述：只按注册码映射，永不收录异常原文/路径/凭证。 */
export const ERROR_SUMMARY_ZH = {
  timeout: "请求超时",
  "connect-refused": "无法连接",
  network: "网络错误",
  "http-5xx": "服务暂时不可用",
  "http-429": "请求过于频繁",
  "http-401": "需要重新登录",
  "http-403": "权限不足",
  "io-error": "本地读写失败",
  "invalid-response": "响应无效",
  "empty-response": "响应为空",
  "not-configured": "尚未配置",
  "invalid-credential": "凭证无效",
  "credential-expired": "凭证已过期",
  "permission-denied": "权限不足",
  "invalid-config": "配置无效",
  "account-mismatch": "账号不匹配",
  "interaction-required": "需要在设置中连接",
  unsupported: "当前来源不可用",
  cancelled: "已取消",
  "rate-limited": "请求过于频繁",
  "cache-write-failed": "缓存写入失败",
  "config-conflict": "配置冲突",
  "schema-unsupported": "协议不受支持",
  "reader-unavailable": "读取器不可用",
  "not-implemented": "尚未实现",
};

/** 小数 deadline 向上取整后仍须通过 isAtMs，避免门控被跳过；非法值丢弃。 */
export function ceilAtMs(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  const n = Math.ceil(v);
  return isAtMs(n) ? n : undefined;
}

/** C11：cache / runtime 本地退避 / 服务端 Retry-After 取有效较晚值。 */
export function laterEligibleAtMs(...vals) {
  let max;
  for (const v of vals) {
    const n = ceilAtMs(v);
    if (n === undefined) continue;
    if (max === undefined || n > max) max = n;
  }
  return max;
}

export function serverDeadlineMs(st) {
  if (!st || typeof st !== "object") return undefined;
  const direct = ceilAtMs(st.serverRetryAtMs);
  if (direct) return direct;
  const fromErr = ceilAtMs(st.lastError?.retryAtMs);
  if (fromErr) return fromErr;
  if (st.lastError?.reasonCode === "http-429") return ceilAtMs(st.nextEligibleAtMs);
  return undefined;
}

export function localDeadlineMs(st) {
  if (!st || typeof st !== "object") return undefined;
  const local = ceilAtMs(st.localBackoffAtMs);
  if (local) return local;
  if (serverDeadlineMs(st) !== undefined) return undefined;
  return ceilAtMs(st.nextEligibleAtMs);
}

function lastErrorRecord(error, failedAtMs) {
  if (!error || typeof error !== "object") return undefined;
  const code = SAFE_ERROR_CODES.includes(error.code) ? error.code : "network";
  const rawReason = String(error.reasonCode ?? "network").slice(0, 64);
  const reasonCode = /^[a-z0-9-]{1,64}$/.test(rawReason) ? rawReason : "network";
  const action = ACTION_CODES.includes(error.action) ? error.action : "retry-later";
  const rec = {
    code,
    reasonCode,
    action,
    summary: ERROR_SUMMARY_ZH[reasonCode] ?? ERROR_SUMMARY_ZH[code] ?? "请求失败",
    failedAtMs: ceilAtMs(failedAtMs),
  };
  if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) {
    rec.httpStatus = error.httpStatus;
  }
  const retryAt = ceilAtMs(error.retryAtMs);
  if (retryAt) rec.retryAtMs = retryAt;
  return rec;
}

function deferredReasonOf(r) {
  if (r.kind !== "deferred") return undefined;
  const reason = r.reason;
  if (typeof reason === "string" && DEFERRED_REASONS.has(reason)) return reason;
  return undefined;
}

/**
 * 将一次 refreshProvider 结果写入 runtime。deferred 不碰失败时间；
 * cancel 不加退避也不清 server Retry-After；partial 只清主失败计数。
 */
export function recordProviderRuntime(prev = {}, r, { nowMs, intervalSeconds }) {
  if (!r || r.kind === "noop-disabled") return { ...prev };
  const next = { ...prev };
  next.lastRequestedAtMs = ceilAtMs(r.requestedAtMs) ?? nowMs;

  if (r.kind === "deferred") {
    next.lastDeferredAtMs = nowMs;
    const eligible = laterEligibleAtMs(r.nextEligibleAtMs, next.localBackoffAtMs, next.serverRetryAtMs, next.nextEligibleAtMs);
    if (eligible !== undefined) next.nextEligibleAtMs = eligible;
    return next;
  }

  if (r.kind === "cancelled") {
    if (r.startedAtMs) next.lastAttemptAtMs = ceilAtMs(r.startedAtMs) ?? next.lastAttemptAtMs;
    if (r.finishedAtMs) next.lastFinishedAtMs = ceilAtMs(r.finishedAtMs) ?? next.lastFinishedAtMs;
    next.nextEligibleAtMs = laterEligibleAtMs(next.localBackoffAtMs, next.serverRetryAtMs);
    return next;
  }

  if (r.kind === "failed") {
    const failures = (prev.consecutiveFailures ?? 0) + 1;
    next.consecutiveFailures = failures;
    const failedAt = ceilAtMs(r.finishedAtMs) ?? nowMs;
    next.lastAttemptAtMs = ceilAtMs(r.startedAtMs) ?? failedAt;
    next.lastFinishedAtMs = failedAt;
    next.lastFailureAtMs = failedAt;
    next.localBackoffAtMs = failedAt + computeBackoffMs(failures, intervalSeconds);
    const serverAt = ceilAtMs(r.error?.retryAtMs);
    if (serverAt) next.serverRetryAtMs = laterEligibleAtMs(prev.serverRetryAtMs, serverAt);
    next.nextEligibleAtMs = laterEligibleAtMs(next.localBackoffAtMs, next.serverRetryAtMs);
    next.lastError = lastErrorRecord(r.error, failedAt);
    return next;
  }

  if (r.kind === "success") {
    next.consecutiveFailures = 0;
    next.localBackoffAtMs = undefined;
    next.serverRetryAtMs = undefined;
    next.nextEligibleAtMs = undefined;
    next.lastAttemptAtMs = ceilAtMs(r.startedAtMs) ?? nowMs;
    next.lastFinishedAtMs = ceilAtMs(r.finishedAtMs) ?? nowMs;
    next.lastError = undefined;
    return next;
  }

  if (r.kind === "partial") {
    next.consecutiveFailures = 0;
    next.localBackoffAtMs = undefined;
    next.lastAttemptAtMs = ceilAtMs(r.startedAtMs) ?? nowMs;
    next.lastFinishedAtMs = ceilAtMs(r.finishedAtMs) ?? nowMs;
    next.nextEligibleAtMs = laterEligibleAtMs(next.serverRetryAtMs);
    return next;
  }

  return next;
}

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
      const pcfg = cfgLoaded?.config?.providers?.[id];
      return !!pcfg?.enabled;
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
        try {
          results.set(providerId, await this.refreshProvider(providerId, { cfgLoaded, runtime: runtimeByProvider, auth, broker, stores, nowMs, signal, dirs, trigger }));
        } catch {
          // C06：单家任何未收敛异常不得击落 Promise.all 整批。
          results.set(providerId, { kind: "failed", error: safeError("io-error", "io-error", "retry-later"), retainLastGood: true });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker));

    // 组装 envelope：registry 顺序 + 有效 providerOrder
    const envelope = this.buildEnvelope({ nowMs: Date.now(), config: cfgLoaded, runtime });
    for (const entry of envelope.providers) {
      const r = results.get(entry.providerId);
      if (!r || r.kind === "noop-disabled") continue;
      completed.push(entry.providerId);
      const prev = runtimeByProvider[entry.providerId] ?? {};
      const interval = Math.max(
        cfgLoaded?.config?.runtime?.refreshIntervalSeconds ?? 300,
        this.registry.get(entry.providerId)?.refresh?.minimumIntervalSeconds ?? 60,
      );
      const stamp = Date.now();
      const next = recordProviderRuntime(prev, r, { nowMs: stamp, intervalSeconds: interval });
      runtimeByProvider[entry.providerId] = next;
      r.nextEligibleAtMs = laterEligibleAtMs(r.nextEligibleAtMs, next.nextEligibleAtMs, next.serverRetryAtMs);
      applyResult(entry, r, { nowMs: stamp, trigger, configRevision: cfgLoaded?.config?.revision ?? 0 });
      const projected = laterEligibleAtMs(entry.nextEligibleAtMs, next.nextEligibleAtMs, next.serverRetryAtMs);
      if (projected !== undefined) entry.nextEligibleAtMs = projected;
      else delete entry.nextEligibleAtMs;
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
  async refreshProvider(providerId, ctx) {
    try {
      return await this.refreshProviderTask(providerId, ctx);
    } catch {
      return { kind: "failed", error: safeError("io-error", "io-error", "retry-later"), retainLastGood: true };
    }
  }

  async refreshProviderTask(providerId, { cfgLoaded, runtime, auth, broker, stores, nowMs, signal, dirs, trigger }) {
    void dirs;
    const manifest = this.registry.get(providerId);
    const provCfg = cfgLoaded?.config?.providers?.[providerId];
    if (!manifest) return { kind: "failed", error: safeError("unsupported", "not-implemented", "contact-maintainer") };
    if (!provCfg?.enabled) return { kind: "noop-disabled" };
    const profileId = typeof provCfg.activeProfile === "string" ? provCfg.activeProfile : undefined;

    const dataSource = this.registry.selectDataSource(manifest, provCfg.dataSource, { allowCommunity: !!provCfg.allowCommunityEndpoints });
    if (!dataSource) return { kind: "failed", error: safeError("unsupported", "insufficient-scope", "contact-maintainer"), retainLastGood: true, profileId };
    if (dataSource.admission !== "approved") return { kind: "failed", error: safeError("unsupported", "insufficient-scope", "contact-maintainer"), retainLastGood: true, profileId };

    const st = runtime?.[providerId];
    const serverAt = serverDeadlineMs(st);
    const localAt = localDeadlineMs(st);
    const lastAttempt = ceilAtMs(st?.lastAttemptAtMs);
    if (serverAt && nowMs < serverAt) {
      return { kind: "deferred", reason: "backoff", nextEligibleAtMs: serverAt, retainLastGood: true, requestedAtMs: nowMs };
    }
    if (trigger.reason === "manual") {
      if (lastAttempt && nowMs < lastAttempt + MANUAL_MIN_INTERVAL_MS) {
        return {
          kind: "deferred", reason: "not-due",
          nextEligibleAtMs: lastAttempt + MANUAL_MIN_INTERVAL_MS,
          retainLastGood: true, requestedAtMs: nowMs,
        };
      }
    } else if (localAt && nowMs < localAt) {
      return {
        kind: "deferred", reason: "backoff",
        nextEligibleAtMs: laterEligibleAtMs(localAt, serverAt),
        retainLastGood: true, requestedAtMs: nowMs,
      };
    }

    const startedAtMs = Date.now();
    const requestedAtMs = nowMs;

    const profile = (provCfg.profiles ?? []).find((p) => p.id === provCfg.activeProfile) ?? { id: profileId ?? "default", discovery: "auto", sources: [] };
    const chain = buildChain(manifest, dataSource);
    const ctx = {
      nowMs, signal, interaction: trigger.interaction ?? "background",
      stores, broker, compatibility: cfgLoaded?.config?.compatibility, stateDir: this.dirs().stateDir,
      credentialReaders: manifest.credentialReaders,
    };
    let resolved;
    try {
      resolved = await resolveChain(providerId, profile, chain, ctx);
    } catch {
      return { kind: "failed", error: safeError("io-error", "io-error", "retry-later"), retainLastGood: true, profileId: profile.id, startedAtMs, finishedAtMs: Date.now(), requestedAtMs };
    }
    if (resolved.status !== "resolved") {
      return { kind: "failed", error: resolveErrorToSafe(resolved), retainLastGood: true, profileId: profile.id, startedAtMs, finishedAtMs: Date.now(), requestedAtMs };
    }

    // v0 桥接 fetch：lease token → v0 fetcher → v0 report → SnapshotReport
    let report;
    try {
      const token = await broker.withSecret(resolved.lease.access, providerId, async (b) => new TextDecoder().decode(b));
      const extra = { region: profile.region, organizationId: profile.organizationId ?? provCfg?.profiles?.find((p) => p.id === profile.id)?.organizationId };
      report = await withTimeout(fetchProviderSnapshot(providerId, token, extra, { signal }), manifest.refresh.taskTimeoutSeconds * 1000, signal);
    } catch (e) {
      if (signal.aborted) return { kind: "cancelled", retainLastGood: true, profileId: profile.id, startedAtMs, finishedAtMs: Date.now(), requestedAtMs };
      return { kind: "failed", error: fetchErrorToSafe(e), retainLastGood: true, profileId: profile.id, startedAtMs, finishedAtMs: Date.now(), requestedAtMs };
    } finally {
      broker.drop(resolved.lease.access);
    }

    if (!snapshotHasData(report)) {
      return { kind: "failed", error: safeError("invalid-response", "empty-response", "retry-later"), retainLastGood: true, report, profileId: profile.id, startedAtMs, finishedAtMs: Date.now(), requestedAtMs };
    }
    const partial = (report.diagnostics ?? []).length > 0;
    return {
      kind: partial ? "partial" : "success",
      report,
      profileId: profile.id,
      dataSourceId: dataSource.id,
      scopeKey: resolved.lease.identity.scopeKey,
      reader: resolved.lease.source.reader,
      credentialSourceId: resolved.lease.source.id,
      identityAssurance: resolved.lease.identity.assurance,
      startedAtMs,
      finishedAtMs: Date.now(),
      requestedAtMs,
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
        const projected = laterEligibleAtMs(source.nextEligibleAtMs, st?.nextEligibleAtMs, st?.serverRetryAtMs);
        providers.push({
          ...source,
          attempt: { ...source.attempt },
          ...(projected !== undefined ? { nextEligibleAtMs: projected } : {}),
        });
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

export function receiptOutcome(providers, requested, results) {
  const kinds = [];
  for (const [id, r] of results) {
    if (requested && !requested.includes(id)) continue;
    if (!r || r.kind === "noop-disabled") continue;
    kinds.push(r.kind);
  }
  const relevant = providers.filter((p) => {
    if (requested && !requested.includes(p.providerId)) return false;
    if (p.status === "disabled") return false;
    const r = results.get(p.providerId);
    if (r?.kind === "noop-disabled") return false;
    return true;
  });
  if (kinds.length === 0 || relevant.every((p) => p.status === "disabled")) return "no-op";
  if (kinds.includes("cancelled")) return "cancelled";
  if (kinds.includes("deferred")) return "deferred";
  const failed = kinds.includes("failed");
  const partial = kinds.includes("partial");
  const success = kinds.includes("success");
  if (success && (failed || partial)) return "partial";
  if (success && !failed && !partial) return "updated";
  if (failed) return "failed";
  return "unchanged";
}

export function applyResult(entry, r, { nowMs, trigger, configRevision = 0 }) {
  if (r.kind === "noop-disabled") return;
  r.configRevision = configRevision;
  const startedAtMs = ceilAtMs(r.startedAtMs);
  const finishedAtMs = ceilAtMs(r.finishedAtMs) ?? nowMs;
  entry.attempt = {
    state: r.kind === "success" ? "succeeded" : r.kind === "partial" ? "partial"
      : r.kind === "failed" ? "failed" : r.kind === "cancelled" ? "cancelled" : "deferred",
    id: undefined, startedAtMs: startedAtMs ?? (r.kind === "deferred" ? nowMs : nowMs), finishedAtMs, reason: trigger.reason,
    deferredReason: deferredReasonOf(r),
  };
  if (r.kind === "success" || r.kind === "partial" || r.kind === "failed") {
    entry.lastAttemptAtMs = startedAtMs ?? nowMs;
  }
  entry.configRevision = r.configRevision;
  const sampledProfile = r.profileId;
  if (sampledProfile && (r.kind === "success" || r.kind === "partial" || r.kind === "failed" || r.kind === "cancelled")) {
    if (entry.profileId !== undefined && entry.profileId !== sampledProfile) {
      delete entry.report;
      delete entry.scopeKey;
      delete entry.source;
      delete entry.lastSuccessAtMs;
      entry.freshness = "none";
      entry.dataDisposition = "none";
    }
    entry.profileId = sampledProfile;
  }
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
    const eligible = ceilAtMs(r.nextEligibleAtMs);
    if (eligible !== undefined) entry.nextEligibleAtMs = eligible;
    const mapped = providerStatusForFailure(r.error);
    if (r.retainLastGood && entry.report) {
      // 凭证类失败必须盖成 reauth-required 等，UI 才能渲染重新登录卡片；
      // 普通运输失败保留原 status（last-good 数字仍可见）。
      entry.status = mapped === "error"
        ? (entry.status === "not-configured" ? "error" : entry.status)
        : mapped;
      entry.dataDisposition = "last-good";
    } else {
      entry.status = mapped;
      if (!entry.report) {
        entry.freshness = "none";
        entry.dataDisposition = "none";
      }
    }
  } else if (r.kind === "deferred") {
    const eligible = ceilAtMs(r.nextEligibleAtMs);
    if (eligible !== undefined) entry.nextEligibleAtMs = eligible;
  }
}

/** resolver 失败码 → SafeError.code（contracts §2.3）；status 由 applyResult 另映。 */
const RESOLVE_REASON_FALLBACK = {
  "not-configured": "not-configured",
  "invalid": "invalid-credential",
  "expired": "credential-expired",
  "permission-denied": "keychain-denied",
  "interaction-required": "interaction-required",
  "account-mismatch": "account-mismatch",
  "unsupported": "reader-unavailable",
  "invalid-config": "invalid-config",
  "io-error": "io-error",
  "cancelled": "cancelled",
};

/** SafeError.code → ProviderEntry.status。reauth-required 是 status，不是 error.code。 */
const STATUS_FROM_SAFE_ERROR = {
  "not-configured": "not-configured",
  "invalid-credential": "reauth-required",
  "credential-expired": "reauth-required",
  "interaction-required": "reauth-required",
  "permission-denied": "permission-denied",
  "account-mismatch": "permission-denied",
  "unsupported": "unsupported",
  "rate-limited": "rate-limited",
};

export function providerStatusForFailure(error) {
  return STATUS_FROM_SAFE_ERROR[error?.code] ?? "error";
}

export function resolveErrorToSafe(resolved) {
  try {
    const resolverCode = CREDENTIAL_ERROR_CODES.includes(resolved?.code) ? resolved.code : undefined;
    const mapped = resolverCode ? RESOLVE_TO_ENTRY[resolverCode] : undefined;
    const errorCode = SAFE_ERROR_CODES.includes(mapped?.code) ? mapped.code : "io-error";
    const reasonCode = resolved?.reasonCode ?? (resolverCode ? RESOLVE_REASON_FALLBACK[resolverCode] : "io-error") ?? "io-error";
    const actionRaw = resolved?.action ?? RESOLVE_TO_ACTION[resolverCode] ?? "retry-later";
    const action = ACTION_CODES.includes(actionRaw) ? actionRaw : "retry-later";
    return safeError(errorCode, reasonCode, action);
  } catch {
    return safeError("io-error", "io-error", "retry-later");
  }
}

const CONNECT_REFUSED_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const TIMEOUT_CAUSE_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function transportCauseCode(e) {
  return e?.cause?.code ?? e?.code ?? e?.cause?.cause?.code;
}

export function fetchErrorToSafe(e) {
  try {
    return classifyFetchError(e);
  } catch {
    return safeError("network", "network", "retry-later");
  }
}

function classifyFetchError(e) {
  const msg = String(e?.message ?? e);
  const kind = e?.transportKind;
  const causeCode = transportCauseCode(e);
  const retryAfter = e?.retryAfterHeader;
  const statusFromMsg = msg.match(/returned (\d{3})/);
  const httpStatus = Number.isInteger(e?.httpStatus) ? e.httpStatus : (statusFromMsg ? parseInt(statusFromMsg[1], 10) : undefined);
  if (httpStatus === 401 || /returned 401/.test(msg)) return safeError("invalid-credential", "http-401", "relogin-owner", { httpStatus: 401 });
  if (httpStatus === 403 || /returned 403/.test(msg)) return safeError("permission-denied", "http-403", "check-plan-region");
  if (httpStatus === 429 || /returned 429/.test(msg)) {
    const retryAtMs = parseRetryAfter(retryAfter);
    const err = safeError("rate-limited", "http-429", "retry-later", { httpStatus: 429 });
    if (retryAtMs) err.retryAtMs = retryAtMs;
    return err;
  }
  if (kind === "http-5xx" || (httpStatus >= 500 && httpStatus <= 599) || /returned (5\d\d)/.test(msg)) {
    const status = httpStatus >= 500 && httpStatus <= 599 ? httpStatus : parseInt((msg.match(/returned (5\d\d)/) ?? [])[1], 10);
    return safeError("network", "http-5xx", "retry-later", { httpStatus: Number.isInteger(status) ? status : undefined });
  }
  if (kind === "timeout" || TIMEOUT_CAUSE_CODES.has(causeCode) || /timed out|timeout/i.test(msg)) {
    return safeError("timeout", "timeout", "retry-later");
  }
  if (kind === "connect-refused" || CONNECT_REFUSED_CODES.has(causeCode) || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|connect-refused/i.test(msg)) {
    return safeError("network", "connect-refused", "retry-later");
  }
  if (kind === "aborted" || /cancelled/i.test(msg)) return safeError("cancelled", "cancelled", "none");
  return safeError("network", "network", "retry-later");
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
  return Math.ceil(Math.max(effectiveIntervalSeconds, exp) * 1000);
}

/** Retry-After 解析：秒数或 HTTP date；非法/缺失 → undefined（§5.3）。 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const v = typeof value === "string" ? value.trim() : value;
  if (/^\d+$/.test(String(v))) {
    const sec = parseInt(v, 10);
    return sec >= 0 ? ceilAtMs(nowMs + sec * 1000) : undefined;
  }
  const t = Date.parse(String(v));
  const parsed = Number.isFinite(t) && t > 0 ? t : undefined;
  return ceilAtMs(parsed);
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
