# Security Policy

## Reporting

Report vulnerabilities privately via GitHub Security Advisories
(**Security → Report a vulnerability**) on this repository — do not open
public issues for security problems.

Include: affected version/commit, component (core CLI / native app / manifest),
and reproduction steps with **redacted** evidence. Do not include real
credentials, tokens, or raw API responses.

## Scope

- Credential exposure (token/cookie/key leakage through CLI output, cache,
  diagnostics, logs, or memory dumps paths)
- Cross-account / cross-profile data mixing (cache scope isolation)
- Keychain handling (naming convention, read/write paths)
- Config write path (CAS, secret rejection)
- The bundled Node engine inside SubsBar.app

## Non-goals

- Provider-side vulnerabilities (report to the provider)
- Bypassing provider access controls or rate limits — SubsBar deliberately
  contains no such functionality, and reports requesting it are out of scope

## Handling

Maintainers acknowledge reports within 7 days, provide an assessment, and
coordinate a fix + disclosure timeline. Fixed vulnerabilities are credited in
release notes unless the reporter prefers otherwise.
