#!/usr/bin/env node
/**
 * M1 场景契约测试（C02/C05/C06/C10/C12/C19/C11）。
 * 运行：node test/m1-scenarios.test.mjs ；退出码 0 = 全过。
 */
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { createCredentialStores } from "../core/credentials/stores.mjs";
import { resolveChain } from "../core/credentials/resolver.mjs";
import { SecretBroker } from "../core/credentials/broker.mjs";
import { LockBackend } from "../core/runtime/lock.mjs";
import { RefreshCoordinator } from "../core/runtime/scheduler.mjs";
import { parseStrictJson } from "../core/runtime/json-strict.mjs";
import { computeBackoffMs, parseRetryAfter, fetchErrorToSafe } from "../core/runtime/scheduler.mjs";

let ok = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }
}

const base = join(tmpdir(), `m1-scenarios-${process.pid}-${Date.now()}`);
rmSync(base, { recursive: true, force: true });
mkdirSync(join(base, "state"), { recursive: true, mode: 0o700 });
const broker = new SecretBroker();

console.log("== C02. 来源覆盖：显式 sources 屏蔽默认 env；file 缺失/损坏分类 ==");
{
  process.env.M1SCEN_ENV_KEY = "synthetic-env-key-0123456789";
  const stores = createCredentialStores({ env: process.env });
  const ctx = { nowMs: 1800000000000, interaction: "background", stores, broker, compatibility: { pi: { enabled: false } }, stateDir: join(base, "state") };
  const fileMissing = [{ id: "f", kind: "file", reader: "json-file-generic", path: join(base, "no-such.json"), implementationId: "json-file-generic" }];
  const r1 = await resolveChain("kimi", { id: "p", discovery: "auto", sources: fileMissing }, [], ctx);
  check("显式 file 缺失 → not-configured（不用 env）", r1.code === "not-configured" && r1.trace.every((t) => t.sourceId === "f"));

  const badFile = join(base, "bad.json");
  writeFileSync(badFile, "{not-json", { mode: 0o600 });
  const r2 = await resolveChain("kimi", { id: "p", discovery: "auto", sources: [{ ...fileMissing[0], path: badFile }] }, [], ctx);
  check("file 损坏 → invalid 停止", r2.code === "invalid");

  const goodFile = join(base, "good.json");
  writeFileSync(goodFile, JSON.stringify({ "opencode-go": { key: "synthetic-file-key-0123456789" } }), { mode: 0o600 });
  const r3 = await resolveChain("opencode", { id: "p", discovery: "auto", sources: [{ id: "f", kind: "file", reader: "opencode-auth-file", path: goodFile, implementationId: "opencode-auth-file" }] }, [], ctx);
  check("file 有效 → resolved（不偷用 env）", r3.status === "resolved" && r3.lease.source.id === "f");
}

console.log("\n== C05. 到期：过期 JWT 保守拒绝；api-key 无 renew ==");
{
  const stores = createCredentialStores({ env: process.env });
  const ctx = { nowMs: 1800000000000, interaction: "background", stores, broker, compatibility: { pi: { enabled: false } }, stateDir: join(base, "state") };
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const expiredJwt = `h.${b64url({ sub: "synthetic", exp: 1000000000 })}.s`;
  process.env.M1SCEN_EXPIRED = expiredJwt;
  const r = await resolveChain("codex", { id: "p", discovery: "auto", sources: [{ id: "e", kind: "env", reader: "env-generic", envName: "M1SCEN_EXPIRED", implementationId: "env-generic", credentialKind: "oauth" }] }, [], ctx);
  check("过期 JWT → expired 停止", r.status === "failed" && r.code === "expired" && r.reasonCode === "credential-expired");
  rmSync(join(base, "state"), { recursive: true, force: true });
  mkdirSync(join(base, "state"), { recursive: true });
  // api-key 无 renew 端点：引擎不包含 token 刷新调用（设计保证 + manifests renewMode:none）
  const { readFileSync } = await import("fs");
  const engine = readFileSync(new URL("../core/providers/engine/engine.mjs", import.meta.url), "utf8");
  check("引擎无 token endpoint 调用（不消费 borrowed refresh）", !/token_endpoint|oauth\/token/i.test(engine));
}

console.log("\n== C06. 错误隔离：一家失败不影响另一家 ==");
{
  const stores = createCredentialStores({ env: process.env });
  const ctx = { nowMs: 1800000000000, interaction: "background", stores, broker, compatibility: { pi: { enabled: false } }, stateDir: join(base, "state2") };
  mkdirSync(join(base, "state2"), { recursive: true, mode: 0o700 });
  process.env.M1SCEN_GOOD = "synthetic-good-key-0123456789";
  const badChain = [{ id: "bad", kind: "file", reader: "json-file-generic", path: join(base, "malformed.json"), implementationId: "json-file-generic" }];
  writeFileSync(join(base, "malformed.json"), "%%%", { mode: 0o600 });
  const rBad = await resolveChain("droid", { id: "p", discovery: "auto", sources: badChain }, [], ctx);
  const rGood = await resolveChain("kimi", { id: "p", discovery: "auto", sources: [{ id: "g", kind: "env", reader: "env-generic", envName: "M1SCEN_GOOD", implementationId: "env-generic" }] }, [], ctx);
  check("A invalid、B resolved 互不影响", rBad.code === "invalid" && rGood.status === "resolved");
}

console.log("\n== C10. 跨进程锁：竞争/崩溃恢复/活锁不抢 ==");
{
  const backend1 = new LockBackend(join(base, "state3"));
  const backend2 = new LockBackend(join(base, "state3"));
  mkdirSync(join(base, "state3"), { recursive: true, mode: 0o700 });
  const l1 = await backend1.acquire("refresh-leader", 200);
  check("首个获取成功", l1.ownerNonce !== undefined);
  const l2 = await backend2.acquire("refresh-leader", 200);
  check("竞争者 busy", l2.status === "busy");
  await l1.release();
  const l3 = await backend2.acquire("refresh-leader", 200);
  check("释放后可重获", l3.ownerNonce !== undefined);
  await l3.release();
  // 崩溃恢复：死 PID 持锁
  const deadPath = join(base, "state3", "lock-refresh-leader");
  mkdirSync(deadPath, { recursive: true });
  writeFileSync(join(deadPath, "owner"), JSON.stringify({ pid: 999999999, startKey: "dead-1", nonce: "x", acquiredAtMs: Date.now() - 20 * 60_000 }));
  const l4 = await backend1.acquire("refresh-leader", 200);
  check("死 owner 锁被回收", l4.ownerNonce !== undefined);
  await l4.release();
  // 活锁不抢：存活进程（self）持锁、mtime 新 → busy
  const live = await backend1.acquire("refresh-leader", 100);
  const liveInfo = JSON.parse(readSelfSync(join(base, "state3", "lock-refresh-leader", "owner")));
  liveInfo.startKey = "other-process-start";
  liveInfo.pid = process.pid;
  writeSelfSync(join(base, "state3", "lock-refresh-leader", "owner"), JSON.stringify(liveInfo));
  const l5 = await backend2.acquire("refresh-leader", 150);
  check("存活 holder 不被 TTL 抢走", l5.status === "busy");
  await live.release();
  function readSelfSync(p) { return require0(p); }
  function writeSelfSync(p, d) { writeFileSync(p, d); }
  function require0(p) { return readFileSync(p, "utf8"); }
}

console.log("\n== C12/C13. 失败持久化与写失败 ==");
{
  const cacheHome = join(base, "c12-cache");
  const stateHome = join(base, "c12-state");
  mkdirSync(cacheHome, { recursive: true, mode: 0o700 });
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const isolatedEnv = { ...process.env, XDG_CACHE_HOME: cacheHome, XDG_STATE_HOME: stateHome };
  const coordinator = new RefreshCoordinator({ configPath: join(base, "no-config.json"), env: isolatedEnv });
  const cacheFile = coordinator.dirs().usageCacheFile;
  const goodEnvelope = { schemaVersion: 1, kind: "usage", contextId: "c", generatedAtMs: 1, cacheRevision: 0, providers: [], diagnostics: [] };
  check("无缓存读取 null", coordinator.readUsageCache() === null);
  mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
  writeFileSync(cacheFile, "{{{", { mode: 0o600 });
  check("损坏缓存不抛错", coordinator.readUsageCache() === null);
  rmSync(cacheFile, { force: true });
  writeFileSync(cacheFile, '{"a":1,"a":2}', { mode: 0o600 });
  check("重复键缓存拒绝", coordinator.readUsageCache() === null);
  rmSync(cacheFile, { force: true });
  const roDir = join(base, "readonly");
  mkdirSync(roDir, { recursive: true });
  writeFileSync(join(roDir, "blocker"), "x");
  const c2 = new RefreshCoordinator({ configPath: join(base, "no-config.json"), env: { ...process.env, XDG_CACHE_HOME: join(roDir, "blocker"), XDG_STATE_HOME: join(base, "state-ro") } });
  const persisted = c2.persist(c2.dirs(), goodEnvelope, {});
  check("cache 目录不可写 → cachePersisted=false", persisted === false);
  check("旧缓存文件未被创建/损坏", !existsSync(join(roDir, "blocker", "subsbar", "usage-v1.json")));
}

console.log("\n== C11. 退避与 Retry-After ==");
{
  check("n=1 → 300s", computeBackoffMs(1, 60, { jitter: 0 }) === 300_000);
  check("n=3 → 1200s", computeBackoffMs(3, 60, { jitter: 0 }) === 1_200_000);
  check("指数封顶 3600s", computeBackoffMs(20, 60, { jitter: 0 }) === 3_600_000);
  check("不低于用户间隔", computeBackoffMs(1, 800, { jitter: 0 }) === 800_000);
  check("Retry-After 秒", parseRetryAfter("90", 5_000) === 95_000);
  check("Retry-After HTTP date", parseRetryAfter("Wed, 21 Oct 2031 07:28:00 GMT", 5_000) > 5_000);
  check("Retry-After 非法 → undefined", parseRetryAfter("soon", 5_000) === undefined);
  const jittered = [computeBackoffMs(2, 300, { jitter: 0 }), computeBackoffMs(2, 300, { jitter: 0.1 })];
  check("抖动只增不减且 ≤10%（n=2 基线 600s）", jittered[0] === 600_000 && jittered[1] >= 600_000 && jittered[1] <= 660_000);
}

console.log("\n== C11b. 退避毫秒取整 / manual 门控 / runtime 语义 ==");
{
  const { isAtMs } = await import("../core/defs.mjs");
  const {
    ceilAtMs, laterEligibleAtMs, recordProviderRuntime, receiptOutcome, applyResult,
    localDeadlineMs, serverDeadlineMs, MANUAL_MIN_INTERVAL_MS, ERROR_SUMMARY_ZH,
  } = await import("../core/runtime/scheduler.mjs");
  const now = 1_800_000_000_000;
  const frac = computeBackoffMs(1, 300, { jitter: 0.012345 });
  check("非整 jitter 向上取整为整数毫秒", Number.isInteger(frac) && frac === Math.ceil(300_000 * (1 + 0.012345)));
  check("取整后 deadline 通过 isAtMs 门控", isAtMs(now + frac) && now < now + frac);
  check("旧小数 deadline 向上取整仍保护", ceilAtMs(now + 303703.5) === now + 303704 && isAtMs(ceilAtMs(now + 303703.5)));
  check("C11 较晚值取 max", laterEligibleAtMs(now + 100, now + 50.2, undefined) === now + 100);

  const failedRt = recordProviderRuntime({}, {
    kind: "failed",
    error: { code: "timeout", reasonCode: "timeout", action: "retry-later" },
    startedAtMs: now, finishedAtMs: now + 12, requestedAtMs: now,
  }, { nowMs: now + 12, intervalSeconds: 300 });
  check("失败写入 lastFailure/lastAttempt 且 lastError 脱敏", failedRt.lastFailureAtMs === now + 12 && failedRt.lastAttemptAtMs === now
    && failedRt.lastError?.summary === ERROR_SUMMARY_ZH.timeout && failedRt.lastError?.code === "timeout"
    && !JSON.stringify(failedRt.lastError).includes("Error") && Number.isInteger(failedRt.nextEligibleAtMs));
  const deferredRt = recordProviderRuntime(failedRt, {
    kind: "deferred", reason: "backoff", nextEligibleAtMs: failedRt.nextEligibleAtMs, requestedAtMs: now + 100,
  }, { nowMs: now + 100, intervalSeconds: 300 });
  check("deferred 不刷新失败时间", deferredRt.lastFailureAtMs === failedRt.lastFailureAtMs && deferredRt.lastAttemptAtMs === failedRt.lastAttemptAtMs
    && deferredRt.lastDeferredAtMs === now + 100 && deferredRt.consecutiveFailures === failedRt.consecutiveFailures);
  const cancelRt = recordProviderRuntime({ ...failedRt, serverRetryAtMs: now + 7_200_000 }, {
    kind: "cancelled", startedAtMs: now + 50, finishedAtMs: now + 51, requestedAtMs: now + 50,
  }, { nowMs: now + 51, intervalSeconds: 300 });
  check("cancel 不加退避且保留 Retry-After", cancelRt.consecutiveFailures === failedRt.consecutiveFailures
    && cancelRt.serverRetryAtMs === now + 7_200_000 && cancelRt.localBackoffAtMs === failedRt.localBackoffAtMs);
  const partialRt = recordProviderRuntime({ ...failedRt, serverRetryAtMs: now + 7_200_000, consecutiveFailures: 3 }, {
    kind: "partial", startedAtMs: now + 80, finishedAtMs: now + 81, requestedAtMs: now + 80,
    report: { diagnostics: [{ code: "summary-unavailable", severity: "warning" }] },
  }, { nowMs: now + 81, intervalSeconds: 300 });
  check("partial 只清主失败计数、保留 server Retry-After", partialRt.consecutiveFailures === 0 && partialRt.localBackoffAtMs === undefined
    && partialRt.serverRetryAtMs === now + 7_200_000 && partialRt.lastError?.code === "timeout");
  const successRt = recordProviderRuntime(failedRt, {
    kind: "success", startedAtMs: now + 90, finishedAtMs: now + 91, requestedAtMs: now + 90,
  }, { nowMs: now + 91, intervalSeconds: 300 });
  check("成功清除 lastError、保留历史 lastFailureAtMs", successRt.lastError === undefined && successRt.consecutiveFailures === 0
    && successRt.lastFailureAtMs === failedRt.lastFailureAtMs);

  const sixFailed = ["kimi", "opencode", "codex", "commandcode", "cursor", "droid"];
  const providers = [
    ...sixFailed.map((id) => ({ providerId: id, status: "error", attempt: { state: "failed" } })),
    ...["claude", "copilot", "zai", "openrouter", "antigravity", "devin", "grok", "ollama"].map((id) => ({ providerId: id, status: "disabled", attempt: { state: "deferred", deferredReason: "backoff" } })),
  ];
  const results = new Map([
    ...sixFailed.map((id) => [id, { kind: "failed" }]),
    ...["claude", "copilot", "zai", "openrouter", "antigravity", "devin", "grok", "ollama"].map((id) => [id, { kind: "noop-disabled" }]),
  ]);
  check("六家失败+八家 disabled → failed 而非 deferred", receiptOutcome(providers, null, results) === "failed");

  const entry = { providerId: "kimi", status: "error", attempt: { state: "never" } };
  applyResult(entry, { kind: "deferred", reason: "batch-budget", nextEligibleAtMs: now + 1000 }, { nowMs: now, trigger: { reason: "timer" } });
  check("batch-budget 透传 deferredReason", entry.attempt.deferredReason === "batch-budget");
  applyResult(entry, { kind: "failed", error: { code: "timeout", reasonCode: "timeout", action: "retry-later" }, nextEligibleAtMs: now + 300_000, startedAtMs: now, finishedAtMs: now + 5 }, { nowMs: now + 5, trigger: { reason: "timer" } });
  check("失败 nextEligibleAtMs 写入本批 entry", entry.nextEligibleAtMs === now + 300_000);

  const coordinator = new RefreshCoordinator({ configPath: join(base, "c11b-config.json"), env: { ...process.env, XDG_CACHE_HOME: join(base, "c11b-cache"), XDG_STATE_HOME: join(base, "c11b-state") } });
  const cfgLoaded = {
    config: {
      revision: 1,
      runtime: { refreshIntervalSeconds: 300, maxConcurrency: 3 },
      providers: {
        kimi: {
          enabled: true, dataSource: "auto", allowCommunityEndpoints: true, activeProfile: "synthetic",
          profiles: [{ id: "synthetic", discovery: "only", sources: [{ id: "missing", kind: "env", reader: "kimi-env-key", purpose: "primary", envName: "SYNTHETIC_C11B_ABSENT" }] }],
        },
      },
    },
  };
  const fracDeadline = now + 303703.5;
  const timerBlocked = await coordinator.refreshProvider("kimi", {
    cfgLoaded, runtime: { kimi: { nextEligibleAtMs: fracDeadline } }, auth: {},
    broker: new SecretBroker(), stores: createCredentialStores({ env: process.env }),
    nowMs: now, signal: new AbortController().signal, dirs: coordinator.dirs(), trigger: { reason: "timer" },
  });
  check("timer 对小数 deadline 仍门控", timerBlocked.kind === "deferred" && timerBlocked.reason === "backoff" && timerBlocked.nextEligibleAtMs === now + 303704);
  const manualLocal = await coordinator.refreshProvider("kimi", {
    cfgLoaded, runtime: { kimi: { localBackoffAtMs: now + 3_600_000, nextEligibleAtMs: now + 3_600_000, lastAttemptAtMs: now - 120_000 } },
    auth: {}, broker: new SecretBroker(), stores: createCredentialStores({ env: process.env }),
    nowMs: now, signal: new AbortController().signal, dirs: coordinator.dirs(), trigger: { reason: "manual" },
  });
  check("manual 绕过本地退避", manualLocal.kind !== "deferred");
  const manualServer = await coordinator.refreshProvider("kimi", {
    cfgLoaded, runtime: { kimi: { serverRetryAtMs: now + 7_200_000, lastError: { reasonCode: "http-429" } } },
    auth: {}, broker: new SecretBroker(), stores: createCredentialStores({ env: process.env }),
    nowMs: now, signal: new AbortController().signal, dirs: coordinator.dirs(), trigger: { reason: "manual" },
  });
  check("manual 不绕过 server Retry-After", manualServer.kind === "deferred" && manualServer.reason === "backoff" && manualServer.nextEligibleAtMs === now + 7_200_000);
  const manualClick = await coordinator.refreshProvider("kimi", {
    cfgLoaded, runtime: { kimi: { lastAttemptAtMs: now - 1_000 } },
    auth: {}, broker: new SecretBroker(), stores: createCredentialStores({ env: process.env }),
    nowMs: now, signal: new AbortController().signal, dirs: coordinator.dirs(), trigger: { reason: "manual" },
  });
  check("manual 连点受 30s 最小间隔", manualClick.kind === "deferred" && manualClick.reason === "not-due"
    && manualClick.nextEligibleAtMs === now - 1_000 + MANUAL_MIN_INTERVAL_MS);
  check("local/server deadline 拆分", localDeadlineMs({ localBackoffAtMs: now + 10 }) === now + 10
    && serverDeadlineMs({ serverRetryAtMs: now + 20.2 }) === now + 21);
}

console.log("\n== R5. Keychain 命名约定（IPC freeze rev5）==");
{
  const { subsbarCredentialService, subsbarCredentialAccount } = await import("../core/credentials/stores.mjs");
  check("service 约定格式", subsbarCredentialService("commandcode") === "SubsBar credential commandcode");
  check("account 约定格式", subsbarCredentialAccount("commandcode", "personal") === "commandcode:personal");
  // keychain reader 按约定 service/account 读取（discover 静默；不存在 → missing 不弹框）
  const stores = createCredentialStores({ env: process.env });
  const d = stores.discover("keychain-generic", { service: subsbarCredentialService("synthetic-prov"), account: subsbarCredentialAccount("synthetic-prov", "p") }, { compatibility: { pi: { enabled: false } } });
  if (process.platform === "darwin") {
    check("约定命名的项不存在 → missing（无弹框路径）", d.status === "missing" && d.reasonCode === "not-configured");
  } else {
    check("非 darwin → unsupported（该平台无 Keychain 存储）", d.status === "unsupported" && d.reasonCode === "reader-unavailable");
  }
  // manifest 投影一致性：registry 输出渲染后的具体服务名（模板仅存在于 manifest 源文件）
  const { ProviderRegistry } = await import("../core/providers/registry.mjs");
  const reg = new ProviderRegistry();
  const proj = reg.projectRegistry(null, stores, { compatibility: { pi: { enabled: false } } });
  for (const p of proj.providers) {
    for (const r of p.credentialReaders ?? []) {
      if (r.kind === "keychain" && r.owner === "subsbar") {
        check(`${p.providerId}/${r.id} 输出渲染后具体服务名`, r.credentialService === `SubsBar credential ${p.providerId}`, r.credentialService);
      }
    }
  }
  check("渲染值与 helper 一致", proj.providers.find((p) => p.providerId === "commandcode").credentialReaders.find((r) => r.id === "commandcode-subsbar-key").credentialService === subsbarCredentialService("commandcode"));
}

console.log("\n== S0. broker 生命周期（09 returnedBytesAllZero 回归）==");
{
  const payload = "synthetic-broker-token-0123456789";
  const refLeak = broker.put(new TextEncoder().encode(payload), ["t"]);
  const leaked = await broker.withSecret(refLeak, "t", async (b) => b);
  const returnedBytesAllZero = leaked.length > 0 && [...leaked].every((x) => x === 0);
  check("传出原始引用 → returnedBytesAllZero", returnedBytesAllZero);
  const refOk = broker.put(new TextEncoder().encode(payload), ["t"]);
  const token = await broker.withSecret(refOk, "t", async (b) => new TextDecoder().decode(b));
  check("回调内解码得到原文", token === payload);
}

console.log("\n== S1. 显式 sources 按 reader id/kind 绑定 implementationId ==");
{
  const { bindSourceToManifest } = await import("../core/credentials/resolver.mjs");
  const { ProviderRegistry } = await import("../core/providers/registry.mjs");
  const { validateConfig } = await import("../core/config/schema.mjs");
  const {
    decryptFactoryLogin, FACTORY_KEYCHAIN_ACCOUNT, FACTORY_KEYCHAIN_SERVICE,
  } = await import("../core/credentials/stores.mjs");
  const { createCipheriv, randomBytes } = await import("crypto");
  const { CORE_REASON_CODES } = await import("../core/defs.mjs");

  const reg = new ProviderRegistry();
  const droid = reg.get("droid");
  const stores = createCredentialStores({ env: process.env });

  check("config.reader 与 registry credentialReaders[].id 同名", (() => {
    for (const p of reg.projectRegistry(null, stores, { pi: { enabled: false } }).providers) {
      for (const r of p.credentialReaders ?? []) {
        if (typeof r.id !== "string" || r.id !== r.id.toLowerCase()) return false;
        const m = reg.get(p.providerId);
        const decl = (m.credentialReaders ?? []).find((d) => d.id === r.id);
        if (!decl || decl.kind !== r.kind) return false;
      }
    }
    return true;
  })());
  const factoryDecl = droid.credentialReaders.find((r) => r.id === "factory-login-keychain");
  check("factory config 引用 id 而不是 implementationId", factoryDecl.id === "factory-login-keychain" && factoryDecl.implementationId === "factory-login-composite");

  const bound = bindSourceToManifest(
    { id: "f", kind: "file", reader: "factory-login-keychain", path: join(base, "synthetic.loginkeychain") },
    droid.credentialReaders,
  );
  check("显式 source 无 implementationId → 绑到 factory-login-composite", bound.ok && bound.source.implementationId === "factory-login-composite");
  const miss = bindSourceToManifest({ id: "x", kind: "file", reader: "no-such-reader" }, droid.credentialReaders);
  check("未知 reader → unknown-reader", !miss.ok && miss.reasonCode === "unknown-reader");
  const kindMismatch = bindSourceToManifest({ id: "x", kind: "env", reader: "factory-login-keychain" }, droid.credentialReaders);
  check("id 命中但 kind 不符 → unknown-reader", !kindMismatch.ok);
  check("unknown-reader 已注册", CORE_REASON_CODES.includes("unknown-reader"));

  const rUnknown = await resolveChain("droid", {
    id: "p", discovery: "only",
    sources: [{ id: "x", kind: "file", reader: "not-a-reader" }],
  }, [], { nowMs: 1800000000000, interaction: "background", stores, broker, compatibility: { pi: { enabled: false } }, stateDir: join(base, "state"), credentialReaders: droid.credentialReaders });
  check("resolveChain 未知 reader → invalid-config/unknown-reader", rUnknown.code === "invalid-config" && rUnknown.reasonCode === "unknown-reader");

  const cfgOk = validateConfig({
    schemaVersion: 1,
    providers: {
      droid: {
        enabled: true, activeProfile: "personal",
        profiles: [{
          id: "personal", allowKeychain: true, discovery: "only",
          sources: [{ id: "factory", kind: "file", reader: "factory-login-keychain", path: "/tmp/synthetic.loginkeychain", account: FACTORY_KEYCHAIN_ACCOUNT }],
        }],
      },
    },
  });
  check("file 类允许 account（与 manifest configurable 对齐）", cfgOk.providers.droid.profiles[0].sources[0].account === FACTORY_KEYCHAIN_ACCOUNT);
  let fileAccountRejected = false;
  try {
    validateConfig({
      schemaVersion: 1,
      providers: { kimi: { enabled: true, activeProfile: "p", profiles: [{ id: "p", sources: [{ id: "e", kind: "env", reader: "droid-env-key", account: "nope" }] }] } },
    });
  } catch (e) { fileAccountRejected = /不允许字段 account/.test(e.message); }
  check("env 仍拒绝 account", fileAccountRejected);
  check("Factory 默认 account 对齐 security-cli", FACTORY_KEYCHAIN_ACCOUNT === "auth-encryption-key-security-cli" && FACTORY_KEYCHAIN_SERVICE === "Factory CLI");

  const key = randomBytes(32);
  const iv = randomBytes(12);
  const token = "synthetic-factory-access-token-0123456789";
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify({ access_token: token }), "utf8"), cipher.final()]);
  const raw = `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
  const keyB64 = key.toString("base64");
  const dec = decryptFactoryLogin(raw, keyB64);
  check("合成 fixture 解密得到 token", new TextDecoder().decode(dec.bytes) === token);
  let aeadFail = false;
  try { decryptFactoryLogin(raw, randomBytes(32).toString("base64")); } catch (e) { aeadFail = e.reasonCode === "file-malformed"; }
  check("错误 key → AEAD 失败 file-malformed", aeadFail);

  const fixturePath = join(base, "synthetic.loginkeychain");
  writeFileSync(fixturePath, raw, { mode: 0o600 });
  const rFactory = await resolveChain("droid", {
    id: "p", discovery: "only",
    sources: [{ id: "factory", kind: "file", reader: "factory-login-keychain", path: fixturePath }],
  }, [], {
    nowMs: 1800000000000, interaction: "user-connect", stores, broker,
    compatibility: { pi: { enabled: false } }, stateDir: join(base, "state"),
    credentialReaders: droid.credentialReaders, testAesKeyB64: keyB64,
  });
  const factoryToken = rFactory.status === "resolved"
    ? await broker.withSecret(rFactory.lease.access, "droid", async (b) => new TextDecoder().decode(b))
    : undefined;
  check("显式 factory reader 解密 resolved（不读真实凭证）", rFactory.status === "resolved" && rFactory.lease.source.reader === "factory-login-keychain" && factoryToken === token);

  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const expiredJwt = `h.${b64url({ sub: "synthetic", exp: 1_000_000_000 })}.s`;
  const cipher2 = createCipheriv("aes-256-gcm", key, iv);
  const enc2 = Buffer.concat([cipher2.update(JSON.stringify({ access_token: expiredJwt }), "utf8"), cipher2.final()]);
  const rawExp = `${iv.toString("base64")}:${cipher2.getAuthTag().toString("base64")}:${enc2.toString("base64")}`;
  writeFileSync(fixturePath, rawExp, { mode: 0o600 });
  const rExp = await resolveChain("droid", {
    id: "p", discovery: "only",
    sources: [{ id: "factory", kind: "file", reader: "factory-login-keychain", path: fixturePath }],
  }, [], {
    nowMs: 1_800_000_000_000, interaction: "user-connect", stores, broker,
    compatibility: { pi: { enabled: false } }, stateDir: join(base, "state"),
    credentialReaders: droid.credentialReaders, testAesKeyB64: keyB64,
  });
  check("过期 JWT → expired/credential-expired（映射 reauth-required）", rExp.code === "expired" && rExp.reasonCode === "credential-expired" && rExp.action === "relogin-owner");

  const proj = reg.projectRegistry(null, stores, { pi: { enabled: false } });
  const modes = new Set(["headless-url", "tty", "web-guide"]);
  check("14 家 login.launchMode 三分类齐全", proj.providers.length === 14 && proj.providers.every((p) => modes.has(p.login?.launchMode)));
  check("claude urlPattern 匹配 authorize URL", (() => {
    const pat = proj.providers.find((p) => p.providerId === "claude").login.urlPattern;
    return typeof pat === "string" && new RegExp(pat).test("https://claude.com/cai/oauth/authorize");
  })());
  check("droid launchMode=tty", proj.providers.find((p) => p.providerId === "droid").login.launchMode === "tty");
  check("cursor launchMode=web-guide", proj.providers.find((p) => p.providerId === "cursor").login.launchMode === "web-guide");
}

console.log("\n== S2. Keychain 定位：keychainPath + console user（不依赖 $HOME）==");
{
  const {
    securityFindArgs, defaultLoginKeychainPath, resolveKeychainPath, consoleUserHome,
  } = await import("../core/credentials/stores.mjs");
  const { validateConfig } = await import("../core/config/schema.mjs");
  const disc = securityFindArgs({ service: "SubsBar credential synthetic", account: "synthetic:p", readSecret: false });
  const reso = securityFindArgs({ service: "SubsBar credential synthetic", account: "synthetic:p", readSecret: true });
  check("discover 参数不含 -w（无弹框）", !disc.includes("-w"));
  check("resolve 参数含 -w", reso.includes("-w"));
  const explicit = "/tmp/synthetic-login.keychain-db";
  const withPath = securityFindArgs({ service: "s", account: "a", keychainPath: explicit, readSecret: false });
  check("显式 keychainPath 在末尾", withPath.at(-1) === explicit && !withPath.includes("-w"));
  check("相对 keychainPath 拒绝", resolveKeychainPath("relative.keychain-db") === undefined);
  const fakeHome = join(base, "isolated-home");
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const p = defaultLoginKeychainPath();
    check("隔离 HOME 时默认路径不落在进程 HOME", !p || !p.startsWith(fakeHome));
    if (process.platform === "darwin") {
      const home = consoleUserHome();
      check("console user home 不来自 $HOME", !!home && home !== fakeHome);
      check("默认 login keychain 在 console user 下", !p || (home && p.startsWith(join(home, "Library", "Keychains"))));
    } else {
      check("非 darwin 无 login keychain 默认", p === undefined);
    }
  } finally {
    process.env.HOME = prevHome;
  }
  const cfgKc = validateConfig({
    schemaVersion: 1,
    providers: {
      droid: {
        enabled: true, activeProfile: "personal",
        profiles: [{
          id: "personal", allowKeychain: true, discovery: "only",
          sources: [{
            id: "factory", kind: "file", reader: "factory-login-keychain",
            path: "/tmp/synthetic.loginkeychain",
            keychainPath: "/tmp/synthetic-login.keychain-db",
          }],
        }],
      },
    },
  });
  check("file 类允许 keychainPath", cfgKc.providers.droid.profiles[0].sources[0].keychainPath === "/tmp/synthetic-login.keychain-db");
  const { ProviderRegistry } = await import("../core/providers/registry.mjs");
  const factoryCfg = new ProviderRegistry().get("droid").credentialReaders.find((r) => r.id === "factory-login-keychain");
  check("manifest factory configurable 含 keychainPath", factoryCfg.configurable.includes("keychainPath"));
}

console.log("\n== S3. fetch 错误分类（timeout ≠ http-5xx）==");
{
  const { CORE_REASON_CODES } = await import("../core/defs.mjs");
  const t = fetchErrorToSafe(new Error("timeout"));
  check("timeout 的 reasonCode 不是 http-5xx", t.code === "timeout" && t.reasonCode === "timeout" && t.httpStatus === undefined);
  const whoami = fetchErrorToSafe(new Error("CmdCode whoami timed out"));
  check("描述性 timed out → timeout", whoami.code === "timeout" && whoami.reasonCode === "timeout");
  const refused = fetchErrorToSafe(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" }, transportKind: "connect-refused" }));
  check("connect-refused 可区分", refused.code === "network" && refused.reasonCode === "connect-refused");
  const s503 = fetchErrorToSafe(Object.assign(new Error("CmdCode credits returned 503"), { httpStatus: 503, transportKind: "http-5xx" }));
  check("服务端 5xx 带 httpStatus", s503.code === "network" && s503.reasonCode === "http-5xx" && s503.httpStatus === 503);
  const generic = fetchErrorToSafe(new Error("socket hang up"));
  check("其它网络错误不是 http-5xx", generic.code === "network" && generic.reasonCode === "network");
  const e401 = fetchErrorToSafe(Object.assign(new Error("usage-summary returned 401"), { httpStatus: 401 }));
  check("HTTP 401 → invalid-credential 不抛", e401.code === "invalid-credential" && e401.reasonCode === "http-401" && e401.action === "relogin-owner");
  check("timeout/connect-refused/network 已注册", ["timeout", "connect-refused", "network"].every((c) => CORE_REASON_CODES.includes(c)));
  const { ProviderRegistry } = await import("../core/providers/registry.mjs");
  const cc = new ProviderRegistry().get("commandcode");
  check("commandcode 任务超时宽于 15s 内层 abort", cc.refresh.taskTimeoutSeconds >= 60 && cc.refresh.requestTimeoutSeconds >= 20);
}

console.log("\n== S4. Pi 默认 agentDir（检测连接可发现 ~/.pi/agent）==");
{
  const fakeHome = join(base, "pi-home");
  mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true, mode: 0o700 });
  writeFileSync(join(fakeHome, ".pi", "agent", "auth.json"), "{}\n", { mode: 0o600 });
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const stores = createCredentialStores({ env: { ...process.env, HOME: fakeHome } });
    const skipped = stores.discover("commandcode", { reader: "commandcode" }, { compatibility: { pi: { enabled: false } } });
    check("Pi 开关关闭 → skipped", skipped.status === "skipped");
    const found = stores.discover("commandcode", { reader: "commandcode" }, { compatibility: { pi: { enabled: true } } });
    check("Pi 开关打开且默认目录有 auth.json → resolved", found.status === "resolved");
  } finally {
    process.env.HOME = prevHome;
  }
}

console.log("\n== S5. 菜单栏 menuBarProviders / menuBarLimit 迁移与校验 ==");
{
  const { validateConfig } = await import("../core/config/schema.mjs");
  const { ConfigStore } = await import("../core/config/store.mjs");
  const pin = (providerId) => ({ providerId, profileId: "personal", metricId: "monthly-credits", field: "remaining" });
  const codeOf = (raw) => { try { validateConfig(raw); return null; } catch (e) { return e.code; } };

  const twoPins = validateConfig({
    schemaVersion: 1,
    ui: { menuBarMode: "pinned", pinnedMetrics: [pin("commandcode"), pin("codex")] },
  });
  check("旧 pins → providers 去重保序", JSON.stringify(twoPins.ui.menuBarProviders) === JSON.stringify(["commandcode", "codex"]));
  check("旧 pins → limit=min(pins,4)", twoPins.ui.menuBarLimit === 2);
  check("旧字段写出剥离", twoPins.ui.menuBarMode === undefined && twoPins.ui.pinnedMetrics === undefined);

  const dupPins = validateConfig({
    schemaVersion: 1,
    ui: { menuBarMode: "pinned", pinnedMetrics: [pin("commandcode"), pin("commandcode")] },
  });
  check("同 provider 两 pin → 去重一家", JSON.stringify(dupPins.ui.menuBarProviders) === JSON.stringify(["commandcode"]) && dupPins.ui.menuBarLimit === 2);

  const zeroPins = validateConfig({ schemaVersion: 1, ui: { menuBarMode: "pinned", pinnedMetrics: [] } });
  check("0 pins → [] 且 limit 默认 1", Array.isArray(zeroPins.ui.menuBarProviders) && zeroPins.ui.menuBarProviders.length === 0 && zeroPins.ui.menuBarLimit === 1);

  const fresh = validateConfig({ schemaVersion: 1 });
  check("无旧字段 → null/1", fresh.ui.menuBarProviders === null && fresh.ui.menuBarLimit === 1);

  const auto = validateConfig({ schemaVersion: 1, ui: { menuBarProviders: null } });
  check("显式 null → 自动", auto.ui.menuBarProviders === null && auto.ui.menuBarLimit === 1);

  const none = validateConfig({ schemaVersion: 1, ui: { menuBarProviders: [] } });
  check("[] → 明确无文本", Array.isArray(none.ui.menuBarProviders) && none.ui.menuBarProviders.length === 0 && none.ui.menuBarLimit === 1);

  const explicit = validateConfig({
    schemaVersion: 1,
    ui: { menuBarProviders: ["kimi", "codex"], menuBarLimit: 2, providerOrder: ["codex", "kimi"] },
  });
  check("显式数组按写入顺序保留", JSON.stringify(explicit.ui.menuBarProviders) === JSON.stringify(["kimi", "codex"]) && explicit.ui.menuBarLimit === 2);

  check("数组超限 → invalid-config", codeOf({ schemaVersion: 1, ui: { menuBarProviders: ["codex", "kimi"], menuBarLimit: 1 } }) === "invalid-config");
  check("省略 limit 且数组>1 → invalid-config", codeOf({ schemaVersion: 1, ui: { menuBarProviders: ["codex", "kimi"] } }) === "invalid-config");
  check("limit 超出 0..4 → invalid-config", codeOf({ schemaVersion: 1, ui: { menuBarLimit: 5 } }) === "invalid-config");
  check("重复 id → invalid-config", codeOf({ schemaVersion: 1, ui: { menuBarProviders: ["codex", "codex"], menuBarLimit: 2 } }) === "invalid-config");

  const cfgPath = join(base, "menubar-config.json");
  const store = new ConfigStore(cfgPath);
  store.initDefault({
    schemaVersion: 1,
    ui: { menuBarMode: "pinned", pinnedMetrics: [pin("commandcode"), pin("codex")] },
  });
  const disk = JSON.parse(readFileSync(cfgPath, "utf8"));
  check("落盘无旧字段", disk.ui.menuBarMode === undefined && disk.ui.pinnedMetrics === undefined);
  check("落盘为迁移后新字段", JSON.stringify(disk.ui.menuBarProviders) === JSON.stringify(["commandcode", "codex"]) && disk.ui.menuBarLimit === 2);
}

console.log("\n== C06b. resolveErrorToSafe 封闭；单家 reauth-required 不击落批次 ==");
{
  const {
    CREDENTIAL_ERROR_CODES, SAFE_ERROR_CODES, RESOLVE_TO_ENTRY, ACTION_CODES, CORE_REASON_CODES, PROVIDER_STATUSES,
  } = await import("../core/defs.mjs");
  const { resolveErrorToSafe, applyResult, receiptOutcome, providerStatusForFailure } = await import("../core/runtime/scheduler.mjs");
  const { validateConfig } = await import("../core/config/schema.mjs");

  const closed = [];
  for (const code of CREDENTIAL_ERROR_CODES) {
    let err;
    let thrown = null;
    try { err = resolveErrorToSafe({ status: "failed", code }); }
    catch (e) { thrown = e; }
    const expected = RESOLVE_TO_ENTRY[code]?.code;
    closed.push(!thrown && SAFE_ERROR_CODES.includes(err?.code) && err.code === expected && ACTION_CODES.includes(err.action));
  }
  check("全部 CREDENTIAL_ERROR_CODES 映射不抛且 SafeError.code∈白名单", closed.length === CREDENTIAL_ERROR_CODES.length && closed.every(Boolean), closed.map((v, i) => v ? "" : CREDENTIAL_ERROR_CODES[i]).filter(Boolean).join(","));

  const reasonClosed = [];
  for (const reasonCode of CORE_REASON_CODES) {
    let err;
    let thrown = null;
    try { err = resolveErrorToSafe({ status: "failed", code: "expired", reasonCode, action: "relogin-owner" }); }
    catch (e) { thrown = e; }
    reasonClosed.push(!thrown && err?.code === "credential-expired" && err.reasonCode === reasonCode);
  }
  check("全部 CORE_REASON_CODES 作 reason 透传不抛", reasonClosed.length === CORE_REASON_CODES.length && reasonClosed.every(Boolean));

  let unknownThrown = false;
  let unknownErr;
  try { unknownErr = resolveErrorToSafe({ code: "reauth-required" }); }
  catch { unknownThrown = true; }
  check("未知/status 码回退 io-error 不抛", !unknownThrown && unknownErr.code === "io-error" && unknownErr.action === "retry-later");

  const expired = resolveErrorToSafe({ code: "expired", reasonCode: "credential-expired", action: "relogin-owner" });
  check("expired → error.code=credential-expired（不是 reauth-required）", expired.code === "credential-expired" && expired.action === "relogin-owner");
  check("expired → provider status=reauth-required", providerStatusForFailure(expired) === "reauth-required" && PROVIDER_STATUSES.includes("reauth-required"));
  const invalid = resolveErrorToSafe({ code: "invalid" });
  const interact = resolveErrorToSafe({ code: "interaction-required" });
  check("invalid/interaction-required 同映 reauth-required status", providerStatusForFailure(invalid) === "reauth-required" && providerStatusForFailure(interact) === "reauth-required");

  const fetch401 = fetchErrorToSafe(Object.assign(new Error("returned 401"), { httpStatus: 401 }));
  check("fetch 401 SafeError.code 合法", SAFE_ERROR_CODES.includes(fetch401.code) && fetch401.code === "invalid-credential" && providerStatusForFailure(fetch401) === "reauth-required");
  const fetch403 = fetchErrorToSafe(Object.assign(new Error("returned 403"), { httpStatus: 403 }));
  const fetch429 = fetchErrorToSafe(Object.assign(new Error("returned 429"), { httpStatus: 429 }));
  check("fetch 403/429 不抛", fetch403.code === "permission-denied" && fetch429.code === "rate-limited");

  const reauthEntry = { providerId: "droid", status: "ok" };
  applyResult(reauthEntry, {
    kind: "failed", error: expired, retainLastGood: true, profileId: "synthetic",
    startedAtMs: 1_800_000_000_000, finishedAtMs: 1_800_000_000_010,
  }, { nowMs: 1_800_000_000_010, trigger: { reason: "manual" } });
  check("无 last-good 时 status=reauth-required + relogin-owner", reauthEntry.status === "reauth-required" && reauthEntry.error?.action === "relogin-owner" && reauthEntry.error?.code === "credential-expired");

  const lastGoodEntry = {
    providerId: "droid", status: "ok", report: { windows: [{ id: "w" }] }, freshness: "fresh", dataDisposition: "current",
  };
  applyResult(lastGoodEntry, {
    kind: "failed", error: expired, retainLastGood: true, profileId: "synthetic",
  }, { nowMs: 1_800_000_000_010, trigger: { reason: "timer" } });
  check("有 last-good 仍盖 status=reauth-required 并保留 report", lastGoodEntry.status === "reauth-required" && lastGoodEntry.dataDisposition === "last-good" && lastGoodEntry.report?.windows?.length === 1);

  const six = ["kimi", "opencode", "codex", "commandcode", "cursor", "droid"];
  const providersCfg = {};
  for (const id of six) {
    providersCfg[id] = {
      enabled: true, dataSource: "auto", allowCommunityEndpoints: true, activeProfile: "synthetic",
      profiles: [{ id: "synthetic", discovery: "auto", sources: [] }],
    };
  }
  const cfg = validateConfig({ schemaVersion: 1, runtime: { maxConcurrency: 6, refreshIntervalSeconds: 300 }, providers: providersCfg });
  const cfgPath = join(base, "c06b-config.json");
  mkdirSync(join(base, "c06b-cache"), { recursive: true, mode: 0o700 });
  mkdirSync(join(base, "c06b-state"), { recursive: true, mode: 0o700 });
  writeFileSync(cfgPath, JSON.stringify(cfg), { mode: 0o600 });
  const isolatedEnv = { ...process.env, XDG_CACHE_HOME: join(base, "c06b-cache"), XDG_STATE_HOME: join(base, "c06b-state") };
  const okReport = {
    name: "synthetic", capturedAtMs: 1_800_000_000_000, observationBasis: "remote-response",
    windows: [{
      id: "monthly-credits", ruleId: "monthly-credits", label: "monthly", kind: "quota", state: "known",
      unit: "percent", used: 0, limit: 100, scope: "subscription", provenance: "reported",
      sourceEndpointIds: [], quotaState: "within-limit", derivations: [],
      period: { kind: "unknown", resetState: "unknown" }, diagnostics: [],
    }],
    metrics: [], primaryMetricId: "monthly-credits", diagnostics: [],
  };
  const coordinator = new RefreshCoordinator({ configPath: cfgPath, env: isolatedEnv });
  coordinator.refreshProvider = async (id) => {
    if (id === "droid") {
      return {
        kind: "failed",
        error: resolveErrorToSafe({ code: "expired", reasonCode: "credential-expired", action: "relogin-owner" }),
        retainLastGood: true, profileId: "synthetic",
        startedAtMs: Date.now(), finishedAtMs: Date.now(), requestedAtMs: Date.now(),
      };
    }
    return {
      kind: "success", report: okReport, profileId: "synthetic",
      dataSourceId: `${id}-alpha`, credentialSourceId: "synthetic", reader: "env-generic",
      identityAssurance: "verified",
      startedAtMs: Date.now(), finishedAtMs: Date.now(), requestedAtMs: Date.now(),
    };
  };
  let envelope;
  let batchThrown = null;
  try { envelope = await coordinator.refresh({ reason: "manual", interaction: "user-connect" }); }
  catch (e) { batchThrown = e; }
  const droid = envelope?.providers?.find((p) => p.providerId === "droid");
  const others = six.filter((id) => id !== "droid").map((id) => envelope?.providers?.find((p) => p.providerId === id));
  check("六启用+一 expired 不抛出批次", batchThrown === null && envelope?.kind === "usage");
  check("droid status=reauth-required 且 action=relogin-owner", droid?.status === "reauth-required" && droid?.error?.code === "credential-expired" && droid?.error?.action === "relogin-owner");
  check("其余五家 ok 收据", others.length === 5 && others.every((p) => p?.status === "ok" && p?.attempt?.state === "succeeded"));
  check("request.outcome=partial", envelope?.request?.outcome === "partial");
  const kinds = new Map(six.map((id) => {
    const p = envelope.providers.find((x) => x.providerId === id);
    return [id, p.status === "ok" ? { kind: "success" } : { kind: "failed" }];
  }));
  check("receiptOutcome(六家) = partial", receiptOutcome(envelope.providers, null, kinds) === "partial");

  const throwCoord = new RefreshCoordinator({ configPath: cfgPath, env: isolatedEnv });
  throwCoord.refreshProvider = async (id) => {
    if (id === "droid") throw new Error("unsafe error code reauth-required");
    return {
      kind: "success", report: okReport, profileId: "synthetic",
      dataSourceId: `${id}-alpha`, credentialSourceId: "synthetic", reader: "env-generic",
      identityAssurance: "verified",
      startedAtMs: Date.now(), finishedAtMs: Date.now(), requestedAtMs: Date.now(),
    };
  };
  let thrownEnv;
  let thrownErr = null;
  try { thrownEnv = await throwCoord.refresh({ reason: "manual", interaction: "user-connect" }); }
  catch (e) { thrownErr = e; }
  const thrownDroid = thrownEnv?.providers?.find((p) => p.providerId === "droid");
  check("worker 捕获 unsafe throw 仍返回 usage envelope", thrownErr === null && thrownEnv?.kind === "usage" && thrownEnv?.request?.outcome === "partial");
  check("抛出的一家收敛为 failed/io-error，不污染其余", thrownDroid?.status === "error" && thrownDroid?.error?.code === "io-error" && six.filter((id) => id !== "droid").every((id) => thrownEnv.providers.find((p) => p.providerId === id)?.status === "ok"));
}

console.log("\n== C19. 严格 JSON ==");
{
  check("重复键拒绝", (() => { try { parseStrictJson('{"a":1,"a":2}'); return false; } catch (e) { return e.reasonCode === "duplicate-key"; } })());
  check("深度超限拒绝", (() => { try { parseStrictJson("[".repeat(40) + "]".repeat(40)); return false; } catch (e) { return e.reasonCode === "file-malformed"; } })());
  check("尾随内容拒绝", (() => { try { parseStrictJson("{} x"); return false; } catch { return true; } })());
  check("合法嵌套通过", (() => { try { return parseStrictJson('{"a":[1,{"b":null}]}').a[1].b === null; } catch { return false; } })());
}

rmSync(base, { recursive: true, force: true });
console.log(`\n== 总结 ==\n通过 ${ok} / 失败 ${fail}`);
if (failures.length > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
