// CredentialResolver：manifest credentialChain 驱动的链式解析（contracts §2.1/§2.2/§2.3）。
// 显式 sources 覆盖整条链；缺失可试下一项；invalid/过期/权限停；链尽 not-configured。
import { RESOLVE_TO_ACTION } from "../defs.mjs";
import { ReaderOutcome } from "./stores.mjs";
import { credentialRevision } from "./broker.mjs";

let saltCache = null;
function localSalt(stateDir) {
  // 本地随机盐：0600 私有 state；用于 credentialRevision HMAC（§2.3）。不可导出、不作日志。
  if (saltCache?.stateDir === stateDir) return saltCache.hex;
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = requireFs();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const f = `${stateDir}/credential-salt.hex`;
  if (existsSync(f)) { saltCache = { stateDir, hex: readFileSync(f, "utf8").trim() }; return saltCache.hex; }
  const hex = randomHex32();
  writeFileSync(f, hex + "\n", { mode: 0o600 });
  saltCache = { stateDir, hex };
  return hex;
}
function randomHex32() {
  const { randomBytes } = requireCrypto();
  return randomBytes(32).toString("hex");
}
function requireFs() { return { existsSync: globalThis.__m1fs.existsSync, mkdirSync: globalThis.__m1fs.mkdirSync, readFileSync: globalThis.__m1fs.readFileSync, writeFileSync: globalThis.__m1fs.writeFileSync }; }
function requireCrypto() { return { randomBytes: globalThis.__m1crypto.randomBytes }; }
export function _injectFsCrypto(fs, crypto) { globalThis.__m1fs = fs; globalThis.__m1crypto = crypto; }
import { existsSync as _e, mkdirSync as _m, readFileSync as _r, writeFileSync as _w } from "fs";
import { randomBytes as _rb } from "crypto";
_injectFsCrypto({ existsSync: _e, mkdirSync: _m, readFileSync: _r, writeFileSync: _w }, { randomBytes: _rb });

/**
 * 显式 SourceSpec 不含 implementationId（config schema 不允许该字段）。
 * 按 reader id + kind 匹配 manifest.credentialReaders，取 implementationId。
 * 匹配不到 → unknown-reader。测试/发现链已带 implementationId 且未给 readers 时原样通过。
 */
export function bindSourceToManifest(source, credentialReaders) {
  if (!source || typeof source !== "object" || typeof source.reader !== "string" || !source.reader) {
    return { ok: false, reasonCode: "unknown-reader" };
  }
  const readers = Array.isArray(credentialReaders) ? credentialReaders : [];
  if (readers.length > 0) {
    const decl = readers.find((r) => r.id === source.reader && r.kind === source.kind);
    if (!decl) return { ok: false, reasonCode: "unknown-reader", source };
    return {
      ok: true,
      source: {
        ...source,
        implementationId: decl.implementationId,
        owner: source.owner ?? decl.owner,
        renewMode: source.renewMode ?? decl.renewMode,
        credentialKind: source.credentialKind ?? decl.credentialKinds?.[0],
      },
    };
  }
  if (typeof source.implementationId === "string" && source.implementationId) {
    return { ok: true, source };
  }
  return { ok: false, reasonCode: "unknown-reader", source };
}

function unknownReaderResult(source) {
  const trace = [{ sourceId: source?.id, reader: source?.reader, outcome: "rejected", reasonCode: "unknown-reader" }];
  return { status: "failed", code: "invalid-config", reasonCode: "unknown-reader", action: actionFor("invalid-config"), trace };
}

/** Private salted artifact identity. Never exported in usage or diagnostics. */
export function probeCredentialArtifact(providerId, profile, source, ctx) {
  const bound = bindSourceToManifest(source, ctx.credentialReaders);
  if (!bound.ok || !ctx.stores.artifactVersion) return undefined;
  const salt = localSalt(ctx.stateDir);
  const binding = credentialRevision(Buffer.from(JSON.stringify([providerId, profile.id, bound.source, ctx.compatibility])), salt);
  if (ctx.artifactBinding && ctx.artifactBinding !== binding) return undefined;
  const version = ctx.stores.artifactVersion(bound.source.implementationId, bound.source, ctx,
    bytes => credentialRevision(bytes, salt));
  return version ? { binding, version } : undefined;
}

/**
 * 解析一条来源 spec。返回 ResolveResult（contracts §2.2 形状）。
 * @param providerId manifest id
 * @param profile EffectiveProfile（已校验合并）
 * @param source {id, kind, reader, purpose, ...kindFields, implementationId?}
 * @param ctx {nowMs, signal, interaction, stores, broker, compatibility, stateDir, credentialReaders?}
 */
export async function resolveSource(providerId, profile, source, ctx) {
  const bound = bindSourceToManifest(source, ctx.credentialReaders);
  if (!bound.ok) return unknownReaderResult(source);
  source = bound.source;
  const trace = [];
  const store = ctx.stores;
  // discover：安全元信息（不读正文）
  const region = ctx.region ?? profile.region;
  const d = store.discover(source.implementationId, source, {
    compatibility: ctx.compatibility, interaction: ctx.interaction, testAesKeyB64: ctx.testAesKeyB64,
    region, allowLocalApi: ctx.allowLocalApi, allowBrowser: ctx.allowBrowser,
  });
  trace.push({ sourceId: source.id, reader: source.reader, outcome: d.status, reasonCode: d.reasonCode });
  if (d.status === "missing" || d.status === "skipped") {
    return { status: "failed", code: "not-configured", reasonCode: d.reasonCode ?? "not-configured", action: actionFor("not-configured"), trace };
  }
  if (d.status === "locked") {
    const code = ctx.interaction === "user-connect" ? "interaction-required" : "permission-denied";
    return { status: "failed", code, reasonCode: "keychain-denied", action: actionFor(code), trace };
  }
  if (d.status === "unsupported") {
    return { status: "failed", code: "unsupported", reasonCode: d.reasonCode ?? "reader-unavailable", action: actionFor("unsupported"), trace };
  }

  // resolve：执行读取（仍不输出正文）
  const artifactBefore = probeCredentialArtifact(providerId, profile, source, ctx);
  let resolved;
  try {
    resolved = store.resolve(source.implementationId, source, {
      compatibility: ctx.compatibility, interaction: ctx.interaction, testAesKeyB64: ctx.testAesKeyB64,
      region, allowLocalApi: ctx.allowLocalApi, allowBrowser: ctx.allowBrowser,
    });
  } catch (e) {
    if (e instanceof ReaderOutcome) {
      const code = outcomeToCode(e);
      trace.push({ sourceId: source.id, reader: source.reader, outcome: e.status, reasonCode: e.reasonCode });
      return { status: "failed", code, reasonCode: e.reasonCode, action: actionFor(code), trace };
    }
    trace.push({ sourceId: source.id, reader: source.reader, outcome: "rejected", reasonCode: "io-error" });
    return { status: "failed", code: "io-error", reasonCode: "io-error", action: actionFor("io-error"), trace };
  }
  trace.push({ sourceId: source.id, reader: source.reader, outcome: "resolved" });

  // 到期检查（§2.3）：已知过期 → expired，停止
  const expiry = resolved.expiry ?? { state: "unknown" };
  if (expiry.state === "known" && expiry.expiresAtMs <= ctx.nowMs) {
    const after = probeCredentialArtifact(providerId, profile, source, ctx);
    const artifact = after?.version === artifactBefore?.version ? artifactBefore : undefined;
    resolved.bytes?.fill(0);
    return { status: "failed", code: "expired", reasonCode: "credential-expired", action: "relogin-owner", trace, artifact };
  }

  // identity：无可验证身份 → source-bound scope（scope 随凭证内容+账户绑定变化）
  const accountId = typeof resolved.accountId === "string" && resolved.accountId.trim()
    ? resolved.accountId.trim() : undefined;
  const salt = localSalt(ctx.stateDir);
  const revision = credentialRevision(revisionInput(resolved.bytes, accountId), salt);
  const scopeKey = `scope-${providerId}-${profile.id}-${revision.slice(0, 16)}`;
  const identity = {
    scopeKey,
    assurance: "source-bound",
    accountKey: accountId ? hashedAccountKey(accountId, salt) : undefined,
  };

  const access = ctx.broker.put(resolved.bytes, [providerId]);
  const lease = {
    providerId,
    profileId: profile.id,
    purpose: source.purpose ?? "primary",
    source: {
      id: source.id, kind: source.kind, reader: source.reader, purpose: source.purpose ?? "primary",
      originOfChoice: source.originOfChoice ?? "discovered",
      ...(resolved.executablePath ? { executablePath: resolved.executablePath } : {}),
      ...(accountId ? { accountId } : {}),
    },
    identity,
    kind: source.credentialKind ?? "api-key",
    access,
    owner: source.owner ?? "external",
    renewMode: source.renewMode ?? "none",
    expiry,
    acquiredAtMs: ctx.nowMs,
    credentialRevision: revision,
    capabilityId: resolved.capabilityId,
  };
  return { status: "resolved", lease, trace };
}

function outcomeToCode(e) {
  switch (e.status) {
    case "missing": return "not-configured";
    case "rejected":
      if (e.reasonCode === "keychain-denied") return "permission-denied";
      if (e.reasonCode === "credential-expired") return "expired";
      return "invalid";
    case "skipped": return "not-configured";
    case "unsupported": return "unsupported";
    default: return "io-error";
  }
}

function actionFor(code) { return RESOLVE_TO_ACTION[code] ?? "none"; }

/** 账户绑定进入 revision：同 token 换账户也换 scope，缓存不混用。 */
function revisionInput(bytes, accountId) {
  if (!accountId) return bytes;
  const suffix = new TextEncoder().encode(`\0acct:${accountId}`);
  const out = new Uint8Array(bytes.length + suffix.length);
  out.set(bytes);
  out.set(suffix, bytes.length);
  return out;
}

/** envelope 只允许哈希 accountKey，不得落明文 accountId。 */
function hashedAccountKey(accountId, salt) {
  return `acct-${credentialRevision(new TextEncoder().encode(`acct:${accountId}`), salt).slice(0, 16)}`;
}

/**
 * 链式解析：按 profile.sources 显式链（非空）或 manifest 内置链执行 §2.1 规则。
 * chain: [{id, kind, reader, implementationId, purpose, ...}]
 */
export async function resolveChain(providerId, profile, chain, ctx) {
  const trace = [];
  if (profile.discovery === "only" && (!profile.sources || profile.sources.length === 0)) {
    return { status: "failed", code: "invalid-config", reasonCode: "invalid-config", action: "configure-source", trace };
  }
  const sources = (profile.sources && profile.sources.length > 0)
    ? profile.sources // 显式覆盖：不追加默认链
    : chain;
  let lastFailure = null;
  for (const source of sources) {
    const r = await resolveSource(providerId, profile, source, ctx);
    trace.push(...r.trace);
    if (r.status === "resolved") return { status: "resolved", lease: r.lease, trace };
    lastFailure = r;
    // 缺失/不适用可继续；invalid/过期/权限/身份不符停止（§2.1）
    if (r.code !== "not-configured") return { status: "failed", code: r.code, reasonCode: r.reasonCode, action: r.action, trace, artifact: r.artifact };
  }
  return lastFailure ?? { status: "failed", code: "not-configured", reasonCode: "not-configured", action: "configure-source", trace };
}
