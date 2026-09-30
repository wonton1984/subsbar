# Contributing to SubsBar

Thanks for your interest! SubsBar is a small, contract-driven project.

## Ground rules

1. **No credentials in issues, PRs, or fixtures.** Tests use synthetic data
   only. The public hygiene scanner (`node scripts/check-public.mjs`) must
   pass with 0 findings.
2. **Contracts first.** Cross-process shapes (usage-v1, config-v1,
   provider-manifest-v1) are frozen in `schemas/` and documented in
   `docs/architecture.md`. Changing them requires updating the schema, both
   consumer sides, and shared fixtures in one PR.
3. **Honest degradation.** Never invent denominators, never clamp over-limit
   values, never report "0" for unknown. See `docs/architecture.md`.
4. **Zero npm runtime dependencies** for the core data layer.

## Workflow

1. Fork / branch from `main`.
2. Make your change with tests (`test/*.test.mjs` for data layer,
   `swift run CoreChecks` for native).
3. Run locally: `node scripts/check-public.mjs` and the full test suite.
4. Commit with **DCO sign-off**:

   ```sh
   git commit -s -m "feat: ..."
   ```

   (`Signed-off-by: Your Name <your@email>` — certifies you have the right to
   submit under the project MIT license, per the [DCO](https://developercertificate.org/).)
5. Open a PR with a short description and the test output.

## Adding a provider

See `docs/contributing-provider.md` — it covers manifests, credential
readers, synthetic fixtures, and admission review.
