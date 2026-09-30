#!/usr/bin/env node
/**
 * SubsBar 数据层兼容 CLI 入口（contracts §6.6 别名）。
 *
 * 引擎（fetch/normalize/缓存）已迁移至 core/providers/engine/engine.mjs；
 * 本文件仅保留历史 CLI 语义：--refresh / --render(JSON) / --select。
 * 依赖方向：scripts → core（core 不得反向 import scripts/，C24）。
 *
 * 数据来源：各 provider 的本机凭证（只读）。解析引擎移植自 pi-subs /
 * @narumitw/pi-usage / pi-commandcode-provider（MIT，见 THIRD_PARTY_NOTICES.md）。
 *
 * 用法：
 *   node subs.mjs                  # 从缓存渲染 JSON 摘要（stdout）
 *   node subs.mjs --refresh        # 拉取全部订阅并写缓存
 *   node subs.mjs --refresh --render
 *   node subs.mjs --render         # 只渲染缓存，不拉取
 *   node subs.mjs --select <id>    # 切换选中订阅（写共享状态文件）
 *
 * 安全约定：任何 stdout/stderr 输出都经过脱敏，绝不包含 token/apiKey。
 */

export * from "../core/providers/engine/engine.mjs";
import {
  agentDir, scrubCredentials, loadCache, saveSelection, refreshAll,
  SUBS_ORDER, MAX_CACHE_AGE_MS, REFRESH_INTERVAL_MS,
} from "../core/providers/engine/engine.mjs";

// main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // --select <id>: 切换选中订阅（共享状态文件，与原生 app 兼容）
  const selectIdx = args.indexOf("--select");
  if (selectIdx >= 0 && args[selectIdx + 1]) {
    const target = args[selectIdx + 1];
    if (SUBS_ORDER.includes(target)) {
      saveSelection(target);
    }
    return;
  }

  const wantRender = args.includes("--render") || args.length === 0;
  const wantRefresh = args.includes("--refresh");

  if (wantRefresh) {
    const { results, cache } = await refreshAll(() => {});
    const okCount = results.filter((r) => r.status === "ok").length;
    process.stderr.write(`done: ${okCount}/${results.length} ok\n`);
    if (args.includes("--render")) {
      process.stdout.write(`${renderJson(cache)}\n`);
    }
    return;
  }

  if (wantRender) {
    const cache = loadCache();
    process.stdout.write(`${renderJson(cache)}\n`);
    return;
  }
}

function renderJson(cache) {
  const now = Date.now();
  const out = {};
  for (const subsId of SUBS_ORDER) {
    const entry = cache[subsId];
    if (!entry || !entry.report) continue;
    out[subsId] = {
      ...entry,
      fresh: now - entry.fetchedAt < MAX_CACHE_AGE_MS,
      stale: now - entry.fetchedAt > REFRESH_INTERVAL_MS * 2,
    };
  }
  return JSON.stringify(out, null, 2);
}


main().catch((error) => {
  process.stderr.write(`${scrubCredentials(String(error?.message ?? error))}\n`);
  process.exit(1);
});
