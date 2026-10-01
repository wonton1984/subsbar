# SubsBar native M1

Swift 6 / SwiftPM, macOS 13+. AppKit owns the menu bar item, transient popover and settings window; SwiftUI renders the content. Node ≥22 is required. The public app uses bundle identifier `com.subsbar.public-native`, separate from the existing private installation.

## Build and check

Run from the public repository root. Build products and captures stay outside the source tree.

```sh
swift build --package-path macos-app --scratch-path /tmp/subsbar-native-build/swift
swift run --package-path macos-app --scratch-path /tmp/subsbar-native-build/swift CoreChecks
SUBSBAR_BUILD_DIR=/tmp/subsbar-native-build macos-app/build-app.sh
open /tmp/subsbar-native-build/dist/SubsBar.app
```

The bundler requires a complete `core/cli.mjs`, copies `core/` and any `schemas/` directory verbatim, records resource hashes and performs ad-hoc signing. It does not bundle the old plugin renderer or legacy refresh script. This is not a Developer ID notarized distribution. Do not replace a private installation during candidate acceptance.

For a bare development executable, set `SUBSBAR_PROJECT_DIR` to the absolute public repository directory. A complete app uses its own bundled engine. `SUBSBAR_CONFIG` can select an isolated absolute config path for development; the Node engine owns config path resolution.

## Connect a subscription

Open the pie icon → Settings → select a subscription. Add an account profile, select a usage source and any explicit credential source references, then save. Click **Connect / Check selected subscription** to test that provider. The first launch has no enabled subscriptions and makes no provider requests.

Supported readers, configurable fields, permissions and admission states come from `registry --json`. Swift contains no provider or reader catalog. The source form edits references such as a file path, environment variable name or Keychain item name; it never accepts or displays a token. Sign in using the credential owner's application when credentials are missing or expired. Unsupported readers remain visible.

Explicit source lists replace automatic discovery completely. Missing sources, invalid credentials, permission failures and expired credentials remain visible with repair instructions. Discovery never reads credential contents or prompts for Keychain access. Expiry is shown only as unknown or an exact date supplied by owner metadata; Swift never infers expiry or runs an expiry countdown.

Saving goes exclusively through Node `config set --stdin` with the revision and content token from `config read --json`. Node performs schema validation and the write. Conflicts keep the draft and require an explicit reload and retry. Swift never merges a conflicting config or writes config/cache files directly.

If Node cannot be found, **Choose Node…** probes the chosen executable for at most three seconds. Only a temporary bootstrap path is stored in UserDefaults; after connection it is written to `runtime.nodePath` through the same CAS writer and the temporary hint is removed.

## Display and refresh

The default popover uses one column up to three enabled subscriptions (360pt), then a two-column row-major grid (560pt). Grid cards show the primary metric and status; clicking expands all visible details. Single-column cards show: primary window bar, one secondary window or balance, reset countdown, freshness and status. Clicking a card expands its details (all visible metrics, source, sampling time, diagnostics, connection actions) for the current session; the persisted default stays in settings. The header (view toggle, refresh, settings) and footer stay fixed while the list scrolls. Enabled providers stay visible when they fail; disabled ones are listed under a **添加订阅** button, collapsed by default each session, and open their connection settings. The compact single-provider view remains a preference and renders the same card model. Direct provider buttons appear only in the single-provider view; clicking switches immediately to that provider. The buttons wrap into rows (six providers: two rows; fourteen: four rows at 360pt), with no horizontal scroll container. The overview omits this selector. The header settings button includes a visible text label. Provider tiles are neutral lettered monograms, not vendor logos.

Settings control single-provider or cards view, provider and metric order, expansion, favorites, hidden metrics, selected provider, appearance, density and menu bar provider selection (0–4 independent slots). Each selected provider owns one 20pt ring gauge with its abbreviation centered inside. The clockwise arc shows primary remaining quota (green above 50%, orange 20–50%, red below 20%); stale/unknown values use a gray dashed ring. Only amounts without a denominator keep an external amount title. Accessibility includes remaining quota and reset information. With zero selected providers there is one unnamed ring entry. By default the first enabled provider is displayed. Selecting another checkbox automatically raises the limit (up to four); reducing the limit keeps the first selections. The persistent save bar applies edits through CAS and reloads the menu items. Legacy pins migrate in Node; the app exposes only the unified menu bar settings. All preferences use the shared config.

Usage v1 is rendered without adapter-specific normalization. Remaining-only values have no invented used/limit or percentage. Zero is retained, zero denominators are unknown, over-limit details remain above 100% while graphics are clipped. The primary metric never switches merely because another window has data. Invalid optional metrics are isolated. All v1 timestamps are milliseconds; an elapsed reset does not refill a quota.

Freshness is recomputed from the sampling time: age ≤10 minutes is fresh, >10 minutes stale, ≥24 hours expired, and more than five minutes in the future invalid. Expired/invalid/legacy snapshots cannot produce an active colored icon. Errors and last-good data are shown separately.

Startup, timer, wake and manual refresh use the frozen Node refresh command. Node owns leader locking, backoff and persistence. When every enabled target of a refresh is deferred for backoff, the popover shows the earliest Node-provided retry time above the cards; missing deadlines are labelled unknown. Different provider deadlines remain independent, and the display does not compute or bypass backoff. Manual refresh can bypass local backoff, but still honors server Retry-After and a 30-second minimum interval (IPC rev8); opening settings and changing selection do not request provider usage. Refresh receipts distinguish partial/deferred/cancelled/unsaved results. A busy leader causes no native retry loop.

Only child processes created by this app can be cancelled. SIGTERM permits a cancelled receipt for 500ms; SIGKILL and process reaping are the fallback. The native deadline is 120 seconds. Shutdown cancels outstanding config/usage/refresh calls as well. Stdout is bounded to 1 MiB and parsed strictly; raw stderr is discarded. Duplicate JSON keys, invalid UTF-8, excessive depth and unsupported schema versions are rejected.

## Verification

Connection guidance and verified login commands come from the Node registry. Unverified instructions are labelled accordingly. If a provider can reuse an existing local login (Pi, a login file, or an official CLI), the primary button is **检测连接**, not a new login or API-key prompt; pasting a key remains a secondary action. API keys entered in the secure field are written with Security.framework to a local, non-synchronizing Keychain item using the registry's final service name and the selected profile's account reference. Only that reference is saved through config CAS, then the selected provider is checked. A config conflict can leave the key saved in Keychain while the config remains unchanged; the UI reports this and asks the user to reload before retrying. Keychain errors use fixed messages. Automated store tests use an injected mock and do not establish real Keychain authorization or provider-login success.

CoreChecks retains the original 91 legacy regression checks and adds M1 wire/config/CAS/process/presentation checks. M2 checks build a 14-provider scene from `usage-golden-normalized.json` and assert that the card overview and the compact view show identical values and states, matching the Node output. It consumes the shared `test/fixtures/ipc/` files, including the Node-generated `usage-golden-normalized.json`; Swift does not implement a duplicate raw-provider normalizer. CLT installations without XCTest use CoreChecks. With full Xcode, `SUBSBAR_XCTEST=1 swift test` runs the shared suites.

The live CLI checks use a temporary synthetic configuration and isolated HOME/XDG directories. They exercise CAS writes, revision and external-edit conflicts, and empty-home discovery without refreshing real accounts. Packaging also runs the bundled registry in an empty environment before signing, so a missing engine dependency fails the build.

Synthetic SwiftUI captures can be generated without credentials, config writes or refresh:

```sh
/tmp/subsbar-native-build/swift/debug/SubsBar --render-synthetic \
  test/fixtures/ipc /tmp/subsbar-native-captures [/tmp/registry.json]
```

The optional last argument is a `registry --json` output (for example from an empty HOME) that supplies the 14 provider names for the M2 scenes.

These captures test rendering, not real mouse/keyboard interactions. Keep all screenshots and logs outside the public tree. The old `Cache`/`Runtime` compatibility helpers remain for regression tests; the active M1 app never reads the private legacy cache or runs its refresh guard.

## Login launch

After acceptance, copy the complete app to an Applications directory and add it in System Settings → General → Login Items. Remove that entry to stop login launch. No LaunchAgent or helper daemon is installed. Use the popover's Quit button to terminate the app and its owned subprocesses.
