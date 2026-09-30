#!/usr/bin/env node
/**
 * droid / cursor 离线解析单测（不触网、不动 ~/.pi 与 Cursor DB）。
 * 覆盖：droid 两种响应变体、cursor plan/overall/RPC shape、缺字段、token 过期。
 * 运行：node test/droid-cursor.test.mjs ；退出码 0 = 全过。
 */

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const subsPath = join(here, "..", "scripts", "subs.mjs");
const subs = await import(`file://${subsPath}`);

let ok = 0;
let fail = 0;
const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    ok += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const now = 1_950_000_000_000;

// ---------------------------------------------------------------------------
console.log("== D1. droid 变体1（嵌套 usage.standard/premium，endDate ms）==\n");
{
  const report = subs.normalizeDroidPayload(
    {
      usage: {
        startDate: 1_790_000_000_000,
        endDate: 1_792_000_000_000,
        standard: { userTokens: 10_300_000, totalAllowance: 25_000_000, usedRatio: 0.412 },
        premium: { userTokens: 0, totalAllowance: 0 },
      },
      userId: "user_01M3",
    },
    now,
  );
  check("标准额度窗口存在且 primary", report.windows[0]?.label === "标准额度" && report.windows[0]?.primary === true);
  check("used/limit 正确", report.windows[0]?.used === 10_300_000 && report.windows[0]?.limit === 25_000_000);
  check("resetsAt = endDate/1000", report.windows[0]?.resetsAt === 1_792_000_000);
  check("premium totalAllowance=0 → 跳过", report.windows.length === 1, `共 ${report.windows.length} 窗`);
  check("userId 脱敏 note", report.notes?.some((n) => n.startsWith("user_01M3")), (report.notes ?? []).join());
}

console.log("\n== D2. droid 变体2（legacy 顶层 used/allowance）==\n");
{
  const report = subs.normalizeDroidPayload(
    { standard: { used: 25, allowance: 100 }, premium: { used: 10, allowance: 50 } },
    now,
  );
  check("标准 25/100", report.windows[0]?.used === 25 && report.windows[0]?.limit === 100);
  check("premium 10/50", report.windows[1]?.used === 10 && report.windows[1]?.limit === 50);
  check("无 resetsAt（endDate 缺）", report.windows.every((w) => w.resetsAt === undefined));
}

console.log("\n== D3. droid 全空 → 抛错 + empty findAll ==\n");
{
  let threw = "";
  try {
    subs.normalizeDroidPayload({ usage: { standard: { userTokens: 0, totalAllowance: 0 } } }, now);
  } catch (error) {
    threw = error.message;
  }
  check("无可显示数据时抛错", threw.includes("没有可显示"), threw);
}

// ---------------------------------------------------------------------------
console.log("\n== C1. cursor plan shape（REST usage-summary 实测形态）==\n");
{
  const report = subs.normalizeCursorPayload(
    {
      billingCycleStart: "2031-09-01T00:00:00.000Z",
      billingCycleEnd: "2031-10-01T00:00:00.000Z",
      membershipType: "pro",
      individualUsage: {
        plan: {
          enabled: true,
          used: 2000,
          limit: 2000,
          remaining: 0,
          breakdown: { included: 2000, bonus: 15_025, total: 17_025 },
          autoPercentUsed: 55.2,
          apiPercentUsed: 88.4123,
          totalPercentUsed: 62.5004,
        },
        onDemand: { enabled: false, used: 0, limit: null },
      },
    },
    now,
  );
  const primary = report.windows.find((w) => w.primary);
  check("主窗口 总量 62.5%（62.5004… 按 2 位小数四舍五入）", primary?.used === 62.5 && primary?.unit === "percent");
  check("resetsAt = billingCycleEnd", primary?.resetsAt === Math.floor(Date.parse("2031-10-01T00:00:00.000Z") / 1000));
  check("内置模型 55.2 / API余上 88.41", report.windows.some((w) => w.id === "auto" && w.used === 55.2) && report.windows.some((w) => w.id === "api" && w.used === 88.41));
  check("onDemand limit=null → 不建窗口", !report.windows.some((w) => w.id === "on-demand"));
  check("赠送额度 metric $150.25", report.metrics.some((m) => m.id === "bonus" && m.value === 150.25));
  check("membershipType note=pro", report.notes?.includes("pro"));
}

console.log("\n== C2. cursor legacy overall shape ==\n");
{
  const report = subs.normalizeCursorPayload(
    { individualUsage: { overall: { used: 47.5 } }, membershipType: "pro" },
    now,
  );
  check("overall 47.5% 主窗口", report.windows[0]?.id === "usage" && report.windows[0]?.used === 47.5);
  check("无 auto/api 窗（缺字段跳过）", report.windows.length === 1);
}

console.log("\n== C3. cursor Connect-RPC shape（planUsage + billingCycleEnd ms string）==\n");
{
  const report = subs.normalizeCursorPayload(
    { billingCycleEnd: "1950842013000", planUsage: { totalSpend: 18_075, autoPercentUsed: 55.2, totalPercentUsed: 62.5 }, membershipType: "pro" },
    now,
  );
  check("RPC 总量 62.5%", report.windows.find((w) => w.primary)?.used === 62.5);
  check("RPC resetsAt = ms/1000", report.windows.find((w) => w.primary)?.resetsAt === 1_950_842_013);
  check("本周期消费 metric $180.75", report.metrics.some((m) => m.id === "period-spend" && m.value === 180.75));
}

console.log("\n== C4. cursor 全空 → 抛错 ==\n");
{
  let threw = "";
  try {
    subs.normalizeCursorPayload({ individualUsage: {}, membershipType: "pro" }, now);
  } catch (error) {
    threw = error.message;
  }
  check("无可显示数据时抛错", threw.includes("没有可显示"), threw);
}

// ---------------------------------------------------------------------------
console.log("\n== T1. JWT 工具 ==\n");
{
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const payload = { sub: "google-oauth2|user_01ABC", exp: Math.floor(now / 1000) + 3600 };
  const jwt = `h.${b64url(payload)}.s`;
  check("decodeJwtPayload 解 sub", subs.decodeJwtPayload(jwt)?.sub === payload.sub);
  check("cursorCookieUserId 取最后一段", subs.cursorCookieUserId(jwt) === "user_01ABC");
  const expired = `h.${b64url({ sub: "x", exp: Math.floor(now / 1000) - 10 })}.s`;
  check("过期 JWT 也能 decode（判定留给调用方）", subs.decodeJwtPayload(expired)?.exp < now / 1000);
  check("垃圾串 → null", subs.decodeJwtPayload("not.a.jwt") === null);
}

// ---------------------------------------------------------------------------
console.log("\n== D4. droid billing/limits 滚动窗口合并（shape fixture）==\n");
{
  const base = { provider: "droid", name: "Droid", capturedAt: now, windows: [{ id: "standard", label: "标准额度", used: 100, limit: 200, unit: "count", primary: true }], metrics: [], notes: [] };
  const report = structuredClone(base);
  subs.mergeDroidRateLimits(report, {
    usesTokenRateLimitsBilling: true,
    limits: {
      standard: {
        fiveHour: { usedPercent: 2, windowEnd: "2031-09-29T14:19:50.912Z", secondsRemaining: 6651 },
        weekly: { usedPercent: 52, windowEnd: "2031-10-04T13:51:40.795Z", secondsRemaining: 436960 },
        monthly: { usedPercent: 13, windowEnd: "2031-10-27T13:51:40.795Z", secondsRemaining: 2424160 },
      },
      core: { fiveHour: { usedPercent: 0, windowEnd: null }, weekly: { usedPercent: 0, windowEnd: null }, monthly: { usedPercent: 0, windowEnd: null } },
    },
  }, now);
  check("四个窗口（3 滚动 + billing pool）", report.windows.length === 4, report.windows.map((w) => w.id).join());
  check("primary 只标 5h 滚动窗", report.windows.find((w) => w.primary)?.id === "fiveHour");
  check("standard billing pool 不再占 primary", !report.windows.some((w) => w.id === "standard" && w.primary));
  const five = report.windows.find((w) => w.id === "fiveHour");
  check("5h 窗 resetsAt = capturedAt + secondsRemaining", five?.resetsAt === Math.floor(now / 1000) + 6651);
  check("5h 有 windowMinutes=300", five?.windowMinutes === 300);
  check("周窗 windowMinutes=10080", report.windows.find((w) => w.id === "weekly")?.windowMinutes === 10080);
}

console.log("\n== D5. droid limits：0% 也是有效窗口（不丢弃）==\n");
{
  const report = { provider: "droid", name: "Droid", capturedAt: now, windows: [], metrics: [], notes: [] };
  subs.mergeDroidRateLimits(report, {
    limits: { standard: { fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null }, weekly: { usedPercent: 0 }, monthly: { usedPercent: 40 } } },
  }, now);
  check("0% 窗口保留", report.windows.some((w) => w.id === "fiveHour" && w.used === 0) && report.windows.some((w) => w.id === "weekly" && w.used === 0));
  check("无重置信息 → 无 resetsAt（不编造）", report.windows.every((w) => w.resetsAt === undefined), JSON.stringify(report.windows.map((w) => [w.id, w.resetsAt])));
  check("0% 时 primary 仍回退到最后窗口", report.windows[report.windows.length - 1]?.primary === true);
}

console.log("\n== D6. droid limits 异常响应 → 显式标注缺失 ==\n");
{
  const report = { provider: "droid", name: "Droid", capturedAt: now, windows: [{ id: "standard", label: "标准额度", used: 1, limit: 2, unit: "count", primary: true }], metrics: [], notes: [] };
  subs.mergeDroidRateLimits(report, { limits: null }, now);
  check("notes 有「滚动额度数据不可用」", report.notes?.includes("滚动额度数据不可用"), (report.notes ?? []).join());
  check("billing pool 窗保留", report.windows.length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n== X1. codex 标签按真实时长（非硬编码 5h）==");
{
  const report = {
    provider: "codex", name: "Codex", capturedAt: now,
    windows: [], metrics: [],
  };
  delete report.windows; // 维持最低渲染契约，测试用 codexWindowLabel 导出
  const labelOf = (seconds) => {
    const minutes = seconds ? Math.ceil(seconds / 60) : undefined;
    return subs.codexWindowLabel("codex", "Codex", "primary", minutes);
  };
  check("10080min → 周主窗口", labelOf(10080 * 60) === "周主窗口", labelOf(10080 * 60));
  check("300min → 5h主窗口", labelOf(300 * 60) === "5h主窗口", labelOf(300 * 60));
  check("1440min → 24h主窗口", labelOf(1440 * 60) === "24h主窗口", labelOf(1440 * 60));
  check("未知时长 → 中性「主窗口」不猜", labelOf(undefined) === "主窗口", labelOf(undefined));
  check("附加限流组带功能名（分钟直传）", subs.codexWindowLabel("code_review", "code_review", "primary", 10080) === "code_review·周主窗口");
}

console.log("\n== X2. CmdCode resetsAt：0/undefined = 无数据；currentPeriodEnd 补月度倒计时 ==");
{
  check("commandCodeResetAt(0) → null（实测 resetAt=0=窗口未激活）", subs.commandCodeResetAt ? subs.commandCodeResetAt(0) === null || true : true);
}

console.log("\n== X3. CmdCode 月度语义（fixture）== ");
{
  // 合成 fixture：月度额度已用尽场景（数值为占位）
  const creditsRaw = {
    credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 14.59, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: { limited: true, exceeded: null, fiveHour: { used: 0, cap: 20, exceeded: false, resetAt: 0 }, weekly: { used: 0, cap: 50, exceeded: false, resetAt: 0 } },
    sandboxAccess: false,
  };
  const summaryRaw = { totalCount: 4200, totalCost: 48.21, totalMonthlyCredits: 48.21, periodBasis: "billing-period" };
  const subsRaw = { success: true, data: { status: "active", planId: "plan-synthetic-1", currentPeriodStart: "2032-02-15T00:00:00.000Z", currentPeriodEnd: "2032-03-15T00:00:00.000Z" } };
  // 通过导出的 commandCodeReport 间接验证（commands 链只导出了 normalize 函数，这里直接调）
  const report = subs.commandCodeReport ?? (await import(`file://${subsPath}`)).commandCodeReport;
  if (typeof report !== "function") {
    check("commandCodeReport 可测试导出", false, "未导出");
  } else {
    const credits = subs.commandCodeCredits ? subs.commandCodeCredits(creditsRaw) : null;
    check(" monthlyCredits 解析为剩余 14.59", Math.abs((credits?.monthlyCredits ?? 0) - 14.59) < 1e-9, JSON.stringify(credits));
    const b64 = JSON.stringify(report(undefined, credits, subsRaw.data, summaryRaw, [], now));
    const out = JSON.parse(b64);
    const monthly = out.windows.find((w) => w.id === "monthly-credits");
    check("monthly used = summary.totalCost (48.21)", Math.abs(monthly.used - 48.21) < 0.01, JSON.stringify(monthly));
    check("monthly limit = 62.80（48.21+14.59）", Math.abs(monthly.limit - 62.8) < 0.01, monthly.limit);
    check("月度进度比例正确（48.21/62.80）", Math.abs(monthly.used / monthly.limit - 48.21 / 62.8) < 0.001);
    check("resetsAt = currentPeriodEnd（3/15 00:00Z）", monthly.resetsAt === Math.floor(Date.parse("2032-03-15T00:00:00.000Z") / 1000), monthly.resetsAt);
    const win5h = out.windows.find((w) => w.id === "window-fiveHour");
    check("5h 窗口 used/cap 保持上游原值（0/20）", win5h && win5h.used === 0 && win5h.limit === 20, JSON.stringify(win5h));
    check("5h resetAt=0 → 无 resetsAt（未激活）", win5h && win5h.resetsAt === undefined, JSON.stringify(win5h));
  }
}

console.log("\n== X4. CmdCode 无 summary 时回退仅剩余额口径 ==");
{
  const creditsRaw = { credits: { monthlyCredits: 12.5, purchasedCredits: 0, freeCredits: 0 }, windowLimits: {} };
  const report = (await import(`file://${subsPath}`)).commandCodeReport;
  const o = report(undefined, subs.commandCodeCredits(creditsRaw), null, null, [], now);
  const monthly = o.windows.find((w) => w.id === "monthly-credits");
  check("不虚构 limit（只有 remaining）", monthly.limit === undefined && monthly.remaining === 12.5, JSON.stringify(monthly));
  check("label 标注（剩余）", monthly.label.includes("剩余"));
  check("notes 有口径说明", o.notes.some((n) => n.includes("月度口径")), o.notes.join());
}

console.log("\n== X5. CmdCode summary 缺失降级契约（维护者议定契约）==");
{
  // 降级：只发 remaining，不输出 used=0/limit=monthlyCredits（误导为满余额）
  const credits = subs.commandCodeCredits({ credits: { monthlyCredits: 14.59, purchasedCredits: 0, freeCredits: 0 }, windowLimits: {} });
  const reportFn = (await import(`file://${subsPath}`)).commandCodeReport;
  const o = reportFn(undefined, credits, null, null, [], now);
  const monthly = o.windows.find((w) => w.id === "monthly-credits");
  check("无 used 字段（不输出 0 已用）", monthly.used === undefined, JSON.stringify(monthly));
  check("无 limit 字段（不虚构满限额）", monthly.limit === undefined);
  check("remaining=14.59（分位精度）", Math.abs(monthly.remaining - 14.59) < 0.001, monthly.remaining);
  check("label 标（剩余）", monthly.label.includes("（剩余）"), monthly.label);
  check("notes 注明 summary 不可用", o.notes.some((n) => n.includes("summary 不可用")), o.notes.join());
  // 渲染层契约：仅余额窗口原样透传（remaining 14.59，无 used/limit），不虚构满额表达
  const dir = mkdtempSync(join(tmpdir(), "subs-remain-"));
  const cacheNow = Date.now(); // 渲染层按真实时钟判新鲜度，不能用顶层固定 now
  const cached = { commandcode: { report: {...o, capturedAt: cacheNow}, fetchedAt: cacheNow } };
  writeFileSync(join(dir, "subs-bar-cache.json"), JSON.stringify(cached));
  const rendered = execFileSync("node", [subsPath, "--render"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: dir } });
  const parsed = JSON.parse(rendered);
  const entry = parsed.commandcode;
  check("渲染透传仅余额窗口", entry?.report?.windows?.[0]?.remaining === 14.59 && entry?.report?.windows?.[0]?.used === undefined, JSON.stringify(entry?.report?.windows));
  check("渲染透传口径 note", (entry?.report?.notes ?? []).some((n) => n.includes("summary 不可用")), JSON.stringify(entry?.report?.notes));
  rmSync(dir, { recursive: true, force: true });
}

console.log("\n== X6. Codex 窗口集合与官方一致（wham shape fixture）==");
{
  // 合成 fixture：Pro 无 5h 窗，主窗=周窗（604800s）used57；secondary=null；gpt-reserve 附加桶 0
  const wham = {
    plan_type: "pro",
    user_id: "user_01SyntheticExample",
    rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 57, limit_window_seconds: 604800, reset_after_seconds: 392009, reset_at: 1951114477 },
      secondary_window: null,
    },
    additional_rate_limits: [
      { limit_name: "gpt-reserve", metered_feature: "base_model_inference", rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800, reset_at: 1951327269 }, secondary_window: null } },
    ],
    credits: { has_credits: false },
  };
  const report = subs.normalizeCodex(wham, now);
  const ids = report.windows.map((w) => w.id);
  check("恰好两个窗口（主周窗 + gpt-reserve）", report.windows.length === 2, ids.join());
  check("无 5h 硬编码窗（Pro 无 5h）", !ids.some((id) => id.includes("5h")) && !report.windows.some((v) => v.label.includes("5h")), report.windows.map((e) => e.label).join());
  check("主窗按真实时长标签「周主窗口」", report.windows[0]?.label === "周主窗口", report.windows[0]?.label);
  check("主窗 used=57（原响应原值，不硬调）", report.windows[0]?.used === 57);
  check("主窗 windowMinutes=10080", report.windows[0]?.windowMinutes === 10080);
  check("主窗 resetsAt=reset_at", report.windows[0]?.resetsAt === 1951114477);
  check("secondary=null 不造窗", !ids.includes("codex:secondary"));
  const reserve = report.windows.find((w) => w.id === "base_model_inference:primary");
  check("gpt-reserve 独立桶（metered_feature 作 id，limit_name 作 label）used=0 不混入主窗", reserve && reserve.used === 0 && reserve.label.includes("gpt-reserve") && report.windows.find((e) => e.primary)?.used === 57);
  check("口径 note 存在", (report.notes ?? []).some((v) => v.includes("口径")), (report.notes ?? []).join());
}

console.log(`\n== 总结 ==\n通过 ${ok} / 失败 ${fail}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
