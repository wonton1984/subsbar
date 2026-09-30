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
codesign --force --sign - "$app"
codesign --verify --strict --verbose=2 "$app"
printf 'App: %s\n' "$app"
