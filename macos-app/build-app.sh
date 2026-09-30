#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
output_root="${SUBSBAR_BUILD_DIR:-${TMPDIR:-/tmp}/subsbar-native-build}"
case "$output_root" in /*) ;; *) echo 'SUBSBAR_BUILD_DIR must be absolute' >&2; exit 2 ;; esac
test -f ../core/cli.mjs || { echo 'Missing core/cli.mjs; complete the data engine checkout first' >&2; exit 2; }
swift build --scratch-path "$output_root/swift" -c release --product SubsBar
app="$output_root/dist/SubsBar.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$(swift build --scratch-path "$output_root/swift" -c release --show-bin-path)/SubsBar" "$app/Contents/MacOS/SubsBar"
cp Info.plist "$app/Contents/Info.plist"
for directory in core schemas; do
  if [ -d "../$directory" ]; then
    rsync -a --delete "../$directory/" "$app/Contents/Resources/$directory/"
  fi
done
(cd "$app/Contents/Resources" && find core -type f -print0 | sort -z | xargs -0 shasum -a 256) > "$app/Contents/Resources/core.sha256"
if [ -f ../LICENSE ]; then cp ../LICENSE "$app/Contents/Resources/LICENSE"; fi
node_path="${SUBSBAR_NODE_PATH:-}"
if [ -z "$node_path" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_path="$candidate"; break; fi
  done
fi
if [ -z "$node_path" ]; then node_path="$(command -v node || true)"; fi
test -n "$node_path" || { echo 'Node is required to verify the bundled engine' >&2; exit 2; }
smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/subsbar-bundle-check.XXXXXX")"
trap 'rm -rf "$smoke_root"' EXIT
env -i HOME="$smoke_root" PATH=/usr/bin:/bin \
  XDG_CONFIG_HOME="$smoke_root/config" XDG_CACHE_HOME="$smoke_root/cache" XDG_STATE_HOME="$smoke_root/state" \
  "$node_path" "$app/Contents/Resources/core/cli.mjs" registry --json > "$smoke_root/registry.json"
"$node_path" -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (value.schemaVersion !== 1 || value.kind !== "registry" || !Array.isArray(value.providers) || !value.providers.length) process.exit(1);' "$smoke_root/registry.json"
codesign --force --sign - "$app"
codesign --verify --strict --verbose=2 "$app"
printf 'App: %s\n' "$app"
