#!/bin/sh
# install.sh - print (or apply) the Claude Code `hooks` block for Maestro event emission.
#
#   hooks/install.sh                 print the JSON block to merge into ~/.claude/settings.json
#   hooks/install.sh --apply         merge ONLY the top-level "hooks" key (backup written first)
#   hooks/install.sh --settings F    operate on F instead of ~/.claude/settings.json
#   MAESTRO_HOME=DIR                 hook path = DIR/hooks/maestro-emit.sh
#                                    (default ~/Projects/operator-skills/skills/maestro)
#
# --apply is idempotent: it removes earlier maestro-emit.sh entries before adding ours, and it
# leaves every other hook and every other settings key untouched. Nothing is applied unless you
# pass --apply. Hooks are emit-only and fail-open (see maestro-emit.sh); to remove them, delete
# the entries whose command ends in maestro-emit.sh.

# The hook path written into settings.json is the CANONICAL install location, not the
# checkout (or worktree) this script happens to run from. MAESTRO_HOME overrides it.
maestro_home="${MAESTRO_HOME:-$HOME/Projects/operator-skills/skills/maestro}"
script="$maestro_home/hooks/maestro-emit.sh"
settings="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
apply=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --settings) shift; settings="$1" ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || { echo "install.sh: node not found on PATH" >&2; exit 1; }
if [ -f "$script" ]; then
  chmod +x "$script" 2>/dev/null
else
  echo "install.sh: warning: $script does not exist yet (merge operator-skills first, or set MAESTRO_HOME)" >&2
  if [ "$apply" = 1 ]; then
    echo "install.sh: refusing to --apply a hook path that does not exist" >&2
    exit 1
  fi
fi

MAESTRO_HOOK_SCRIPT="$script" MAESTRO_SETTINGS="$settings" MAESTRO_APPLY="$apply" node --input-type=module - <<'NODE'
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

const script = process.env.MAESTRO_HOOK_SCRIPT;
const settingsPath = process.env.MAESTRO_SETTINGS;
const apply = process.env.MAESTRO_APPLY === '1';

const handler = { type: 'command', command: script, timeout: 5 };
const group = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ ...handler }] });
const ours = {
  SessionStart: [group()],
  SessionEnd: [group()],
  Stop: [group()],
  StopFailure: [group()],
  SubagentStart: [group()],
  SubagentStop: [group()],
  TaskCreated: [group()],
  TaskCompleted: [group()],
  PostToolUse: [group('Bash')],
  PermissionRequest: [group()],
};

if (!apply) {
  console.log(JSON.stringify({ hooks: ours }, null, 2));
  console.error(`\n# Merge the block above into ${settingsPath}, or re-run with --apply.`);
  process.exit(0);
}

let raw = '{}';
if (existsSync(settingsPath)) raw = readFileSync(settingsPath, 'utf8');
let settings;
try {
  settings = JSON.parse(raw);
} catch (e) {
  console.error(`install.sh: ${settingsPath} is not valid JSON (${e.message}); not touching it`);
  process.exit(1);
}

const isOurs = (g) => (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.endsWith('maestro-emit.sh'));
const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
for (const [event, groups] of Object.entries(ours)) {
  hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event].filter((g) => !isOurs(g)) : []), ...groups];
}
settings.hooks = hooks;

const indent = (raw.match(/^\{\r?\n([ \t]+)"/) ?? [])[1] ?? '  ';
let mode = 0o600;
if (existsSync(settingsPath)) {
  mode = statSync(settingsPath).mode & 0o777;
  const backup = `${settingsPath}.bak-maestro-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(settingsPath, backup);
  chmodSync(backup, 0o600); // settings.json can hold tokens: the backup is owner-only
  console.log(`backup: ${backup}`);
}
// Atomic replace: write a sibling temp file with the original mode, then rename over the target,
// so a crash can never leave a half-written settings.json.
const tmp = `${settingsPath}.tmp-maestro-${process.pid}`;
try {
  writeFileSync(tmp, `${JSON.stringify(settings, null, indent)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, settingsPath);
} catch (e) {
  try {
    unlinkSync(tmp);
  } catch {
    /* nothing to clean */
  }
  console.error(`install.sh: could not write ${settingsPath}: ${e.message}`);
  process.exit(1);
}
console.log(`hooks merged into ${settingsPath} (${Object.keys(ours).join(', ')})`);
NODE
