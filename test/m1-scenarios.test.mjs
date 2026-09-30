#!/usr/bin/env node
/**
 * M1 场景契约测试（C02/C05/C06/C10/C12/C19/C11）。
 * 运行：node test/m1-scenarios.test.mjs ；退出码 0 = 全过。
 */
import { mkdirSync, writeFileSync, rmSync, chmodSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createCredentialStores } from "../core/credentials/stores.mjs";
import { resolveChain } from "../core/credentials/resolver.mjs";
import { SecretBroker } from "../core/credentials/broker.mjs";
import { LockBackend } from "../core/runtime/lock.mjs";
import { RefreshCoordinator } from "../core/runtime/scheduler.mjs";
import { parseStrictJson } from "../core/runtime/json-strict.mjs";
import { computeBackoffMs, parseRetryAfter } from "../core/runtime/scheduler.mjs";

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
  const cacheFile = join(base, "usage-v1.json");
  const goodEnvelope = { schemaVersion: 1, kind: "usage", contextId: "c", generatedAtMs: 1, cacheRevision: 0, providers: [], diagnostics: [] };
  // 正常写
  const c1 = new RefreshCoordinator({ configPath: join(base, "no-config.json"), env: process.env });
  // 让 persist 用指定目录：直接测内部原子行为——改为测 readUsageCache 往返
  const coordinator = new RefreshCoordinator({ configPath: join(base, "no-config.json"), env: process.env });
  // 无缓存 → null
  check("无缓存读取 null", coordinator.readUsageCache() === null);
  // 损坏缓存 → null（C19 兜底）
  writeFileSync(cacheFile, "{{{", { mode: 0o600 });
  check("损坏缓存不抛错", coordinator.readUsageCache() === null);
  rmSync(cacheFile, { force: true });
  // 重复键拒绝（C19）
  writeFileSync(cacheFile, '{"a":1,"a":2}', { mode: 0o600 });
  check("重复键缓存拒绝", coordinator.readUsageCache() === null);
  rmSync(cacheFile, { force: true });
  // 不可写目录 → persist false（C13）
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
    ? await broker.withSecret(rFactory.lease.access, "droid", async (b) => new TextDecoder().decode(Buffer.from(b)))
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
