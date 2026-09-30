#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release --product SubsBar
app="$PWD/dist/SubsBar.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/scripts"
cp "$(swift build -c release --show-bin-path)/SubsBar" "$app/Contents/MacOS/SubsBar"
cp Info.plist "$app/Contents/Info.plist"
# Copy data bridge and relative import verbatim. Never rewrite the repository sources.
for source in subs.mjs pie-png.mjs; do
  cp "../scripts/$source" "$app/Contents/Resources/scripts/$source"
  cmp "../scripts/$source" "$app/Contents/Resources/scripts/$source"
done
(cd "$app/Contents/Resources/scripts" && shasum -a 256 subs.mjs pie-png.mjs) > "$app/Contents/Resources/scripts.sha256"
if [ -f ../LICENSE ]; then cp ../LICENSE "$app/Contents/Resources/LICENSE"; fi
codesign --force --sign - "$app"
codesign --verify --strict --verbose=2 "$app"
printf 'App: %s\n' "$app"
