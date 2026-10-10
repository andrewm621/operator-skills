#!/bin/sh
# build.sh <out-dir>   -> <out-dir>/Probe.app  (bundle id co.andrewmiller.desktop-probe)
# <out-dir> must be a PRIVATE dir: created here with mode 0700 if it does not exist, otherwise it must already be a
# real dir (not a symlink), owned by you, mode 0700. The built app is executed, so never a shared/predictable /tmp dir.
set -eu
OUT="${1:?usage: build.sh <private-out-dir>}"
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  # BSD stat: type, owner uid, octal permission bits
  set -- $(stat -f '%HT %u %Lp' "$OUT")
  if [ "$1" != "Directory" ] || [ "$2" != "$(id -u)" ] || [ "$3" != "700" ]; then
    echo "refusing: $OUT is not a real directory owned by you with mode 0700 (got: $*)" >&2; exit 1
  fi
else
  mkdir -p "$(dirname "$OUT")" && mkdir -m 700 "$OUT"
fi
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
