// CredentialStores + reader 实现（contracts §2.4）。
// discover 只做存在性/可用性检查（不读 secret 正文、不弹框、不发网络）；
// resolve 才读取内容。所有错误折为固定 reasonCode，不携带路径/原文。
import { existsSync, statSync, readFileSync } from "fs";
import { execFileSync } from "child_process";
import { createDecipheriv } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { safeText } from "../defs.mjs";

/** Factory CLI Keychain 项（本机核实：account=auth-encryption-key-security-cli，不是 auth-encryption-key）。 */
export const FACTORY_KEYCHAIN_SERVICE = "Factory CLI";
export const FACTORY_KEYCHAIN_ACCOUNT = "auth-encryption-key-security-cli";

const FILE_LIMIT = 1024 * 1024; // 具名文件默认上限 1MiB

export class ReaderOutcome extends Error {
  constructor(status, reasonCode, detail) {
    super(detail ?? reasonCode);
    this.status = status;        // "missing" | "invalid" | "resolved" | "rejected" | "skipped" | "locked" | "unsupported"
    this.reasonCode = reasonCode;
  }
}

/**
 * SubsBar 自有 Keychain 命名约定（IPC freeze rev5）：
 *   service = "SubsBar credential <providerId>"（Swift Security 框架写入同此命名）
 *   account = "<providerId>:<profileId>"
 * Node keychain reader 按此约定读取；label 不得含用户名；诊断/日志/缓存永不落 key。
 */
export function subsbarCredentialService(providerId) {
  return `SubsBar credential ${providerId}`;
}

export function subsbarCredentialAccount(providerId, profileId) {
  return `${providerId}:${profileId}`;
}

function expand(p) {
  if (typeof p !== "string") return p;
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const USER_RE = /^[A-Za-z0-9_.-]+$/;

/** 控制台用户名：`stat -f '%Su' /dev/console`，不读 $HOME。 */
export function consoleUserName() {
  if (process.platform !== "darwin") return undefined;
  try {
    const user = execFileSync("/usr/bin/stat", ["-f", "%Su", "/dev/console"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return USER_RE.test(user) ? user : undefined;
  } catch {
    return undefined;
  }
}

/** 控制台用户家目录：dscl NFSHomeDirectory，不读 $HOME。 */
export function consoleUserHome() {
  const user = consoleUserName();
  if (!user) return undefined;
  try {
    const out = execFileSync("/usr/bin/dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
    const m = String(out).match(/NFSHomeDirectory:\s*(\/\S+)/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** 真实 login keychain 路径（console user，不依赖进程 HOME）。 */
export function defaultLoginKeychainPath() {
  const home = consoleUserHome();
  if (!home) return undefined;
  for (const name of ["login.keychain-db", "login.keychain"]) {
    const p = join(home, "Library", "Keychains", name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** 解析 spec.keychainPath；~/ 相对 console user home。相对路径拒绝。 */
export function resolveKeychainPath(explicit) {
  if (typeof explicit === "string" && explicit) {
    if (explicit.startsWith("~/")) {
      const home = consoleUserHome();
      return home ? join(home, explicit.slice(2)) : undefined;
    }
    if (!explicit.startsWith("/")) return undefined;
    return explicit;
  }
  return defaultLoginKeychainPath();
}

/**
 * security find-generic-password 参数。discover 不得带 -w（无弹框）；
 * resolve 才带 -w。keychain 路径放末尾，不进 search-list 改写。
 */
export function securityFindArgs({ service, account, keychainPath, readSecret = false }) {
  const args = ["find-generic-password", "-s", service];
  if (account) args.push("-a", account);
  if (readSecret) args.push("-w");
  const kc = resolveKeychainPath(keychainPath);
  if (kc) args.push(kc);
  return args;
}

/** 静默检查文件存在且是常规文件（目录/FIFO/设备拒绝）。 */
export function fileExistsQuiet(path) {
  try {
    const st = statSync(expand(path));
    return st.isFile();
  } catch {
    return false;
  }
}

/** 有界读取文件；非 regular/超限/非 UTF-8 → rejected(file-malformed)。 */
export function readFileBounded(path, limit = FILE_LIMIT) {
  const abs = expand(path);
  let st;
  try { st = statSync(abs); } catch { throw new ReaderOutcome("missing", "not-configured"); }
  if (!st.isFile()) throw new ReaderOutcome("rejected", "file-malformed");
  if (st.size > limit) throw new ReaderOutcome("rejected", "file-malformed");
  let data;
  try { data = readFileSync(abs); } catch { throw new ReaderOutcome("rejected", "io-error"); }
  const text = data.toString("utf8");
  if (text.includes("\uFFFD")) throw new ReaderOutcome("rejected", "file-malformed");
  return { text, data };
}

// ---------------------------------------------------------------------------
// CredentialStores：按 reader implementationId 注册的具体读取能力。
// discover(spec) → {status, reasonCode?}；resolve(spec, ctx) → {bytes} 或抛 ReaderOutcome。
// ---------------------------------------------------------------------------

export function createCredentialStores({ env = process.env } = {}) {
  const impls = new Map();

  function register(implementationId, { discover, resolve }) {
    impls.set(implementationId, { discover, resolve });
  }

  // ---- env：只检查注册变量是否存在；不枚举整环境 ----
  register("env-generic", {
    discover(spec) {
      const name = spec.envName;
      if (typeof name !== "string" || !name) return { status: "unsupported", reasonCode: "reader-unavailable" };
      const v = env[name];
      if (v === undefined) return { status: "missing", reasonCode: "not-configured" };
      if (v === "") return { status: "invalid", reasonCode: "file-malformed" }; // 显式空 = invalid，停止
      return { status: "resolved", reasonCode: undefined };
    },
    resolve(spec) {
      const name = spec.envName;
      const v = env[name];
      if (v === undefined) throw new ReaderOutcome("missing", "not-configured");
      if (v === "") throw new ReaderOutcome("rejected", "file-malformed");
      // OAuth 形状 token 的 JWT exp 提取（保守拒绝已过期，§2.3）；API key 无到期元数据 → unknown
      return { bytes: new TextEncoder().encode(v), expiry: expiryFromJwt(v) };
    },
  });

  // ---- 具名 JSON 文件：stat 检查；resolve 有界读取 + 固定字段提取 ----
  register("json-file-generic", {
    discover(spec) {
      const path = spec.path ?? implDefaults(spec.reader)?.path;
      if (!path || !fileExistsQuiet(path)) return { status: "missing", reasonCode: "not-configured" };
      return { status: "resolved", reasonCode: undefined };
    },
    resolve(spec) {
      const path = spec.path ?? implDefaults(spec.reader)?.path;
      if (!path) throw new ReaderOutcome("unsupported", "reader-unavailable");
      const { data } = readFileBounded(path);
      let json;
      try { json = JSON.parse(data.toString("utf8")); } catch { throw new ReaderOutcome("rejected", "file-malformed"); }
      const extract = implDefaults(spec.reader)?.extract;
      if (!extract) throw new ReaderOutcome("unsupported", "reader-unavailable");
      const out = extract(json);
      if (!out) throw new ReaderOutcome("rejected", "file-malformed");
      return out; // {bytes, expiry?, identity?}
    },
  });

  // ---- Keychain：无提示存在性检查；resolve 才读取（交互仅 user-connect）----
  // 平台守卫：Security 框架仅 macOS；其他平台该存储不存在 → unsupported（非错误）。
  const IS_DARWIN = process.platform === "darwin";
  register("keychain-generic", {
    discover(spec) {
      if (!IS_DARWIN) return { status: "unsupported", reasonCode: "reader-unavailable" };
      const { service, account, keychainPath } = spec;
      if (typeof service !== "string" || !service) return { status: "unsupported", reasonCode: "reader-unavailable" };
      // find-generic-password 无 -w 不读密码，可静默判定存在性；非零+itemNotFound → missing
      try {
        const args = securityFindArgs({ service, account, keychainPath, readSecret: false });
        execFileSync("/usr/bin/security", args, { stdio: "ignore", timeout: 5000 });
        return { status: "resolved", reasonCode: undefined };
      } catch (e) {
        if (e.status === 44 || e.status === 45) return { status: "missing", reasonCode: "not-configured" };
        return { status: "locked", reasonCode: "keychain-denied" }; // 无法确认 → locked（等 user-connect）
      }
    },
    resolve(spec, ctx) {
      if (!IS_DARWIN) throw new ReaderOutcome("unsupported", "reader-unavailable");
      const { service, account, keychainPath } = spec;
      if (ctx.interaction !== "user-connect" && spec.reader?.endsWith("owner-keychain") === false) {
        // 后台：仅允许无提示读取（owner 存储的项一般可无提示读）；拒绝即 permission-denied，不弹框
      }
      try {
        const args = securityFindArgs({ service, account, keychainPath, readSecret: true });
        const out = execFileSync("/usr/bin/security", args, { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, maxBuffer: 65536 });
        const secret = out.toString("utf8").replace(/\n$/, "");
        if (!secret) throw new ReaderOutcome("rejected", "file-malformed");
        return { bytes: new TextEncoder().encode(secret) };
      } catch (e) {
        if (e instanceof ReaderOutcome) throw e;
        if (e.status === 44 || e.status === 45) throw new ReaderOutcome("missing", "not-configured");
        if (e.status === 128 || e.status === 51 || e.status === 77) throw new ReaderOutcome("rejected", "keychain-denied");
        throw new ReaderOutcome("rejected", "keychain-denied");
      }
    },
  });

  // ---- pi：显式兼容开关下的固定 auth 键只读 ----
  register("pi-generic", {
    discover(spec, ctx) {
      if (!ctx.compatibility?.pi?.enabled) return { status: "skipped", reasonCode: "reader-unavailable" };
      const path = spec.path ?? ctx.compatibility?.pi?.agentDir;
      const key = implDefaults(spec.reader)?.piKey;
      if (!path || !key || !fileExistsQuiet(join(path, "auth.json"))) return { status: "missing", reasonCode: "not-configured" };
      return { status: "resolved", reasonCode: undefined };
    },
    resolve(spec, ctx) {
      if (!ctx.compatibility?.pi?.enabled) throw new ReaderOutcome("skipped", "reader-unavailable");
      const path = spec.path ?? ctx.compatibility?.pi?.agentDir;
      const key = implDefaults(spec.reader)?.piKey;
      const { data } = readFileBounded(join(path, "auth.json"));
      let json;
      try { json = JSON.parse(data.toString("utf8")); } catch { throw new ReaderOutcome("rejected", "file-malformed"); }
      const entry = json?.[key];
      if (!entry || typeof entry !== "object") throw new ReaderOutcome("missing", "not-configured");
      const secret = entry.key ?? entry.access ?? entry.accessToken;
      if (typeof secret !== "string" || !secret) throw new ReaderOutcome("rejected", "file-malformed");
      // 只读、不刷新、不写回（contracts §2.4 pi 行）
      return { bytes: new TextEncoder().encode(secret), expiry: expiryFromJwt(secret) };
    },
  });

  // ---- cli-session：固定程序定位/版本探测（resolve 由 provider adapter 经 endpoint commandId 执行）----
  register("cli-generic", {
    discover(spec) {
      const exe = spec.executablePath ?? implDefaults(spec.reader)?.executable;
      if (!exe || !existsSync(expand(exe))) return { status: "missing", reasonCode: "not-configured" };
      return { status: "resolved", reasonCode: undefined };
    },
    resolve() {
      // cli-session 的 secret 是能力句柄（capabilityId），不是可复制 token；
      // 实际调用由 FetchContext.request 走受控命令。v1 由各 provider adapter 决定。
      throw new ReaderOutcome("unsupported", "not-implemented");
    },
  });

  // ---- sqlite/IDE（Cursor）：具名库静默检查；固定只读 SELECT 由实现封装 ----
  register("cursor-state-db", {
    discover(spec) {
      const path = spec.path ?? "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb";
      if (!fileExistsQuiet(path)) return { status: "missing", reasonCode: "not-configured" };
      return { status: "resolved", reasonCode: undefined };
    },
    resolve(spec) {
      const path = expand(spec.path ?? "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
      // 只读模式打开；不导出整库，只取固定 key
      let out;
      try {
        out = execFileSync("/usr/bin/sqlite3", ["-readonly", path,
          "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken';"], { maxBuffer: 65536, timeout: 5000 });
      } catch (e) {
        if (e.status === 14 || /unable to open/.test(String(e.message))) throw new ReaderOutcome("rejected", "io-error");
        throw new ReaderOutcome("rejected", "file-malformed");
      }
      const secret = out.toString("utf8").trim().replace(/^"|"$/g, "");
      if (!secret) throw new ReaderOutcome("missing", "not-configured");
      return { bytes: new TextEncoder().encode(secret), expiry: expiryFromJwt(secret) };
    },
  });

  // ---- 复合加密文件（Factory）：文件+指定 Keychain 项成对；discover 只做存在性，resolve 才解密 ----
  register("factory-login-composite", {
    discover(spec, ctx) {
      const file = spec.path ?? "~/.factory/auth.v2.loginkeychain";
      if (!fileExistsQuiet(file)) return { status: "missing", reasonCode: "not-configured" };
      // 合成测试可跳过真实 Keychain；生产路径仍检查指定项（无提示、不读 secret）
      if (typeof ctx?.testAesKeyB64 === "string" && ctx.testAesKeyB64) {
        return { status: "resolved", reasonCode: undefined };
      }
      const kc = impls.get("keychain-generic").discover({
        service: spec.service ?? FACTORY_KEYCHAIN_SERVICE,
        account: spec.account ?? FACTORY_KEYCHAIN_ACCOUNT,
        keychainPath: spec.keychainPath,
      });
      if (kc.status === "unsupported") return { status: "unsupported", reasonCode: "reader-unavailable" };
      if (kc.status === "missing") return { status: "missing", reasonCode: "not-configured" };
      if (kc.status === "locked") return { status: "locked", reasonCode: "keychain-denied" };
      return { status: "resolved", reasonCode: undefined };
    },
    resolve(spec, ctx) {
      const file = spec.path ?? "~/.factory/auth.v2.loginkeychain";
      const { text } = readFileBounded(file);
      let keyB64;
      if (typeof ctx?.testAesKeyB64 === "string" && ctx.testAesKeyB64) {
        keyB64 = ctx.testAesKeyB64;
      } else {
        const kc = impls.get("keychain-generic").resolve({
          service: spec.service ?? FACTORY_KEYCHAIN_SERVICE,
          account: spec.account ?? FACTORY_KEYCHAIN_ACCOUNT,
          reader: spec.reader,
          keychainPath: spec.keychainPath,
        }, ctx);
        keyB64 = new TextDecoder().decode(kc.bytes);
      }
      return decryptFactoryLogin(text, keyB64);
    },
  });

  // ---- browser / local-api / request-signer：v1 显式准入才实现 ----
  register("browser-generic", {
    discover() { return { status: "skipped", reasonCode: "reader-unavailable" }; },
    resolve() { throw new ReaderOutcome("unsupported", "not-implemented"); },
  });
  register("localapi-generic", {
    discover() { return { status: "skipped", reasonCode: "reader-unavailable" }; },
    resolve() { throw new ReaderOutcome("unsupported", "not-implemented"); },
  });
  register("ollama-signing-key", {
    discover(spec) {
      const path = spec.path ?? "~/.ollama/id_ed25519";
      if (!fileExistsQuiet(path)) return { status: "missing", reasonCode: "not-configured" };
      return { status: "resolved", reasonCode: undefined };
    },
    resolve() { throw new ReaderOutcome("unsupported", "not-implemented"); }, // 签名能力经 broker，v1 探测后接入
  });

  // cli-session 别名：各家官方 CLI reader 共用受控探测实现
  for (const alias of ["codex-official", "claude-official-usage", "copilot-official", "agy-official-usage"]) {
    impls.set(alias, impls.get("cli-generic"));
  }
  // kind 别名表（manifest implementationId → 通用实现）：按 kind 分流，env 不得误接 keychain
  const envAliases = ["zai-env-key", "kimi-env-key", "commandcode-env-key", "droid-env-key", "openrouter-env-key", "codex-env-token"];
  const keychainAliases = ["codex-subsbar-key", "opencode-subsbar-key", "kimi-subsbar-key", "commandcode-subsbar-key",
    "droid-subsbar-key", "zai-subsbar-key", "openrouter-subsbar-key", "grok-subsbar-key",
    "devin-subsbar-session", "copilot-gh-keychain", "openrouter-management-key"];
  const fileAliases = ["codex-auth-file", "opencode-auth-file", "grok-auth-file", "devin-toml", "copilot-apps-json"];
  const piAliases = ["openai-codex", "opencode-go", "kimi-coding", "commandcode", "openrouter",
    "zai", "zai-coding-cn", "claude-pi-anthropic", "github-copilot"];
  for (const a of envAliases) impls.set(a, impls.get("env-generic"));
  for (const a of keychainAliases) impls.set(a, impls.get("keychain-generic"));
  for (const a of fileAliases) impls.set(a, impls.get("json-file-generic"));
  for (const a of piAliases) impls.set(a, impls.get("pi-generic"));

  // 各 reader 的默认路径/pi 键/默认可执行登记（manifest 的 implementationId → 元数据）
  const defaults = new Map([
    ["codex-auth-file", { path: join(env.CODEX_HOME ? expand(env.CODEX_HOME) : "", "auth.json"), extract: codexAuthExtract }],
    ["codex-official", { executable: "/opt/homebrew/bin/codex" }],
    ["opencode-auth-file", { path: join(env.OPENCODE_DATA_DIR ?? join(homedir(), ".local", "share", "opencode"), "auth.json"), extract: opencodeAuthExtract }],
    ["openai-codex", { piKey: "openai-codex" }],
    ["opencode-go", { piKey: "opencode-go" }],
    ["kimi-coding", { piKey: "kimi-coding" }],
    ["commandcode", { piKey: "commandcode" }],
    ["openrouter", { piKey: "openrouter" }],
    ["grok-auth-file", { path: join(env.GROK_HOME ? expand(env.GROK_HOME) : "", ".grok", "auth.json"), extract: grokAuthExtract }],
    ["devin-credentials-toml", { path: "~/.local/share/devin/credentials.toml" }],
    ["copilot-apps-json", { path: join(env.XDG_CONFIG_HOME ? expand(env.XDG_CONFIG_HOME) : join(homedir(), ".config"), "github-copilot", "apps.json"), extract: copilotAppsExtract }],
    ["claude-pi-anthropic", { piKey: "anthropic" }],
    ["github-copilot", { piKey: "github-copilot" }],
    ["openrouter", { piKey: "openrouter" }],
  ]);
  function implDefaults(readerId) { return defaults.get(readerId); }

  return {
    discover(implementationId, spec, ctx) {
      const impl = impls.get(implementationId);
      if (!impl) return { status: "unsupported", reasonCode: "reader-unavailable" };
      try { return impl.discover(spec, ctx); }
      catch (e) { return e instanceof ReaderOutcome ? { status: e.status, reasonCode: e.reasonCode } : { status: "rejected", reasonCode: "io-error" }; }
    },
    resolve(implementationId, spec, ctx) {
      const impl = impls.get(implementationId);
      if (!impl) throw new ReaderOutcome("unsupported", "reader-unavailable");
      return impl.resolve(spec, ctx);
    },
  };
}

function codexAuthExtract(json) {
  // codex auth.json：tokens.access_token（JWT）或 OPENAI_API_KEY（不作订阅凭证，仅形状检查）
  const token = json?.tokens?.access_token;
  if (typeof token === "string" && token.length >= 16) {
    return { bytes: new TextEncoder().encode(token), expiry: expiryFromJwt(token) };
  }
  throw new ReaderOutcome("rejected", "file-malformed");
}

function opencodeAuthExtract(json) {
  const entry = json?.["opencode-go"] ?? json?.opencode;
  const key = entry?.key ?? entry?.apiKey;
  if (typeof key === "string" && key.length >= 16) return { bytes: new TextEncoder().encode(key) };
  throw new ReaderOutcome("rejected", "file-malformed");
}

function copilotAppsExtract(json) {
  // github-copilot apps.json：{"github.com":{"oauth_token":"gho_…"}}
  const entry = json?.["github.com"];
  const token = entry?.oauth_token;
  if (typeof token === "string" && token.length >= 16) return { bytes: new TextEncoder().encode(token) };
  throw new ReaderOutcome("rejected", "file-malformed");
}

function grokAuthExtract(json) {
  const token = json?.access_token ?? json?.apiKey ?? json?.tokens?.access_token;
  if (typeof token === "string" && token.length >= 16) {
    return { bytes: new TextEncoder().encode(token), expiry: expiryFromJwt(token) };
  }
  throw new ReaderOutcome("rejected", "file-malformed");
}

/**
 * 合成/生产共用：AES-256-GCM 解密 auth.v2.loginkeychain（iv:tag:data，key 为 32 字节的 base64）。
 * AEAD 失败 → file-malformed；不在此读真实 Keychain。
 */
export function decryptFactoryLogin(rawText, keyB64) {
  if (typeof rawText !== "string" || !rawText.includes(":")) {
    throw new ReaderOutcome("rejected", "file-malformed");
  }
  const parts = rawText.trim().split(":");
  if (parts.length !== 3) throw new ReaderOutcome("rejected", "file-malformed");
  const [ivB64, tagB64, dataB64] = parts;
  let key;
  try {
    key = Buffer.from(String(keyB64 ?? ""), "base64");
  } catch {
    throw new ReaderOutcome("rejected", "file-malformed");
  }
  if (key.length !== 32) throw new ReaderOutcome("rejected", "file-malformed");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const creds = JSON.parse(out);
    const token = creds?.access_token;
    if (typeof token !== "string" || !token) throw new ReaderOutcome("rejected", "file-malformed");
    return { bytes: new TextEncoder().encode(token), expiry: expiryFromJwt(token) };
  } catch (e) {
    if (e instanceof ReaderOutcome) throw e;
    throw new ReaderOutcome("rejected", "file-malformed");
  }
}

/** 未验签 JWT 的 exp 仅用于保守拒绝已过期（§2.3）；sub/org 不作 verified 身份。 */
export function expiryFromJwt(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload && typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0) {
      return { state: "known", expiresAtMs: Math.round(payload.exp * 1000), evidence: "jwt-claim" };
    }
  } catch { /* 非 JWT */ }
  return undefined;
}

export { safeText };
