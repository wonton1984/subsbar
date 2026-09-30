# Credential Security

## Design rules

1. **Secrets never enter config.** Config holds *references* (env var name,
   file path, Keychain service/account). The schema rejects token-shaped
   fields outright.
2. **Secrets live in the broker.** Resolved credentials become opaque,
   non-serializable references inside the data layer. Only the registered
   provider adapter can obtain the bytes, and only for the duration of one
   request (`broker.withSecret`).
3. **Borrowed tokens are read-only.** For credentials owned by other tools
   (`owner: external`) SubsBar never consumes refresh tokens, never writes to
   upstream auth files or Keychains. 401/403 → `reauth-required`; the owner
   CLI refreshes.
4. **SubsBar-owned storage** uses a fixed Keychain convention:
   - service: `SubsBar credential <providerId>`
   - account: `<providerId>:<profileId>`
   - contents: the key material only; label must not contain usernames.

   The native app writes these items (Security framework); the data layer
   reads them by the same convention.
5. **No output leakage.** stdout/stderr/cache/diagnostics never contain
   tokens, cookie values, secret prefixes, raw HTTP bodies, or absolute user
   paths. A second-line scrubber runs over all error text.
6. **Background never prompts.** Keychain authorization UI only in
   explicit user-connect flows.

## Identity and scope

Every resolved credential gets a local random identity scope (`scopeKey`).
Scope changes when the credential content, source, region, or organization
changes — caches from an old scope are never merged or displayed (see
`docs/architecture.md` for the projection rules).

## What is stored where

| Location | Contents |
| --- | --- |
| `~/.config/subsbar/config.json` (0600) | provider config, source references (no secrets) |
| `~/.cache/subsbar/usage-v1.json` (0600) | last reports (no secrets) |
| `~/.local/state/subsbar/runtime-v1.json` (0600) | backoff state, identity scopes, migration flags, credential-salt (HMAC only) |
| macOS Keychain (`SubsBar credential …`) | key material written via the app's paste-box flow |

## Reporting

See [SECURITY.md](../SECURITY.md). Please do not attach real tokens or raw
responses to bug reports.
