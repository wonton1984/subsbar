# Releasing

Versioning: `0.x` product versions; config and report carry their own
`schemaVersion: 1`. Patch releases fix provider/schema compatibility; minor
releases add providers or settings.

## Pre-flight (maintainer machine)

1. `node scripts/check-public.mjs` — 0 findings (worktree + full history).
2. Full offline suite: six `node test/*.test.mjs` files, 0 failures.
3. `swift build && swift run CoreChecks` in `macos-app/`.
4. `./macos-app/build-app.sh` bundle smoke (hashes, codesign, temp HOME).
5. Confirm THIRD_PARTY_NOTICES.md is current for every ported parser.

## M4 checklist: private → public

1. **Repository**: create `subsbar/subsbar` (private first), push `main`.
2. **CI**: confirm all six workflows green on the private remote
   (node-offline ×4 matrix, swift-core ×2, contract-integration,
   package-smoke ×2, public-hygiene; release only on tags).
   - Re-verify pinned action SHAs (checkout/setup-node/upload-artifact)
     against the official tags before the first run.
   - Verify runner labels `macos-15` / `macos-15-intel` still exist.
3. **Content review**: browse the public tree — no `notes/`, `evidence/`,
   `dist/`, `.build/`, real fixtures, or machine paths (the hygiene job
   enforces this, but eyeball the tree).
4. **License check**: LICENSE (MIT, 2026 SubsBar Contributors),
   THIRD_PARTY_NOTICES.md entries match every ported parser.
5. **Docs check**: `node scripts/check-docs.mjs`; README language links.
6. **Tag**: `git tag vX.Y.Z && git push origin vX.Y.Z` → release workflow
   builds the source archive + SHA256 artifact.
7. **Publication**: flip the repository to public only after a human has
   re-read the release artifact and the tree. Never publish from a state
   that failed the hygiene gate.

## Post-release

- File the verification matrix update (which providers are verified).
- Keep `pending-verification` annotations until a real-account report exists.
