// usage 投影（IPC freeze rev4 / C07·C21）：缓存读取必须按当前配置与失效记录投影，
// 防止 disabled provider 泄漏旧数值、跨 profile/scope 重现旧账号数据。
import { safeError } from "../defs.mjs";

function strippedEntry(providerId, why) {
  const base = {
    providerId,
    status: "disabled",
    freshness: "none",
    dataDisposition: "none",
    attempt: { state: "never" },
    diagnostics: [],
  };
  if (why === "stale-foreign") {
    base.status = "not-configured";
    base.error = safeError("not-configured", "not-configured", "configure-source");
    base.diagnostics = [{ code: "stale-foreign", severity: "info", action: "configure-source" }];
  }
  return base;
}

/**
 * 按当前 config + 失效记录投影 usage envelope。
 * @param envelope 持久化 usage-v1（或内存构造）
 * @param opts.config 规范化 config（可为 null=空 HOME）
 * @param opts.invalidated runtime state 的 {providerId: 失效时 config.revision}
 * @returns 新 envelope（不改输入）
 */
export function projectUsage(envelope, { config, invalidated = {} } = {}) {
  const providersCfg = config?.providers ?? {};
  const providers = envelope.providers.map((entry) => {
    const pcfg = providersCfg[entry.providerId];
    // 规则1：未配置或 disabled → 全剥离（显式 disabled 条目，不静默消失）
    if (!pcfg?.enabled) {
      return { ...strippedEntry(entry.providerId, "disabled"), cacheRevision: envelope.cacheRevision };
    }
    // 规则2：条目属于其他 profile → stale-foreign（旧 scope 数值不得重现）
    const activeProfile = pcfg.activeProfile;
    if (entry.profileId && activeProfile && entry.profileId !== activeProfile) {
      return { ...strippedEntry(entry.providerId, "stale-foreign"), profileId: activeProfile, cacheRevision: envelope.cacheRevision };
    }
    // 规则3：身份相关失效（config set invalidatedProviderIds）后未重新采样 → 不投影
    const invalidatedAt = invalidated[entry.providerId];
    const fetchedAtRev = entry.configRevision;
    if (typeof invalidatedAt === "number" && (typeof fetchedAtRev !== "number" || fetchedAtRev < invalidatedAt)) {
      return { ...strippedEntry(entry.providerId, "stale-foreign"), profileId: activeProfile, cacheRevision: envelope.cacheRevision };
    }
    return { ...entry, cacheRevision: envelope.cacheRevision };
  });
  return { ...envelope, providers };
}
