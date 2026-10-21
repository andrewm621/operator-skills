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
#
# Pruning: when a skill is removed from the repo, the next run also cleans up after it.
#   - symlinks in ~/.codex/skills, ~/.cursor/skills and ~/.agents/skills that point into
#     this repo's skills/ but whose target no longer exists are moved to the backup folder.
#     Symlinks pointing anywhere else are never touched.
#   - ~/.claude/commands/<name>.md: the installer records what it wrote in
#     ~/.claude/commands/.operator-skills-manifest (name + checksum per line). A recorded
#     file whose skill is gone is moved to the backup folder, but only if it is still
#     byte-identical to what was installed; an edited copy is left alone with a warning.
#     Commands that were never installed by this script (your own, other tools') are
#     never in the manifest, so they are never touched. A first run with no manifest
#     prunes only the LEGACY_REMOVED names below (skills removed before the manifest existed).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
STAMP="$(date +%Y%m%d-%H%M%S)"
changed=0

# Skills deleted from this repo before the install manifest existed; pruned (to backup) once
# if still present in ~/.claude/commands and not a current skill. Do not add new names here:
# the manifest covers everything installed from now on.
LEGACY_REMOVED="db-status session-notes parallel-check notion-ctx"
MANIFEST_NAME=".operator-skills-manifest"

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

# Like points_into_repo, but only for targets under this repo's skills/ (what prune may remove).
points_into_skills() {
  [ -L "$1" ] || return 1
  local t; t="$(readlink "$1")"
  case "$t" in /*) ;; *) t="$(dirname "$1")/$t" ;; esac
  case "$t" in "$REPO/skills"/*) return 0 ;; *) return 1 ;; esac
}

# Move aside symlinks in $1 that point into this repo's skills/ but no longer resolve to a
# skill (target deleted or without SKILL.md). $2 = backup root.
prune_links() {
  local root="$1" backups="$2" link pruned=0
  [ -d "$root" ] || return 0
  for link in "$root"/*; do
    [ -L "$link" ] || continue
    points_into_skills "$link" || continue
    if [ -f "$link/SKILL.md" ]; then continue; fi
    backup "$link" "$backups"
    echo "  pruned $link (skill no longer in this repo)"
    pruned=$((pruned + 1))
  done
  echo "  pruned $pruned stale link(s)"
  changed=$((changed + pruned))
}

sha_of() { # $1 = file -> sha256 hex
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
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
  prune_claude_commands "$root"
  write_manifest "$root"
}

is_current_skill() { [ -f "$REPO/skills/$1/SKILL.md" ]; }

# Move aside commands this installer wrote for skills that no longer exist (see header).
prune_claude_commands() {
  local root="$1" manifest="$1/$MANIFEST_NAME" pruned=0 name sum file
  local candidates=""
  if [ -f "$manifest" ]; then
    while IFS="$(printf '\t')" read -r name sum; do
      case "$name" in ""|*[!a-z0-9-]*|-*) continue ;; esac   # ignore anything that isn't a plain skill name
      is_current_skill "$name" && continue
      candidates="$candidates $name:$sum"
    done < "$manifest"
  else
    for name in $LEGACY_REMOVED; do
      is_current_skill "$name" && continue
      candidates="$candidates $name:"                          # legacy: no recorded checksum
    done
  fi
  for cand in $candidates; do
    name="${cand%%:*}"; sum="${cand#*:}"; file="$root/$name.md"
    [ -f "$file" ] || continue
    if [ -n "$sum" ] && [ "$(sha_of "$file")" != "$sum" ]; then
      echo "  warning: $file was edited since install; skipped (not pruned)"
      continue
    fi
    backup "$file" "$HOME/.claude/commands-backup"
    echo "  pruned $file (skill no longer in this repo)"
    pruned=$((pruned + 1))
  done
  echo "  pruned $pruned stale command(s)"
  changed=$((changed + pruned))
}

# Record what this installer put in ~/.claude/commands (name<TAB>sha256 of the file).
write_manifest() {
  local root="$1" tmp name
  [ "$DRY" = 1 ] && return 0
  tmp="$(mktemp)"
  for dir in "$REPO"/skills/*/; do
    name="$(basename "$dir")"
    [ -f "$dir/SKILL.md" ] || continue
    [ -f "$root/$name.md" ] || continue
    printf '%s\t%s\n' "$name" "$(sha_of "$root/$name.md")" >> "$tmp"
  done
  if [ -f "$root/$MANIFEST_NAME" ] && cmp -s "$tmp" "$root/$MANIFEST_NAME"; then rm -f "$tmp"; else mv "$tmp" "$root/$MANIFEST_NAME"; fi
}

echo "Codex (~/.codex/skills)";   link_into "$HOME/.codex/skills";   prune_links "$HOME/.codex/skills" "$HOME/.codex/skills-backup"
echo "Cursor (~/.cursor/skills)"; link_into "$HOME/.cursor/skills"; prune_links "$HOME/.cursor/skills" "$HOME/.cursor/skills-backup"
echo "Agents (${AGENTS_SKILLS_DIR:-~/.agents/skills})"; link_agents_skills; prune_links "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}" "${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}-backup"
echo "Claude (~/.claude/commands)"; copy_claude_commands
echo "Grok: reads ~/.claude/commands and ~/.cursor/skills; nothing to install."
echo "$changed change(s)$([ "$DRY" = 1 ] && echo ' (dry run)'). Start a new session in each tool to pick them up."
