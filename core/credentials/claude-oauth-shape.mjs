// Claude 凭证形状：仅离线结构体解析。不读 Keychain、不读 .credentials.json、不实现 reader。
// 官方文档：macOS 默认 Keychain；写入失败才可能落到 ~/.claude/.credentials.json。
// 字段形态来自公开源码旁证（claudeAiOauth），不是本机实测、也不是稳定 API 契约。
// borrowed 规则：refreshToken 解析后必须丢弃，不消费、不持久化、不写回、不进通用刷新路径。

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

function asFiniteNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** 借入 refresh 的禁止策略：测试与未来准入共用，不得改成可执行刷新。 */
export const CLAUDE_BORROWED_REFRESH = Object.freeze({
  consume: false,
  persist: false,
  writeBack: false,
  enterGenericRefresh: false,
});

/**
 * 解析 claudeAiOauth 对象。返回的 shape 永不包含 refreshToken。
 * input 可为 { claudeAiOauth: {...} } 或直接的 oauth 对象。
 */
export function parseClaudeAiOauth(input) {
  const root = asObject(input);
  if (!root) return { ok: false, reason: "malformed" };
  const oauth = asObject(root.claudeAiOauth) ?? (typeof root.accessToken === "string" ? root : undefined);
  if (!oauth) return { ok: false, reason: "malformed" };

  const accessToken = typeof oauth.accessToken === "string" && oauth.accessToken ? oauth.accessToken : undefined;
  const expiresAt = asFiniteNumber(oauth.expiresAt);
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((s) => typeof s === "string")
    : undefined;
  const subscriptionType = typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined;
  const rateLimitTier = typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : undefined;

  const hadRefreshField = Object.prototype.hasOwnProperty.call(oauth, "refreshToken");
  const discardedRefresh = hadRefreshField && oauth.refreshToken != null && oauth.refreshToken !== "";

  const shape = { accessToken, expiresAt, scopes, subscriptionType, rateLimitTier };
  return { ok: true, shape, discardedRefresh, expiresAtKnown: expiresAt !== undefined };
}

/** 缺 user:profile 是能力不足，不是剩余 0。scopes 缺失 ≠ 已证明权限。 */
export function claudeUsageCapability(shape) {
  const scopes = shape?.scopes;
  if (!Array.isArray(scopes)) {
    return { status: "unknown-scope", code: "insufficient-scope", remainingInvented: false, proven: false };
  }
  if (scopes.includes("user:profile")) {
    return { status: "can-read-usage", remainingInvented: false, proven: true };
  }
  return { status: "insufficient-scope", code: "insufficient-scope", remainingInvented: false, proven: false };
}

/**
 * 401 后的有界行为（§4.3）：最多重读一次同绑定来源；
 * 仅当 owner 已更新 access 且身份未变才重试；否则 reauth-required。
 * 永不消费 refresh。
 */
export function claudeOnUnauthorized({ rereadCount = 0, sameBinding = false, accessUpdated = false, identityUnchanged = false } = {}) {
  const refuseRefresh = { consumeRefresh: false, persistRefresh: false, writeBack: false };
  if (rereadCount >= 1) return { action: "reauth-required", ...refuseRefresh };
  if (sameBinding && accessUpdated && identityUnchanged) {
    return { action: "reread-once", ...refuseRefresh };
  }
  return { action: "reauth-required", ...refuseRefresh };
}

/** 无法确认账户/组织时 fail closed，不猜账号。 */
export function claudeBindKey({ accountId, organizationId, sourceRevision, generation } = {}) {
  const account = typeof accountId === "string" ? accountId.trim() : "";
  const org = typeof organizationId === "string" ? organizationId.trim() : "";
  if (!account && !org) return { ok: false, reason: "identity-unconfirmed" };
  const rev = typeof sourceRevision === "string" ? sourceRevision : "";
  const gen = Number.isInteger(generation) ? generation : 0;
  return { ok: true, key: `${account}:${org}:${rev}:${gen}`, generation: gen };
}

/** 登录源/账户变更递增 generation 后，旧结果不得落入新账号。 */
export function claudeAcceptLateResult({ bindKey, resultBindKey, generation, resultGeneration } = {}) {
  if (generation !== resultGeneration) return { accept: false, reason: "generation-mismatch" };
  if (bindKey !== resultBindKey) return { accept: false, reason: "identity-mismatch" };
  return { accept: true };
}
