// Shared synthetic scenarios, called by the M2 suite. No real Keychain/network.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { createCredentialStores } from "../core/credentials/stores.mjs";
import { SecretBroker } from "../core/credentials/broker.mjs";
import { RefreshCoordinator, recordProviderRuntime, applyResult } from "../core/runtime/scheduler.mjs";

export async function credentialRenewalCases(check) {
  const root = mkdtempSync(join(tmpdir(), "subsbar-renewal-test-"));
  try {
    const file = join(root, "synthetic.loginkeychain");
    const key = randomBytes(32);
    function fixture(exp, marker) {
      const token = `synthetic.${Buffer.from(JSON.stringify({ exp, marker })).toString("base64url")}.signature`;
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(JSON.stringify({ access_token: token })), cipher.final()]);
      return [iv, cipher.getAuthTag(), enc].map(x => x.toString("base64")).join(":");
    }
    const expiredA = fixture(1, "a"), expiredB = fixture(2, "b"), valid = fixture(4102444800, "valid");
    writeFileSync(file, expiredA);
    const raw = createCredentialStores({ env: {} });
    let resolves = 0, fetches = 0;
    const stores = {
      artifactVersion: (...args) => raw.artifactVersion(...args),
      discover: (id, spec, ctx) => raw.discover(id, spec, { ...ctx, testAesKeyB64: key.toString("base64") }),
      resolve: (id, spec, ctx) => { resolves++; return raw.resolve(id, spec, { ...ctx, testAesKeyB64: key.toString("base64") }); },
    };
    const coordinator = new RefreshCoordinator({ env: { XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache") },
      fetchSnapshot: async () => { fetches++; return { windows: [{ id: "synthetic" }], metrics: [] }; } });
    const profile = { id: "synthetic", discovery: "only", sources: [{ id: "factory", kind: "file", reader: "factory-login-keychain", path: file }] };
    const cfgLoaded = { config: { providers: { droid: { enabled: true, activeProfile: profile.id, profiles: [profile], dataSource: "auto", allowCommunityEndpoints: true } } } };
    const runtime = {};
    async function run(reason = "timer") {
      const nowMs = Date.now();
      const r = await coordinator.refreshProvider("droid", { cfgLoaded, runtime, stores, broker: new SecretBroker(), nowMs,
        signal: new AbortController().signal, trigger: { reason }, dirs: coordinator.dirs() });
      runtime.droid = recordProviderRuntime(runtime.droid, r, { nowMs, intervalSeconds: 300 });
      return r;
    }
    const first = await run();
    check("renewal local expiry records salted artifact baseline", first.error?.code === "credential-expired" && runtime.droid.credentialRenewal?.version?.length === 64);
    const baseline = structuredClone(runtime.droid);
    const unchanged = await run();
    check("renewal unchanged artifact stays in backoff without resolve", unchanged.kind === "deferred" && resolves === 1 && unchanged.credentialState === "awaiting-renewal");
    utimesSync(file, new Date(), new Date(Date.now() + 10000));
    await run();
    check("renewal mtime-only touch cannot bypass", resolves === 1);
    writeFileSync(file, expiredB);
    const bad = await run();
    check("renewal changed expired artifact gets exactly one immediate read", bad.kind === "failed" && bad.credentialState === "renewal-retry" && resolves === 2 && fetches === 0);
    check("renewal failed exemption retains backoff and version marker", runtime.droid.consecutiveFailures === 2 && runtime.droid.nextEligibleAtMs > Date.now() && runtime.droid.credentialRenewal.usedVersions.length === 1);
    const disk = JSON.parse(readFileSync(coordinator.dirs().runtimeStateFile, "utf8"));
    check("renewal reservation persisted before attempt", disk.providers.droid.credentialRenewal.usedVersions.length === 1);
    const afterBad = structuredClone(runtime.droid);
    runtime.droid = disk.providers.droid;
    await run();
    check("renewal process restart cannot regrant reserved version", resolves === 2);
    runtime.droid = afterBad;
    await run();
    check("renewal same failed version cannot retry again", resolves === 2);
    writeFileSync(file, expiredA); await run(); // A may be consumed once after initial baseline.
    writeFileSync(file, expiredB); const repeated = await run();
    check("renewal A-B-A-B never regrants consumed B", repeated.kind === "deferred" && resolves === 3);
    writeFileSync(file, valid);
    for (const error of [
      { code: "credential-expired", httpStatus: 401 }, { code: "invalid-credential", httpStatus: 401 },
      { code: "network", reasonCode: "http-403", httpStatus: 403 }, { code: "network", reasonCode: "http-429", httpStatus: 429 },
      { code: "network", reasonCode: "network" },
    ]) {
      runtime.droid = { ...structuredClone(baseline), lastError: error };
      const blocked = await run();
      check(`renewal excludes ${error.reasonCode ?? error.code}-${error.httpStatus ?? "local"}`, blocked.kind === "deferred" && resolves === 3);
    }
    runtime.droid = { ...structuredClone(baseline), serverRetryAtMs: Date.now() + 3600000 };
    const server = await run("manual");
    check("renewal never bypasses server Retry-After even manual", server.kind === "deferred" && resolves === 3 && !server.credentialState);
    runtime.droid = { ...structuredClone(baseline), credentialRenewal: { ...baseline.credentialRenewal, usedVersions: Array.from({ length: 32 }, (_, i) => String(i)) } };
    check("renewal bounded history exhaustion fails closed", (await run()).kind === "deferred" && resolves === 3);
    runtime.droid = structuredClone(baseline);
    profile.id = "different-profile";
    cfgLoaded.config.providers.droid.activeProfile = profile.id;
    check("renewal different profile cannot inherit exemption", (await run()).kind === "deferred" && resolves === 3);
    profile.id = "synthetic";
    cfgLoaded.config.providers.droid.activeProfile = profile.id;
    const noBaseline = { ...structuredClone(baseline) };
    delete noBaseline.credentialRenewal;
    runtime.droid = noBaseline;
    check("renewal legacy runtime without fingerprint fails closed", (await run()).kind === "deferred" && resolves === 3);
    runtime.droid = structuredClone(baseline);
    const stateFile = coordinator.dirs().runtimeStateFile;
    rmSync(stateFile);
    mkdirSync(stateFile);
    check("renewal failed reservation write cannot bypass", (await run()).kind === "deferred" && resolves === 3);
    rmSync(stateFile, { recursive: true });
    runtime.droid = structuredClone(baseline);
    const success = await run("manual");
    check("renewal fresh artifact succeeds immediately within manual interval", success.kind === "success" && fetches === 1 && resolves === 4 && success.credentialState === "renewal-retry");
    check("renewal success clears failures and private version history", runtime.droid.consecutiveFailures === 0 && runtime.droid.credentialRenewal === undefined);
    const entry = { providerId: "droid", attempt: { state: "never" } };
    applyResult(entry, success, { nowMs: Date.now(), trigger: { reason: "manual" } });
    check("renewal usage attempt is machine readable without hashes", entry.attempt.credentialState === "renewal-retry" && !JSON.stringify(entry).includes(baseline.credentialRenewal.version));
    applyResult(entry, unchanged, { nowMs: Date.now(), trigger: { reason: "timer" } });
    check("renewal waiting attempt retains accurate backoff reason", entry.attempt.credentialState === "awaiting-renewal" && entry.attempt.deferredReason === "backoff");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
