// Provider registry：加载并校验 14 家 manifest，绑定 reader 实现/适配器，
// 为 CLI registry 命令投影安全元信息（IPC freeze rev2 §2.1）。
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { diagnostic } from "../defs.mjs";
import { bindSourceToManifest } from "../credentials/resolver.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_DIR = join(here, "manifests");

// reader implementationId → credentials/stores.mjs 实现（已实现清单）
export const IMPLEMENTED_READERS = new Set([
  "env-generic", "json-file-generic", "keychain-generic", "pi-generic", "cli-generic",
  "cursor-state-db", "factory-login-composite", "browser-generic", "localapi-generic",
  "ollama-signing-key",
  // 专属 keychain/file 实现名：与 stores.mjs 的 keychain-generic/json-file-generic 复用
  "codex-auth-file", "opencode-auth-file", "grok-auth-file", "devin-toml",
  "codex-subsbar-key", "opencode-subsbar-key", "kimi-subsbar-key", "commandcode-subsbar-key",
  "droid-subsbar-key", "zai-subsbar-key", "openrouter-subsbar-key", "grok-subsbar-key",
  "devin-subsbar-session", "zai-env-key", "kimi-env-key", "commandcode-env-key",
  "droid-env-key", "openrouter-env-key", "codex-env-token",
  "openai-codex", "opencode-go", "kimi-coding", "commandcode", "openrouter", "zai",
]);

// 已实现六家的数据适配器（v0 引擎桥接）；其余 8 家 M1 标 not-implemented（unsupported）
export const IMPLEMENTED_ADAPTERS = new Set(["codex", "opencode", "kimi", "commandcode", "droid", "cursor", "claude", "copilot", "zai", "openrouter", "antigravity", "devin", "grok", "ollama"]);

function validateManifest(m, file) {
  const errs = [];
  const push = (s) => errs.push(`${file}: ${s}`);
  if (m.schemaVersion !== 1) push("schemaVersion != 1");
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(m.id ?? "")) push("非法 id");
  for (const k of ["name", "product"]) {
    if (typeof m[k] !== "string" || !m[k] || m[k].length > 80) push(`${k} 非法`);
  }
  if (!["planned", "experimental", "supported", "blocked"].includes(m.releaseStatus)) push("releaseStatus 非法");
  if (!Array.isArray(m.platforms) || !m.platforms.includes("darwin")) push("platforms");
  if (!Array.isArray(m.credentialReaders) || m.credentialReaders.length === 0 || m.credentialReaders.length > 64) push("credentialReaders");
  const readerIds = new Set();
  for (const r of m.credentialReaders ?? []) {
    if (!r.id || readerIds.has(r.id)) push(`reader id 重复/缺失 ${r.id}`);
    readerIds.add(r.id);
    if (!["env", "file", "keychain", "cli", "pi", "browser", "local-api"].includes(r.kind)) push(`reader ${r.id} kind 非法`);
    if (!["owner-cli", "subsbar-store", "none"].includes(r.renewMode)) push(`reader ${r.id} renewMode 非法`);
  }
  const endpointIds = new Set();
  for (const e of m.endpoints ?? []) {
    if (!e.id || endpointIds.has(e.id)) push(`endpoint id 重复 ${e.id}`);
    endpointIds.add(e.id);
    if (e.transport === "https") {
      if (!e.origin && !e.regionOrigins) push(`endpoint ${e.id}: https 缺 origin`);
      if (e.origin && !/^https:\/\//.test(e.origin)) push(`endpoint ${e.id}: origin 必须 https`);
      if (!e.method || !e.pathTemplate) push(`endpoint ${e.id}: 缺 method/pathTemplate`);
    } else if (e.transport === "cli" && !e.commandId) {
      push(`endpoint ${e.id}: cli 缺 commandId`);
    }
  }
  for (const s of m.dataSources ?? []) {
    for (const eid of s.endpointIds ?? []) if (!endpointIds.has(eid)) push(`source ${s.id} 引用未知 endpoint ${eid}`);
    for (const rid of s.credentialChain ?? []) if (!readerIds.has(rid)) push(`source ${s.id} 引用未知 reader ${rid}`);
    if (!["approved", "pending", "blocked"].includes(s.admission)) push(`source ${s.id} admission 非法`);
    if (s.minimumIntervalSeconds !== undefined && s.minimumIntervalSeconds < 300 && s.kind === "community-api") {
      push(`source ${s.id}: 社区远程下限 300s`);
    }
  }
  const ruleIds = new Set();
  for (const r of m.metricRules ?? []) {
    if (!r.id || ruleIds.has(r.id)) push(`rule id 重复 ${r.id}`);
    ruleIds.add(r.id);
    if (r.unit === "currency" && !r.currency && !r.currencyFromPayload) push(`rule ${r.id}: currency 缺声明`);
    if (r.kind === "quota" && r.unit === "none") push(`rule ${r.id}: quota 不得 unit=none`);
    if (r.kind === "status" && r.unit !== "none") push(`rule ${r.id}: status 必须 unit=none`);
  }
  for (const p of m.primaryPreference ?? []) if (!ruleIds.has(p)) push(`primaryPreference 未知规则 ${p}`);
  if (errs.length > 0) throw new Error(errs.join("; "));
  return m;
}

export class ProviderRegistry {
  constructor() {
    /** @type {Map<string, manifest>} */
    this.manifests = new Map();
    this.loadErrors = [];
    this.load();
  }

  load(dir = MANIFEST_DIR) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const m = validateManifest(raw, f);
        this.manifests.set(m.id, m);
      } catch (e) {
        this.loadErrors.push(e.message);
      }
    }
  }

  get(id) { return this.manifests.get(id); }
  get order() { return [...this.manifests.keys()]; }
  get size() { return this.manifests.size; }

  /** 数据源选择（§3.2）：完整 source ID 优先，其次 kind；取首个已准入且平台匹配。 */
  selectDataSource(manifest, dataSource, { allowCommunity }) {
    const sources = manifest.dataSources ?? [];
    if (dataSource && dataSource !== "auto") {
      const byId = sources.find((s) => s.id === dataSource);
      if (byId) return byId;
      const byKind = sources.find((s) => s.kind === dataSource);
      if (byKind) return byKind;
      return undefined; // 显式指定不可退回不同 kind → unsupported
    }
    return sources.find((s) => {
      if (s.admission !== "approved") return false;
      if (s.kind === "community-api" && !allowCommunity) return false;
      return true;
    }) ?? sources.find((s) => s.kind !== "community-api" && s.admission === "approved");
  }

  /** reader/adapter 实现判定。 */
  readerImplemented(r) { return IMPLEMENTED_READERS.has(r.implementationId); }
  adapterImplemented(providerId) { return IMPLEMENTED_ADAPTERS.has(providerId); }

  /**
   * CLI registry 投影（IPC freeze rev2 §2/§2.1/§2.2）。
   * cfg: 当前规范化 config（可为 null=空 HOME）；discover 沿用 stores 的安全检查。
   */
  projectRegistry(cfg, stores, compatibility) {
    const providers = [];
    for (const id of this.order) {
      const m = this.manifests.get(id);
      const pcfg = cfg?.providers?.[id];
      const entry = {
        providerId: id,
        name: m.name,
        product: m.product,
        grade: m.dataSources?.[0]?.grade ?? "D",
        releaseStatus: m.releaseStatus,
        admission: m.dataSources?.some((s) => s.admission === "approved") ? "approved" : (m.dataSources?.[0]?.admission ?? "pending"),
        supported: this.adapterImplemented(id) && (m.dataSources ?? []).some((s) => s.admission === "approved"),
        capabilities: [...new Set((m.dataSources ?? []).flatMap((s) => s.capabilities))],
        minimumRefreshIntervalSeconds: m.refresh.minimumIntervalSeconds,
        defaultRefreshIntervalSeconds: m.refresh.defaultIntervalSeconds,
        credentialReaders: (m.credentialReaders ?? []).map((r) => {
          const implemented = this.readerImplemented(r);
          const out = {
            id: r.id, kind: r.kind, credentialKinds: r.credentialKinds,
            implementationId: r.implementationId, configurable: r.configurable,
            requires: r.requires, purposes: r.purposes, owner: r.owner, renewMode: r.renewMode,
            implemented,
            expiryCapability: expiryCapabilityOf(r),
          };
          if (r.credentialService) {
            // 模板渲染职责归 Node（rev5）：manifest 源文件含 <providerId> 占位符，
            // registry 输出渲染后的具体服务名；Swift 永不做模板替换。
            out.credentialService = r.credentialService.replaceAll("<providerId>", id);
          }
          if (!implemented) out.unsupportedReason = "reader-unavailable";
          return out;
        }),
        login: m.login ?? undefined,
        dataSources: (m.dataSources ?? []).map((s) => ({
          id: s.id, kind: s.kind, grade: s.grade, admission: s.admission,
          endpointIds: s.endpointIds, capabilities: s.capabilities,
          coverageMetricRules: s.coverageMetricRules, coverageMatch: s.coverageMatch,
        })),
        configured: !!pcfg,
        enabled: !!pcfg?.enabled,
        profiles: [],
      };
      if (pcfg) {
        entry.profiles = (pcfg.profiles ?? []).map((p) => ({
          profileId: p.id,
          label: p.label ?? null,
          active: p.id === pcfg.activeProfile,
          region: p.region ?? null,
          discovery: p.discovery,
          allowKeychain: !!p.allowKeychain,
          allowBrowser: !!p.allowBrowser,
          allowLocalApi: !!p.allowLocalApi,
          sources: (p.sources ?? []).map((s) => {
            const bound = bindSourceToManifest(s, m.credentialReaders);
            if (!bound.ok) {
              return {
                id: s.id, kind: s.kind, reader: s.reader, purpose: s.purpose ?? "primary",
                originOfChoice: "explicit",
                availability: "unsupported",
                credentialExpiry: keychainMetaExpiry(s),
                unsupportedReason: "unknown-reader",
              };
            }
            const d = stores.discover(bound.source.implementationId, bound.source, { compatibility });
            const out = {
              id: s.id, kind: s.kind, reader: s.reader, purpose: s.purpose ?? "primary",
              originOfChoice: "explicit",
              availability: d.status === "resolved" ? "resolved" : d.status,
              credentialExpiry: keychainMetaExpiry(s),
            };
            if (d.status === "unsupported") out.unsupportedReason = d.reasonCode ?? "reader-unavailable";
            else out.unsupportedReason = null;
            return out;
          }),
        }));
      }
      providers.push(entry);
    }
    return { providers, diagnostics: this.loadErrors.map((e) => diagnostic("reader-unavailable", "warning")) };
  }
}

function expiryCapabilityOf(r) {
  // 冻结表（IPC freeze §3）：discover 恒 unknown（subsbar 元数据除外）
  const discover = r.owner === "subsbar" && r.kind === "keychain" ? "unknown-or-owner-metadata" : "unknown";
  let resolve = "unknown";
  if (["codex-auth-file", "openai-codex", "cursor-state-db", "grok-auth-file", "factory-login-composite"].includes(r.implementationId)) {
    resolve = "jwt-claim-if-decodable";
  } else if (r.owner === "subsbar" && r.kind === "keychain") {
    resolve = "unknown-or-owner-metadata";
  }
  return { discover, resolve };
}

function keychainMetaExpiry(spec) {
  // v1 冻结：discover 阶段 expiry 一律 unknown；仅 subsbar 自有项的相邻元数据可升格（本实现未写入元数据 → unknown）
  void spec;
  return { state: "unknown" };
}
