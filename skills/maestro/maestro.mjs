#!/usr/bin/env node
/* Maestro — cross-provider orchestration CLI.
   Zero dependencies: Node built-ins only.

   Phase 0 subcommands (see docs/maestro-spec.md §10):
     init        create <projects>/.maestro/ (registry + index + board), idempotent
     new         allocate a T-<id> and write a task file into <repo>/.maestro/tasks/
     claim       atomically claim a task (mkdir-based lock + heartbeat claim file)
     heartbeat   refresh a claim's heartbeat
     sync        reconcile all registered repos, rebuild index.jsonl + board.md
     board       sync, then print board.md

   Phase 1 subcommands (see docs/maestro-spec.md §6, §7, §8.2) — worker + router:
     work        claim + spin a sibling git worktree/branch + seed PROMPT.md/AGENTS.md
     route       same seeding, then print a provider launch string
                 (claude | codex | cursor | grok — all four wired, spec §7/§11)
     set         small idempotent frontmatter field-setter (e.g. recording `issue: gh#N`
                 after a human runs /handoff — this CLI never invokes Claude skills itself)

   L2 comms subcommands (see docs/maestro-comms-spec.md §3-§5, §7-§8) — agent<->agent
   and agent<->human messaging over the same filesystem+git bus, no daemon/socket:
     say         append a broadcast line to a task or `fleet` channel
     ask         append a `#open` question, prints its stable M-id
     answer      append an answer re: an ask AND flip that ask's `#open`->`#resolved`
                 (the one sanctioned in-place edit — everything else is append-only)
     read        print a channel's thread (optionally only messages `--since` a ts)
     inbox       list every `#open` ask addressed to someone (default: you, `owner.handle`) —
                 the "needs human" queue, across every registered repo + fleet
     handoff     like `say` but kind=handoff, explicitly targeted at `--to <who>`

   GitHub mirror subcommand (see docs/maestro-spec.md §13) — the ONLY networked
   verb in this whole CLI; `sync`/`board` stay pure-filesystem and offline-safe:
     mirror      opt-in per repo (`mirror: github` in registry.yaml) reconcile
                 of each task file to a GitHub issue — create-or-recover when
                 no `issue:` is recorded yet, else patch-only-on-drift; status
                 maps to `maestro`/`maestro:<status>` labels, `done` closes it.

   Agent Ops P1a subcommands (see docs/maestro-spec.md §14):
     done        review -> done: preconditions, merge, worktree teardown (reviewer/human action)
     block       status blocked + blocked_by/blocked_reason (an `@handle` also files an ask)
     release     drop a claim, task back to open, worktree kept
     reap        release abandoned claims whose worktree is clean; list the dirty ones
     emit|status|who   event-log verbs, implemented by the optional sibling events.mjs

   v1 dispatch is human-in-the-loop (spec §7): `route` prepares the worktree/seed and
   prints the launch string; it never spawns another provider process itself.

   Config (all optional; see docs/config.md). Precedence: environment variable, then
   ~/.config/operator-skills/config.yaml (or $XDG_CONFIG_HOME/...), then the default:
     owner.handle   env MAESTRO_HANDLE    default $USER    — the human's handle for asks/answers/inbox
     paths.projects env MAESTRO_PROJECTS  default ~/Projects — <projects>/.maestro holds the global state
     identity.host  env MAESTRO_HOST      default short hostname — pin it on a Mac with no HostName set
   Identity: MAESTRO_PROVIDER (default claude), MAESTRO_SESSION / CLAUDE_CODE_SESSION_ID / CLAUDE_SESSION_ID (default: random 8-hex per process).

   Data layout (docs/maestro-spec.md §4, docs/maestro-comms-spec.md §2):
     <projects>/.maestro/{registry.yaml, index.jsonl, board.md, worktrees/}  — global, derived
     <projects>/.maestro/policy.yaml                                         — global, hand-kept (repo -> client map)
     <projects>/.maestro/events/                                             — event log + _system/reaper.jsonl
     <projects>/.maestro/channels/fleet.md                                   — global, authoritative
     <projects>/.maestro/inbox.jsonl                                         — global, DERIVED
     <repo>/.maestro/{tasks,todos,locks,channels}/                          — per-repo, authoritative
*/

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/* ---- paths -------------------------------------------------------------- */

const HOME = os.homedir();

/* Tiny zero-dependency reader for the two scalar keys Maestro needs from the
   shared per-user config (`owner.handle`, `paths.projects`). Not a YAML parser:
   it finds `<section>:` at column 0, then the first indented `<key>: value`
   under it, and understands only bare/quoted scalars and trailing comments.
   Missing file, section, or key -> undefined (caller applies the default). */
function readConfigScalar(section, key) {
  const base = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  let text;
  try {
    text = readFileSync(path.join(base, 'operator-skills', 'config.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    if (/^\S/.test(line)) {
      inSection = line.replace(/\s*#.*$/, '').trim() === `${section}:`;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(new RegExp(`^\\s+${key}:\\s*(.*)$`));
    if (!m) continue;
    let v = m[1].trim();
    const q = v.match(/^(["'])(.*?)\1/);
    v = q ? q[2] : v.replace(/\s+#.*$/, '').trim();
    return v === '' ? undefined : v;
  }
  return undefined;
}

function expandHome(p) {
  return p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
}

/* The human's handle (no leading @) — the default target of `ask`, the author
   of `answer`, and whose open asks light up the board's NEEDS YOU block. */
const HUMAN = (process.env.MAESTRO_HANDLE || readConfigScalar('owner', 'handle') || process.env.USER || os.userInfo().username).replace(/^@/, '');
const PROJECTS_DIR = path.resolve(expandHome(process.env.MAESTRO_PROJECTS || readConfigScalar('paths', 'projects') || '~/Projects'));
const GLOBAL_DIR = path.join(PROJECTS_DIR, '.maestro');
const REGISTRY_PATH = path.join(GLOBAL_DIR, 'registry.yaml');
const INDEX_PATH = path.join(GLOBAL_DIR, 'index.jsonl');
const BOARD_PATH = path.join(GLOBAL_DIR, 'board.md');
const WORKTREES_ROOT = path.join(GLOBAL_DIR, 'worktrees');
const FLEET_CHANNEL_PATH = path.join(GLOBAL_DIR, 'channels', 'fleet.md');
const INBOX_PATH = path.join(GLOBAL_DIR, 'inbox.jsonl');
const POLICY_PATH = path.join(GLOBAL_DIR, 'policy.yaml');
const EVENTS_DIR = path.join(GLOBAL_DIR, 'events');

const DEFAULT_TTL_SECONDS = 1800;
const HEARTBEAT_EVENT_MIN_GAP_MS = 10 * 60 * 1000; // heartbeat events: at most one per 10 min per claim
const STATUS_ORDER = ['open', 'claimed', 'in-progress', 'review', 'blocked', 'done'];
const CHANNEL_LOCK_TIMEOUT_MS = 5000;

/* Provider adapter table (spec §7). All four are wired as of Phase 2 — see
   spec §11 for which flags below are `--help`-confirmed vs. researched-only.
   Two corrections vs. the original research, both confirmed live on this
   machine via `<bin> --help` (never by executing a real headless run):

   1. Cursor's headless binary is `cursor-agent`, NOT bare `agent`. Spec §7's
      own footnote already flagged "agent (aka cursor-agent)" as a common
      trap — and it bit here for real: on a machine with Grok Build
      installed, plain `agent` on PATH resolves to *Grok's* CLI (its own
      `--help` banner literally prints "Grok Build TUI"). Using bare `agent`
      as the bin name would silently launch the wrong provider.
   2. Grok's researched `force_flag` (`--no-auto-update`) does not exist in
      `grok --help` on this build (self-hosted Grok Build — spec §11 unknown
      #6 flagged exactly this hosted-vs-self-hosted flag drift risk).
      Substituted the closest `--help`-confirmed non-interactive equivalent,
      `--always-approve` ("Auto-approve all tool executions"). A stronger
      alternative, `--permission-mode bypassPermissions`, exists too but
      wasn't chosen — it needs a value, breaking this table's boolean
      force_flag shape, and its exact scope vs. `--always-approve` is
      unverified without a real run. Confirm either before trusting it. */
const ADAPTERS = {
  claude: { bin: 'claude', folder_flag: null, prompt_mode: 'native_skill' },
  codex: { bin: 'codex', folder_flag: null, prompt_mode: 'issue', seed: ['PROMPT.md', 'AGENTS.md'] },
  // --workspace / -p / --print / --force / --output-format all confirmed
  // verbatim via `cursor-agent --help`.
  cursor: { bin: 'cursor-agent', folder_flag: '--workspace', prompt_flag: '-p', force_flag: '--force' },
  // --cwd and -p (alias of --single <PROMPT>) confirmed verbatim via
  // `grok --help`. That same --help also resolves spec §11 unknown #5: in
  // headless `-p` mode, `-w`/`--worktree` is documented as inert ("Headless
  // (-p) does not create a worktree from this flag"), so `--cwd .` alone —
  // pointed at our own pre-seeded worktree — is the correct, only mechanism.
  grok: { bin: 'grok', folder_flag: '--cwd', prompt_flag: '-p', force_flag: '--always-approve' },
};

/* ---- identity (spec §14.4) ----------------------------------------------------
   Actor ids are role-level — `<provider>@<short-host>`, e.g. claude@macbook-air —
   so they survive a restart. The ephemeral part is the *session*, recorded in
   the claim file and on every event, never baked into the owner string. */
const SHORT_HOST =
  String(process.env.MAESTRO_HOST || readConfigScalar('identity', 'host') || os.hostname())
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'host';

let sessionId = null;
function currentSession() {
  if (!sessionId) {
    const fromEnv = process.env.MAESTRO_SESSION || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
    sessionId = fromEnv ? String(fromEnv).replace(/[^A-Za-z0-9_.-]+/g, '-') : randomBytes(4).toString('hex');
  }
  return sessionId;
}

/* Provider for the default actor id: --provider, else MAESTRO_PROVIDER, else
   claude (Claude Code sets CLAUDECODE=1; there is no reliable equivalent marker
   for Codex/Cursor/Grok, so those must export MAESTRO_PROVIDER — `route`'s
   launch strings do). */
function envProvider() {
  if (process.env.MAESTRO_PROVIDER) return process.env.MAESTRO_PROVIDER;
  return 'claude';
}

function resolveProvider(flags) {
  if (flags && typeof flags.provider === 'string') return flags.provider;
  return envProvider();
}

function defaultActor(provider = envProvider()) {
  return `${provider}@${SHORT_HOST}`;
}

/* ---- events (optional sibling module, fail-open) --------------------------------
   events.mjs is owned by the observability half of Agent Ops. When it is absent
   (or broken) every appendEvent call below is a no-op, so Maestro behaves exactly
   as before. Contract: appendEvent(evt, { projectsDir }) where evt carries
   { type, task, actor, session, client, data, refs, to } — the module fills
   ts/id/trace_id and picks the file. Emission is best-effort and never throws. */
let appendEvent = () => {};
let eventsModule = null;
let eventsLoadError = null;
try {
  eventsModule = await import('./events.mjs');
  if (typeof eventsModule.appendEvent === 'function') appendEvent = eventsModule.appendEvent;
} catch (err) {
  eventsLoadError = err;
}

const pendingEvents = [];
function emitEvent(evt) {
  try {
    const result = appendEvent({ session: currentSession(), ...evt }, { projectsDir: PROJECTS_DIR });
    if (result && typeof result.then === 'function') pendingEvents.push(result.catch(() => {}));
  } catch {
    /* best-effort — an event must never break the verb that raised it */
  }
}

/* ---- small utilities ------------------------------------------------------ */

/* Thrown by fail() only when an async appendEvent promise is still pending, so
   the process can flush it (bounded) before exiting; see flushPendingEvents. */
class ExitSignal extends Error {}

const EVENT_FLUSH_TIMEOUT_MS = 500;

/* Waits for pending event promises, but never longer than the timeout: a promise
   that never settles must not hang a top-level await (Node would exit 13). */
async function flushPendingEvents() {
  if (!pendingEvents.length) return;
  let timer;
  await Promise.race([
    Promise.allSettled(pendingEvents),
    new Promise((resolve) => {
      timer = setTimeout(resolve, EVENT_FLUSH_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}

process.on('uncaughtException', (err) => {
  if (err instanceof ExitSignal) {
    flushPendingEvents().finally(() => process.exit(1));
    return;
  }
  console.error(err);
  process.exit(1);
});

function fail(msg) {
  console.error(`maestro: ${msg}`);
  // appendEvent is expected to be synchronous (spec §14.7). Only if an async one
  // left a promise pending do we unwind to the handler above to flush it first.
  if (pendingEvents.length) throw new ExitSignal();
  process.exit(1);
}

function warn(msg) {
  console.error(`maestro: warning: ${msg}`);
}

function nowISOMinute() {
  return new Date().toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
}

function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* Synchronous sleep, Node built-ins only — no worker thread required; Node
   (unlike a browser) allows a blocking Atomics.wait on the main thread. Used
   only for the channel append-lock's small jittered retry backoff below. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/* Set by parseArgs: did the command line contain a bare `--`? Free-text arguments
   that start with `-` are only accepted after it. */
let sawTerminator = false;

function checkText(text, what) {
  if (typeof text === 'string' && text.startsWith('-') && !sawTerminator) {
    fail(`${what} starts with '-', which is ambiguous with a flag — put it after '--' (e.g. maestro say T-1 -- "${text.slice(0, 24)}")`);
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  sawTerminator = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      // Everything after a bare `--` is positional, even if it looks like a flag.
      sawTerminator = true;
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/* Presence check only — `route` never blocks on a missing binary (v1 dispatch
   is human-in-the-loop, spec §7: it prints the launch string regardless, for
   the human to run once/if the binary is installed). Used solely to decide
   whether to print the "confirm with --help" advisory below. */
function commandExists(bin) {
  try {
    execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function binaryAdvisory(bin) {
  if (commandExists(bin)) return null;
  return `note: '${bin}' not found on PATH — launch string uses researched flags; confirm with '${bin} --help' once installed (spec §11)`;
}

function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'task';
}

/* ---- minimal hand-rolled frontmatter parse/serialize (no YAML dependency) - */
/* Handles exactly what task files use: bare scalars, `null`, integers, and
   `[a, b]` / `[]` inline lists. Good enough for §4.1's flat schema. */

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('no --- frontmatter fences found');
  const [, fmText, body] = m;
  const data = {};
  for (const line of fmText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val === 'null' || val === '') data[key] = null;
    else if (val === '[]') data[key] = [];
    else if (val.startsWith('[') && val.endsWith(']')) {
      data[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (/^-?\d+$/.test(val)) data[key] = Number(val);
    else data[key] = val;
  }
  return { data, body };
}

function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) lines.push(`${k}: null`);
    else if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function setTaskFields(taskPath, patch) {
  const raw = readFileSync(taskPath, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  Object.assign(data, patch);
  data.updated = nowISOMinute();
  writeFileSync(taskPath, `${serializeFrontmatter(data)}\n${body}`);
  return data;
}

/* Frontmatter values are scalars or inline lists. A task field that should be a
   list may have been hand-written as a bare scalar (`depends_on: T-3`). */
function asList(v) {
  if (v === null || v === undefined || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

/* Collapses a free-text value to something parseFrontmatter reads back as one
   scalar: a single line, and never shaped like an inline list. */
function sanitizeScalar(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.startsWith('[') && s.endsWith(']') ? `(${s.slice(1, -1)})` : s;
}

/* ---- registry (hand-rolled — flat list, not a general YAML parser) -------- */

function renderRegistry(repos) {
  const lines = [
    "# Maestro registry — repos this machine's `maestro sync` walks.",
    '# Hand-maintained: add a repo by appending a `- name` / `path` pair below.',
    `# Everything else under ${GLOBAL_DIR}/ is derived — never hand-edit it.`,
    'repos:',
  ];
  for (const r of repos) {
    lines.push(`  - name: ${r.name}`);
    lines.push(`    path: ${r.path}`);
    if (r.mirror) lines.push(`    mirror: ${r.mirror}`);
  }
  lines.push('id_prefix_from: name');
  return `${lines.join('\n')}\n`;
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    fail(`no registry at ${REGISTRY_PATH} — run 'maestro init' first`);
  }
  const raw = readFileSync(REGISTRY_PATH, 'utf8');
  const repos = [];
  let idPrefixFrom = 'name';
  let current = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    const trimmed = line.trim();
    if (!trimmed) continue;
    let m;
    if ((m = trimmed.match(/^-\s*name:\s*(.+)$/))) {
      current = { name: m[1].trim(), path: '', mirror: null };
      repos.push(current);
    } else if (current && (m = trimmed.match(/^path:\s*(.+)$/))) {
      current.path = m[1].trim();
    } else if (current && (m = trimmed.match(/^mirror:\s*(.+)$/))) {
      current.mirror = m[1].trim();
    } else if ((m = trimmed.match(/^id_prefix_from:\s*(.+)$/))) {
      idPrefixFrom = m[1].trim();
    }
  }
  return { repos, idPrefixFrom };
}

function resolveRepo(registry, name) {
  const known = () => registry.repos.map((r) => r.name).join(', ') || '(none — run maestro init)';
  if (name) {
    const r = registry.repos.find((r) => r.name === name);
    if (!r) fail(`no repo named '${name}' in registry. Known repos: ${known()}`);
    return r;
  }
  const cwd = process.cwd();
  const r = registry.repos.find((r) => cwd === r.path || cwd.startsWith(r.path + path.sep));
  if (!r) fail(`--repo required (cwd doesn't match a registered repo). Known repos: ${known()}`);
  return r;
}

/* ---- policy.yaml (hand-kept, flat; spec §14.5) ------------------------------------
   Only the `repos:` map (repo name -> client) is read in P1a:
     repos:
       agencyos: rebel-ops
       "liberty networking": liberty
   Same lenient style as registry.yaml: no general YAML, unknown sections and
   deeper-nested lines are ignored, a missing file means an empty map. */
let policyCache = null;
function loadPolicy() {
  if (policyCache) return policyCache;
  const policy = { repos: {} };
  policyCache = policy;
  let raw;
  try {
    raw = readFileSync(POLICY_PATH, 'utf8');
  } catch {
    return policy;
  }
  let section = null;
  let headerClient = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '');
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      const m = line.match(/^([A-Za-z_][\w-]*):/);
      section = m ? m[1] : null;
      headerClient = null;
      continue;
    }
    if (section !== 'repos') continue;
    // Canonical form is `  repo: client`. Two looser shapes are tolerated so every
    // reader of this file agrees: `  - repo: client`, and a `  client:` header
    // followed by `    - repo` lines.
    const item = line.match(/^\s+-\s+(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*$/);
    if (item) {
      const repoName = (item[1] ?? item[2] ?? item[3]).trim();
      if (headerClient && repoName) policy.repos[repoName] = headerClient;
      continue;
    }
    const m = line.match(/^\s+(?:-\s+)?(?:"([^"]+)"|'([^']+)'|([^:]+?))\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = (m[1] ?? m[2] ?? m[3]).trim();
    const value = m[4].replace(/^(["'])(.*)\1$/, '$2').trim();
    if (!value) {
      headerClient = key || null;
    } else if (key && value !== 'null' && value !== '~') {
      policy.repos[key] = value;
    }
  }
  return policy;
}

/* client = the task's own `client:` field, else the policy repo map, else null. */
function clientFor(repoName, data) {
  const own = data?.client;
  if (own !== null && own !== undefined && own !== '') return String(own);
  return loadPolicy().repos[repoName] ?? null;
}

/* ---- per-repo task helpers ------------------------------------------------ */

function ensureRepoDirs(repoPath) {
  for (const sub of ['tasks', 'todos', 'locks']) {
    mkdirSync(path.join(repoPath, '.maestro', sub), { recursive: true });
  }
}

function tasksDirFor(repoPath) {
  return path.join(repoPath, '.maestro', 'tasks');
}

function nextTaskNum(tasksDir) {
  if (!existsSync(tasksDir)) return 1;
  let max = 0;
  for (const f of readdirSync(tasksDir)) {
    const m = f.match(/^T-(\d+)(?:-|\.md$)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function findTaskFile(repoPath, taskId) {
  const tasksDir = tasksDirFor(repoPath);
  if (!existsSync(tasksDir)) return null;
  const match = readdirSync(tasksDir).find((f) => f === `${taskId}.md` || f.startsWith(`${taskId}-`));
  return match ? path.join(tasksDir, match) : null;
}

/* `T-3` (with --repo, or inferred from cwd) or the global form `<repo>/T-3`;
   the split is on the LAST slash, so repo names may contain spaces. */
function resolveTask(registry, ref, repoFlag) {
  let repoName = repoFlag;
  let taskId = String(ref);
  const i = taskId.lastIndexOf('/');
  if (i > 0) {
    repoName = taskId.slice(0, i);
    taskId = taskId.slice(i + 1);
  }
  const repo = resolveRepo(registry, repoName);
  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);
  return { repo, taskId, taskPath };
}

function readClaim(repo, taskId) {
  try {
    return JSON.parse(readFileSync(path.join(repo.path, '.maestro', 'locks', `${taskId}.claim.json`), 'utf8'));
  } catch {
    return null;
  }
}

/* Event helper for anything tied to one task: fills the global task id and the
   resolved client so call sites only say what happened. */
function emitTask(repo, taskId, taskPath, evt) {
  let client = null;
  try {
    client = clientFor(repo.name, parseFrontmatter(readFileSync(taskPath, 'utf8')).data);
  } catch {
    /* unreadable task file — event still goes out, just without a client */
  }
  emitEvent({ task: `${repo.name}/${taskId}`, client, ...evt });
}

/* ---- commands -------------------------------------------------------------- */

function cmdInit() {
  mkdirSync(GLOBAL_DIR, { recursive: true });

  if (!existsSync(REGISTRY_PATH)) {
    // Start empty: add repos by appending `- name` / `path` pairs to the registry.
    writeFileSync(REGISTRY_PATH, renderRegistry([]));
    console.log(`Created ${REGISTRY_PATH} (no repos yet — append \`- name\` / \`path\` pairs)`);
  } else {
    console.log(`Registry already exists — ${REGISTRY_PATH} (left untouched)`);
  }

  if (!existsSync(INDEX_PATH)) {
    writeFileSync(INDEX_PATH, '');
    console.log(`Created ${INDEX_PATH}`);
  } else {
    console.log(`Index already exists — ${INDEX_PATH} (left untouched)`);
  }

  if (!existsSync(BOARD_PATH)) {
    writeFileSync(
      BOARD_PATH,
      '# Maestro Board\n\n_No sync run yet — run `maestro sync` or `maestro board`._\n'
    );
    console.log(`Created ${BOARD_PATH}`);
  } else {
    console.log(`Board already exists — ${BOARD_PATH} (left untouched)`);
  }

  console.log('Maestro initialized.');
}

function cmdNew(positional, flags) {
  const title = positional[0];
  if (!title) fail('usage: maestro new "<title>" [--repo R] [--provider P] [--after T-x] [--priority N]');
  checkText(title, 'title');

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  ensureRepoDirs(repo.path);

  const tasksDir = tasksDirFor(repo.path);
  const num = nextTaskNum(tasksDir);
  const taskId = `T-${num}`;
  const slug = slugify(title);
  const filename = `${taskId}-${slug}.md`;
  const filePath = path.join(tasksDir, filename);

  const priority = flags.priority !== undefined ? Number(flags.priority) : 3;
  const dependsOn = flags.after ? [flags.after] : [];
  const now = nowISOMinute();

  const fm = {
    id: taskId,
    title,
    status: 'open',
    owner: null,
    provider_hint: typeof flags.provider === 'string' ? flags.provider : null,
    worktree: null,
    branch: null,
    issue: null,
    depends_on: dependsOn,
    priority,
    created: now,
    updated: now,
  };

  const body = [
    '',
    '## Goal',
    title,
    '',
    '## Context pointers',
    `- repo: ${repo.name} (read its CLAUDE.md first)`,
    '',
    '## Acceptance',
    '- [ ] Define acceptance criteria',
    '- [ ] Build + type-check pass',
    '',
  ].join('\n');

  writeFileSync(filePath, `${serializeFrontmatter(fm)}\n${body}`);

  console.log(`Created ${taskId} — ${filePath}`);
  console.log(taskId);
}

/* Atomic claim, shared by `claim`, `work`, and `route`. mkdir fails with EEXIST
   if another session already holds (or held) the lock — that's the whole
   concurrency primitive (§9). Sets task status→claimed + owner on success.
   Calls fail() (process.exit) on an unrecoverable claim conflict, so callers
   can treat a return as unconditional success.

   `resume` re-claims a task whose existing claim has the SAME role-level owner
   (a restarted session picking its own work back up): no steal, status left
   alone, only the session/pid/heartbeat are refreshed. A claim held by any other
   owner falls through to the normal live/stale rules. */
function claimTask(repo, taskId, taskPath, { owner, provider, steal, resume, takeover }) {
  const locksDir = path.join(repo.path, '.maestro', 'locks');
  mkdirSync(locksDir, { recursive: true });
  const lockDir = path.join(locksDir, `${taskId}.claim.lock`);
  const claimFile = path.join(locksDir, `${taskId}.claim.json`);

  function writeClaim() {
    const stamp = isoSeconds(new Date());
    const data = {
      task: taskId,
      owner,
      provider,
      session: currentSession(),
      pid: process.pid,
      claimed_at: stamp,
      heartbeat: stamp,
      ttl_seconds: DEFAULT_TTL_SECONDS,
    };
    writeFileSync(claimFile, `${JSON.stringify(data, null, 2)}\n`);
    return data;
  }

  function announce(action, extra = {}) {
    emitTask(repo, taskId, taskPath, { type: 'claim', actor: owner, data: { action, provider, ...extra } });
  }

  try {
    mkdirSync(lockDir);
    const claim = writeClaim();
    setTaskFields(taskPath, { status: 'claimed', owner });
    announce('acquire');
    return { claim, stolen: false, resumed: false };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // Lock dir already exists — inspect the existing claim to decide live vs stale.
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(claimFile, 'utf8'));
  } catch {
    /* missing/corrupt claim file alongside an existing lock dir — treat as stale */
  }
  const heartbeatMs = existing ? Date.parse(existing.heartbeat) : 0;
  const ttlMs = (existing?.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const isStale = !existing || Number.isNaN(heartbeatMs) || Date.now() - heartbeatMs > ttlMs;

  if (resume && existing && existing.owner === owner) {
    const previousSession = existing.session ?? null;
    // Role-level ids are shared by every session of a role, so a LIVE claim held
    // by a different session may well still be running: that needs --takeover.
    const takingOver = !isStale && previousSession !== null && previousSession !== currentSession();
    if (takingOver && !takeover) {
      fail(
        `claim FAILED — ${taskId} is held by ${owner} in another live session (${previousSession}, heartbeat ${existing.heartbeat}). If that session is dead, rerun with --takeover; otherwise pick another task.`
      );
    }
    const stamp = isoSeconds(new Date());
    const claim = { ...existing, provider, session: currentSession(), pid: process.pid, heartbeat: stamp, resumed_at: stamp };
    writeFileSync(claimFile, `${JSON.stringify(claim, null, 2)}\n`);
    if (takingOver) announce('steal', { takeover: true, prev_owner: owner, from: owner, prev_session: previousSession });
    else announce('resume', { prev_session: previousSession, was_stale: isStale });
    return { claim, stolen: false, resumed: true, takenOver: takingOver, previousSession, wasStale: isStale };
  }

  if (!isStale) {
    fail(`claim FAILED — ${taskId} owned by ${existing.owner} (heartbeat ${existing.heartbeat}, live)`);
  }
  if (!steal) {
    fail(
      `claim FAILED — ${taskId} has a STALE claim (owner ${existing?.owner ?? 'unknown'}, last heartbeat ${existing?.heartbeat ?? 'unknown'}) — rerun with --steal to reclaim`
    );
  }

  rmSync(lockDir, { recursive: true, force: true });
  mkdirSync(lockDir);
  const claim = writeClaim();
  setTaskFields(taskPath, { status: 'claimed', owner });
  announce('steal', { prev_owner: existing?.owner ?? null, from: existing?.owner ?? null });
  return { claim, stolen: true, resumed: false, previousOwner: existing?.owner };
}

/* Readiness gate shared by claim/work/route (spec §14.2). A task is workable when
   nothing is waiting on it: every depends_on done, blocked_by empty, no cycle.
   (Not the same as the index's `ready`, which also requires status `open`, so a
   task you already hold can still be re-entered.) --force overrides and is logged
   by noteForced() once the claim actually succeeds. Returns the waiting list when
   forced, else null. */
function enforceReady(registry, repo, taskId, flags, verb) {
  const rows = loadTaskRows(registry, { quiet: true });
  annotateReadiness(rows);
  const row = rows.find((r) => r.repoName === repo.name && r.taskId === taskId);
  if (!row) {
    // The sync scan skipped this task (malformed frontmatter?): readiness is unknowable.
    if (flags.force) {
      warn(`--force: ${verb} ${taskId} although its readiness could not be evaluated`);
      return ['unknown'];
    }
    fail(`${verb} refused — could not evaluate readiness of ${taskId} (is its task file malformed? try 'maestro sync'). Rerun with --force (logged) to override.`);
  }
  if (!row.waitingOn.length) return null;
  const waiting = row.waitingOn.map((w) => displayRef(w, repo.name)).join(', ');
  if (flags.force) {
    warn(`--force: ${verb} ${taskId} although it is waiting on ${waiting}`);
    return row.waitingOn;
  }
  fail(`${verb} refused — ${taskId} is not ready, waiting on: ${waiting}. Resolve those first, or rerun with --force (logged).`);
  return null;
}

function noteForced(repo, taskId, taskPath, owner, waitingOn, verb) {
  const text = `forced ${verb} past unmet readiness (waiting on ${waitingOn.join(', ')})`;
  try {
    const { mid } = postMessage(repo, taskId, { kind: 'say', text, author: owner });
    emitMessage({ repo, target: taskId, kind: 'say', mid, author: owner, taskPath });
  } catch (e) {
    warn(`could not log --force to the task channel: ${e.message}`);
  }
  emitTask(repo, taskId, taskPath, { type: 'claim', actor: owner, data: { action: 'force', verb, waiting_on: waitingOn } });
}

function cmdClaim(positional, flags) {
  const taskId = positional[0];
  if (!taskId) fail('usage: maestro claim T-<id> [--repo R] [--owner O] [--provider P] [--steal] [--resume [--takeover]] [--force]');

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  ensureRepoDirs(repo.path);

  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);

  const provider = resolveProvider(flags);
  const owner = typeof flags.owner === 'string' ? flags.owner : defaultActor(provider);
  const steal = !!flags.steal;
  const resume = !!flags.resume;

  const resumingOwn = resume && readClaim(repo, taskId)?.owner === owner;
  const forced = resumingOwn ? null : enforceReady(registry, repo, taskId, flags, 'claim');

  const result = claimTask(repo, taskId, taskPath, { owner, provider, steal, resume, takeover: !!flags.takeover });
  if (forced) noteForced(repo, taskId, taskPath, owner, forced, 'claim');

  if (result.resumed) {
    console.log(
      `${result.takenOver ? 'Took over' : 'Resumed'} ${taskId} as ${owner} (session ${result.previousSession ?? 'unknown'} → ${currentSession()}${result.wasStale ? ', claim was stale' : ''}) (${repo.name})`
    );
  } else if (result.stolen) {
    console.log(`Stole stale claim on ${taskId} (was ${result.previousOwner ?? 'unknown'}) — now owned by ${owner} (${repo.name})`);
  } else {
    if (resume) console.log(`No existing claim on ${taskId} to resume — claimed fresh.`);
    console.log(`Claimed ${taskId} for ${owner} (${repo.name})`);
  }
}

const HEARTBEAT_NOTE_KEY = 'hb_event_at';

function cmdHeartbeat(positional, flags) {
  const taskId = positional[0];
  if (!taskId) fail('usage: maestro heartbeat T-<id> [--repo R]');

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  const claimFile = path.join(repo.path, '.maestro', 'locks', `${taskId}.claim.json`);
  if (!existsSync(claimFile)) fail(`no active claim for ${taskId} in ${repo.name}`);

  const data = JSON.parse(readFileSync(claimFile, 'utf8'));
  data.heartbeat = isoSeconds(new Date());
  // Heartbeat *events* are throttled (≤1 per 10 min per claim); the claim file
  // itself is refreshed every call so liveness stays exact.
  const lastEmit = Date.parse(data[HEARTBEAT_NOTE_KEY] ?? '');
  const shouldEmit = Number.isNaN(lastEmit) || Date.now() - lastEmit > HEARTBEAT_EVENT_MIN_GAP_MS;
  if (shouldEmit) data[HEARTBEAT_NOTE_KEY] = data.heartbeat;
  writeFileSync(claimFile, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Heartbeat refreshed for ${taskId} (${repo.name}) — owner ${data.owner}`);

  if (shouldEmit) {
    const { done, total } = countTodos(path.join(repo.path, '.maestro', 'todos', `${taskId}.todos.md`));
    const taskPath = findTaskFile(repo.path, taskId);
    if (taskPath) emitTask(repo, taskId, taskPath, { type: 'heartbeat', actor: data.owner, data: { todos: `${done}/${total}` } });
  }
}

function refreshHeartbeat(repo, taskId) {
  const claimFile = path.join(repo.path, '.maestro', 'locks', `${taskId}.claim.json`);
  if (!existsSync(claimFile)) return;
  const data = JSON.parse(readFileSync(claimFile, 'utf8'));
  data.heartbeat = isoSeconds(new Date());
  writeFileSync(claimFile, `${JSON.stringify(data, null, 2)}\n`);
}

/* ---- L2 comms: channels + messages (maestro-comms-spec.md §2-§5) ----------- */

function isFleet(target) {
  return target === 'fleet';
}

/* `M-<taskid>-<seq>` uses the bare id (T-1 -> "1"), fleet uses "fleet"
   (comms spec §3). */
function messageBaseFor(target) {
  return isFleet(target) ? 'fleet' : target.replace(/^T-/, '');
}

function channelPathFor(repo, target) {
  const dir = isFleet(target) ? path.dirname(FLEET_CHANNEL_PATH) : path.join(repo.path, '.maestro', 'channels');
  mkdirSync(dir, { recursive: true });
  return isFleet(target) ? FLEET_CHANNEL_PATH : path.join(dir, `${target}.md`);
}

function channelLockDirFor(channelPath) {
  const base = path.basename(channelPath, '.md');
  return path.join(path.dirname(channelPath), `.${base}.lock`);
}

/* Short-lived mkdir lock, comms spec §5 — same atomic primitive as claims,
   but retries-with-backoff instead of failing loudly: two agents `say`-ing at
   once should serialize, not race each other out. A stale lock (crashed
   process) is stolen after CHANNEL_LOCK_TIMEOUT_MS so the CLI can't hang
   forever on a lock nobody will ever release. */
function acquireChannelLock(lockDir) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - start > CHANNEL_LOCK_TIMEOUT_MS) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* another process may have released it between our check and rmSync — fine */
        }
        continue;
      }
      sleepMs(15 + Math.floor(Math.random() * 25));
    }
  }
}

function releaseChannelLock(lockDir) {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/* `- [ts] (M-id) author · kind[→target][ re:M-id]: text [#tag]` — comms spec §3. */
function formatMessageLine({ ts, mid, author, kind, target, reId, text, tag }) {
  let line = `- [${ts}] (${mid}) ${author} · ${kind}`;
  if (target) line += `→${target}`;
  if (reId) line += ` re:${reId}`;
  line += `: ${text}`;
  if (tag) line += ` #${tag}`;
  return line;
}

const MESSAGE_LINE_RE = /^-\s*\[([^\]]+)\]\s*\(([^)]+)\)\s*(\S+)\s*·\s*(\w+)(?:→(\S+))?(?:\s+re:(\S+))?:\s(.*)$/;

/* Tolerant parse — throws on anything that isn't this exact shape, so callers
   can skip-with-warning per comms spec §3 ("never crash a read/sync"). */
function parseMessageLine(rawLine) {
  const line = rawLine.replace(/\r$/, '');
  const m = line.match(MESSAGE_LINE_RE);
  if (!m) throw new Error('unparseable message line');
  const [, ts, mid, author, kind, target, reId, rest] = m;
  let text = rest;
  let tag = null;
  const tagMatch = text.match(/\s#(open|resolved)\s*$/);
  if (tagMatch) {
    tag = tagMatch[1];
    text = text.slice(0, tagMatch.index).trimEnd();
  }
  return { ts, mid, author, kind, target: target || null, reId: reId || null, text, tag };
}

/* Reads a channel file into parsed message objects (each carrying its `raw`
   original line too, so `read`'s human mode can print verbatim). Missing
   file = empty thread, not an error. Malformed lines are skipped with a
   warning, never thrown — same rule as task frontmatter (spec §3). */
function readChannelMessages(channelPath) {
  if (!existsSync(channelPath)) return [];
  const text = readFileSync(channelPath, 'utf8');
  const messages = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    try {
      messages.push({ ...parseMessageLine(rawLine), raw: rawLine });
    } catch {
      warn(`skipping malformed message line in ${channelPath}: ${rawLine.slice(0, 80)}`);
    }
  }
  return messages;
}

function nextMessageSeq(channelPath, base) {
  if (!existsSync(channelPath)) return 1;
  const text = readFileSync(channelPath, 'utf8');
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\(M-${escaped}-(\\d+)\\)`, 'g');
  let max = 0;
  let m;
  while ((m = re.exec(text))) max = Math.max(max, Number(m[1]));
  return max + 1;
}

/* Author = the live claim owner if the target task is claimed, else a
   session-identity fallback (comms spec §3). Fleet posts and unclaimed tasks
   always fall back — there's no claim to borrow an identity from. `answer`
   overrides this with the configured human handle (spec §3/§4) since it's
   always the human replying. */
function resolveAuthor(repo, target) {
  if (!repo || isFleet(target)) return defaultActor();
  const claimPath = path.join(repo.path, '.maestro', 'locks', `${target}.claim.json`);
  if (existsSync(claimPath)) {
    try {
      const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
      if (claim?.owner) return claim.owner;
    } catch {
      /* corrupt claim file — fall through to the session-identity fallback */
    }
  }
  return defaultActor();
}

/* `@<handle>` and the bare handle must match for --for/--to filtering (spec §3
   uses `@<handle>` for the human in the line format, but the CLI's default
   `--for`/`--to` value is documented as the bare name) — compare with the
   leading `@` stripped and the case folded on both sides (handles are
   case-insensitive: `@Alice` and `alice` are the same person). */
function normalizeWho(who) {
  return String(who || '').replace(/^@/, '').toLowerCase();
}

/* Shared append path for say/ask/answer/handoff: acquire the channel lock,
   compute the next M-id fresh (inside the lock, so two concurrent posts
   can't compute the same seq), append one line, release. */
function postMessage(repo, target, { kind, text, targetAddr, reId, tag, author }) {
  const channelPath = channelPathFor(repo, target);
  const lockDir = channelLockDirFor(channelPath);
  const base = messageBaseFor(target);

  acquireChannelLock(lockDir);
  let mid, line, resolvedAuthorOut;
  try {
    const seq = nextMessageSeq(channelPath, base);
    mid = `M-${base}-${seq}`;
    const ts = isoSeconds(new Date());
    const resolvedAuthor = author ?? resolveAuthor(repo, target);
    resolvedAuthorOut = resolvedAuthor;
    line = formatMessageLine({ ts, mid, author: resolvedAuthor, kind, target: targetAddr, reId, text, tag });
    appendFileSync(channelPath, `${line}\n`);
  } finally {
    releaseChannelLock(lockDir);
  }
  return { mid, line, channelPath, author: resolvedAuthorOut };
}

/* Event for a posted channel message: `message` (or `handoff`) carrying only the
   pointer data — mid/kind/tag — never the text (events stay small and the thread
   remains the single copy of what was said). */
function emitMessage({ repo, target, kind, mid, author, to, tag, reId, taskPath }) {
  const type = kind === 'handoff' ? 'handoff' : 'message';
  const data = { mid, kind, tag: tag ?? null };
  const evt = { type, actor: author, to: to ?? null, refs: reId ? [reId] : [], data };
  if (isFleet(target) || !repo) {
    emitEvent({ task: null, client: null, ...evt });
    return;
  }
  const file = taskPath ?? findTaskFile(repo.path, target);
  if (type === 'handoff' && file) {
    try {
      const gh = parseFrontmatter(readFileSync(file, 'utf8')).data.issue;
      if (typeof gh === 'string' && /^gh#\d+$/.test(gh)) data.gh = gh;
    } catch {
      /* no issue ref — fine */
    }
  }
  if (file) emitTask(repo, target, file, evt);
  else emitEvent({ task: `${repo.name}/${target}`, client: null, ...evt });
}

/* `answer <M-id>` doesn't require --repo — resolve which channel/repo an
   M-id belongs to by its base id, searching every registered repo (and
   fleet) for a channel file containing that exact M-id. Ambiguous only if
   two repos happen to both have a same-numbered task AND a collision on the
   literal message id, which --repo disambiguates. */
function resolveChannelForMessageId(registry, mid, repoNameHint) {
  const m = String(mid).match(/^M-(.+)-(\d+)$/);
  if (!m) fail(`invalid message id '${mid}' — expected M-<taskid>-<seq> or M-fleet-<seq>`);
  const base = m[1];
  const target = base === 'fleet' ? 'fleet' : `T-${base}`;

  if (base === 'fleet') {
    return { repo: null, target, channelPath: FLEET_CHANNEL_PATH };
  }

  if (repoNameHint) {
    const repo = resolveRepo(registry, repoNameHint);
    const channelPath = path.join(repo.path, '.maestro', 'channels', `${target}.md`);
    if (!existsSync(channelPath)) fail(`no channel ${target} in ${repo.name}`);
    return { repo, target, channelPath };
  }

  const matches = [];
  for (const repo of registry.repos) {
    const channelPath = path.join(repo.path, '.maestro', 'channels', `${target}.md`);
    if (existsSync(channelPath) && readFileSync(channelPath, 'utf8').includes(`(${mid})`)) {
      matches.push({ repo, target, channelPath });
    }
  }
  if (matches.length === 0) fail(`message ${mid} not found in any registered repo's channel — pass --repo to disambiguate`);
  if (matches.length > 1) {
    fail(`message id ${mid} exists in multiple repos (${matches.map((x) => x.repo.name).join(', ')}) — pass --repo to disambiguate`);
  }
  return matches[0];
}

/* Every #open ask across fleet + every registered repo's channels/. Backs
   both `inbox` (live, filtered by --for) and `sync`'s derived inbox.jsonl /
   board ⚑ block (unfiltered, then filtered to the human for the board). */
function collectOpenAsks(registry) {
  const rows = [];
  const scan = (channelPath, channelLabel) => {
    for (const m of readChannelMessages(channelPath)) {
      if (m.kind === 'ask' && m.tag === 'open') {
        rows.push({ mid: m.mid, channel: channelLabel, author: m.author, target: m.target, text: m.text, ts: m.ts });
      }
    }
  };
  scan(FLEET_CHANNEL_PATH, 'fleet');
  for (const repo of registry.repos) {
    const channelsDir = path.join(repo.path, '.maestro', 'channels');
    if (!existsSync(channelsDir)) continue;
    let files;
    try {
      files = readdirSync(channelsDir).filter((f) => f.endsWith('.md'));
    } catch (e) {
      warn(`cannot read channels dir for ${repo.name}: ${e.message}`);
      continue;
    }
    for (const f of files) {
      scan(path.join(channelsDir, f), `${repo.name}/${f.replace(/\.md$/, '')}`);
    }
  }
  return rows;
}

/* ---- worktree + seed helpers (spec §2, §6) --------------------------------- */

function isGitRepo(repoPath) {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function listGitWorktrees(repoPath) {
  try {
    const out = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entries = [];
    let current = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = { path: line.slice('worktree '.length) };
        entries.push(current);
      } else if (line.startsWith('branch refs/heads/') && current) {
        current.branch = line.slice('branch refs/heads/'.length);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function gitBranchExists(repoPath, branch) {
  try {
    const out = execFileSync('git', ['-C', repoPath, 'branch', '--list', branch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/* Creates (or, idempotently, reuses) the sibling worktree for a task. Never
   nests inside the repo — WORKTREES_ROOT lives under <projects>/.maestro/,
   a sibling of every repo under <projects>/ (spec §2). Hard-fails rather than
   guessing when the branch/path already exists in an unrecognized state. */
/* Throws (rather than calling fail()/process.exit) so seedTask can catch a
   setup failure and roll back the claim it just took — see seedTask. */
function ensureWorktree(repo, taskId, title) {
  if (!isGitRepo(repo.path)) {
    throw new Error(`${repo.name} (${repo.path}) is not a git repository — cannot create a worktree for ${taskId}`);
  }

  const branch = `maestro/${taskId}-${slugify(title)}`;
  const worktreePath = path.join(WORKTREES_ROOT, slugify(repo.name), taskId);

  const already = listGitWorktrees(repo.path).find((w) => path.resolve(w.path) === path.resolve(worktreePath));
  if (already) {
    return { worktreePath, branch: already.branch || branch, created: false };
  }

  if (existsSync(worktreePath)) {
    throw new Error(
      `worktree path already exists on disk but isn't a registered git worktree: ${worktreePath} — remove it manually before retrying`
    );
  }
  if (gitBranchExists(repo.path, branch)) {
    throw new Error(`branch '${branch}' already exists in ${repo.name} — remove it or resolve manually before retrying`);
  }

  mkdirSync(path.dirname(worktreePath), { recursive: true });
  try {
    execFileSync('git', ['-C', repo.path, 'worktree', 'add', worktreePath, '-b', branch], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`git worktree add failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`);
  }
  return { worktreePath, branch, created: true };
}

/* Pulls a `## Header` section's body out of a task file's markdown, matching
   the shape `new` writes (Goal / Context pointers / Acceptance). Splits on
   section boundaries rather than a single regex with a `$` end-of-string
   lookahead — combined with the `m` flag needed to find `##` mid-body, `$`
   matches every line end, not just the true end, and silently truncates the
   last section to its first line. */
function extractSection(body, header) {
  const sections = body.split(/\r?\n(?=##\s+)/);
  for (const section of sections) {
    const m = section.match(/^##\s+(.+?)\s*\r?\n([\s\S]*)$/);
    if (m && m[1].trim() === header) return m[2].trim();
  }
  return '';
}

/* Projects the task file into the vendor-neutral brief every provider reads
   (spec §6) — Goal + Context pointers + Acceptance, plus a pointer to the
   live todos file so an agent knows where in-flight state lives. */
function buildPrompt(taskId, repo, data, body) {
  const goal = extractSection(body, 'Goal') || '(none recorded)';
  const context = extractSection(body, 'Context pointers') || '(none recorded)';
  const acceptance = extractSection(body, 'Acceptance') || '(none recorded)';
  const todosPath = path.join(repo.path, '.maestro', 'todos', `${taskId}.todos.md`);

  return [
    `# ${taskId} — ${data.title}`,
    '',
    '## Goal',
    goal,
    '',
    '## Context pointers',
    context,
    '',
    '## Acceptance',
    acceptance,
    '',
    '## Todos',
    `Live checklist: ${todosPath}`,
    `Work it item by item, checking boxes as you go, and refresh the claim heartbeat (\`maestro heartbeat ${taskId} --repo "${repo.name}"\`) on each update.`,
    '',
  ].join('\n');
}

const AGENTS_STUB = "Read PROMPT.md for the current task. Follow this repo's CLAUDE.md for conventions.\n";

function writeAgentsStub(worktreePath) {
  writeFileSync(path.join(worktreePath, 'AGENTS.md'), AGENTS_STUB);
}

/* Seeds the todos file from the task's Acceptance checkboxes the first time
   a worker/router touches a task — never overwrites an already-started list. */
function seedTodosIfEmpty(repo, taskId, body, owner) {
  const todosDir = path.join(repo.path, '.maestro', 'todos');
  mkdirSync(todosDir, { recursive: true });
  const todosPath = path.join(todosDir, `${taskId}.todos.md`);

  const existing = existsSync(todosPath) ? readFileSync(todosPath, 'utf8') : '';
  if (/^- \[[ xX]\]/m.test(existing)) return todosPath;

  const acceptance = extractSection(body, 'Acceptance');
  const items = acceptance
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^- \[[ xX]\]/.test(l));

  const header = `# ${taskId} todos — owner: ${owner} — updated: ${nowISOMinute()}`;
  const lines = [header, ...(items.length ? items : ['- [ ] (no acceptance items found — add todos manually)'])];
  writeFileSync(todosPath, `${lines.join('\n')}\n`);
  return todosPath;
}

/* Shared by `work` and `route`: claim, spin/reuse the worktree, seed
   PROMPT.md + AGENTS.md + todos. Returns everything the caller needs to
   record on the task frontmatter and report to the user. */
/* Best-effort undo of a claim taken by this call — used when worktree/prompt
   seeding fails after the claim already succeeded, so a bad repo path or a
   git error doesn't leave the task stuck "claimed" with no way back to `open`
   short of `--steal`. */
function dropClaimFiles(repo, taskId) {
  const locksDir = path.join(repo.path, '.maestro', 'locks');
  try {
    rmSync(path.join(locksDir, `${taskId}.claim.lock`), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(path.join(locksDir, `${taskId}.claim.json`), { force: true });
  } catch {
    /* best-effort */
  }
}

function releaseClaim(repo, taskId, taskPath) {
  dropClaimFiles(repo, taskId);
  try {
    setTaskFields(taskPath, { status: 'open', owner: null });
  } catch {
    /* best-effort */
  }
}

function seedTask(repo, taskId, taskPath, { owner, provider, steal, resume, takeover }) {
  const claimResult = claimTask(repo, taskId, taskPath, { owner, provider, steal, resume, takeover });

  try {
    const { data, body } = parseFrontmatter(readFileSync(taskPath, 'utf8'));
    const { worktreePath, branch, created } = ensureWorktree(repo, taskId, data.title);

    const prompt = buildPrompt(taskId, repo, data, body);
    writeFileSync(path.join(worktreePath, 'PROMPT.md'), prompt);
    writeAgentsStub(worktreePath);
    const todosPath = seedTodosIfEmpty(repo, taskId, body, owner);

    return { data, body, worktreePath, branch, created, prompt, todosPath };
  } catch (err) {
    // A resumed claim predates this call and may hold real work — never undo it.
    if (!claimResult.resumed) {
      releaseClaim(repo, taskId, taskPath);
      emitTask(repo, taskId, taskPath, { type: 'claim', actor: owner, data: { action: 'release', reason: 'rollback' } });
    }
    fail(err.message);
    throw err; // unreachable — fail() exits — but keeps control-flow analysis happy
  }
}

function cmdWork(positional, flags) {
  const taskId = positional[0];
  if (!taskId) fail('usage: maestro work T-<id> [--repo R] [--owner O] [--provider P] [--steal] [--resume [--takeover]] [--force]');

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  ensureRepoDirs(repo.path);

  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);

  const provider = resolveProvider(flags);
  const owner = typeof flags.owner === 'string' ? flags.owner : defaultActor(provider);
  const steal = !!flags.steal;
  const resume = !!flags.resume;

  const resumingOwn = resume && readClaim(repo, taskId)?.owner === owner;
  const forced = resumingOwn ? null : enforceReady(registry, repo, taskId, flags, 'work');

  const { worktreePath, branch, created, prompt, todosPath } = seedTask(repo, taskId, taskPath, {
    owner,
    provider,
    steal,
    resume,
    takeover: !!flags.takeover,
  });
  if (forced) noteForced(repo, taskId, taskPath, owner, forced, 'work');

  const fromStatus = parseFrontmatter(readFileSync(taskPath, 'utf8')).data.status ?? 'claimed';
  setTaskFields(taskPath, { status: 'in-progress', worktree: worktreePath, branch });
  refreshHeartbeat(repo, taskId);
  if (fromStatus !== 'in-progress') {
    emitTask(repo, taskId, taskPath, {
      type: 'state',
      actor: owner,
      data: { from: fromStatus, to: 'in-progress', worktree: worktreePath },
    });
  }

  console.log(`${created ? 'Created' : 'Reused'} worktree for ${taskId}: ${worktreePath}`);
  console.log(`Branch: ${branch}`);
  console.log(`Todos: ${todosPath}`);
  console.log(`Status: in-progress (owner ${owner}, session ${currentSession()})`);
  console.log('');
  console.log('--- PROMPT.md ---');
  console.log(prompt);
}

function cmdRoute(positional, flags) {
  const taskId = positional[0];
  const provider = positional[1];
  if (!taskId || !provider) fail('usage: maestro route T-<id> <provider> [--repo R] [--steal] [--force]');
  if (!ADAPTERS[provider]) fail(`unknown provider '${provider}'. Known: ${Object.keys(ADAPTERS).join(', ')}`);

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  ensureRepoDirs(repo.path);

  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);

  const owner = defaultActor(provider);
  const steal = !!flags.steal;

  const forced = enforceReady(registry, repo, taskId, flags, 'route');
  const { worktreePath, branch, created } = seedTask(repo, taskId, taskPath, { owner, provider, steal });
  if (forced) noteForced(repo, taskId, taskPath, owner, forced, 'route');

  setTaskFields(taskPath, { worktree: worktreePath, branch });

  console.log(`${created ? 'Created' : 'Reused'} worktree for ${taskId}: ${worktreePath}`);
  console.log(`Branch: ${branch}`);
  console.log('');

  if (provider === 'claude') {
    console.log('Launch string:');
    console.log(`  cd "${worktreePath}" && claude   # then: /maestro work ${taskId}`);
  } else if (provider === 'codex') {
    // §7: v1 dispatch is human-in-the-loop. This CLI cannot invoke a Claude
    // skill (/handoff) itself, so it prepares state and prints the steps —
    // the calling skill (or the human) runs /handoff and records the result
    // with `maestro set --issue`.
    console.log("Codex hand-off is two steps — this CLI can't invoke the /handoff skill itself:");
    console.log(`  1. Run /handoff ${taskId} to create the GitHub issue, then record it:`);
    console.log(`     node maestro.mjs set ${taskId} --repo "${repo.name}" --issue gh#<n>`);
    console.log('  2. Launch string (references the issue created above):');
    console.log(`     cd "${worktreePath}" && MAESTRO_PROVIDER=codex codex`);
  } else if (provider === 'cursor') {
    const adapter = ADAPTERS.cursor;
    const advisory = binaryAdvisory(adapter.bin);
    if (advisory) console.log(advisory);
    console.log('Launch string (brief piped via stdin — a long PROMPT.md can exceed CLI arg limits):');
    console.log(
      `  cd "${worktreePath}" && cat PROMPT.md | MAESTRO_PROVIDER=cursor ${adapter.bin} ${adapter.prompt_flag} "Execute the attached task brief" ${adapter.force_flag} --output-format json`
    );
  } else if (provider === 'grok') {
    const adapter = ADAPTERS.grok;
    const advisory = binaryAdvisory(adapter.bin);
    if (advisory) console.log(advisory);
    console.log(
      "Launch string (brief piped via stdin; --cwd points at our own pre-seeded worktree — never grok's own -w worktree creation, which would double-nest):"
    );
    console.log(
      `  cd "${worktreePath}" && cat PROMPT.md | MAESTRO_PROVIDER=grok ${adapter.bin} ${adapter.prompt_flag} "Execute the attached task brief" ${adapter.folder_flag} . ${adapter.force_flag}`
    );
  }
}

/* `set` flag tables. Scalars named in SET_NULLABLE accept `none` to clear;
   list flags take a comma-separated value (`none` or empty clears). */
const SET_SCALAR_FLAGS = {
  issue: 'issue',
  status: 'status',
  owner: 'owner',
  branch: 'branch',
  worktree: 'worktree',
  client: 'client',
  project: 'project',
  deadline: 'deadline',
  wu: 'wu',
  'blocked-reason': 'blocked_reason',
};
const SET_NULLABLE = new Set(['client', 'project', 'deadline', 'wu', 'blocked_reason']);
const SET_NUMBER_FLAGS = { priority: 'priority', 'budget-minutes': 'budget_minutes', 'budget-usd': 'budget_usd' };
const SET_LIST_FLAGS = { scope: 'scope', uses: 'uses', 'blocked-by': 'blocked_by', 'depends-on': 'depends_on' };

function parseListFlag(value) {
  if (value === true || value === 'none') return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function cmdSet(positional, flags) {
  const taskArg = positional[0];
  if (!taskArg) {
    fail(
      'usage: maestro set T-<id> [--issue X] [--status S] [--owner O] [--priority N] [--branch B] [--worktree W] ' +
        '[--client C] [--project P] [--deadline D] [--wu W] [--scope a,b] [--uses a,b] [--depends-on T-1,T-2] ' +
        '[--blocked-by x,y] [--blocked-reason "…"] [--budget-minutes N] [--budget-usd N] [--repo R]'
    );
  }

  const registry = loadRegistry();
  const { repo, taskId, taskPath } = resolveTask(registry, taskArg, flags.repo);

  const patch = {};
  for (const [flag, key] of Object.entries(SET_SCALAR_FLAGS)) {
    if (typeof flags[flag] !== 'string') continue;
    patch[key] = SET_NULLABLE.has(key) ? (flags[flag] === 'none' ? null : sanitizeScalar(flags[flag])) : flags[flag];
  }
  for (const [flag, key] of Object.entries(SET_NUMBER_FLAGS)) {
    if (flags[flag] !== undefined) patch[key] = Number(flags[flag]);
  }
  for (const [flag, key] of Object.entries(SET_LIST_FLAGS)) {
    if (flags[flag] !== undefined) patch[key] = parseListFlag(flags[flag]);
  }

  if (!Object.keys(patch).length) {
    fail('nothing to set — pass at least one field flag (see usage: maestro set)');
  }

  const before = parseFrontmatter(readFileSync(taskPath, 'utf8')).data;
  // Leaving `blocked` clears the blocker unless this same call sets one explicitly.
  if (before.status === 'blocked' && patch.status !== undefined && patch.status !== 'blocked' && !('blocked_by' in patch)) {
    patch.blocked_by = [];
    patch.blocked_reason = null;
  }

  setTaskFields(taskPath, patch);
  const summary = Object.entries(patch)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(', ')}]` : v}`)
    .join(', ');
  console.log(`Updated ${taskId} (${repo.name}): ${summary}`);

  if (patch.status !== undefined && patch.status !== before.status) {
    emitTask(repo, taskId, taskPath, {
      type: 'state',
      actor: defaultActor(),
      data: { from: before.status ?? null, to: patch.status, ...(patch.blocked_by?.length ? { blocked_by: patch.blocked_by } : {}) },
    });
  }
}

/* ---- L2 comms commands (maestro-comms-spec.md §4) --------------------------- */

/* Resolves a `<T-id|fleet>` target: `fleet` needs no repo; anything else
   requires a real, existing task in the resolved repo. Shared by
   say/ask/read/handoff — the four verbs that take a channel target directly
   (`answer` instead resolves its channel from an M-id, see
   resolveChannelForMessageId). */
function resolveChannelTarget(registry, target, repoFlag, { requireTask } = { requireTask: true }) {
  if (isFleet(target)) return { repo: null, target };
  const repo = resolveRepo(registry, repoFlag);
  if (requireTask && !findTaskFile(repo.path, target)) fail(`no task ${target} found in ${repo.name}`);
  return { repo, target };
}

function channelLabelFor(repo, target) {
  return isFleet(target) ? 'fleet' : `${target} (${repo.name})`;
}

function cmdSay(positional, flags) {
  const targetArg = positional[0];
  const text = positional[1];
  if (!targetArg || !text) fail('usage: maestro say <T-id|fleet> "text" [--repo R]   (text starting with "-" goes after --)');
  checkText(text, 'say text');

  const registry = loadRegistry();
  const { repo, target } = resolveChannelTarget(registry, targetArg, flags.repo);

  const { mid, author } = postMessage(repo, target, { kind: 'say', text });
  if (repo) refreshHeartbeat(repo, target);
  emitMessage({ repo, target, kind: 'say', mid, author });
  console.log(`Posted ${mid} to ${channelLabelFor(repo, target)}`);
}

function cmdRead(positional, flags) {
  const targetArg = positional[0];
  if (!targetArg) fail('usage: maestro read <T-id|fleet> [--since <ts>] [--repo R]');

  const registry = loadRegistry();
  // `read` doesn't need the task to exist (a channel can outlive/precede
  // strict task bookkeeping in edge cases) — just resolve the repo/path.
  const { repo, target } = resolveChannelTarget(registry, targetArg, flags.repo, { requireTask: false });
  const channelPath = isFleet(target) ? FLEET_CHANNEL_PATH : path.join(repo.path, '.maestro', 'channels', `${target}.md`);

  const messages = readChannelMessages(channelPath);
  const sinceMs = typeof flags.since === 'string' ? Date.parse(flags.since) : null;
  const filtered = sinceMs && !Number.isNaN(sinceMs) ? messages.filter((m) => Date.parse(m.ts) > sinceMs) : messages;

  if (flags.json) {
    console.log(JSON.stringify(filtered.map(({ raw: _raw, ...rest }) => rest), null, 2));
    return;
  }

  if (!filtered.length) {
    console.log(`(no messages${sinceMs ? ` since ${flags.since}` : ''} in ${channelLabelFor(repo, target)})`);
    return;
  }
  for (const m of filtered) console.log(m.raw);
}

function cmdAsk(positional, flags) {
  const targetArg = positional[0];
  const text = positional[1];
  if (!targetArg || !text) fail('usage: maestro ask <T-id|fleet> "question" [--to who] [--repo R]   (text starting with "-" goes after --)');
  checkText(text, 'ask text');

  const registry = loadRegistry();
  const { repo, target } = resolveChannelTarget(registry, targetArg, flags.repo);

  const targetAddr = typeof flags.to === 'string' ? flags.to : `@${HUMAN}`;
  const { mid, author } = postMessage(repo, target, { kind: 'ask', text, targetAddr, tag: 'open' });
  if (repo) refreshHeartbeat(repo, target);
  emitMessage({ repo, target, kind: 'ask', mid, author, to: targetAddr, tag: 'open' });
  console.log(mid);
}

function cmdAnswer(positional, flags) {
  const mid = positional[0];
  const text = positional[1];
  if (!mid || !text) fail('usage: maestro answer <M-id> "text" [--repo R]   (text starting with "-" goes after --)');
  checkText(text, 'answer text');

  const registry = loadRegistry();
  const { repo, target, channelPath } = resolveChannelForMessageId(registry, mid, flags.repo);
  const lockDir = channelLockDirFor(channelPath);

  // NOTE: process.exit() (what fail() calls) does NOT run pending `finally`
  // blocks — verified empirically. So this can't be a try/finally with
  // fail() inside; any failure must throw, get caught, release the lock
  // explicitly, THEN fail() — otherwise a bad answer call would leave an
  // orphaned lock directory that hangs every future post to this channel
  // until CHANNEL_LOCK_TIMEOUT_MS steals it.
  acquireChannelLock(lockDir);
  let answerMid, askAuthor;
  try {
    const original = existsSync(channelPath) ? readFileSync(channelPath, 'utf8') : '';
    const lines = original.length ? original.replace(/\n$/, '').split('\n') : [];

    let askIdx = -1;
    let ask = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const parsed = parseMessageLine(lines[i]);
        if (parsed.mid === mid) {
          askIdx = i;
          ask = parsed;
          break;
        }
      } catch {
        /* malformed line — tolerated, just not a match */
      }
    }
    if (!ask) throw new Error(`message ${mid} not found in ${channelPath}`);
    if (ask.kind !== 'ask') throw new Error(`${mid} is a '${ask.kind}' message, not an 'ask' — nothing to answer`);
    if (ask.tag !== 'open') warn(`${mid} was already '${ask.tag ?? 'untagged'}' — appending another answer anyway`);

    askAuthor = ask.author;
    const base = messageBaseFor(target);
    const seq = nextMessageSeq(channelPath, base);
    answerMid = `M-${base}-${seq}`;
    const ts = isoSeconds(new Date());
    const answerLine = formatMessageLine({ ts, mid: answerMid, author: HUMAN, kind: 'answer', target: askAuthor, reId: mid, text });

    // The one sanctioned in-place edit (comms spec §5): flip this ask's
    // #open -> #resolved, under the same lock as the append below.
    lines[askIdx] = lines[askIdx].replace(/#open\s*$/, '#resolved');
    lines.push(answerLine);

    writeFileSync(channelPath, `${lines.join('\n')}\n`);
  } catch (err) {
    releaseChannelLock(lockDir);
    fail(err.message);
    throw err; // unreachable — fail() exits — but keeps control-flow analysis happy
  }
  releaseChannelLock(lockDir);

  emitMessage({ repo, target, kind: 'answer', mid: answerMid, author: HUMAN, to: askAuthor, tag: null, reId: mid });
  console.log(`Posted ${answerMid} (answer→${askAuthor} re:${mid}) to ${channelLabelFor(repo, target)} — ${mid} now #resolved`);
}

function cmdInbox(positional, flags) {
  const registry = loadRegistry();
  const forWho = normalizeWho(typeof flags.for === 'string' ? flags.for : HUMAN);

  const rows = collectOpenAsks(registry).filter((r) => normalizeWho(r.target) === forWho);

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log(`inbox: no open asks for ${forWho}`);
    return;
  }
  console.log(`⚑ ${rows.length} open ask(s) for ${forWho}:`);
  for (const r of rows) {
    console.log(`  ${r.mid}  [${r.channel}]  ${r.author} asked (${r.ts}): ${r.text}`);
  }
}

function cmdHandoff(positional, flags) {
  const targetArg = positional[0];
  const text = positional[1];
  if (!targetArg || !text || typeof flags.to !== 'string' || !flags.to) {
    fail('usage: maestro handoff <T-id|fleet> --to <who> "text" [--repo R]');
  }
  checkText(text, 'handoff text');

  const registry = loadRegistry();
  const { repo, target } = resolveChannelTarget(registry, targetArg, flags.repo);

  const { mid, author } = postMessage(repo, target, { kind: 'handoff', text, targetAddr: flags.to });
  if (repo) refreshHeartbeat(repo, target);
  emitMessage({ repo, target, kind: 'handoff', mid, author, to: flags.to });
  console.log(`Posted ${mid} (handoff→${flags.to}) to ${channelLabelFor(repo, target)}`);
}

function worktreeBranchesFor(repoPath) {
  const branches = new Set();
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const m = line.match(/^branch refs\/heads\/(.+)$/);
      if (m) branches.add(m[1]);
    }
  } catch {
    /* not a git repo, git missing, or no worktrees — non-fatal, best-effort only */
  }
  return branches;
}

function countTodos(todosPath) {
  if (!existsSync(todosPath)) return { done: 0, total: 0 };
  const text = readFileSync(todosPath, 'utf8');
  const checked = text.match(/^- \[x\]/gim) || [];
  const unchecked = text.match(/^- \[ \]/gim) || [];
  return { done: checked.length, total: checked.length + unchecked.length };
}

const nz = (v) => (v === undefined || v === '' ? null : v);

/* Walks every registered repo's tasks into row objects (frontmatter + claim +
   todos + channel facts). `quiet` suppresses per-file warnings for callers that
   aren't the sync itself (the claim gate). */
function loadTaskRows(registry, { quiet = false } = {}) {
  const note = quiet ? () => {} : warn;
  const rows = [];

  for (const repo of registry.repos) {
    const tasksDir = tasksDirFor(repo.path);
    if (!existsSync(tasksDir)) continue;

    let files;
    try {
      files = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    } catch (e) {
      note(`cannot read tasks dir for ${repo.name}: ${e.message}`);
      continue;
    }

    const worktreeBranches = worktreeBranchesFor(repo.path);

    for (const file of files) {
      const full = path.join(tasksDir, file);
      let data;
      try {
        ({ data } = parseFrontmatter(readFileSync(full, 'utf8')));
        if (!data.id) throw new Error('missing id field');
      } catch (e) {
        note(`skipping malformed task file ${full}: ${e.message}`);
        continue;
      }

      const id = data.id;
      const { done, total } = countTodos(path.join(repo.path, '.maestro', 'todos', `${id}.todos.md`));

      const claimPath = path.join(repo.path, '.maestro', 'locks', `${id}.claim.json`);
      let owner = data.owner ?? null;
      let stale = false;
      if (existsSync(claimPath)) {
        try {
          const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
          owner = claim.owner;
          const ttlMs = (claim.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000;
          stale = Date.now() - Date.parse(claim.heartbeat) > ttlMs;
        } catch (e) {
          note(`unreadable claim file ${claimPath}: ${e.message}`);
        }
      }

      const needsHuman = countNeedsHuman(path.join(repo.path, '.maestro', 'channels', `${id}.md`));

      rows.push({
        repoName: repo.name,
        taskId: id,
        globalId: `${repo.name}/${id}`,
        title: data.title ?? '(untitled)',
        status: data.status ?? 'open',
        owner,
        stale,
        progress: `${done}/${total}`,
        priority: data.priority ?? 3,
        updated: data.updated ?? '',
        hasWorktree: Boolean(data.branch && worktreeBranches.has(data.branch)),
        needsHuman,
        client: clientFor(repo.name, data),
        project: nz(data.project),
        deadline: nz(data.deadline),
        wu: nz(data.wu),
        scope: asList(data.scope),
        uses: asList(data.uses),
        dependsOn: asList(data.depends_on),
        blockedBy: asList(data.blocked_by),
        blockedReason: nz(data.blocked_reason),
        budgetMinutes: nz(data.budget_minutes),
        budgetUsd: nz(data.budget_usd),
      });
    }
  }
  return rows;
}

/* `T-3` -> `<repo>/T-3`; a value already containing `/` is a global id. */
function normalizeTaskRef(ref, repoName) {
  const s = String(ref).trim();
  if (!s) return null;
  return s.includes('/') ? s : `${repoName}/${s}`;
}

/* Display form: drop the row's own repo prefix. */
function displayRef(ref, repoName) {
  return String(ref).startsWith(`${repoName}/`) ? String(ref).slice(repoName.length + 1) : String(ref);
}

const TASK_REF_RE = /^(?:.+\/)?T-\d+$/;

/* Strongly-connected components of the depends_on graph that are real cycles
   (size > 1, or a task depending on itself). Tarjan; the graph is tiny. */
function findDependencyCycles(rows, byId) {
  let counter = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const low = new Map();
  const cycles = [];

  function visit(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of byId.get(v).dependsOn) {
      if (!byId.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || byId.get(v).dependsOn.includes(v)) cycles.push(component.reverse());
    }
  }

  for (const r of rows) if (!index.has(r.globalId)) visit(r.globalId);
  return cycles;
}

/* Readiness (spec §14.2). Mutates rows: normalizes dependsOn to global ids and
   sets `waitingOn` + `ready`.
     waitingOn = depends_on entries not (yet) done  +  blocked_by entries
                 (a blocked_by that names a done task counts as resolved)
     ready     = status is `open` AND waitingOn is empty
   A task in a dependency cycle is never ready and waits on ['cycle'].
   Returns { cycles, missing }: the cycles found (arrays of global ids) and a
   Map of depends_on targets that name no known task -> the tasks naming them,
   so the caller can warn once. */
function annotateReadiness(rows) {
  const byId = new Map(rows.map((r) => [r.globalId, r]));
  for (const r of rows) r.dependsOn = r.dependsOn.map((d) => normalizeTaskRef(d, r.repoName)).filter(Boolean);

  const cycles = findDependencyCycles(rows, byId);
  const cyclic = new Set(cycles.flat());
  const missing = new Map();
  for (const r of rows) {
    for (const dep of r.dependsOn) {
      if (!byId.has(dep)) missing.set(dep, [...(missing.get(dep) ?? []), r.globalId]);
    }
  }

  for (const r of rows) {
    if (r.status === 'done') {
      r.waitingOn = [];
      r.ready = false;
      continue;
    }
    if (cyclic.has(r.globalId)) {
      r.waitingOn = ['cycle'];
      r.ready = false;
      continue;
    }
    const waiting = [];
    for (const dep of r.dependsOn) {
      if (byId.get(dep)?.status !== 'done') waiting.push(dep);
    }
    for (const b of r.blockedBy) {
      const ref = String(b).trim();
      if (!ref) continue;
      if (TASK_REF_RE.test(ref)) {
        const global = normalizeTaskRef(ref, r.repoName);
        if (byId.get(global)?.status === 'done') continue;
        waiting.push(global);
      } else {
        waiting.push(ref);
      }
    }
    r.waitingOn = waiting;
    r.ready = r.status === 'open' && waiting.length === 0;
  }
  return { cycles, missing };
}

function cmdSync() {
  const registry = loadRegistry();
  const rows = loadTaskRows(registry);
  const { cycles, missing } = annotateReadiness(rows);
  for (const cycle of cycles) {
    warn(`dependency cycle: ${[...cycle, cycle[0]].join(' -> ')} (these tasks are not ready)`);
  }
  if (missing.size) {
    const list = [...missing].map(([dep, by]) => `${dep} (named by ${by.join(', ')})`).join('; ');
    warn(`depends_on names ${missing.size} task(s) that do not exist — they never resolve: ${list}`);
  }

  const indexLines = rows.map((r) =>
    JSON.stringify({
      id: r.globalId,
      repo: r.repoName,
      title: r.title,
      status: r.status,
      owner: r.owner,
      progress: r.progress,
      priority: r.priority,
      updated: r.updated,
      needs_human: r.needsHuman,
      client: r.client,
      project: r.project,
      deadline: r.deadline,
      wu: r.wu,
      scope: r.scope,
      uses: r.uses,
      depends_on: r.dependsOn,
      blocked_by: r.blockedBy,
      blocked_reason: r.blockedReason,
      budget_minutes: r.budgetMinutes,
      budget_usd: r.budgetUsd,
      ready: r.ready,
      waiting_on: r.waitingOn,
    })
  );
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, indexLines.length ? `${indexLines.join('\n')}\n` : '');

  // Derived comms projections (comms spec §2, §7) — inbox.jsonl (every open
  // ask, any target) and the board's ⚑ block (just the ones for the human).
  const openAsks = collectOpenAsks(registry);
  writeFileSync(INBOX_PATH, openAsks.length ? `${openAsks.map((a) => JSON.stringify(a)).join('\n')}\n` : '');
  const needsYou = openAsks.filter((a) => normalizeWho(a.target) === normalizeWho(HUMAN));

  writeFileSync(BOARD_PATH, renderBoard(rows, needsYou));

  // Diagnostic progress line, not payload — stderr unconditionally so stdout
  // stays pure for `--json` consumers (board/inbox/read) that trigger a sync
  // first. Humans still see it in the terminal either way.
  console.error(`sync: ${rows.length} task(s) across ${registry.repos.length} repo(s) → ${INDEX_PATH}`);
  return rows;
}

/* #open asks in a task's channel addressed to the human — this is the count
   that lands in index.jsonl's `needs_human` field (comms spec §7). */
function countNeedsHuman(channelPath) {
  let n = 0;
  for (const m of readChannelMessages(channelPath)) {
    if (m.kind === 'ask' && m.tag === 'open' && normalizeWho(m.target) === normalizeWho(HUMAN)) n++;
  }
  return n;
}

function renderBoard(rows, needsYou = []) {
  const groups = new Map(STATUS_ORDER.map((s) => [s, []]));
  for (const r of rows) {
    if (!groups.has(r.status)) groups.set(r.status, []);
    groups.get(r.status).push(r);
  }

  const staleCount = rows.filter((r) => r.stale).length;
  const readyCount = rows.filter((r) => r.ready).length;
  const lines = [
    '# Maestro Board',
    '',
    `_Generated ${isoSeconds(new Date())} by \`maestro sync\`_`,
    '',
  ];

  // Derived header block (comms spec §7) — kept out of the status tables
  // below on purpose; it's a cross-cutting "blocked on you" view, not a
  // task status.
  if (needsYou.length) {
    lines.push(`⚑ NEEDS YOU (${needsYou.length})`, '');
    for (const a of needsYou) {
      lines.push(`- [${a.channel}] ${a.author} asked (${a.mid}): ${a.text}`);
    }
    lines.push('');
  }

  lines.push(
    `${rows.length} task(s) tracked · ${readyCount} ready${staleCount ? ` · ${staleCount} STALE claim(s)` : ''}`,
    ''
  );

  for (const [status, list] of groups) {
    lines.push(`## ${status} (${list.length})`);
    lines.push('');
    if (!list.length) {
      lines.push('_none_', '');
      continue;
    }
    lines.push('| id | title | owner | progress | priority | updated | waiting on |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const r of [...list].sort((a, b) => a.priority - b.priority)) {
      const ownerCell = r.owner ? (r.stale ? `${r.owner} ⚠ STALE` : r.owner) : '—';
      const idCell = r.needsHuman ? `${r.globalId} ⚑` : r.globalId;
      const waitCell = r.waitingOn?.length ? r.waitingOn.map((w) => displayRef(w, r.repoName)).join(', ') : '—';
      lines.push(`| ${idCell} | ${r.title} | ${ownerCell} | ${r.progress} | ${r.priority} | ${r.updated} | ${waitCell} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function cmdBoard(flags) {
  const rows = cmdSync();
  if (flags?.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(readFileSync(BOARD_PATH, 'utf8'));
}

/* ---- Agent Ops P1a verbs: release / block / done / reap (spec §14) ---------------- */

/* Every git call below may run inside a directory an agent could have shaped
   (a task worktree), so repo-config-driven execution hooks are switched off. */
const GIT_HARDENING = [
  '-c', 'core.fsmonitor=false',
  '-c', 'safe.bareRepository=explicit',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'diff.external=',
  '-c', 'submodule.recurse=false',
];

function gitOut(cwd, args) {
  return execFileSync('git', [...GIT_HARDENING, '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

/* The `worktree:` / `branch:` frontmatter values are plain text anyone (or any
   agent) can edit, and `done`/`reap` act on them destructively — so nothing
   destructive is ever driven by `worktree:`. The worktree to inspect or remove
   is DERIVED FROM GIT: the entry in `git worktree list` whose branch is the
   task's recorded branch, and only if it sits at the exact path Maestro creates
   for this task (<projects>/.maestro/worktrees/<repo>/<task>) and is not the
   main checkout. The recorded `worktree:` value is consulted only to warn when
   it disagrees. Returns the resolved real path, or null. */
const realPath = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

function taskWorktree(repo, taskId, data) {
  if (!safeBranchName(data.branch)) return null;
  const expected = realPath(path.join(WORKTREES_ROOT, slugify(repo.name), taskId));
  const main = realPath(repo.path);
  for (const w of listGitWorktrees(repo.path)) {
    if (w.branch !== data.branch) continue;
    const p = realPath(w.path);
    if (p !== main && p === expected) return p;
  }
  return null;
}

/* True (with a warning) when the task file records a worktree that exists on
   disk but is not the one git derived — it is then ignored, never touched. */
function recordedWorktreeDisagrees(repo, taskId, data, derived) {
  if (!data.worktree || !existsSync(String(data.worktree))) return false;
  if (derived && realPath(String(data.worktree)) === derived) return false;
  warn(`${repo.name}/${taskId}: recorded worktree '${data.worktree}' is not the worktree git has for branch '${data.branch ?? '(none)'}' — ignoring it (never inspected or removed)`);
  return true;
}

const headRef = (branch) => `refs/heads/${branch}`;

/* Branch names go straight into git argv; refuse anything option-shaped. */
function safeBranchName(branch) {
  return typeof branch === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) && !branch.includes('..');
}

function gitErr(e) {
  const text = [e.stderr, e.stdout].map((s) => (s ? s.toString().trim() : '')).filter(Boolean).join(' | ');
  return text || e.message;
}

/* The branch finished work lands on: origin/HEAD if the clone has one, else
   `main`, else `master`. null = can't tell, which callers treat as "unsafe". */
function defaultBranch(repoPath) {
  try {
    const ref = gitOut(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
    const name = ref.replace(/^origin\//, '');
    if (name && gitBranchExists(repoPath, name)) return name;
  } catch {
    /* no origin/HEAD — fall through */
  }
  for (const name of ['main', 'master']) if (gitBranchExists(repoPath, name)) return name;
  return null;
}

/* `git status --porcelain` lines that represent real work. The files Maestro
   seeds itself (an untracked PROMPT.md / AGENTS.md, or an AGENTS.md that still
   holds the seeded stub) don't count. `ignoreMaestro` skips <repo>/.maestro/ —
   Maestro's own bookkeeping, which some repos track — when judging the MAIN
   checkout. */
function dirtyLines(dir, { untracked = true, ignoreMaestro = false } = {}) {
  const out = gitOut(dir, ['status', '--porcelain', '--ignore-submodules', untracked ? '--untracked-files=normal' : '--untracked-files=no']);
  return out
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      const file = line.slice(3).replace(/^"|"$/g, '');
      if (line.startsWith('?? ') && (file === 'PROMPT.md' || file === 'AGENTS.md')) return false;
      if (file === 'AGENTS.md') {
        try {
          if (readFileSync(path.join(dir, 'AGENTS.md'), 'utf8') === AGENTS_STUB) return false;
        } catch {
          /* unreadable — counts as dirty */
        }
      }
      if (ignoreMaestro && (file === '.maestro' || file.startsWith('.maestro/'))) return false;
      return true;
    });
}

/* Is anything at risk if this task's claim is dropped? Looks at the recorded
   worktree (uncommitted changes) and branch (commits beyond the default branch
   that exist on no remote). Anything it cannot verify is reported as `unknown`,
   which callers treat as not-clean. */
function inspectWork(repo, data) {
  const out = { worktree: data.worktree ?? null, branch: data.branch ?? null, dirty: [], ahead: 0, unpushed: 0, unknown: null };
  const wt = taskWorktree(repo, data.id ?? '?', data);
  if (recordedWorktreeDisagrees(repo, data.id ?? '?', data, wt)) {
    out.unknown = 'recorded worktree is not a Maestro/git worktree of this repo (not inspected)';
  } else if (wt && existsSync(wt)) {
    try {
      out.dirty = dirtyLines(wt);
    } catch (e) {
      out.unknown = `cannot inspect worktree: ${gitErr(e)}`;
    }
  }
  if (out.branch && !safeBranchName(out.branch)) {
    out.unknown = `unsafe branch name '${out.branch}'`;
  } else if (out.branch && gitBranchExists(repo.path, out.branch)) {
    const base = defaultBranch(repo.path);
    if (!base) {
      out.unknown = 'cannot determine the default branch';
    } else {
      try {
        out.ahead = Number(gitOut(repo.path, ['rev-list', '--count', `${headRef(base)}..${headRef(out.branch)}`]).trim());
        if (out.ahead > 0) {
          out.unpushed = Number(gitOut(repo.path, ['rev-list', '--count', `${headRef(base)}..${headRef(out.branch)}`, '--not', '--remotes']).trim());
        }
      } catch (e) {
        out.unknown = `cannot compare branch: ${gitErr(e)}`;
      }
    }
  }
  return out;
}

function describeWork(w) {
  const parts = [];
  if (w.dirty.length) parts.push(`${w.dirty.length} uncommitted file(s)`);
  if (w.unpushed) parts.push(`${w.unpushed} unpushed commit(s)`);
  if (w.unknown) parts.push(w.unknown);
  return parts.join(', ');
}

function cmdRelease(positional, flags) {
  const ref = positional[0];
  if (!ref) fail('usage: maestro release T-<id> [--repo R]');

  const registry = loadRegistry();
  const { repo, taskId, taskPath } = resolveTask(registry, ref, flags.repo);
  const { data } = parseFrontmatter(readFileSync(taskPath, 'utf8'));
  if (data.status === 'done') fail(`${taskId} is done — nothing to release`);

  const claim = readClaim(repo, taskId);
  releaseClaim(repo, taskId, taskPath);

  const actor = defaultActor();
  if (claim) {
    emitTask(repo, taskId, taskPath, {
      type: 'claim',
      actor,
      data: { action: 'release', prev_owner: claim.owner ?? null, worktree: data.worktree ?? null },
    });
  }
  if ((data.status ?? 'open') !== 'open') {
    emitTask(repo, taskId, taskPath, { type: 'state', actor, data: { from: data.status, to: 'open' } });
  }
  console.log(
    claim
      ? `Released ${taskId} (${repo.name}) — claim by ${claim.owner} dropped, status open${data.worktree ? `, worktree kept at ${data.worktree}` : ''}`
      : `${taskId} (${repo.name}) had no claim — status set to open`
  );
}

const BLOCK_BY_RE = /^(?:@[\w.-]+|(?:external|resource):\S+)$/;

function cmdBlock(positional, flags) {
  const ref = positional[0];
  const reason = positional[1];
  if (!ref || typeof flags.by !== 'string' || !reason) {
    fail('usage: maestro block T-<id> --by <@person|external:x|resource:x|T-id>[,…] "reason" [--repo R]   (a reason starting with "-" goes after --)');
  }
  checkText(reason, 'block reason');
  const blockers = parseListFlag(flags.by);
  if (!blockers.length) fail('--by needs at least one blocker');
  for (const b of blockers) {
    if (!BLOCK_BY_RE.test(b) && !TASK_REF_RE.test(b)) {
      fail(`bad --by value '${b}' — use @person, external:<who>, resource:<name>, or a task id (T-n or repo/T-n)`);
    }
  }

  const registry = loadRegistry();
  const { repo, taskId, taskPath } = resolveTask(registry, ref, flags.repo);
  const { data } = parseFrontmatter(readFileSync(taskPath, 'utf8'));
  if (data.status === 'done') fail(`${taskId} is done — cannot block it`);
  if (blockers.some((b) => b === taskId || b === `${repo.name}/${taskId}`)) fail(`${taskId} cannot be blocked by itself`);

  const cleanReason = sanitizeScalar(reason);
  setTaskFields(taskPath, { status: 'blocked', blocked_by: blockers, blocked_reason: cleanReason });

  const actor = defaultActor();
  emitTask(repo, taskId, taskPath, {
    type: 'state',
    actor,
    data: { from: data.status ?? null, to: 'blocked', blocked_by: blockers },
  });
  console.log(`Blocked ${taskId} (${repo.name}) by ${blockers.join(', ')} — ${cleanReason}`);

  // A human blocker also gets a real ask, so it lands in their inbox / on the board.
  for (const who of blockers.filter((b) => b.startsWith('@'))) {
    const { mid, author } = postMessage(repo, taskId, { kind: 'ask', text: cleanReason, targetAddr: who, tag: 'open' });
    if (readClaim(repo, taskId)) refreshHeartbeat(repo, taskId);
    emitMessage({ repo, target: taskId, kind: 'ask', mid, author, to: who, tag: 'open', taskPath });
    console.log(`Asked ${who}: ${mid}`);
  }
}

const boxLines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^- \[[ xX]\]/.test(l));

/* Where "every Acceptance box is checked" is judged: the live todos file when it
   has any boxes (workers tick that, not the task file), else the task's own
   Acceptance section. */
function acceptanceState(repo, taskId, body) {
  const todosPath = path.join(repo.path, '.maestro', 'todos', `${taskId}.todos.md`);
  const todoBoxes = existsSync(todosPath) ? boxLines(readFileSync(todosPath, 'utf8')) : [];
  if (todoBoxes.length) {
    const { done, total } = countTodos(todosPath);
    return { source: 'todos file', total, unchecked: done === total ? [] : todoBoxes.filter((l) => /^- \[ \]/.test(l)) };
  }
  const accBoxes = boxLines(extractSection(body, 'Acceptance'));
  return { source: 'task Acceptance section', total: accBoxes.length, unchecked: accBoxes.filter((l) => /^- \[ \]/.test(l)) };
}

function openAsksFor(repo, taskId) {
  return readChannelMessages(path.join(repo.path, '.maestro', 'channels', `${taskId}.md`)).filter(
    (m) => m.kind === 'ask' && m.tag === 'open'
  );
}

/* Merges the task branch into the repo's default branch inside the repo's own
   checkout. Refuses (state untouched) when that is unsafe: task worktree has
   uncommitted work, the checkout isn't on the default branch, or it has tracked
   changes outside .maestro/. A real merge conflict is aborted cleanly and turns
   into a `blocked` task. Exits non-zero on any failure; returns on success. */
function mergeTaskBranch(repo, taskId, taskPath, data, actor, worktree) {
  const branch = data.branch;
  const base = defaultBranch(repo.path);
  if (!base) fail(`done refused for ${taskId}: cannot determine ${repo.name}'s default branch — merge by hand, then rerun with --no-merge`);

  if (worktree && existsSync(worktree)) {
    let dirty;
    try {
      dirty = dirtyLines(worktree);
    } catch (e) {
      fail(`done refused for ${taskId}: cannot inspect the task worktree (${gitErr(e)})`);
    }
    if (dirty.length) {
      fail(
        `done refused for ${taskId}: task worktree has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 4).join('; ')}) — commit or discard them first`
      );
    }
  }

  let current = '';
  try {
    current = gitOut(repo.path, ['branch', '--show-current']).trim();
  } catch (e) {
    fail(`done refused for ${taskId}: ${gitErr(e)}`);
  }
  if (current !== base) {
    fail(
      `done refused for ${taskId}: ${repo.name}'s checkout is on '${current || 'a detached HEAD'}', not '${base}' — switch it, or merge ${branch} by hand and rerun with --no-merge`
    );
  }
  let dirtyMain;
  try {
    dirtyMain = dirtyLines(repo.path, { untracked: false, ignoreMaestro: true });
  } catch (e) {
    fail(`done refused for ${taskId}: ${gitErr(e)}`);
  }
  if (dirtyMain.length) {
    fail(
      `done refused for ${taskId}: ${repo.name}'s '${base}' checkout has uncommitted tracked changes (${dirtyMain.slice(0, 4).join('; ')}) — merging here is unsafe; clean it, or merge ${branch} by hand and rerun with --no-merge`
    );
  }

  try {
    gitOut(repo.path, ['merge', '--no-edit', '-m', `Merge ${branch} (${repo.name}/${taskId})`, headRef(branch)]);
    return;
  } catch (e) {
    const detail = gitErr(e);
    let conflicts = [];
    try {
      conflicts = gitOut(repo.path, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    } catch {
      /* no conflict list available */
    }
    let midMerge = false;
    try {
      gitOut(repo.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      midMerge = true;
    } catch {
      /* no MERGE_HEAD — the merge never started or already unwound */
    }
    if (midMerge) {
      try {
        gitOut(repo.path, ['merge', '--abort']);
      } catch (abortErr) {
        fail(`merge of ${branch} conflicted and 'git merge --abort' failed (${gitErr(abortErr)}) — ${repo.path} is mid-merge; run 'git merge --abort' there by hand`);
      }
    }
    if (!conflicts.length) fail(`done refused for ${taskId}: merging ${branch} into ${base} failed — ${detail}`);

    const reason = sanitizeScalar(
      `merge conflict merging ${branch} into ${base} in ${conflicts.length} file(s): ${conflicts.slice(0, 5).join(' ')}${conflicts.length > 5 ? ' …' : ''}`
    );
    setTaskFields(taskPath, { status: 'blocked', blocked_by: [`conflict:${base}`], blocked_reason: reason });
    try {
      const { mid, author } = postMessage(repo, taskId, { kind: 'say', text: `done aborted — ${reason}`, author: actor });
      emitMessage({ repo, target: taskId, kind: 'say', mid, author, taskPath });
    } catch {
      /* the block itself is the record that matters */
    }
    emitTask(repo, taskId, taskPath, { type: 'state', actor, data: { from: 'review', to: 'blocked', blocked_by: [`conflict:${base}`] } });
    emitTask(repo, taskId, taskPath, { type: 'error', actor, data: { class: 'conflict', message: reason.slice(0, 240) } });
    fail(
      `merge conflict — ${taskId} NOT merged (merge aborted, ${repo.name} left clean). Marked blocked (conflict:${base}). Resolve in the task worktree (merge ${base} into ${branch}), then: set ${taskId} --status review && done ${taskId}`
    );
  }
}

function cmdDone(positional, flags) {
  const ref = positional[0];
  if (!ref) fail('usage: maestro done T-<id> [--repo R] [--no-merge]');

  const registry = loadRegistry();
  const { repo, taskId, taskPath } = resolveTask(registry, ref, flags.repo);
  const { data, body } = parseFrontmatter(readFileSync(taskPath, 'utf8'));
  const noMerge = !!flags['no-merge'];
  const actor = defaultActor();

  const problems = [];
  if (data.status !== 'review') {
    problems.push(`status is '${data.status ?? 'open'}', not 'review' (a worker ends at review: set ${taskId} --status review)`);
  }
  const acc = acceptanceState(repo, taskId, body);
  if (acc.total === 0) {
    problems.push('no Acceptance checkboxes recorded anywhere (todos file or task Acceptance section) — nothing to verify against');
  } else if (acc.unchecked.length) {
    problems.push(`${acc.unchecked.length} of ${acc.total} Acceptance item(s) unchecked in the ${acc.source}: ${acc.unchecked.slice(0, 3).join(' / ')}`);
  }
  const asks = openAsksFor(repo, taskId);
  if (asks.length) problems.push(`${asks.length} open ask(s) on the task channel: ${asks.map((a) => a.mid).join(', ')} (answer them first)`);
  if (problems.length) fail(`done refused for ${taskId}:\n  - ${problems.join('\n  - ')}`);

  let merged = false;
  let tornDown = false;
  let branchDeleted = false;
  if (!noMerge) {
    if (data.branch && !safeBranchName(data.branch)) {
      fail(`done refused for ${taskId}: recorded branch '${data.branch}' is not a plain branch name`);
    }
    if (data.branch && !data.branch.startsWith(`maestro/${taskId}-`)) {
      fail(`done refused for ${taskId}: recorded branch '${data.branch}' is not this task's maestro/${taskId}-* branch — merge it by hand and use --no-merge`);
    }
    // Destructive steps act on the worktree git derives for this branch, never on `worktree:`.
    const worktree = taskWorktree(repo, taskId, data);
    recordedWorktreeDisagrees(repo, taskId, data, worktree);
    if (!data.branch || !gitBranchExists(repo.path, data.branch)) {
      console.log(`note: ${taskId} has no task branch to merge (branch: ${data.branch ?? 'unset'}) — marking done without a merge`);
    } else {
      mergeTaskBranch(repo, taskId, taskPath, data, actor, worktree);
      merged = true;
      if (worktree && existsSync(worktree)) {
        try {
          gitOut(repo.path, ['worktree', 'remove', '--force', worktree]);
          tornDown = true;
        } catch (e) {
          warn(`merged, but 'git worktree remove' failed for ${worktree}: ${gitErr(e)} — remove it by hand`);
        }
      } else {
        try {
          gitOut(repo.path, ['worktree', 'prune']);
        } catch {
          /* best-effort */
        }
      }
      try {
        gitOut(repo.path, ['branch', '-d', '--', data.branch]);
        branchDeleted = true;
      } catch (e) {
        warn(`merged, but could not delete branch ${data.branch}: ${gitErr(e)}`);
      }
    }
  }

  const claim = readClaim(repo, taskId);
  dropClaimFiles(repo, taskId);
  const patch = { status: 'done' };
  if (tornDown) patch.worktree = null;
  if (asList(data.blocked_by).length) {
    patch.blocked_by = [];
    patch.blocked_reason = null;
  }
  setTaskFields(taskPath, patch);

  emitTask(repo, taskId, taskPath, { type: 'state', actor, data: { from: 'review', to: 'done', merged, branch: data.branch ?? null } });
  if (claim) {
    emitTask(repo, taskId, taskPath, { type: 'claim', actor, data: { action: 'release', reason: 'done', prev_owner: claim.owner ?? null } });
  }

  console.log(`Done ${taskId} (${repo.name}).`);
  if (noMerge) console.log(`  --no-merge: branch ${data.branch ?? '(none)'} and worktree ${data.worktree ?? '(none)'} left as they were; claim released.`);
  else if (merged) {
    console.log(
      `  merged ${data.branch} into the default branch${tornDown ? ', worktree removed' : ', worktree NOT removed'}${branchDeleted ? ', branch deleted' : ', branch NOT deleted'}; claim released.`
    );
  }
  else console.log('  claim released.');
}

/* Has the claim's session written an event file lately? events.mjs names its
   files <actor>-<token>.jsonl, where token is the first 8 chars of the session,
   lowercased (it exports sessionFileToken(); the same rule is the fallback here).
   Only claims that recorded a session can be checked. */
function sessionFileToken(session) {
  try {
    const t = eventsModule?.sessionFileToken?.(session);
    if (typeof t === 'string' && t) return t;
  } catch {
    /* fall back to the documented rule */
  }
  return String(session).slice(0, 8).toLowerCase();
}

function hasRecentEvents(claim, windowMs) {
  if (!claim.session) return false;
  const suffix = `-${sessionFileToken(claim.session)}.jsonl`;
  let days;
  try {
    days = readdirSync(EVENTS_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-2);
  } catch {
    return false;
  }
  for (const day of days) {
    let files;
    try {
      files = readdirSync(path.join(EVENTS_DIR, day));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(suffix)) continue;
      try {
        if (Date.now() - statSync(path.join(EVENTS_DIR, day, f)).mtimeMs < windowMs) return true;
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
  return false;
}

function cmdReap(positional, flags) {
  const dryRun = !!flags['dry-run'];
  const registry = loadRegistry();
  const started = Date.now();
  const actor = `reaper@${SHORT_HOST}`;
  const stats = { scanned: 0, live: 0, stale: 0, active: 0, errors: 0 };
  const released = [];
  const needsYou = [];

  for (const repo of registry.repos) {
    const locksDir = path.join(repo.path, '.maestro', 'locks');
    if (!existsSync(locksDir)) continue;
    let files;
    try {
      files = readdirSync(locksDir).filter((f) => f.endsWith('.claim.json'));
    } catch (e) {
      warn(`cannot read locks dir for ${repo.name}: ${e.message}`);
      stats.errors++;
      continue;
    }
    for (const file of files) {
      const taskId = file.replace(/\.claim\.json$/, '');
      const globalId = `${repo.name}/${taskId}`;
      try {
        stats.scanned++;
        const claim = JSON.parse(readFileSync(path.join(locksDir, file), 'utf8'));
        const ttlMs = (claim.ttl_seconds ?? DEFAULT_TTL_SECONDS) * 1000;
        const heartbeatMs = Date.parse(claim.heartbeat);
        const age = Number.isNaN(heartbeatMs) ? Infinity : Date.now() - heartbeatMs;
        if (age <= ttlMs) {
          stats.live++;
          continue;
        }
        if (age <= 2 * ttlMs) {
          stats.stale++; // STALE on the board already; the reaper waits for 2×TTL
          continue;
        }
        const taskPath = findTaskFile(repo.path, taskId);
        if (!taskPath) {
          warn(`${globalId}: claim file with no task file — leaving it`);
          stats.errors++;
          continue;
        }
        if (hasRecentEvents(claim, 2 * ttlMs)) {
          stats.active++;
          continue;
        }
        const { data } = parseFrontmatter(readFileSync(taskPath, 'utf8'));
        const ageMin = Number.isFinite(age) ? Math.round(age / 60000) : null;
        const work = inspectWork(repo, data);
        const risk = describeWork(work);
        if (risk) {
          needsYou.push({ id: globalId, owner: claim.owner ?? null, status: data.status ?? null, since: Number.isNaN(heartbeatMs) ? null : isoSeconds(new Date(heartbeatMs)), age_min: ageMin, worktree: work.worktree, branch: work.branch, reason: risk });
          continue;
        }
        released.push({ id: globalId, owner: claim.owner ?? null, age_min: ageMin });
        if (dryRun) continue;
        dropClaimFiles(repo, taskId);
        const patch = { owner: null };
        if (data.status === 'claimed' || data.status === 'in-progress') patch.status = 'open';
        setTaskFields(taskPath, patch);
        try {
          postMessage(null, 'fleet', { kind: 'say', text: `reaped ${globalId} from ${claim.owner ?? 'unknown'}`, author: actor });
        } catch (e) {
          warn(`could not post the reap notice for ${globalId}: ${e.message}`);
        }
        emitTask(repo, taskId, taskPath, {
          type: 'claim',
          actor,
          data: { action: 'release', reason: 'reaped', prev_owner: claim.owner ?? null, age_min: ageMin },
        });
      } catch (e) {
        stats.errors++;
        warn(`${globalId}: reap failed — ${e.message}`);
      }
    }
  }

  const verb = dryRun ? 'would release' : 'released';
  console.log(
    `reap${dryRun ? ' [dry-run]' : ''}: ${stats.scanned} claim(s) — ${stats.live} live, ${stats.stale} stale (under 2×TTL), ${stats.active} with recent events, ${released.length} ${verb}, ${needsYou.length} need you${stats.errors ? `, ${stats.errors} error(s)` : ''}`
  );
  if (released.length) {
    console.log(`${dryRun ? 'would release' : 'released'} (clean worktree):`);
    for (const r of released) console.log(`  - ${r.id} (was ${r.owner ?? 'unknown'}, heartbeat ${r.age_min ?? '?'}m ago)`);
  }
  if (needsYou.length) {
    console.log('⚑ needs you: abandoned work (never released automatically)');
    for (const n of needsYou) {
      console.log(`  - ${n.id} (${n.owner ?? 'unknown'}, heartbeat ${n.age_min ?? '?'}m ago, status ${n.status}): ${n.reason}${n.worktree ? ` — ${n.worktree}` : ''}`);
    }
  }

  // One line per real run, so a silent failure of the schedule is visible (the
  // dashboard shows the age of the last record). A dry run is not a run.
  if (!dryRun) {
    const record = {
      ts: isoSeconds(new Date()),
      host: SHORT_HOST,
      ok: true,
      ...stats,
      released: released.map((r) => r.id),
      needs_you: needsYou,
      duration_ms: Date.now() - started,
    };
    try {
      mkdirSync(path.join(EVENTS_DIR, '_system'), { recursive: true });
      appendFileSync(path.join(EVENTS_DIR, '_system', 'reaper.jsonl'), `${JSON.stringify(record)}\n`);
    } catch (e) {
      warn(`could not write reaper.jsonl: ${e.message}`);
    }
    if (released.length) cmdSync();
  }
}

/* ---- event-log verbs (implemented by the sibling events.mjs) -------------------- */

function eventsContext(flags) {
  let repo = null;
  try {
    if (existsSync(REGISTRY_PATH)) {
      const registry = loadRegistry();
      const cwd = process.cwd();
      repo =
        (typeof flags.repo === 'string'
          ? registry.repos.find((r) => r.name === flags.repo)
          : registry.repos.find((r) => cwd === r.path || cwd.startsWith(r.path + path.sep))) ?? null;
    }
  } catch {
    /* ctx.repo is best-effort */
  }
  return { projectsDir: PROJECTS_DIR, handle: HUMAN, repo, host: SHORT_HOST, actor: defaultActor(resolveProvider(flags)), session: currentSession() };
}

async function runEventsVerb(name, argv, flags) {
  const fn = eventsModule?.[name];
  if (typeof fn !== 'function') {
    const why = eventsLoadError && eventsLoadError.code !== 'ERR_MODULE_NOT_FOUND' ? ` (failed to load: ${eventsLoadError.message})` : '';
    console.error(`maestro: events module not installed${why}`);
    process.exit(1);
  }
  const code = await fn(argv, eventsContext(flags));
  if (typeof code === 'number') process.exitCode = code;
}

/* ---- github mirror ---------------------------------------------------------- */
/* The ONLY networked verb in this CLI (spec §13). Opt-in per repo via
   `mirror: github` in registry.yaml; `sync`/`board` never shell out to `gh` —
   they only ever read back the `issue: gh#<n>` frontmatter this section writes. */

/* Status→GitHub map (one const) — state + status-only labels per task status.
   `done` is the only status that closes the mirrored issue. */
const STATUS_GH_MAP = {
  open: { state: 'open', labels: ['maestro', 'maestro:open'] },
  claimed: { state: 'open', labels: ['maestro', 'maestro:claimed'] },
  'in-progress': { state: 'open', labels: ['maestro', 'maestro:in-progress'] },
  review: { state: 'open', labels: ['maestro', 'maestro:review'] },
  blocked: { state: 'open', labels: ['maestro', 'maestro:blocked'] },
  done: { state: 'closed', labels: ['maestro', 'maestro:done'] },
};

function ghAvailable() {
  return commandExists('gh');
}

/* Parses `owner/repo` out of `origin`'s remote URL (ssh or https form). Returns
   null for no remote / not a git repo / a non-GitHub host (GHE, GitLab, ...) —
   callers skip that repo gracefully rather than failing the whole mirror run. */
function ghRepoSlug(repoPath) {
  let url;
  try {
    url = execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function parseIssueRef(issue) {
  if (typeof issue !== 'string') return null;
  const m = issue.match(/^gh#(\d+)$/);
  return m ? Number(m[1]) : null;
}

function formatIssueRef(n) {
  return `gh#${n}`;
}

function formatIssueTitle(taskId, title) {
  return `${taskId}: ${title}`;
}

function statusToState(status) {
  return (STATUS_GH_MAP[status] ?? STATUS_GH_MAP.open).state;
}

function statusToLabels(status) {
  return (STATUS_GH_MAP[status] ?? STATUS_GH_MAP.open).labels;
}

/* Projects Goal + Context pointers + Acceptance (same sections `buildPrompt`
   reads) into an issue body, plus a managed footer — owner/status/priority/
   progress/local-path — and the hidden marker this mirror regenerates and
   matches on every run. No comment trail: the body itself is the sync target. */
function buildIssueBody(taskId, repo, data, body) {
  const goal = extractSection(body, 'Goal') || '(none recorded)';
  const context = extractSection(body, 'Context pointers') || '(none recorded)';
  const acceptance = extractSection(body, 'Acceptance') || '(none recorded)';
  const { done, total } = countTodos(path.join(repo.path, '.maestro', 'todos', `${taskId}.todos.md`));
  const localPath = path.join(repo.path, '.maestro', 'tasks');

  return [
    '## Goal',
    goal,
    '',
    '## Context pointers',
    context,
    '',
    '## Acceptance',
    acceptance,
    '',
    '---',
    `**Owner:** ${data.owner ?? '—'}`,
    `**Status:** ${data.status ?? 'open'}`,
    `**Priority:** ${data.priority ?? 3}`,
    `**Progress:** ${done}/${total}`,
    `**Local path:** ${localPath} (${taskId})`,
    '',
    `<!-- maestro-task: ${repo.name}/${taskId} -->`,
  ].join('\n');
}

/* Best-effort label seeding (`gh label create … || true`, spec) — never fatal:
   the label may already exist, or the token may lack repo-admin scope. */
function ghEnsureLabels(slug) {
  const labels = new Set(Object.values(STATUS_GH_MAP).flatMap((v) => v.labels));
  for (const label of labels) {
    try {
      execFileSync('gh', ['label', 'create', label, '--repo', slug], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      /* best-effort — see comment above */
    }
  }
}

function ghCreateIssue(slug, { title, bodyFile, labels }) {
  const args = ['issue', 'create', '--repo', slug, '--title', title, '--body-file', bodyFile];
  for (const label of labels) args.push('--label', label);
  const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const m = out.match(/\/issues\/(\d+)\s*$/);
  if (!m) throw new Error(`could not parse issue number from 'gh issue create' output: ${out}`);
  return Number(m[1]);
}

/* One `gh issue list` call per repo (spec: minimize API calls / rate-limit) —
   every maestro-labeled issue, open or closed, so recovery-by-marker and
   drift-detection both work off a single fetch. */
function ghListMirroredIssues(slug) {
  const out = execFileSync(
    'gh',
    ['issue', 'list', '--repo', slug, '--label', 'maestro', '--state', 'all', '--json', 'number,title,state,labels,body', '--limit', '500'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return JSON.parse(out || '[]');
}

function ghPatchIssue(slug, number, { title, bodyFile, addLabels = [], removeLabels = [], state } = {}) {
  const editArgs = ['issue', 'edit', String(number), '--repo', slug];
  let hasEditFields = false;
  if (title !== undefined) {
    editArgs.push('--title', title);
    hasEditFields = true;
  }
  if (bodyFile !== undefined) {
    editArgs.push('--body-file', bodyFile);
    hasEditFields = true;
  }
  for (const label of addLabels) {
    editArgs.push('--add-label', label);
    hasEditFields = true;
  }
  for (const label of removeLabels) {
    editArgs.push('--remove-label', label);
    hasEditFields = true;
  }
  if (hasEditFields) {
    execFileSync('gh', editArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  if (state === 'closed') {
    execFileSync('gh', ['issue', 'close', String(number), '--repo', slug], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (state === 'open') {
    execFileSync('gh', ['issue', 'reopen', String(number), '--repo', slug], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
}

function issueBodyTempFile(repoName, taskId) {
  return path.join(os.tmpdir(), `maestro-issue-${slugify(repoName)}-${taskId}-${process.pid}-${Date.now()}.md`);
}

/* Computes desired {title, body, labels, state} vs the batch-fetched current
   issue and patches only what drifted — never a no-op `gh issue edit` call.
   Label reconcile only ever touches other `maestro:*` labels, never a label
   this mirror didn't create. */
function reconcileIssue(slug, current, desired, { dryRun, taskId, repoName }) {
  const currentLabelNames = new Set((current.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)));
  const desiredLabelSet = new Set(desired.labels);
  const addLabels = desired.labels.filter((l) => !currentLabelNames.has(l));
  const removeLabels = [...currentLabelNames].filter((l) => l.startsWith('maestro:') && !desiredLabelSet.has(l));

  const currentState = String(current.state ?? 'OPEN').toLowerCase();
  const titleChanged = current.title !== desired.title;
  const bodyChanged = (current.body ?? '').trim() !== desired.body.trim();
  const stateChanged = currentState !== desired.state;
  const labelsChanged = addLabels.length > 0 || removeLabels.length > 0;

  if (!titleChanged && !bodyChanged && !stateChanged && !labelsChanged) {
    console.log(`mirror: ${repoName}/${taskId} — issue #${current.number} already in sync, no drift`);
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] ${repoName}/${taskId} — would patch issue #${current.number} in ${slug}:`);
    if (titleChanged) console.log(`  gh issue edit ${current.number} --repo ${slug} --title ${JSON.stringify(desired.title)}`);
    if (bodyChanged) console.log(`  gh issue edit ${current.number} --repo ${slug} --body-file <tmp>`);
    for (const label of addLabels) console.log(`  gh issue edit ${current.number} --repo ${slug} --add-label ${label}`);
    for (const label of removeLabels) console.log(`  gh issue edit ${current.number} --repo ${slug} --remove-label ${label}`);
    if (stateChanged) console.log(`  gh issue ${desired.state === 'closed' ? 'close' : 'reopen'} ${current.number} --repo ${slug}`);
    return;
  }

  let bodyFile;
  try {
    if (bodyChanged) {
      bodyFile = issueBodyTempFile(repoName, taskId);
      writeFileSync(bodyFile, desired.body);
    }
    if (titleChanged || bodyChanged || labelsChanged) {
      ghPatchIssue(slug, current.number, {
        title: titleChanged ? desired.title : undefined,
        bodyFile,
        addLabels,
        removeLabels,
      });
    }
    if (stateChanged) {
      ghPatchIssue(slug, current.number, { state: desired.state });
    }
  } finally {
    if (bodyFile) {
      try {
        rmSync(bodyFile, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  const changed = [titleChanged && 'title', bodyChanged && 'body', labelsChanged && 'labels', stateChanged && 'state']
    .filter(Boolean)
    .join(', ');
  console.log(`mirror: ${repoName}/${taskId} — patched issue #${current.number} (${changed})`);
}

/* Per-task reconcile, wrapped in its own try/catch by the caller (cmdMirror)
   so one task's `gh` failure never aborts the batch. No `issue:` yet → try to
   recover an existing maestro-labeled issue by marker (adopt its number)
   before creating a new one; either way, write `issue: gh#<n>` back onto the
   task file immediately via the existing `set` setter (setTaskFields). */
function mirrorTask(repo, slug, taskPath, data, body, { dryRun, issuesByNumber, issuesByMarker }) {
  const taskId = data.id;
  const marker = `<!-- maestro-task: ${repo.name}/${taskId} -->`;
  const desired = {
    title: formatIssueTitle(taskId, data.title ?? '(untitled)'),
    body: buildIssueBody(taskId, repo, data, body),
    state: statusToState(data.status),
    labels: statusToLabels(data.status),
  };

  const currentIssueNum = parseIssueRef(data.issue);

  if (currentIssueNum) {
    const current = issuesByNumber.get(currentIssueNum);
    if (!current) {
      warn(
        `${repo.name}/${taskId} — ${formatIssueRef(currentIssueNum)} not found among maestro-labeled issues in ${slug} (label removed manually?) — skipping this run`
      );
      return;
    }
    reconcileIssue(slug, current, desired, { dryRun, taskId, repoName: repo.name });
    return;
  }

  const recovered = issuesByMarker.get(marker);
  if (recovered) {
    console.log(
      `mirror: ${repo.name}/${taskId} — recovered issue #${recovered.number} via marker, writing back issue: ${formatIssueRef(recovered.number)}`
    );
    if (!dryRun) setTaskFields(taskPath, { issue: formatIssueRef(recovered.number) });
    reconcileIssue(slug, recovered, desired, { dryRun, taskId, repoName: repo.name });
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] ${repo.name}/${taskId} — would create issue in ${slug}:`);
    console.log(
      `  gh issue create --repo ${slug} --title ${JSON.stringify(desired.title)} --body-file <tmp> ${desired.labels.map((l) => `--label ${l}`).join(' ')}`
    );
    if (desired.state === 'closed') console.log(`  gh issue close <new#> --repo ${slug}`);
    console.log(`  (then: node maestro.mjs set ${taskId} --repo "${repo.name}" --issue gh#<new#>)`);
    return;
  }

  ghEnsureLabels(slug);
  const bodyFile = issueBodyTempFile(repo.name, taskId);
  try {
    writeFileSync(bodyFile, desired.body);
    const num = ghCreateIssue(slug, { title: desired.title, bodyFile, labels: desired.labels });
    setTaskFields(taskPath, { issue: formatIssueRef(num) });
    if (desired.state === 'closed') ghPatchIssue(slug, num, { state: 'closed' });
    console.log(`mirror: ${repo.name}/${taskId} — created issue #${num}, wrote back issue: ${formatIssueRef(num)}`);
  } finally {
    try {
      rmSync(bodyFile, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

function cmdMirror(positional, flags) {
  if (!ghAvailable()) {
    warn("'gh' not found on PATH — mirror needs the GitHub CLI (https://cli.github.com/). Skipping.");
    return;
  }

  const registry = loadRegistry();
  const dryRun = !!flags['dry-run'];
  const repos = flags.repo ? [resolveRepo(registry, flags.repo)] : registry.repos;

  let taskCount = 0;
  let repoCount = 0;

  for (const repo of repos) {
    if (repo.mirror !== 'github') {
      if (flags.repo) console.log(`mirror: ${repo.name} — not opted in (add 'mirror: github' under it in registry.yaml)`);
      continue;
    }

    const slug = ghRepoSlug(repo.path);
    if (!slug) {
      warn(`${repo.name} — no resolvable GitHub remote (origin) — skipping`);
      continue;
    }

    const tasksDir = tasksDirFor(repo.path);
    if (!existsSync(tasksDir)) continue;

    let files;
    try {
      files = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    } catch (e) {
      warn(`cannot read tasks dir for ${repo.name}: ${e.message}`);
      continue;
    }
    if (!files.length) continue;

    console.log(`mirror: ${repo.name} → ${slug}${dryRun ? ' [dry-run]' : ''}`);

    let issues;
    try {
      issues = ghListMirroredIssues(slug);
    } catch (e) {
      warn(`${repo.name} — 'gh issue list --repo ${slug}' failed: ${e.message} — skipping this repo`);
      continue;
    }
    const issuesByNumber = new Map(issues.map((i) => [i.number, i]));
    const issuesByMarker = new Map();
    for (const i of issues) {
      const m = (i.body ?? '').match(/<!--\s*maestro-task:\s*(\S+)\s*-->/);
      if (m) issuesByMarker.set(`<!-- maestro-task: ${m[1]} -->`, i);
    }

    repoCount++;
    for (const file of files) {
      const full = path.join(tasksDir, file);
      try {
        const { data, body } = parseFrontmatter(readFileSync(full, 'utf8'));
        if (!data.id) throw new Error('missing id field');
        mirrorTask(repo, slug, full, data, body, { dryRun, issuesByNumber, issuesByMarker });
        taskCount++;
      } catch (e) {
        warn(`${repo.name}/${file} — mirror failed: ${e.message}`);
      }
    }
  }

  console.error(`mirror: ${taskCount} task(s) reconciled across ${repoCount} repo(s)${dryRun ? ' (dry run — nothing written)' : ''}`);
}

/* ---- dispatch --------------------------------------------------------------- */

const SUPPORTED_SUBCOMMANDS =
  'init, new, claim, heartbeat, sync, board, work, route, set, say, read, ask, answer, inbox, handoff, mirror, done, block, release, reap, emit, status, who';

const [, , sub, ...rest] = process.argv;
const { positional, flags } = parseArgs(rest);

switch (sub) {
  case 'init':
    cmdInit();
    break;
  case 'new':
    cmdNew(positional, flags);
    break;
  case 'claim':
    cmdClaim(positional, flags);
    break;
  case 'heartbeat':
    cmdHeartbeat(positional, flags);
    break;
  case 'sync':
    cmdSync();
    break;
  case undefined:
  case 'board':
    cmdBoard(flags);
    break;
  case 'work':
    cmdWork(positional, flags);
    break;
  case 'route':
    cmdRoute(positional, flags);
    break;
  case 'set':
    cmdSet(positional, flags);
    break;
  case 'say':
    cmdSay(positional, flags);
    break;
  case 'read':
    cmdRead(positional, flags);
    break;
  case 'ask':
    cmdAsk(positional, flags);
    break;
  case 'answer':
    cmdAnswer(positional, flags);
    break;
  case 'inbox':
    cmdInbox(positional, flags);
    break;
  case 'handoff':
    cmdHandoff(positional, flags);
    break;
  case 'mirror':
    cmdMirror(positional, flags);
    break;
  case 'done':
    cmdDone(positional, flags);
    break;
  case 'block':
    cmdBlock(positional, flags);
    break;
  case 'release':
    cmdRelease(positional, flags);
    break;
  case 'reap':
    cmdReap(positional, flags);
    break;
  case 'emit':
    await runEventsVerb('cmdEmit', rest, flags);
    break;
  case 'status':
    await runEventsVerb('cmdStatus', rest, flags);
    break;
  case 'who':
    await runEventsVerb('cmdWho', rest, flags);
    break;
  default:
    fail(`unknown subcommand '${sub}'. Supported: ${SUPPORTED_SUBCOMMANDS}.`);
}

await flushPendingEvents();
