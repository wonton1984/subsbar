# Installation

## Requirements

- macOS 13+ (Apple Silicon preferred; Intel builds are CI-verified but not
  hand-tested on real hardware)
- Node.js ≥ 22 (external; SubsBar does not bundle a runtime)
- Optional provider CLIs for their login flows (see the `login` section of
  each `docs/providers/<id>.md`)

## Data layer / CLI

```sh
git clone https://github.com/subsbar/subsbar.git
cd subsbar
node core/cli.mjs config validate --json   # no config yet -> exit 2 is expected
node core/cli.mjs registry --json          # see what providers can be connected
```

The first run creates nothing on disk. All providers are disabled until you
enable one (see [configuration.md](configuration.md)).

## Native app

```sh
cd macos-app
swift build
swift run CoreChecks          # 200+ contract assertions must pass
./build-app.sh                # produces dist/SubsBar.app (ad-hoc signed)
cp -R dist/SubsBar.app ~/Applications/
```

SubsBar.app holds a single-instance lock (flock); a second launch replaces
nothing and exits. Auto-start: System Settings → General → Login Items.

## Node discovery

The app locates Node in this order: explicit `nativeNodePath` (UserDefaults
`com.subsbar.native`) → `/opt/homebrew/bin/node` → `/usr/local/bin/node` →
`PATH`. Node < 22 is rejected with a bounded version probe (3 s, 64 KiB
output cap).

## Uninstall

1. Quit SubsBar from the popover.
2. Remove `~/Applications/SubsBar.app` (or the checkout).
3. Optional cleanup: `~/.cache/subsbar/`, `~/.local/state/subsbar/`,
   `~/.config/subsbar/` (cache, private state, config respectively).
4. Optional: remove Login Items entry.

SubsBar never installs LaunchAgents and never modifies other tools.
