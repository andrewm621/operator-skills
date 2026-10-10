#!/bin/sh
# build.sh <out-dir under /private/tmp>   -> <out-dir>/Probe.app  (bundle id co.andrewmiller.desktop-probe)
set -eu
OUT="${1:?usage: build.sh /private/tmp/desktop-probe-<x>}"
case "$OUT" in /private/tmp/*|"${TMPDIR:-/nonexistent}"*) ;; *) echo "refusing: $OUT is not under a scratch dir" >&2; exit 1;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$OUT/Probe.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
swiftc -O -o "$APP/Contents/MacOS/probe" "$HERE/Probe.swift" -framework AppKit -framework WebKit
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>co.andrewmiller.desktop-probe</string>
  <key>CFBundleName</key><string>Probe</string>
  <key>CFBundleExecutable</key><string>probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign -s - --force "$APP" >/dev/null 2>&1 || true
echo "$APP"
