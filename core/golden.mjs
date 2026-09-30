// golden runner（IPC freeze rev3）：把共享 golden 向量经本归一化模块产出 v1-wire 期望文件，
// 供 Node 测试与 Swift 断言共用同一份数值结果（原生不重复实现归一化）。
// 用法：node core/golden.mjs --input test/fixtures/ipc/usage-golden-vectors.json --output <file>
import { normalizeQuota, usedPercentOf, iconFractionOf, freshnessOf, legacyWindowToMetric } from "./runtime/report.mjs";
import { diagnostic } from "./defs.mjs";
import { readFileSync, writeFileSync } from "fs";

// 合成 metricRule 注册表（真实规则来自 manifests；此处覆盖向量所需的最小集）
const RULES = {
  "quota-percent": { id: "quota-percent", metricId: "quota-percent", unit: "percent", derivations: ["remaining-from-limit-used"], scope: "subscription" },
  "quota-count": { id: "quota-count", metricId: "quota-count", unit: "count", derivations: ["used-from-limit-remaining", "remaining-from-limit-used", "limit-from-used-remaining"], scope: "subscription" },
  "monthly-credits": { id: "monthly-credits", metricId: "monthly-credits", unit: "currency", currency: "USD", derivations: [], scope: "subscription" },
};

export function runGoldenVectors(doc) {
  const nowMs = doc.nowMs;
  const vectors = {};
  for (const v of doc.vectors) {
    vectors[v.id] = { inputLayer: v.inputLayer, output: runOne(v, nowMs) };
  }
  return { schemaVersion: 1, kind: "golden-normalized", nowMs, vectors };
}

function runOne(v, nowMs) {
  const input = v.input;
  switch (v.id) {
    case "zero":
    case "unknown":
    case "zero-denominator":
    case "over-limit":
    case "inconsistent":
    case "inconsistent-remaining-over-limit":
    case "remaining-only": {
      const rule = RULES[input.metricRule];
      const fields = { ...input.payload };
      if (input.metricRule === "monthly-credits" && input.payload.summaryMissing) {
        fields.diagnostics = [diagnostic("summary-unavailable", "warning")];
      }
      const metric = normalizeQuota(rule, fields);
      return quotaOut(metric);
    }
    case "primary-unknown": {
      const primary = normalizeQuota(RULES["quota-percent"], input.primary);
      const secondary = normalizeQuota({ ...RULES["quota-count"], metricId: input.secondary.id ?? "secondary" }, input.secondary);
      return {
        primary: quotaOut(primary),
        secondary: quotaOut(secondary),
        primaryMetricIdStays: "primary",
      };
    }
    case "partial-balance": {
      const m = input.metrics[0];
      const metric = {
        id: "wallet", ruleId: "wallet", label: "Wallet", kind: "balance", state: "known",
        unit: m.unit, currency: m.currency, scope: "account", provenance: "reported",
        sourceEndpointIds: [], value: m.value, diagnostics: [],
      };
      return { metrics: [metric], reportStatus: "partial", iconFraction: iconFractionOf(null) ?? null, note: "windows 为空：无饼图，余额可显示" };
    }
    case "stale-network": {
      return { ...input, statusRule: "网络失败 + 同 scope last-good → stale，错误保留，lastSuccessAtMs 不变" };
    }
    case "rate-limited-fresh-cache": {
      const freshness = freshnessOf({ capturedAtMs: nowMs - input.capturedAgeMs, observationBasis: "remote-response" }, nowMs);
      return { ...input, computedFreshness: freshness };
    }
    case "expired-cache": {
      const freshness = freshnessOf({ capturedAtMs: nowMs - input.capturedAgeMs, observationBasis: "remote-response" }, nowMs);
      return { ...input, computedFreshness: freshness };
    }
    case "future-clock": {
      const freshness = freshnessOf({ capturedAtMs: input.capturedAtMs, observationBasis: "remote-response" }, input.nowMs);
      return { ...input, computedFreshness: freshness };
    }
    case "scope-switched": {
      return { ...input, mergeDecision: "drop-old-scope", note: "scope/generation 不符的结果在提交前丢弃；缓存不得跨 scope 合并" };
    }
    case "legacy-commandcode": {
      const metric = legacyWindowToMetric(input.windows[0], { nowMs });
      const freshness = freshnessOf({ capturedAtMs: input.fetchedAtMs, observationBasis: "legacy-import" }, nowMs);
      return {
        metric: quotaOut(metric),
        dataDisposition: "legacy",
        freshness,
      };
    }
    default:
      throw new Error(`golden: 未知向量 ${v.id}`);
  }
}

function quotaOut(metric) {
  return {
    ...metric,
    usedPercent: usedPercentOf(metric) ?? null,
    iconFraction: iconFractionOf(metric) ?? null,
  };
}

// CLI 入口（测试支持命令，不属于 §6.6 公开 CLI 面；仅读写 fixture 文件）
if (process.argv[1] && process.argv[1].endsWith("core/golden.mjs")) {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--input");
  const oidx = args.indexOf("--output");
  const input = idx >= 0 ? args[idx + 1] : "test/fixtures/ipc/usage-golden-vectors.json";
  const doc = JSON.parse(readFileSync(input, "utf8"));
  const out = runGoldenVectors(doc);
  const text = JSON.stringify(out, null, 2) + "\n";
  if (oidx >= 0) {
    writeFileSync(args[oidx + 1], text);
    process.stderr.write(`golden: wrote ${args[oidx + 1]} (${Object.keys(out.vectors).length} vectors)\n`);
  } else {
    process.stdout.write(text);
  }
}
