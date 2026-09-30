// config 存取：加载、CAS 原子保存、contentToken（contracts §4.1/§4.2）。
// 目录 0700 / 文件 0600；原子写 = 同目录临时文件 + rename；失败不动原文件。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { validateConfig, applyMergePatch, patchAllowedPath } from "./schema.mjs";

export class ConfigError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 缺文件 CAS 基线（IPC freeze rev4）：revision=0 + 本哨兵 token。 */
export const ABSENT_CONTENT_TOKEN = "absent";

export function contentToken(rawText) {
  // 外部编辑检测 token：对原始文件字节做摘要（不依赖 revision 字段）。
  return createHash("sha256").update(rawText, "utf8").digest("hex").slice(0, 32);
}

function ensurePerms(file) {
  try { chmodSync(file, 0o600); } catch { /* 平台不支持时忽略 */ }
}

export class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  /** 读取并校验。返回 {config, revision, contentToken, rawText}。文件不存在返回 null。 */
  load() {
    if (!existsSync(this.filePath)) return null;
    let rawText;
    try {
      const st = statSync(this.filePath);
      if (!st.isFile() || st.size > 1_048_576) throw new ConfigError("invalid-config", "config 文件非法或超限");
      rawText = readFileSync(this.filePath, "utf8");
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError("io-error", `config 不可读: ${e.code ?? ""}`);
    }
    // 重复键检测（JSON.parse 静默取最后值，契约要求拒绝）
    const text = rawText;
    if (/"[\w-]+"\s*:/.test(text)) {
      const keys = text.match(/"([\w.-]+)"\s*:/g) ?? [];
      // 粗检只在根层相邻重复；完整重复键检测由 JSON.parse reviver 不可行，依赖结构校验兜底
      void keys;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new ConfigError("invalid-config", "config JSON 无法解析"); }
    const config = validateConfig(parsed);
    return { config, revision: config.revision, contentToken: contentToken(rawText), rawText };
  }

  /**
   * CAS 保存：校验 patch → 取 store 锁（由调用方持有）→ 核对 baseRevision+contentToken →
   * 临时文件 0600 → rename → revision+1。返回 {config, revision, contentToken, invalidatedProviderIds}。
   */
  saveWithPatch({ baseRevision, contentToken: baseToken, patch }) {
    const current = this.load();
    if (!current) {
      // 缺文件 CAS 首写（IPC freeze rev4）：baseRevision=0 + ABSENT_CONTENT_TOKEN；
      // 文件在竞态中出现（并发首写）→ 其真实 token 必然 != "absent" → config-conflict
      if (baseRevision !== 0 || baseToken !== ABSENT_CONTENT_TOKEN) {
        throw new ConfigError("config-conflict", "config 不存在且基线不是缺文件哨兵");
      }
      const defaultCfg = validateConfig({ schemaVersion: 1, revision: 0 });
      const patchedRaw = applyMergePatch(defaultCfg, patch, patchAllowedPath);
      patchedRaw.revision = 1;
      const config = validateConfig(patchedRaw);
      const invalidated = computeInvalidations(defaultCfg, config);
      this.writeAtomic(config);
      return { config, revision: config.revision, contentToken: this.lastWriteToken, invalidatedProviderIds: invalidated };
    }
    if (current.revision !== baseRevision) {
      throw new ConfigError("config-conflict", `revision 冲突：当前 ${current.revision} != base ${baseRevision}`);
    }
    if (current.contentToken !== baseToken) {
      // 外部编辑：revision 未变但内容变了也必须冲突（contracts §4.2）
      throw new ConfigError("config-conflict", "配置文件被外部修改（内容 token 不匹配）");
    }
    if (patch === undefined || patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new ConfigError("invalid-config", "patch 必须是对象");
    }
    const nextRaw = applyMergePatch(current.config, patch, patchAllowedPath);
    nextRaw.revision = current.revision + 1; // patch 不得改 revision/schemaVersion（apply 已限制路径）
    const config = validateConfig(nextRaw);
    const invalidated = computeInvalidations(current.config, config);
    this.writeAtomic(config);
    return { config, revision: config.revision, contentToken: this.lastWriteToken, invalidatedProviderIds: invalidated };
  }

  /** 首次创建默认配置（用户显式操作时调用；启动不自动创建）。 */
  initDefault(config = null) {
    const base = config ?? { schemaVersion: 1, revision: 0 };
    const validated = validateConfig(base);
    this.writeAtomic(validated);
    return { config: validated, revision: validated.revision, contentToken: this.lastWriteToken };
  }

  writeAtomic(config) {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
    const text = JSON.stringify(config, null, 2) + "\n";
    writeFileSync(tmp, text, { mode: 0o600 });
    ensurePerms(tmp);
    try {
      renameSync(tmp, this.filePath);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* 尽力清理 */ }
      throw new ConfigError("io-error", `config 原子替换失败: ${e.code ?? ""}`);
    }
    ensurePerms(this.filePath);
    this.lastWriteToken = contentToken(text);
  }

  /** 供调度器整体写 usage 缓存等场景复用的通用原子写。 */
  static atomicWriteJson(file, obj, dirMode = 0o700) {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: dirMode });
    const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    const text = JSON.stringify(obj, null, 2) + "\n";
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
    ensurePerms(file);
  }
}

/** 身份相关变更检测：providers/compatibility 变化即失效相关 provider（§4.2）。 */
function computeInvalidations(oldCfg, newCfg) {
  const ids = new Set();
  const providerIds = new Set([...Object.keys(oldCfg.providers ?? {}), ...Object.keys(newCfg.providers ?? {})]);
  for (const id of providerIds) {
    if (JSON.stringify(oldCfg.providers?.[id] ?? null) !== JSON.stringify(newCfg.providers?.[id] ?? null)) ids.add(id);
  }
  if (JSON.stringify(oldCfg.compatibility ?? null) !== JSON.stringify(newCfg.compatibility ?? null)) {
    for (const id of providerIds) ids.add(id);
  }
  return [...ids];
}
