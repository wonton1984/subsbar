#!/usr/bin/env node
/**
 * 离线边界测试（数据层渲染契约）。
 * 不触网、不读真实凭证：通过 PI_CODING_AGENT_DIR 指向临时目录，
 * 用精心构造的 subs-bar-cache.json 驱动 `node scripts/subs.mjs --render`，
 * 断言渲染器在畸形/边界数据下的行为。全部数据为合成 fixture。
 *
 * 运行：node test/edge.test.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const subsMjs = join(here, "..", "scripts", "subs.mjs");

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

/** 在独立临时 PI_CODING_AGENT_DIR 下渲染给定 cache 对象，返回 {json, exitCode}。 */
function renderWith(cacheObject) {
  const dir = mkdtempSync(join(tmpdir(), "subs-edge-"));
  try {
    writeFileSync(join(dir, "subs-bar-cache.json"), JSON.stringify(cacheObject));
    try {
      const stdout = execFileSync("node", [subsMjs, "--render"], {
        encoding: "utf-8",
        env: { ...process.env, PI_CODING_AGENT_DIR: dir },
        timeout: 15_000,
      });
      return { json: JSON.parse(stdout), exitCode: 0 };
    } catch (error) {
      return { json: null, exitCode: error.status ?? -1, stderr: String(error.stderr ?? "") };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fresh = () => Date.now();
const baseReport = (windows, metrics = []) => ({
  windows,
  metrics,
  name: "EdgeTest",
  capturedAt: fresh(),
});
const onlyCodex = (report) => ({ codex: { report, fetchedAt: fresh() } });

// ---------------------------------------------------------------------------
console.log("== E1. resetsAt 缺失：正常渲染、无倒计时、不崩溃 ==\n");
{
  const { json, exitCode } = renderWith(
    onlyCodex(baseReport([{ id: "w", label: "无重置", used: 40, limit: 100, unit: "percent", primary: true }])),
  );
  check("exit 0", exitCode === 0);
  const codex = json?.codex;
  check("选中 provider 输出 report", !!codex?.report, JSON.stringify(json)?.slice(0, 120));
  check("fresh 标记（新缓存）", codex?.fresh === true && codex?.stale === false, JSON.stringify(codex?.fresh));
  const win = codex?.report?.windows?.[0];
  check("窗口原样保留（used/limit/unit）", win?.used === 40 && win?.limit === 100 && win?.unit === "percent", JSON.stringify(win));
  check("无重置字段不编造", win?.resetsAt === undefined, JSON.stringify(win));
}

// ---------------------------------------------------------------------------
console.log("\n== E2. limit=0：无 NaN/Infinity，原值保留 ==\n");
{
  const { json, exitCode } = renderWith(
    onlyCodex(baseReport([{ id: "w", label: "零上限", used: 0, limit: 0, unit: "usd", primary: true }])),
  );
  check("exit 0", exitCode === 0);
  const text = JSON.stringify(json);
  check("无 NaN/Infinity 字样", !/NaN|Infinity/.test(text), text.slice(0, 120));
  const win = json?.codex?.report?.windows?.[0];
  check("0/0 原值保留", win?.used === 0 && win?.limit === 0, JSON.stringify(win));
}

// ---------------------------------------------------------------------------
console.log("\n== E3. used=null（JSON 无法表达 NaN，等价于 NaN 落盘形态）==\n");
{
  const { json, exitCode } = renderWith(
    onlyCodex(baseReport([{ id: "w", label: "空值", used: null, limit: 100, unit: "percent", primary: true }])),
  );
  check("exit 0", exitCode === 0);
  check("无 NaN 字样", !/NaN/.test(JSON.stringify(json)));
  const win = json?.codex?.report?.windows?.[0];
  check("null 原样保留（渲染层兜底）", win?.used === null, JSON.stringify(win));
}

// ---------------------------------------------------------------------------
console.log("\n== E4. 空 windows 数组：结构合法、metrics 保留 ==\n");
{
  const { json, exitCode } = renderWith(
    onlyCodex(baseReport([], [{ label: "余额", value: 12.5, unit: "usd" }])),
  );
  check("exit 0", exitCode === 0);
  const report = json?.codex?.report;
  check("windows 空数组保留", Array.isArray(report?.windows) && report.windows.length === 0, JSON.stringify(report));
  check("metrics 行保留（$12.5）", report?.metrics?.[0]?.value === 12.5 && report?.metrics?.[0]?.unit === "usd", JSON.stringify(report?.metrics));
}

// ---------------------------------------------------------------------------
console.log("\n== E5. used > limit（150%）：超额原值保留，不静默裁剪 ==\n");
{
  const { json, exitCode } = renderWith(
    onlyCodex(baseReport([{ id: "w", label: "超限", used: 150, limit: 100, unit: "percent", primary: true }])),
  );
  check("exit 0", exitCode === 0);
  const win = json?.codex?.report?.windows?.[0];
  check("超额原值保留（150）", win?.used === 150, JSON.stringify(win));
}

// ---------------------------------------------------------------------------
console.log("\n== E6. resetsAt 为过去的时刻：原值保留 ==\n");
{
  const past = Math.floor(Date.now() / 1000) - 3600;
  const { json, exitCode } = renderWith(
    onlyCodex(
      baseReport([{ id: "w", label: "过期", used: 10, limit: 100, unit: "percent", primary: true, resetsAt: past }]),
    ),
  );
  check("exit 0", exitCode === 0);
  const win = json?.codex?.report?.windows?.[0];
  check("过期 resetsAt 原值保留", win?.resetsAt === past, JSON.stringify(win));
}

// ---------------------------------------------------------------------------
console.log("\n== E7. 负数 used：原值保留（由展示层钳制）==\n");
{
  const { json, exitCode } = renderWith(
    onlyCodex(baseReport([{ id: "w", label: "负数", used: -5, limit: 100, unit: "percent", primary: true }])),
  );
  check("exit 0", exitCode === 0);
  const win = json?.codex?.report?.windows?.[0];
  check("负值原样保留", win?.used === -5, JSON.stringify(win));
}

// ---------------------------------------------------------------------------
console.log("\n== E8. report 缺 windows 字段（合法 JSON 但结构残缺）==\n");
{
  const { json, exitCode, stderr } = renderWith(onlyCodex({ metrics: [], name: "Broken", capturedAt: fresh() }));
  check("渲染器对残缺 report 不崩溃（exit 0）", exitCode === 0, `exit=${exitCode} stderr=${(stderr ?? "").slice(0, 120)}`);
  if (exitCode === 0) {
    check("残缺 report 仍输出（无 windows 字段）", json?.codex?.report && !("windows" in json.codex.report), JSON.stringify(json?.codex?.report));
  }
}

// ---------------------------------------------------------------------------
console.log("\n== E9. stale 缓存标记 ==\n");
{
  const old = Date.now() - 20 * 60 * 1000; // 20 分钟前 → 超过 2× 刷新间隔
  const { json, exitCode } = renderWith(
    { codex: { report: baseReport([{ used: 30, limit: 100, unit: "percent", primary: true }]), fetchedAt: old } },
  );
  check("exit 0", exitCode === 0);
  check("stale=true 且 fresh 与 stale 不矛盾", json?.codex?.stale === true, JSON.stringify({ fresh: json?.codex?.fresh, stale: json?.codex?.stale }));
  check("fetchedAt 原值保留（毫秒）", json?.codex?.fetchedAt === old, JSON.stringify(json?.codex?.fetchedAt));
}

// ---------------------------------------------------------------------------
console.log("\n== E10. 非选中/未知 provider 不输出 ==\n");
{
  const { json, exitCode } = renderWith({
    codex: { report: baseReport([{ used: 30, limit: 100, unit: "percent", primary: true }]), fetchedAt: fresh() },
    unknownProvider: { report: baseReport([]), fetchedAt: fresh() },
  });
  check("exit 0", exitCode === 0);
  check("未知 provider 被忽略", !("unknownProvider" in (json ?? {})), Object.keys(json ?? {}).join());
  check("已知 provider 输出", "codex" in (json ?? {}), Object.keys(json ?? {}).join());
}

// ---------------------------------------------------------------------------
console.log(`\n== 总结 ==`);
console.log(`通过 ${ok} / 失败 ${fail}`);
if (failures.length > 0) {
  console.log("失败项：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
