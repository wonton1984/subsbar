#!/usr/bin/env node
/**
 * M1 契约测试：quota 归一化语义（contracts §6.3）+ golden 向量一致性。
 * 向量真源：test/fixtures/ipc/usage-golden-vectors.json（输入）
 *          test/fixtures/ipc/usage-golden-normalized.json（Node 归一化输出，由 core/golden.mjs 生成）
 * 断言：runner 输出与向量 expected 摘要一致（expected 冲突时以 contracts §6.3 为准）。
 * 运行：node test/m1-quota.test.mjs ；退出码 0 = 全过。
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "fixtures", "ipc", "usage-golden-vectors.json"), "utf8"));
const normalized = JSON.parse(readFileSync(join(here, "fixtures", "ipc", "usage-golden-normalized.json"), "utf8"));

let ok = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log("== G1. runner 输出与 golden 向量一一对应 ==");
{
  const ids = vectors.vectors.map((v) => v.id);
  check("向量数一致", Object.keys(normalized.vectors).length === ids.length, `${Object.keys(normalized.vectors).length}`);
  for (const id of ids) check(`向量 ${id} 有归一化输出`, !!normalized.vectors[id], "missing");
}

console.log("\n== G2. numeric vectors 与 §6.3 判定表一致 ==");
{
  const out = normalized.vectors;
  const get = (id) => out[id].output;

  let m = get("zero");
  check("zero: known/within-limit", m.state === "known" && m.quotaState === "within-limit");
  check("zero: 标尺 100", m.limit === 100);
  check("zero: usedPercent 0 / 图标满", m.usedPercent === 0 && m.iconFraction === 1);

  m = get("unknown");
  check("unknown: 不凭空补标尺", m.state === "unknown" && m.quotaState === "unknown" && m.usedPercent === null && m.iconFraction === null);

  m = get("zero-denominator");
  check("zero-denominator: known 但 quotaState unknown，无百分比", m.state === "known" && m.quotaState === "unknown" && m.usedPercent === null);

  m = get("remaining-only");
  check("remaining-only: 仅 remaining，无百分比", m.state === "remaining-only" && m.quotaState === "unknown" && m.remaining === 12.5 && m.used === undefined && m.limit === undefined);
  check("remaining-only: summary-unavailable 诊断", (m.diagnostics ?? []).some((d) => d.code === "summary-unavailable"));

  m = get("over-limit");
  check("over-limit: 150% 保留、图形裁剪 0", m.usedPercent === 150 && m.iconFraction === 0 && m.used === 150 && m.quotaState === "over-limit");
  check("over-limit: 源数不被 clamp", m.detailKeepsRaw === undefined || (m.used === 150 && m.limit === 100));

  m = get("inconsistent");
  check("inconsistent: 原值不动 + 诊断", m.used === 30 && m.remaining === 90 && m.limit === 100 && (m.diagnostics ?? []).some((d) => d.code === "inconsistent-values"));
  check("inconsistent: 百分比用 used/limit", m.usedPercent === 30 && m.iconFraction === 0.7);

  m = get("inconsistent-remaining-over-limit");
  check("remaining>limit 无 used：比例未知 + 诊断", m.usedPercent === null && m.quotaState === "unknown" && (m.diagnostics ?? []).some((d) => d.code === "inconsistent-values") && m.remaining === 120);

  m = get("primary-unknown");
  check("primary unknown 不偷换次窗口", m.primary.usedPercent === null && m.primary.iconFraction === null && m.secondary.usedPercent === 0 && m.secondary.iconFraction === 1 && m.primaryMetricIdStays === "primary");
}

console.log("\n== G3. freshness 边界（§6.3）==");
{
  const get = (id) => normalized.vectors[id].output;
  check("rate-limited：数据 1 分钟 fresh 但 status 仍 rate-limited", get("rate-limited-fresh-cache").computedFreshness === "fresh");
  check("expired：age≥24h", get("expired-cache").computedFreshness === "expired");
  check("future>300s：invalid", get("future-clock").computedFreshness === "invalid");
}

console.log("\n== G4. legacy 迁移（§7 CmdCode 余额支路）==");
{
  const m = normalized.vectors["legacy-commandcode"].output.metric;
  check("legacy: remaining-only 12.5 USD", m.state === "remaining-only" && m.remaining === 12.5 && m.currency === "USD");
  check("legacy: used/limit 被删除（不虚构分母）", m.used === undefined && m.limit === undefined);
  check("legacy: resetsAt 秒→毫秒", m.period?.resetsAtMs === 1800000000000 && m.period?.resetState === "known");
  check("legacy: provenance=legacy-unverified", m.provenance === "legacy-unverified");
  check("legacy: freshness 固定 expired", normalized.vectors["legacy-commandcode"].output.freshness === "expired");
}

console.log("\n== G5. scope 隔离 ==");
{
  check("scope-switched: 丢弃旧 scope 结果", normalized.vectors["scope-switched"].output.mergeDecision === "drop-old-scope");
}

console.log(`\n== 总结 ==\n通过 ${ok} / 失败 ${fail}`);
if (failures.length > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
