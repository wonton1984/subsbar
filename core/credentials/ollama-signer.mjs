// Ollama Cloud request-signer（官方 CLI 同款：OpenSSH Ed25519 → Authorization）。
// 只签固定 host/method/path + unix ts。私钥只在本进程内使用，不进 URL/配置/日志。
// node:crypto / OpenSSL 3 不能直接 decode OpenSSH Ed25519；未加密钥走手写解析 + JWK。
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "crypto";

export const OLLAMA_ORIGIN = "https://ollama.com";
export const OLLAMA_USAGE_PATH = "/api/usage";
export const OLLAMA_ME_PATH = "/api/me";

const OPENSSH_KIND = "OPENSSH PRIVATE KEY";

export function isOllamaOpenSshKey(text) {
  return typeof text === "string"
    && text.includes(`-----BEGIN ${OPENSSH_KIND}-----`)
    && text.includes(`-----END ${OPENSSH_KIND}-----`);
}

/** 普通 API key / 空串：不能当 quota 凭证。 */
export function isOllamaApiKey(text) {
  return typeof text === "string" && text.trim() !== "" && !isOllamaOpenSshKey(text);
}

export function ollamaUsageUrl(ts) {
  return `${OLLAMA_ORIGIN}${OLLAMA_USAGE_PATH}?ts=${ts}`;
}

export function ollamaUsageChallenge(ts) {
  return `GET,${OLLAMA_USAGE_PATH}?ts=${ts}`;
}

export function ollamaMeChallenge(ts) {
  return `POST,${OLLAMA_ME_PATH}?ts=${ts}`;
}

function sshString(buf) {
  const out = Buffer.alloc(4 + buf.length);
  out.writeUInt32BE(buf.length, 0);
  buf.copy(out, 4);
  return out;
}

export function opensshEd25519PublicB64(pub32) {
  if (!Buffer.isBuffer(pub32) || pub32.length !== 32) throw new Error("ollama-signer: public key length");
  return Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(pub32)]).toString("base64");
}

/** 只接受 cipher=none 的 OpenSSH Ed25519。口令加密钥拒绝。 */
export function parseOpenSshEd25519(pem) {
  const text = Buffer.isBuffer(pem) ? pem.toString("utf8") : String(pem ?? "");
  if (!isOllamaOpenSshKey(text)) throw new Error("ollama-signer: not an OpenSSH private key");
  const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = Buffer.from(b64, "base64");
  const magic = Buffer.from("openssh-key-v1\0");
  if (bin.length < magic.length || !bin.subarray(0, magic.length).equals(magic)) throw new Error("ollama-signer: bad magic");
  let o = magic.length;
  const u32 = () => {
    if (o + 4 > bin.length) throw new Error("ollama-signer: truncated");
    const n = bin.readUInt32BE(o);
    o += 4;
    return n;
  };
  const str = () => {
    const n = u32();
    if (n < 0 || o + n > bin.length) throw new Error("ollama-signer: truncated");
    const s = bin.subarray(o, o + n);
    o += n;
    return s;
  };
  const cipher = str().toString();
  const kdf = str().toString();
  str();
  const nkeys = u32();
  if (nkeys !== 1) throw new Error("ollama-signer: unexpected key count");
  str();
  const priv = str();
  if (cipher !== "none" || kdf !== "none") throw new Error("ollama-signer: encrypted key unsupported");
  if (priv.length < 8) throw new Error("ollama-signer: truncated private");
  let p = 8;
  const ru32 = () => {
    if (p + 4 > priv.length) throw new Error("ollama-signer: truncated private");
    const n = priv.readUInt32BE(p);
    p += 4;
    return n;
  };
  const rstr = () => {
    const n = ru32();
    if (n < 0 || p + n > priv.length) throw new Error("ollama-signer: truncated private");
    const s = priv.subarray(p, p + n);
    p += n;
    return s;
  };
  const type = rstr().toString();
  if (type !== "ssh-ed25519") throw new Error("ollama-signer: not ed25519");
  const pub = rstr();
  const privpub = rstr();
  if (pub.length !== 32 || privpub.length !== 64) throw new Error("ollama-signer: bad ed25519 sizes");
  if (!privpub.subarray(32).equals(pub)) throw new Error("ollama-signer: public mismatch");
  return { seed: Buffer.from(privpub.subarray(0, 32)), pub: Buffer.from(pub) };
}

export function ed25519KeyPairFromOpenSsh(pem) {
  const { seed, pub } = parseOpenSshEd25519(pem);
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: pub.toString("base64url") },
    format: "jwk",
  });
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") },
    format: "jwk",
  });
  return { privateKey, publicKey, pub, pubB64: opensshEd25519PublicB64(pub) };
}

export function signOllamaChallenge(keyPem, challenge) {
  if (typeof challenge !== "string" || !/^(GET|POST),\/api\/(usage|me)\?ts=\d+$/.test(challenge)) {
    throw new Error("ollama-signer: challenge not in allowlist");
  }
  const { privateKey, publicKey, pubB64 } = ed25519KeyPairFromOpenSsh(keyPem);
  const raw = cryptoSign(null, Buffer.from(challenge, "utf8"), privateKey);
  if (!cryptoVerify(null, Buffer.from(challenge, "utf8"), publicKey, raw)) {
    throw new Error("ollama-signer: self-verify failed");
  }
  return {
    authorization: `${pubB64}:${raw.toString("base64")}`,
    challenge,
  };
}
