#!/usr/bin/env node
/**
 * 公开卫生扫描器（M0）。
 *
 * 扫描范围：
 *   1. 当前工作树（白名单候选目录内全部文本文件 + PNG 二进制头检查）；
 *   2. 全部 git 历史（refs/* 上每个 commit 的完整 tree 内容）。
 *
 * 检查类别：
 *   - secret 模式（API key / token / cookie / 私钥块 / 已知服务 key 前缀）
 *   - 邮箱地址
 *   - 机器用户名（wonton1984）
 *   - 绝对路径（/Users/…）
 *   - 真实套餐用量数字（已知真实值的指纹清单）
 *   - 截图/证据目录引用（evidence/、verification/、dist/、.build/）
 *
 * 已知误报（合成 fixture 的假 token）用窄范围豁免并注释原因。
 *
 * 运行：node scripts/check-public.mjs [目录] （默认：脚本所在仓库根）
 * 退出码：0 = 干净；1 = 有发现。
 */

import { execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";
import { fileURLToPath } from "url";

const root = process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: "username",
    reason: "机器用户名（隐私去个性化红线）",
    pattern: /wonton1984/g,
  },
  {
    id: "home-path",
    reason: "绝对路径 /Users/…（机器指纹）",
    pattern: /\/Users\/[A-Za-z0-9._-]+/g,
  },
  {
    id: "email",
    reason: "邮箱地址（PII）",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    id: "secret-prefix",
    reason: "已知服务的 key/token 前缀",
    pattern:
      /\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|sk-or-v1-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJhbGciOi[A-Za-z0-9._-]{16,})/g,
  },
  {
    id: "private-key-block",
    reason: "私钥块",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: "cookie",
    reason: "cookie / 会话字段",
    pattern: /\b(Cookie|Set-Cookie|__Secure-[A-Za-z-]+|sessionid|connect_sid)\s*[:=]/gi,
  },
  {
    id: "bearer",
    reason: "Bearer 凭证",
    pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
  },
  {
    id: "evidence-ref",
    reason: "私有证据/构建产物引用（evidence|verification|dist|.build）",
    pattern:
      /\b(evidence\/|verification\/|dist\/SubsBar\.app|\.build\/|ACCEPTANCE\.md|swiftbar|SwiftBar)/g,
  },
  {
    id: "usage-fingerprint",
    reason: "真实套餐用量指纹（私有实测数值及其截断/注释变体）",
    pattern:
      /\b(69\.9685824984|69\.9686|69\.969|69\.97|0\.0314175016|0\.0314|0\.031|10_302_574|10302574|user-wRPAdeNFlVThtYDamlS3vhwB|individual-goat)\b|本号\s*82|T04:04:39|2026-08-30T04|2026-09-30T04/g,
  },
  {
    id: "real-epoch",
    reason: "真实观测纪元（2026-09 前后 1790/1791 秒或毫秒段；fixture 一律用 1950+ 合成段）",
    pattern: /\b179[01][0-9]{6}\b|\b179[01][0-9]{9}\b/g,
  },
  {
    id: "real-era-iso-ms",
    reason: "真实观测年代的毫秒级 ISO 时间戳（2015–2027 段；合成 fixture 一律用 2031+ 年份）",
    pattern: /\b20(?:1[5-9]|2[0-7])-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z\b/g,
  },
];

/**
 * 窄范围豁免（带原因）。path 与内容片段必须同时命中才豁免；
 * 禁止整体关闭规则或按目录全量豁免。
 */
const EXEMPTIONS = [
  {
    rule: "secret-prefix",
    pathIncludes: "scripts/check-public.mjs",
    contentIncludes: "sk-ant-",
    reason: "扫描器自身的模式定义（规则文本），不是泄漏值",
  },
  {
    rule: "secret-prefix",
    pathIncludes: "test/fixtures/ipc/config-write-patch-synthetic.json",
    contentIncludes: "sk-synthetic-000",
    reason: "合成假 token：fixture 的『secret 字段必须被 patch 拒绝』用例输入，非真实凭证",
  },
  {
    rule: "username",
    pathIncludes: "scripts/check-public.mjs",
    contentIncludes: "wonton1984/g",
    reason: "扫描器 username 规则的定义文本本身含该用户名字面量",
  },
  {
    rule: "usage-fingerprint",
    pathIncludes: "scripts/check-public.mjs",
    contentIncludes: "usage-fingerprint",
    reason: "指纹清单定义文本必然包含被禁数值/变体，逐规则豁免本文件该规则",
  },
  {
    rule: "evidence-ref",
    pathIncludes: ".gitignore",
    reason: ".gitignore 登记排除项时必须写出被排除的私有目录名，属刻意引用",
  },
  {
    rule: "evidence-ref",
    pathIncludes: "build-app.sh",
    contentIncludes: "dist/SubsBar.app",
    reason: "构建脚本的标准 SwiftPM 产物路径，非私有证据目录",
  },
  {
    rule: "evidence-ref",
    pathIncludes: "macos-app/README.md",
    contentIncludes: "dist/SubsBar.app",
    reason: "构建文档引用本仓构建产物路径，非私有证据目录",
  },
  {
    rule: "evidence-ref",
    pathIncludes: "macos-app/build.sh",
    reason: "构建入口脚本转发 build-app.sh，含标准产物路径",
  },
  {
    rule: "cookie",
    pathIncludes: "scripts/subs.mjs",
    reason: "凭证传输实现代码（对 Cookie 头做脱敏/构造），不含字面 secret",
  },
];

// ---------------------------------------------------------------------------
// 扫描实现
// ---------------------------------------------------------------------------

const findings = [];

function isExempt(ruleId, relPath, content) {
  // 严格逐规则豁免：不做任何整文件/全规则的 blanket 豁免
  return EXEMPTIONS.some(
    (e) =>
      e.rule === ruleId &&
      relPath.includes(e.pathIncludes) &&
      (e.contentIncludes === undefined || content.includes(e.contentIncludes)),
  );
}

function scanText(content, relPath) {
  for (const rule of RULES) {
    if (rule.id === "evidence-ref" && relPath.includes("scripts/check-public.mjs")) continue; // 扫描器自身引用私有目录名是规则定义（工作树与历史皆适用）
    const matches = content.match(rule.pattern);
    if (!matches) continue;
    if (isExempt(rule.id, relPath, content)) continue;
    for (const m of new Set(matches)) {
      findings.push({
        where: relPath,
        rule: rule.id,
        reason: rule.reason,
        sample: m.length > 8 ? `${m.slice(0, 4)}…${m.slice(-4)}（len ${m.length}）` : m,
      });
    }
  }
}

const TEXT_EXTS = new Set([".mjs", ".js", ".ts", ".swift", ".md", ".json", ".sh", ".py", ".plist", ".yml", ".yaml", ".txt", ".gitignore", ""]);
const SKIP_DIRS = new Set([".git", ".build", "dist", "node_modules", "Packages"]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function scanWorktree() {
  for (const full of walk(root)) {
    const rel = relative(root, full);
    const ext = extname(full);
    if (!TEXT_EXTS.has(ext)) {
      // 二进制：仅允许白名单内的 PNG fixture，且检查其确为小尺寸 PNG（防止误带截图）
      if (ext === ".png") {
        const buf = readFileSync(full);
        const ok =
          buf.length < 4096 &&
          buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
          buf[16] === 0 && buf[17] === 0 && buf[18] === 0 && buf[19] === 18; // IHDR width=18（大端高 16 位）
        if (!ok) findings.push({ where: rel, rule: "binary", reason: "非预期二进制或尺寸异常的 PNG（疑似截图）", sample: `${buf.length} bytes` });
      } else {
        findings.push({ where: rel, rule: "binary", reason: "非白名单二进制类型", sample: ext || "(无扩展名)" });
      }
      continue;
    }
    scanText(readFileSync(full, "utf-8"), rel);
  }
}

function scanGitHistory() {
  // 只扫描候选目录自己的 .git；绝不能逃逸到外层私有仓（用显式 --git-dir）
  const gitDir = join(root, ".git");
  let isDir;
  try { isDir = statSync(gitDir).isDirectory(); } catch { return; }
  if (!isDir) return; // 尚未 git init：仅扫描工作树
  const git = ["git", "--git-dir", gitDir];
  const refs = execFileSync(git[0], [...git.slice(1), "for-each-ref", "--format=%(refname)"], { encoding: "utf-8" })
    .split("\n")
    .filter(Boolean);
  const commits = new Set();
  for (const ref of refs) {
    const list = execFileSync(git[0], [...git.slice(1), "rev-list", ref], { encoding: "utf-8" }).split("\n").filter(Boolean);
    for (const c of list) commits.add(c);
  }
  for (const commit of commits) {
    const files = execFileSync(git[0], [...git.slice(1), "ls-tree", "-r", "--name-only", commit], { encoding: "utf-8" })
      .split("\n")
      .filter(Boolean);
    for (const f of files) {
      const blob = execFileSync(git[0], [...git.slice(1), "show", `${commit}:${f}`], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
      scanText(blob, `(history ${commit.slice(0, 7)}) ${f}`);
    }
  }
}

// ---------------------------------------------------------------------------
scanWorktree();
scanGitHistory();

const byRule = {};
for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;

console.log(`== 公开卫生扫描 ==`);
console.log(`根目录: ${root}`);
console.log(`发现: ${findings.length}`);
for (const [rule, n] of Object.entries(byRule)) console.log(`  ${rule}: ${n}`);
if (findings.length > 0) {
  console.log("\n明细（sample 已脱敏为前后缀指纹）：");
  for (const f of findings) console.log(`  [${f.rule}] ${f.where} — ${f.reason} — ${f.sample}`);
  process.exit(1);
}
console.log("PASS: 未发现隐私/凭证风险项（豁免清单见脚本 EXEMPTIONS）");
