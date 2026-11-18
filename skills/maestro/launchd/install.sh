#!/bin/bash
# Installs the Maestro sync+reap launchd job (macOS, bash 3.2 safe).
#   ./install.sh             render the plist into ~/Library/LaunchAgents and bootstrap it
#   ./install.sh --print     print the rendered plist, change nothing
#   ./install.sh --uninstall bootout the job and remove the plist
# Reads MAESTRO_PROJECTS / config like maestro.mjs does; this script only wires the schedule.
set -eu

LABEL="com.rebelops.maestro-sync"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
MAESTRO_MJS="$(cd "$HERE/.." && pwd -P)/maestro.mjs"
TEMPLATE="$HERE/$LABEL.plist"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/maestro-sync.log"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$DEST"
  echo "Removed $LABEL"
  exit 0
fi

[ -f "$MAESTRO_MJS" ] || { echo "install.sh: $MAESTRO_MJS not found" >&2; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "install.sh: node not found on PATH" >&2; exit 1; }

# The values land inside XML and a shell string: refuse anything that would need escaping.
for v in "$NODE" "$MAESTRO_MJS" "$LOG"; do
  case "$v" in
    *[\&\<\>\"\$\`\\]*) echo "install.sh: unsupported character in path: $v" >&2; exit 1 ;;
  esac
done

content="$(cat "$TEMPLATE")"
content="${content//__NODE__/$NODE}"
content="${content//__MAESTRO_MJS__/$MAESTRO_MJS}"
content="${content//__LOG__/$LOG}"

if [ "${1:-}" = "--print" ]; then
  printf '%s\n' "$content"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
printf '%s\n' "$content" > "$DEST"
plutil -lint "$DEST" >/dev/null
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$DEST"
echo "Installed $LABEL (every 300s) -> logs in $LOG"
