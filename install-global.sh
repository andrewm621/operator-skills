#!/usr/bin/env bash
# Install every skill in skills/ for Claude Code, Codex, Cursor and Grok, user-wide.
#
#   Codex   ~/.codex/skills/<name>   -> symlink to skills/<name>  (folder with SKILL.md)
#   Cursor  ~/.cursor/skills/<name>  -> symlink to skills/<name>
#   Claude  ~/.claude/commands/<name>.md  frontmatter-stripped copy (the existing convention)
#   Grok    nothing extra: it scans ~/.claude/commands and ~/.cursor/skills by default
#
# Symlinks follow the working tree, so edits to a SKILL.md show up everywhere at once.
# Re-run after adding or renaming a skill, or to refresh the Claude copies.
# Anything that isn't already our symlink is moved to a dated backup folder first,
# never deleted. Use --dry-run to see what would change.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
STAMP="$(date +%Y%m%d-%H%M%S)"
changed=0

run() { if [ "$DRY" = 1 ]; then echo "  would: $*"; else "$@"; fi; }

backup() { # $1 = path to move aside, $2 = backup root
  local dest="$2/$STAMP"
  run mkdir -p "$dest"
  run mv "$1" "$dest/"
  echo "  backed up $1 -> $dest/"
}

link_into() { # $1 = target root (e.g. ~/.codex/skills)
  local root="$1"
  run mkdir -p "$root"
  for dir in "$REPO"/skills/*/; do
    local name; name="$(basename "$dir")"
    [ -f "$dir/SKILL.md" ] || continue
    local src="${dir%/}" dst="$root/$name"
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then continue; fi
    if [ -e "$dst" ] || [ -L "$dst" ]; then backup "$dst" "$root-backup"; fi
    run ln -s "$src" "$dst"
    echo "  linked $dst"
    changed=$((changed + 1))
  done
}

copy_claude_commands() {
  local root="$HOME/.claude/commands"
  run mkdir -p "$root"
  for dir in "$REPO"/skills/*/; do
    local name; name="$(basename "$dir")"
    [ -f "$dir/SKILL.md" ] || continue
    local dst="$root/$name.md" tmp
    tmp="$(mktemp)"
    awk 'c<2 && /^---$/ {c++; next} c>=2' "$dir/SKILL.md" | awk 'NF||p{p=1; print}' > "$tmp"
    if [ -f "$dst" ] && cmp -s "$tmp" "$dst"; then rm -f "$tmp"; continue; fi
    if [ -e "$dst" ] || [ -L "$dst" ]; then backup "$dst" "$HOME/.claude/commands-backup"; fi
    if [ "$DRY" = 1 ]; then echo "  would: write $dst"; rm -f "$tmp"; else mv "$tmp" "$dst"; fi
    echo "  wrote $dst"
    changed=$((changed + 1))
  done
}

echo "Codex (~/.codex/skills)";   link_into "$HOME/.codex/skills"
echo "Cursor (~/.cursor/skills)"; link_into "$HOME/.cursor/skills"
echo "Claude (~/.claude/commands)"; copy_claude_commands
echo "Grok: reads ~/.claude/commands and ~/.cursor/skills; nothing to install."
echo "$changed change(s)$([ "$DRY" = 1 ] && echo ' (dry run)'). Start a new session in each tool to pick them up."
