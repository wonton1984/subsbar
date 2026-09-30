// SecretBroker（contracts §2.2）：secret 只以 SecretRef 引用存在，
// 仅注册目标（provider adapter）可通过 withSecret 短时取值；不可序列化。
import { randomBytes, createHmac } from "crypto";

export class SecretBroker {
  constructor() {
    /** @type {Map<string, {bytes: Uint8Array, allowedTargets: Set<string>}>} */
    this.#secrets = new Map();
  }
  #secrets;

  /** 存入明文，返回不透明引用。引用不含明文、不可 JSON 序列化（toJSON 抛出）。 */
  put(bytes, allowedTargets) {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("broker: 空 secret");
    const ref = `secret-${randomBytes(16).toString("hex")}`;
    this.#secrets.set(ref, { bytes, allowedTargets: new Set(allowedTargets) });
    return makeRef(ref);
  }

  /** 受限取值：仅 targetId 在允许清单内的操作可拿到字节。操作完成后引用由 lease.release 清理。
   *  回调必须在返回前完成消费（解码/拷贝）；finally 会 fill(0) 原始缓冲。
   *  把原始引用传出回调（`async b => b`）后读到的是全零——见 m1-scenarios 生命周期回归。 */
  async withSecret(ref, targetId, operation) {
    const entry = this.#secrets.get(ref?._id);
    if (!entry) throw new Error("broker: 未知引用");
    if (!entry.allowedTargets.has(targetId)) throw new Error("broker: 目标未获授权");
    try {
      return await operation(entry.bytes);
    } finally {
      entry.bytes.fill(0); // 短时取值后擦除（尽力而为，见 contracts §2.3 生命周期说明）
    }
  }

  /** 清除引用（lease release / 任务结束调用）。 */
  drop(ref) {
    const entry = this.#secrets.get(ref?._id);
    if (entry) { entry.bytes.fill(0); this.#secrets.delete(ref._id); }
  }

  get size() { return this.#secrets.size; }
}

function makeRef(id) {
  return {
    _id: id,
    toJSON() { throw new Error("SecretRef 不可序列化"); },
    toString() { return "[SecretRef]"; },
  };
}

/** 凭证版本指纹：HMAC(本地盐, secret)，盐存 0600 私有 state；不输出前缀/明文（contracts §2.3）。 */
export function credentialRevision(bytes, saltHex) {
  return createHmac("sha256", Buffer.from(saltHex, "hex")).update(bytes).digest("hex");
}
