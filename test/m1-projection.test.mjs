#!/usr/bin/env node
/**
 * M1 契约测试：usage 活动配置投影（C07/C21，IPC freeze rev4）。
 * 规则：disabled 全剥离；跨 profile → stale-foreign 不重现；失效记录 → 不投影；匹配保留。
 * 运行：node test/m1-projection.test.mjs ；退出码 0 = 全过。
 */
import { projectUsage } from "../core/runtime/project.mjs";
import { applyResult } from "../core/runtime/scheduler.mjs";

let ok = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`); }
}

const baseEntry = (over = {}) => ({
  providerId: "commandcode",
  profileId: "personal",
  scopeKey: "scope-synthetic-a",
  accountKey: "account-synthetic-a",
  status: "ok",
  freshness: "fresh",
  dataDisposition: "current",
  lastSuccessAtMs: 1800000000000,
  configRevision: 1,
  attempt: { state: "succeeded" },
  source: { dataSourceId: "commandcode-alpha", grade: "C", transport: "https", credentialSourceId: "my-key", reader: "commandcode-subsbar-key", identityAssurance: "verified" },
  report: { name: "CommandCode", capturedAtMs: 1800000000000, observationBasis: "remote-response", windows: [{ id: "monthly-credits", ruleId: "monthly-credits", label: "月度credits", kind: "quota", state: "remaining-only", remaining: 12.5, unit: "currency", currency: "USD", scope: "subscription", provenance: "reported", sourceEndpointIds: [], quotaState: "unknown", derivations: [], period: { kind: "billing", resetState: "unknown" }, diagnostics: [] }], metrics: [], primaryMetricId: "monthly-credits", diagnostics: [] },
  diagnostics: [],
  ...over,
});
const envelope = (entries) => ({ schemaVersion: 1, kind: "usage", contextId: "context-synthetic-default", generatedAtMs: 1800000000000, cacheRevision: 7, providers: entries, diagnostics: [] });
const cfgEnabled = (profileId = "personal") => ({ providers: { commandcode: { enabled: true, activeProfile: profileId, profiles: [{ id: profileId, discovery: "auto", sources: [] }] } } });

console.log("== P1. disabled → 全剥离（含 report/scopeKey/error），显式 disabled 条目 ==");
{
  const out = projectUsage(envelope([baseEntry()]), { config: { providers: { commandcode: { enabled: false, profiles: [] } } }, invalidated: {} });
  const e = out.providers[0];
  check("status=disabled 且条目保留", e.status === "disabled" && out.providers.length === 1);
  check("report/scopeKey/accountKey/source/error 全剥离", e.report === undefined && e.scopeKey === undefined && e.accountKey === undefined && e.source === undefined && e.error === undefined);
  check("freshness/dataDisposition 归零", e.freshness === "none" && e.dataDisposition === "none");
}

console.log("\n== P2. 缺 config（空 HOME）→ 全部 disabled 剥离 ==");
{
  const out = projectUsage(envelope([baseEntry(), baseEntry({ providerId: "codex" })]), { config: null, invalidated: {} });
  check("两条目均 disabled", out.providers.every((p) => p.status === "disabled"));
  check("无数值残留", out.providers.every((p) => p.report === undefined));
}

console.log("\n== P3. 换 profile → stale-foreign 不重现 ==");
{
  const out = projectUsage(envelope([baseEntry()]), { config: cfgEnabled("work"), invalidated: {} });
  const e = out.providers[0];
  check("profileId 显示为当前活动 profile", e.profileId === "work");
  check("旧 scope 数值不出现", e.report === undefined && e.scopeKey === undefined);
  check("stale-foreign 诊断 + not-configured", e.status === "not-configured" && (e.diagnostics ?? []).some((d) => d.code === "stale-foreign"));
}

console.log("\n== P4. 身份失效记录 → 不投影旧 report ==");
{
  check("invalidated(rev2) > 条目 revision(1) → 剥离",
    projectUsage(envelope([baseEntry()]), { config: cfgEnabled(), invalidated: { commandcode: 2 } }).providers[0].report === undefined);
  check("条目 revision(2) >= invalidated(2) → 重新采样后保留",
    projectUsage(envelope([baseEntry({ configRevision: 2 })]), { config: cfgEnabled(), invalidated: { commandcode: 2 } }).providers[0].report !== undefined);
  check("无失效记录 → 保留", projectUsage(envelope([baseEntry()]), { config: cfgEnabled(), invalidated: {} }).providers[0].report !== undefined);
}

console.log("\n== P5. 匹配场景原样保留 ==");
{
  const out = projectUsage(envelope([baseEntry()]), { config: cfgEnabled("personal"), invalidated: {} });
  const e = out.providers[0];
  check("report/scopeKey/status 保留", e.status === "ok" && e.report !== undefined && e.scopeKey === "scope-synthetic-a");
}

console.log("\n== P6. 换 profile 后新采样可显示（09 cursor usage 0 窗回归）==");
{
  const entry = baseEntry({ profileId: "profile-03273fb1", scopeKey: "scope-old" });
  applyResult(entry, {
    kind: "success",
    profileId: "dev-local",
    scopeKey: "scope-dev-local",
    report: baseEntry().report,
    dataSourceId: "commandcode-alpha",
    credentialSourceId: "my-key",
    reader: "commandcode-subsbar-key",
    identityAssurance: "verified",
  }, { nowMs: 1800000001000, trigger: { reason: "manual" }, configRevision: 8 });
  check("applyResult 成功后 profileId 跟随新采样", entry.profileId === "dev-local");
  check("新 scopeKey 写入", entry.scopeKey === "scope-dev-local");
  check("新 report windows 保留", (entry.report?.windows ?? []).length > 0);
  const cfg = {
    providers: {
      commandcode: {
        enabled: true, activeProfile: "dev-local",
        profiles: [
          { id: "profile-03273fb1", discovery: "auto", sources: [] },
          { id: "dev-local", discovery: "auto", sources: [] },
        ],
      },
    },
  };
  const shown = projectUsage(envelope([entry]), { config: cfg, invalidated: {} }).providers[0];
  check("投影后新采样可显示", shown.profileId === "dev-local" && shown.status === "ok" && (shown.report?.windows ?? []).length > 0);

  const failed = baseEntry({ profileId: "profile-03273fb1" });
  applyResult(failed, {
    kind: "failed",
    profileId: "dev-local",
    error: { code: "timeout", reasonCode: "timeout", action: "retry-later" },
    retainLastGood: true,
  }, { nowMs: 1800000001000, trigger: { reason: "manual" }, configRevision: 8 });
  check("换 profile 失败不把旧 report 改挂到新 profile", failed.profileId === "dev-local" && failed.report === undefined);

  const scoped = baseEntry({ profileId: "personal", scopeKey: "scope-acct-a" });
  applyResult(scoped, {
    kind: "failed",
    profileId: "personal",
    scopeKey: "scope-acct-b",
    error: { code: "invalid-credential", reasonCode: "http-401", action: "relogin-owner" },
    retainLastGood: true,
  }, { nowMs: 1800000001000, trigger: { reason: "manual" }, configRevision: 8 });
  check("换 scope/账户失败丢弃旧 last-good", scoped.profileId === "personal" && scoped.report === undefined && scoped.scopeKey === undefined);
}

console.log(`\n== 总结 ==\n通过 ${ok} / 失败 ${fail}`);
if (failures.length > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
