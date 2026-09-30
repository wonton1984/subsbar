// 进程间锁（contracts §5.2）：refresh-leader 与 store 两个锁域。
// 原子 mkdir 竞争 + owner（PID/起始时间/随机 nonce）；不凭 TTL 强删活锁，
// 仅当 owner 进程确认死亡（ESRCH）时回收；PID 复用保守处理。
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

function processStartKey() {
  return `${process.pid}-${Math.floor(process.uptime())}`;
}

function readLockInfo(path) {
  try {
    return JSON.parse(readFileSync(join(path, "owner"), "utf8"));
  } catch { return undefined; }
}

/** owner 进程死亡判定：ESRCH 即死；存活但 startKey 不同且锁文件 >10 分钟旧 → 保守判死。 */
function holderDead(path, info) {
  if (typeof info?.pid !== "number") return true;
  try {
    process.kill(info.pid, 0); // EPERM=存活（他人进程），ESRCH=死亡
    let mtimeMs = 0;
    try { mtimeMs = statSync(join(path, "owner")).mtimeMs; } catch { return false; }
    return info.startKey !== processStartKey() && Date.now() - mtimeMs > 10 * 60_000;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

export class LockBackend {
  constructor(stateDir) {
    this.stateDir = stateDir;
  }

  lockPath(name) { return join(this.stateDir, `lock-${name}`); }

  /**
   * 获取锁。成功：{ownerNonce, release()}；被占：{status:"busy", holder, cancelled?}。
   * timeoutMs 内轮询；signal 已取消立即返回。
   */
  async acquire(name, timeoutMs, signal, { reason = "" } = {}) {
    const path = this.lockPath(name);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (signal?.aborted) return { status: "busy", cancelled: true };
      try {
        mkdirSync(path); // 原子：已存在抛 EEXIST
        const ownerNonce = randomBytes(16).toString("hex");
        writeFileSync(join(path, "owner"), JSON.stringify({
          pid: process.pid, startKey: processStartKey(), nonce: ownerNonce,
          acquiredAtMs: Date.now(), reason,
        }), { mode: 0o600 });
        return {
          ownerNonce,
          release: async () => {
            try {
              const cur = readLockInfo(path);
              if (cur?.nonce === ownerNonce) rmSync(path, { recursive: true, force: true });
            } catch { /* 已消失 */ }
          },
        };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const info = readLockInfo(path);
        if (info && holderDead(path, info)) {
          try { rmSync(path, { recursive: true, force: true }); continue; } catch { /* 竞争：他人回收 */ }
        }
        if (Date.now() >= deadline) return { status: "busy", holder: info };
        await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
      }
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

export { existsSync };
