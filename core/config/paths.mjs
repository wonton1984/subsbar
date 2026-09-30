// 配置路径解析（contracts §4.1）。只展开 ~/ 前缀；不做其他变量插值。
import { homedir } from "os";
import { join } from "path";

function expandTilde(p) {
  if (typeof p !== "string" || !p.startsWith("~/")) return p;
  return join(homedir(), p.slice(2));
}

export function resolveConfigPath({ configFlag, env = process.env } = {}) {
  const candidates = [configFlag, env.SUBSBAR_CONFIG, null, null];
  const xdg = env.XDG_CONFIG_HOME ? expandTilde(env.XDG_CONFIG_HOME) : null;
  candidates[2] = xdg ? join(xdg, "subsbar", "config.json") : join(homedir(), ".config", "subsbar", "config.json");
  candidates[3] = join(homedir(), ".config", "subsbar", "config.json");
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      const abs = expandTilde(c);
      if (!abs.startsWith("/")) throw new Error("invalid-config: 配置路径必须是绝对路径");
      return abs;
    }
  }
}

export function resolveStateDirs({ env = process.env } = {}) {
  const cacheBase = env.XDG_CACHE_HOME ? expandTilde(env.XDG_CACHE_HOME) : join(homedir(), ".cache");
  const stateBase = env.XDG_STATE_HOME ? expandTilde(env.XDG_STATE_HOME) : join(homedir(), ".local", "state");
  return {
    cacheDir: join(cacheBase, "subsbar"),
    stateDir: join(stateBase, "subsbar"),
    usageCacheFile: join(cacheBase, "subsbar", "usage-v1.json"),
    runtimeStateFile: join(stateBase, "subsbar", "runtime-v1.json"),
  };
}
