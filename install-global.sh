#!/usr/bin/env bash
# Install every skill in skills/ for Claude Code, Codex, Cursor, Grok and Agent Skills
# clients (Delta, Zed), user-wide.
#
#   Codex   ~/.codex/skills/<name>   -> symlink to skills/<name>  (folder with SKILL.md)
#   Cursor  ~/.cursor/skills/<name>  -> symlink to skills/<name>
#   Claude  ~/.claude/commands/<name>.md  frontmatter-stripped copy (the existing convention)
#   Agents  ~/.agents/skills/<name>  -> symlink to skills/<name>  (Delta + Zed discover skills here;
#                                       override the root with AGENTS_SKILLS_DIR)
#   Grok    nothing extra: it scans ~/.claude/commands and ~/.cursor/skills by default
#
# Symlinks follow the working tree, so edits to a SKILL.md show up everywhere at once.
# Re-run after adding or renaming a skill, or to refresh the Claude copies.
# Anything that isn't already our symlink is moved to a dated backup folder first,
# never deleted. Use --dry-run to see what would change.
# ~/.agents/skills is shared with other tools, so it is stricter: only our own symlinks
# (or a dir holding just a SKILL.md symlink into this repo) are replaced; anything else
# is left alone with a warning.
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

# Is symlink $1 pointing somewhere under this repo? (relative targets resolve against the link's dir)
points_into_repo() {
  [ -L "$1" ] || return 1
  local t; t="$(readlink "$1")"
  case "$t" in /*) ;; *) t="$(dirname "$1")/$t" ;; esac
  case "$t" in "$REPO"/*) return 0 ;; *) return 1 ;; esac
}

# ~/.agents/skills/<name> -> whole-directory symlink to skills/<name>. Never backs up or
# removes foreign entries: they are skipped with a warning.
link_agents_skills() {
  local root="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
  local linked=0 converged=0 skipped=0 current=0
  run mkdir -p "$root"
  for dir in "$REPO"/skills/*/; do
    local name; name="$(basename "$dir")"
    [ -f "$dir/SKILL.md" ] || continue
    local src="${dir%/}" dst="$root/$name"
    if [ -L "$dst" ]; then
      if [ "$(readlink "$dst")" = "$src" ]; then current=$((current + 1)); continue; fi
      if points_into_repo "$dst"; then
        run rm "$dst"; run ln -s "$src" "$dst"
        echo "  converged $dst"; converged=$((converged + 1))
      else
        echo "  warning: $dst is a symlink outside this repo; skipped"; skipped=$((skipped + 1))
      fi
    elif [ -d "$dst" ]; then
      # old form: a real dir whose only content is a SKILL.md symlink into this repo
      if [ "$(ls -A "$dst")" = "SKILL.md" ] && points_into_repo "$dst/SKILL.md"; then
        run rm "$dst/SKILL.md"; run rmdir "$dst"; run ln -s "$src" "$dst"
        echo "  converged $dst"; converged=$((converged + 1))
      else
        echo "  warning: $dst is not one of ours; skipped"; skipped=$((skipped + 1))
      fi
    elif [ -e "$dst" ]; then
      echo "  warning: $dst is a file; skipped"; skipped=$((skipped + 1))
    else
      run ln -s "$src" "$dst"
      echo "  linked $dst"; linked=$((linked + 1))
    fi
  done
  echo "  agents: $linked linked, $converged converged, $skipped skipped ($current already current)"
  changed=$((changed + linked + converged))
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
echo "Agents (${AGENTS_SKILLS_DIR:-~/.agents/skills})"; link_agents_skills
echo "Claude (~/.claude/commands)"; copy_claude_commands
echo "Grok: reads ~/.claude/commands and ~/.cursor/skills; nothing to install."
echo "$changed change(s)$([ "$DRY" = 1 ] && echo ' (dry run)'). Start a new session in each tool to pick them up."
