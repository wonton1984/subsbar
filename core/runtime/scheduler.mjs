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
import { v0ReadAuth, v0ResolveCredential, v0Fetch, v0ReportToSnapshot, snapshotHasData } from "../providers/adapters.mjs";
import { safeError, diagnostic, isAtMs } from "../defs.mjs";

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
      const parsed = JSON.parse(readFileSync(usageCacheFile, "utf8"));
      if (parsed?.schemaVersion !== 1 || parsed?.kind !== "usage") return null;
      return parsed;
    } catch { return null; }
  }

  /** 读取 runtime 私有 state（退避/身份映射）。 */
  readRuntimeState() {
    const { runtimeStateFile } = this.dirs();
    try {
      return JSON.parse(readFileSync(runtimeStateFile, "utf8"));
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
      applyResult(entry, r, { nowMs: Date.now(), trigger });
      // 退避状态持久化
      runtimeByProvider[entry.providerId] = {
        consecutiveFailures: r.kind === "failed" ? (runtimeByProvider[entry.providerId]?.consecutiveFailures ?? 0) + 1 : 0,
        nextEligibleAtMs: r.nextEligibleAtMs,
        lastAttemptAtMs: Date.now(),
      };
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
      const v0Report = await withTimeout(v0Fetch(providerId, token), manifest.refresh.taskTimeoutSeconds * 1000, signal);
      report = v0ReportToSnapshot(providerId, v0Report, { capturedAtMs: Date.now() });
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

function applyResult(entry, r, { nowMs, trigger }) {
  entry.attempt = {
    state: r.kind === "success" ? "succeeded" : r.kind === "partial" ? "partial"
      : r.kind === "failed" ? "failed" : r.kind === "cancelled" ? "cancelled" : "deferred",
    id: undefined, startedAtMs: nowMs, finishedAtMs: nowMs, reason: trigger.reason,
    deferredReason: r.kind === "deferred" ? (r.reason === "busy" ? "busy" : r.reason === "cancelled" ? undefined : "backoff") : undefined,
  };
  entry.lastAttemptAtMs = nowMs;
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
  if (/returned 401/.test(msg)) return safeError("reauth-required", "http-401", "relogin-owner");
  if (/returned 403/.test(msg)) return safeError("permission-denied", "http-403", "check-plan-region");
  if (/returned 429/.test(msg)) return safeError("rate-limited", "http-429", "retry-later");
  if (/returned 5\d\d/.test(msg)) return safeError("network", "http-5xx", "retry-later");
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
