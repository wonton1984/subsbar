#!/usr/bin/env node
/**
 * docs 交叉引用检查（M3 public-hygiene）：
 *   1. docs/ 与 README 的相对 markdown 链接指向存在的文件；
 *   2. docs/providers/ 覆盖全部 14 家 manifest；
 *   3. schemas/ 引用的文件存在；
 *   4. 禁止 docs 链接指向私有路径（evidence/verification/notes/dist）。
 * 运行：node scripts/check-docs.mjs ；退出码 0 = 全过。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname, normalize } from "path";
import { fileURLToPath } from "url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const findings = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".md")) yield full;
  }
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

for (const file of walk(root)) {
  const rel = file.slice(root.length + 1);
  // 相对链接目标以该 md 所在目录解析
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(LINK_RE)) {
    const target = m[1];
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#") || target.startsWith("mailto:")) continue;
    const abs = normalize(join(dirname(file), decodeURI(target.split("#")[0])));
    if (!existsSync(abs)) findings.push(`${rel}: 链接目标不存在 ${target}`);
    const n = normalize(target.split("#")[0]);
    if (/^(evidence|verification|dist|notes)\//.test(n)) findings.push(`${rel}: 链接指向私有路径 ${target}`);
  }
}

// docs/providers 覆盖 14 家
const manifests = readdirSync(join(root, "core", "providers", "manifests")).filter((f) => f.endsWith(".json"));
for (const mf of manifests) {
  const id = mf.replace(".json", "");
  const doc = join(root, "docs", "providers", id + ".md");
  if (!existsSync(doc)) findings.push(`docs/providers/${id}.md 缺失（manifest ${mf}）`);
}

// schema 引用
for (const s of ["config-v1", "usage-v1", "provider-manifest-v1"]) {
  if (!existsSync(join(root, "schemas", s + ".schema.json"))) findings.push(`schemas/${s}.schema.json 缺失`);
}

console.log(`docs 检查：${findings.length} 项问题`);
if (findings.length > 0) for (const f of findings) console.log("  - " + f), process.exitCode = 1;
else console.log("PASS: docs 交叉引用/覆盖完整");
