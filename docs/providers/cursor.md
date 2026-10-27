# cursor

> 状态：已实现（来源成熟度 C）。本文为 M0 占位草案，M2 验收后补全来源版本、已验证 CLI 版本、fixture 清单与人工验收记录。

## 数据来源

Cursor IDE state.vscdb（本地只读）+ usage-summary / Dashboard RPC

## 凭证方式

IDE state.vscdb 默认路径 ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb；Keychain 派生请求

## 口径说明（首发指标）

included 额度按套餐实报；onDemand 缺数据不编造；赠送额度保留 USD

## 风险与 403/异常处理

不混拼两账号 REST/RPC 结果；IDE 过期交原应用处理

## 已知缺口

- 见上；M2 验收时逐项登记未支持场景与未验证套餐。

## Encrypted local credentials (Cursor 3.27)

The read-only `cursor-state-db` reader accepts legacy plaintext access tokens and
`cursor-safe-storage:v1:` envelopes. Encrypted values use Electron safeStorage:
base64 containing Chromium macOS `v10`, AES-128-CBC, PBKDF2-HMAC-SHA1 with
`saltysalt`, 1003 iterations, 16-byte key and a 16-space IV. The iteration count
is the macOS variant, not Linux's 1. See [Chromium implementation](https://chromium.googlesource.com/chromium/src/+/93d0dcd55046ac06154f4d642c26d7697c4b0304/components/os_crypt/sync/os_crypt_mac.mm).

Only resolve reads the `Cursor Safe Storage` / `Cursor Key` Keychain item;
discover does not read secrets. Decryption and JWT shape checks happen in memory;
no owner token is refreshed or written back. Unknown envelope versions, bad keys
and malformed plaintext return `credential-undecryptable` before any request.
Keychain denial, missing key or timeout returns `keychain-access-denied`
(permission-denied): allow the Keychain read before reconnecting. The read has a
bounded timeout; encrypted text is never treated as a bearer or session token.

Offline coverage uses a generated synthetic JWT and synthetic Keychain password
(`test/cursor-safe-storage-cases.mjs`). Local Cursor code confirmed the v1 envelope
and safeStorage call. On 2026-10-27, after the user granted Keychain access, the
reader decrypted the live envelope into a JWT and the usage API returned HTTP 200
with all three quota windows. Earlier authorization timeouts correctly stopped
validation. No real credential or account-response fixture is shipped.
