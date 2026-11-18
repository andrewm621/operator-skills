#!/bin/sh
# maestro-emit.sh - Claude Code hook -> `maestro emit --from-hook` (Agent Ops design section 3).
#
# EMIT-ONLY and FAIL-OPEN: reads the hook JSON from stdin, hands it to a detached
# background node process, and returns immediately. It
#   - always exits 0 (never blocks, denies or alters a tool call),
#   - never prints to stdout or stderr (hook stdout is treated as feedback to Claude),
#   - does the real work (event mapping, redaction, append) in the background.
# Tool-call spam is throttled here so most PostToolUse hooks cost one sed + one find.
#
# Env overrides: MAESTRO_MJS (path to maestro.mjs), MAESTRO_NODE (node binary),
#                MAESTRO_PROJECTS (projects dir, read by maestro itself).

payload=$(cat 2>/dev/null) || payload=''
[ -n "$payload" ] || exit 0

here=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) || here=''
mjs=${MAESTRO_MJS:-}
[ -n "$mjs" ] || { [ -n "$here" ] && mjs="$here/../maestro.mjs"; }
[ -f "$mjs" ] || mjs="$HOME/Projects/operator-skills/skills/maestro/maestro.mjs"
[ -f "$mjs" ] || exit 0

node=${MAESTRO_NODE:-}
[ -n "$node" ] || node=$(command -v node 2>/dev/null)
[ -n "$node" ] || { [ -x /opt/homebrew/bin/node ] && node=/opt/homebrew/bin/node; }
[ -n "$node" ] || { [ -x /usr/local/bin/node ] && node=/usr/local/bin/node; }
[ -n "$node" ] || exit 0

event=$(printf '%s' "$payload" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p' | head -n 1)

if [ "$event" = "PostToolUse" ]; then
  # Commits and PRs always go through. Every other tool call is only a liveness
  # signal, so allow at most one per session per 10 minutes. The stamp lives in a
  # private dir under the projects dir (never shared /tmp) and is never written
  # through a symlink. If the dir isn't usable we skip this throttle; node has its own.
  case "$payload" in
    *git*commit*|*gh*pr*create*) ;;
    *)
      proj=${MAESTRO_PROJECTS:-}
      if [ -z "$proj" ]; then
        cfg="${XDG_CONFIG_HOME:-$HOME/.config}/operator-skills/config.yaml"
        [ -f "$cfg" ] && proj=$(sed -n 's/^[[:space:]]*projects:[[:space:]]*//p' "$cfg" | head -n 1 | sed 's/[[:space:]]*#.*$//; s/^["'"'"']//; s/["'"'"']$//')
        [ -n "$proj" ] || proj="$HOME/Projects"
      fi
      case "$proj" in "~"|"~/"*) proj="$HOME${proj#\~}" ;; esac
      if [ -d "$proj/.maestro" ]; then
        rundir="$proj/.maestro/run"
        mkdir -p "$rundir" 2>/dev/null && chmod 700 "$rundir" 2>/dev/null
        sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9-]*\)".*/\1/p' | head -n 1)
        stamp="$rundir/hb-sh-${sid:-nosession}"
        if [ -d "$rundir" ] && [ ! -L "$rundir" ]; then
          if [ -L "$stamp" ]; then
            exit 0
          elif [ -f "$stamp" ]; then
            [ -z "$(find "$stamp" -mmin -10 2>/dev/null)" ] || exit 0
            touch "$stamp" 2>/dev/null
          elif [ -e "$stamp" ]; then
            exit 0
          else
            ( set -C; umask 077; : > "$stamp" ) 2>/dev/null || exit 0
          fi
        fi
      fi
      ;;
  esac
fi

( printf '%s' "$payload" | "$node" "$mjs" emit --from-hook >/dev/null 2>&1 & ) >/dev/null 2>&1
exit 0
