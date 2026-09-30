#!/usr/bin/env node
/**
 * SubsBar M1 CLI（contracts §6.6 + IPC freeze）。
 * 命令：usage / refresh / config {validate,read,effective,set} / registry / golden
 * stdout 严格一个 JSON 对象 + 换行；stderr 仅固定结构诊断；退出码 0/2/3/4。
 * SIGTERM/SIGINT → 取消整批 → 输出 request.outcome=cancelled → exit 3（≤500ms 宽限）。
 */
import { writeFileSync } from "fs";
import { resolveConfigPath, resolveStateDirs } from "./config/paths.mjs";
import { ConfigStore } from "./config/store.mjs";
import { validateConfig, applyMergePatch, patchAllowedPath } from "./config/schema.mjs";
import { ProviderRegistry } from "./providers/registry.mjs";
import { createCredentialStores } from "./credentials/stores.mjs";
import { RefreshCoordinator } from "./runtime/scheduler.mjs";
import { freshnessOf } from "./runtime/report.mjs";
import { safeError } from "./defs.mjs";
import { runGoldenVectors } from "./golden.mjs";
import { readFileSync } from "fs";

const REGISTRY = new ProviderRegistry();
const REASONS = ["startup", "timer", "manual", "wake", "cli", "config-change"];

function errEnvelope(code, reasonCode, action) {
  return { schemaVersion: 1, kind: "error", error: safeError(code, reasonCode, action) };
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function exitWith(obj, code) {
  out(obj);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { providers: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.flags.json = true;
    else if (a === "--provider") { const v = argv[++i]; if (!v) return { error: "--provider 需要值" }; args.providers.push(v); }
    else if (a === "--reason") { const v = argv[++i]; if (!REASONS.includes(v)) return { error: `非法 --reason ${v}` }; args.reason = v; }
    else if (a === "--interaction") { const v = argv[++i]; if (!["background", "user-connect"].includes(v)) return { error: `非法 --interaction ${v}` }; args.interaction = v; }
    else if (a === "--config") { const v = argv[++i]; if (!v) return { error: "--config 需要值" }; args.config = v; }
    else if (a === "--input" || a === "--output") { args[a.slice(2)] = argv[++i]; }
    else if (a === "--stdin") { args.flags.stdin = true; }
    else if (!a.startsWith("--")) { (args.positional ??= []).push(a); }
    else return { error: `未知参数 ${a}` };
  }
  return args;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2);
  const command = parsed.positional?.[0];
  const subcommand = parsed.positional?.[1];
  if (!command) return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2);

  // ---- golden（测试支持命令）----
  if (command === "golden") {
    try {
      const input = parsed.input ?? "test/fixtures/ipc/usage-golden-vectors.json";
      const doc = JSON.parse(readFileSync(input, "utf8"));
      const outDoc = runGoldenVectors(doc);
      if (parsed.output) writeFileSync(parsed.output, JSON.stringify(outDoc, null, 2) + "\n");
      else out(outDoc);
      return process.exit(0);
    } catch (e) {
      return exitWith(errEnvelope("io-error", "io-error", "retry-later"), 4);
    }
  }

  // ---- config 路径 ----
  let configPath;
  try { configPath = resolveConfigPath({ configFlag: parsed.config, env: process.env }); }
  catch (e) { return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2); }

  // ---- registry ----
  if (command === "registry") {
    const store = new ConfigStore(configPath);
    let loaded = null;
    try { loaded = store.load(); } catch (e) {
      return exitWith(errEnvelope(e.code === "config-conflict" ? "config-conflict" : "invalid-config", "file-malformed", "none"), 2);
    }
    const dirs = resolveStateDirs({ env: process.env });
    const stores = createCredentialStores({ env: process.env });
    const compatibility = loaded?.config?.compatibility;
    const projection = REGISTRY.projectRegistry(loaded?.config ?? null, stores, compatibility);
    const filtered = parsed.providers.length > 0
      ? projection.providers.filter((p) => parsed.providers.includes(p.providerId))
      : projection.providers;
    for (const id of parsed.providers) {
      if (!REGISTRY.get(id)) return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2);
    }
    return exitWith({
      schemaVersion: 1, kind: "registry",
      contextId: loaded?.config ? contextOf(loaded.config) : "context-default",
      generatedAtMs: Date.now(),
      providers: filtered,
      diagnostics: projection.diagnostics,
    }, 0);
  }

  // ---- config validate ----
  if (command === "config" && subcommand === "validate") {
    try {
      const store = new ConfigStore(configPath);
      const loaded = store.load();
      if (!loaded) return exitWith({ schemaVersion: 1, kind: "config-validate", valid: true, note: "no-config" }, 0);
      return exitWith({ schemaVersion: 1, kind: "config-validate", valid: true, revision: loaded.revision, contentToken: loaded.contentToken }, 0);
    } catch (e) {
      return exitWith(errEnvelope(e.code ?? "invalid-config", "file-malformed", "none"), 2);
    }
  }

  // ---- config read / effective ----
  if (command === "config") {
    const sub = subcommand;
    const store = new ConfigStore(configPath);
    if (sub === "read") {
      try {
        const loaded = store.load();
        if (!loaded) return exitWith(errEnvelope("invalid-config", "not-configured", "configure-source"), 2);
        return exitWith({ schemaVersion: 1, kind: "config", config: loaded.config, revision: loaded.revision, contentToken: loaded.contentToken }, 0);
      } catch (e) {
        return exitWith(errEnvelope(e.code ?? "invalid-config", "file-malformed", "none"), 2);
      }
    }
    if (sub === "effective") {
      try {
        const loaded = store.load();
        if (!loaded) return exitWith(errEnvelope("invalid-config", "not-configured", "configure-source"), 2);
        // 脱敏投影：providers 只含 id/enabled/activeProfile/dataSource/interval（不含 sources 细节路径）
        const providers = {};
        for (const [id, p] of Object.entries(loaded.config.providers ?? {})) {
          providers[id] = { enabled: p.enabled, dataSource: p.dataSource, activeProfile: p.activeProfile ?? null, refreshIntervalSeconds: p.refreshIntervalSeconds ?? null };
        }
        return exitWith({
          schemaVersion: 1, kind: "config-effective",
          config: { ...loaded.config, providers },
          revision: loaded.revision,
          notes: ["diagnostics: local-redacted projection; not a write source"],
        }, 0);
      } catch (e) {
        return exitWith(errEnvelope(e.code ?? "invalid-config", "file-malformed", "none"), 2);
      }
    }
    if (sub === "set") {
      try {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const store2 = new ConfigStore(configPath);
        if (!store2.load()) return exitWith(errEnvelope("invalid-config", "not-configured", "configure-source"), 2);
        const result = store2.saveWithPatch({ baseRevision: req.baseRevision, contentToken: req.contentToken, patch: req.patch });
        return exitWith({ schemaVersion: 1, kind: "config-write", revision: result.revision, contentToken: result.contentToken, invalidatedProviderIds: result.invalidatedProviderIds }, 0);
      } catch (e) {
        const code = e.code === "config-conflict" ? "config-conflict" : "invalid-config";
        return exitWith(errEnvelope(code, e.code === "config-conflict" ? "config-conflict" : "file-malformed", e.code === "config-conflict" ? "retry-later" : "none"), 2);
      }
    }
    return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2);
  }

  // ---- usage ----
  if (command === "usage") {
    const coordinator = new RefreshCoordinator({ configPath, env: process.env });
    const cache = coordinator.readUsageCache();
    if (cache) return exitWith({ ...cache, generatedAtMs: Date.now() }, 0);
    // 无缓存：生成 not-configured envelope（无网络、无 secret）
    const coordinatorEnvelope = coordinator.buildEnvelope({ nowMs: Date.now(), config: coordinator.loadConfigOrNull(), runtime: coordinator.readRuntimeState() });
    return exitWith(coordinatorEnvelope, 0);
  }

  // ---- refresh ----
  if (command === "refresh") {
    if (parsed.interaction === "user-connect" && parsed.providers.length !== 1) {
      return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2);
    }
    for (const id of parsed.providers) {
      if (!REGISTRY.get(id)) return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2);
    }
    const coordinator = new RefreshCoordinator({ configPath, env: process.env });
    const controller = new AbortController();
    let signalled = false;
    const onSignal = () => {
      signalled = true;
      controller.abort();
      // ≤500ms 宽限输出 cancelled envelope（IPC freeze §4.1）
      setTimeout(() => process.exit(3), 480).unref();
    };
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
    try {
      const envelope = await coordinator.refresh(
        { reason: parsed.reason ?? "cli", providerIds: parsed.providers.length ? parsed.providers : undefined, interaction: parsed.interaction ?? "background" },
        controller.signal,
      );
      if (signalled) {
        envelope.request = { ...(envelope.request ?? {}), outcome: "cancelled" };
        return exitWith(envelope, 3);
      }
      const outcome = envelope.request?.outcome ?? "failed";
      const code = ["updated", "unchanged", "no-op"].includes(outcome) ? 0 : 3;
      if (!envelope.request?.cachePersisted && outcome !== "deferred") {
        envelope.coordinatorError = safeError("cache-write-failed", "io-error", "retry-later");
        return exitWith(envelope, 4);
      }
      return exitWith(envelope, code);
    } catch (e) {
      if (signalled) process.exit(3);
      return exitWith(errEnvelope("io-error", "io-error", "retry-later"), 4);
    }
  }

  return exitWith(errEnvelope("invalid-config", "invalid-parameter", "none"), 2);
}

function contextOf(config) {
  // 简化 contextId：默认配置 → context-default；自定义路径按规范化路径哈希（§4.1）
  return config.__contextId ?? "context-default";
}

main().catch((e) => {
  out(errEnvelope("io-error", "io-error", "retry-later"));
  process.exit(4);
});
