#!/usr/bin/env node
/* Maestro — cross-provider orchestration CLI.
   Zero dependencies: Node built-ins only.

   Phase 0 subcommands (see docs/maestro-spec.md §10):
     init        create ~/Projects/.maestro/ (registry + index + board), idempotent
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
     inbox       list every `#open` ask addressed to someone (default `andrew`) —
                 the "needs human" queue, across every registered repo + fleet
     handoff     like `say` but kind=handoff, explicitly targeted at `--to <who>`

   `done` / `block` / `release` are not built yet — they fail loudly with a pointer.

   v1 dispatch is human-in-the-loop (spec §7): `route` prepares the worktree/seed and
   prints the launch string; it never spawns another provider process itself.

   Data layout (docs/maestro-spec.md §4, docs/maestro-comms-spec.md §2):
     ~/Projects/.maestro/{registry.yaml, index.jsonl, board.md, worktrees/}  — global, derived
     ~/Projects/.maestro/channels/fleet.md                                   — global, authoritative
     ~/Projects/.maestro/inbox.jsonl                                         — global, DERIVED
     <repo>/.maestro/{tasks,todos,locks,channels}/                          — per-repo, authoritative
*/

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/* ---- paths -------------------------------------------------------------- */

const HOME = os.homedir();
const GLOBAL_DIR = path.join(HOME, 'Projects', '.maestro');
const REGISTRY_PATH = path.join(GLOBAL_DIR, 'registry.yaml');
const INDEX_PATH = path.join(GLOBAL_DIR, 'index.jsonl');
const BOARD_PATH = path.join(GLOBAL_DIR, 'board.md');
const WORKTREES_ROOT = path.join(GLOBAL_DIR, 'worktrees');
const FLEET_CHANNEL_PATH = path.join(GLOBAL_DIR, 'channels', 'fleet.md');
const INBOX_PATH = path.join(GLOBAL_DIR, 'inbox.jsonl');

const DEFAULT_TTL_SECONDS = 1800;
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

/* ---- small utilities ------------------------------------------------------ */

function fail(msg) {
  console.error(`maestro: ${msg}`);
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

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
   Andrew to run once/if the binary is installed). Used solely to decide
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

/* ---- registry (hand-rolled — flat list, not a general YAML parser) -------- */

function renderRegistry(repos) {
  const lines = [
    "# Maestro registry — repos this machine's `maestro sync` walks.",
    '# Hand-maintained: add a repo by appending a `- name` / `path` pair below.',
    '# Everything else under ~/Projects/.maestro/ is derived — never hand-edit it.',
    'repos:',
  ];
  for (const r of repos) {
    lines.push(`  - name: ${r.name}`);
    lines.push(`    path: ${r.path}`);
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
      current = { name: m[1].trim(), path: '' };
      repos.push(current);
    } else if (current && (m = trimmed.match(/^path:\s*(.+)$/))) {
      current.path = m[1].trim();
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

/* ---- commands -------------------------------------------------------------- */

function cmdInit() {
  mkdirSync(GLOBAL_DIR, { recursive: true });

  if (!existsSync(REGISTRY_PATH)) {
    const seed = [
      { name: 'liberty networking', path: path.join(HOME, 'Projects', 'liberty networking') },
      { name: 'agencyos', path: path.join(HOME, 'Projects', 'agencyos') },
    ];
    writeFileSync(REGISTRY_PATH, renderRegistry(seed));
    console.log(`Created ${REGISTRY_PATH}`);
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
   can treat a return as unconditional success. */
function claimTask(repo, taskId, taskPath, { owner, provider, steal }) {
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
      pid: process.pid,
      claimed_at: stamp,
      heartbeat: stamp,
      ttl_seconds: DEFAULT_TTL_SECONDS,
    };
    writeFileSync(claimFile, `${JSON.stringify(data, null, 2)}\n`);
    return data;
  }

  try {
    mkdirSync(lockDir);
    const claim = writeClaim();
    setTaskFields(taskPath, { status: 'claimed', owner });
    return { claim, stolen: false };
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
  return { claim, stolen: true, previousOwner: existing?.owner };
}

function cmdClaim(positional, flags) {
  const taskId = positional[0];
  if (!taskId) fail('usage: maestro claim T-<id> [--repo R] [--owner O] [--steal]');

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  ensureRepoDirs(repo.path);

  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);

  const owner = typeof flags.owner === 'string' ? flags.owner : `${os.userInfo().username}@cli`;
  const provider = typeof flags.provider === 'string' ? flags.provider : 'claude';
  const steal = !!flags.steal;

  const { stolen, previousOwner } = claimTask(repo, taskId, taskPath, { owner, provider, steal });
  if (stolen) {
    console.log(`Stole stale claim on ${taskId} (was ${previousOwner ?? 'unknown'}) — now owned by ${owner} (${repo.name})`);
  } else {
    console.log(`Claimed ${taskId} for ${owner} (${repo.name})`);
  }
}

function cmdHeartbeat(positional, flags) {
  const taskId = positional[0];
  if (!taskId) fail('usage: maestro heartbeat T-<id> [--repo R]');

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  const claimFile = path.join(repo.path, '.maestro', 'locks', `${taskId}.claim.json`);
  if (!existsSync(claimFile)) fail(`no active claim for ${taskId} in ${repo.name}`);

  const data = JSON.parse(readFileSync(claimFile, 'utf8'));
  data.heartbeat = isoSeconds(new Date());
  writeFileSync(claimFile, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Heartbeat refreshed for ${taskId} (${repo.name}) — owner ${data.owner}`);
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
   overrides this with the literal 'andrew' (spec §3/§4) since it's always
   the human replying. */
function resolveAuthor(repo, target) {
  if (!repo || isFleet(target)) return `${os.userInfo().username}@cli`;
  const claimPath = path.join(repo.path, '.maestro', 'locks', `${target}.claim.json`);
  if (existsSync(claimPath)) {
    try {
      const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
      if (claim?.owner) return claim.owner;
    } catch {
      /* corrupt claim file — fall through to the session-identity fallback */
    }
  }
  return `${os.userInfo().username}@cli`;
}

/* `@andrew` and bare `andrew` must match for --for/--to filtering (spec §3
   uses `@andrew` for the human in the line format, but the CLI's default
   `--for`/`--to` value is documented as the bare name) — compare with the
   leading `@` stripped from both sides. */
function normalizeWho(who) {
  return String(who || '').replace(/^@/, '');
}

/* Shared append path for say/ask/answer/handoff: acquire the channel lock,
   compute the next M-id fresh (inside the lock, so two concurrent posts
   can't compute the same seq), append one line, release. */
function postMessage(repo, target, { kind, text, targetAddr, reId, tag, author }) {
  const channelPath = channelPathFor(repo, target);
  const lockDir = channelLockDirFor(channelPath);
  const base = messageBaseFor(target);

  acquireChannelLock(lockDir);
  let mid, line;
  try {
    const seq = nextMessageSeq(channelPath, base);
    mid = `M-${base}-${seq}`;
    const ts = isoSeconds(new Date());
    const resolvedAuthor = author ?? resolveAuthor(repo, target);
    line = formatMessageLine({ ts, mid, author: resolvedAuthor, kind, target: targetAddr, reId, text, tag });
    appendFileSync(channelPath, `${line}\n`);
  } finally {
    releaseChannelLock(lockDir);
  }
  return { mid, line, channelPath };
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
   board ⚑ block (unfiltered, then filtered to `andrew` for the board). */
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
   nests inside the repo — WORKTREES_ROOT lives under ~/Projects/.maestro/,
   a sibling of every repo under ~/Projects/ (spec §2). Hard-fails rather than
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

function writeAgentsStub(worktreePath) {
  const content = "Read PROMPT.md for the current task. Follow this repo's CLAUDE.md for conventions.\n";
  writeFileSync(path.join(worktreePath, 'AGENTS.md'), content);
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
function releaseClaim(repo, taskId, taskPath) {
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
  try {
    setTaskFields(taskPath, { status: 'open', owner: null });
  } catch {
    /* best-effort */
  }
}

function seedTask(repo, taskId, taskPath, { owner, provider, steal }) {
  claimTask(repo, taskId, taskPath, { owner, provider, steal });

  try {
    const { data, body } = parseFrontmatter(readFileSync(taskPath, 'utf8'));
    const { worktreePath, branch, created } = ensureWorktree(repo, taskId, data.title);

    const prompt = buildPrompt(taskId, repo, data, body);
    writeFileSync(path.join(worktreePath, 'PROMPT.md'), prompt);
    writeAgentsStub(worktreePath);
    const todosPath = seedTodosIfEmpty(repo, taskId, body, owner);

    return { data, body, worktreePath, branch, created, prompt, todosPath };
  } catch (err) {
    releaseClaim(repo, taskId, taskPath);
    fail(err.message);
    throw err; // unreachable — fail() exits — but keeps control-flow analysis happy
  }
}

function cmdWork(positional, flags) {
  const taskId = positional[0];
  if (!taskId) fail('usage: maestro work T-<id> [--repo R] [--owner O] [--steal]');

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  ensureRepoDirs(repo.path);

  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);

  const owner = typeof flags.owner === 'string' ? flags.owner : `${os.userInfo().username}@claude`;
  const steal = !!flags.steal;

  const { worktreePath, branch, created, prompt, todosPath } = seedTask(repo, taskId, taskPath, {
    owner,
    provider: 'claude',
    steal,
  });

  setTaskFields(taskPath, { status: 'in-progress', worktree: worktreePath, branch });
  refreshHeartbeat(repo, taskId);

  console.log(`${created ? 'Created' : 'Reused'} worktree for ${taskId}: ${worktreePath}`);
  console.log(`Branch: ${branch}`);
  console.log(`Todos: ${todosPath}`);
  console.log(`Status: in-progress (owner ${owner})`);
  console.log('');
  console.log('--- PROMPT.md ---');
  console.log(prompt);
}

function cmdRoute(positional, flags) {
  const taskId = positional[0];
  const provider = positional[1];
  if (!taskId || !provider) fail('usage: maestro route T-<id> <provider> [--repo R]');
  if (!ADAPTERS[provider]) fail(`unknown provider '${provider}'. Known: ${Object.keys(ADAPTERS).join(', ')}`);

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  ensureRepoDirs(repo.path);

  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);

  const owner = `${provider}@route`;
  const steal = !!flags.steal;

  const { worktreePath, branch, created } = seedTask(repo, taskId, taskPath, { owner, provider, steal });

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
    // the calling skill (or Andrew) runs /handoff and records the result
    // with `maestro set --issue`.
    console.log("Codex hand-off is two steps — this CLI can't invoke the /handoff skill itself:");
    console.log(`  1. Run /handoff ${taskId} to create the GitHub issue, then record it:`);
    console.log(`     node maestro.mjs set ${taskId} --repo "${repo.name}" --issue gh#<n>`);
    console.log('  2. Launch string (references the issue created above):');
    console.log(`     cd "${worktreePath}" && codex`);
  } else if (provider === 'cursor') {
    const adapter = ADAPTERS.cursor;
    const advisory = binaryAdvisory(adapter.bin);
    if (advisory) console.log(advisory);
    console.log('Launch string (brief piped via stdin — a long PROMPT.md can exceed CLI arg limits):');
    console.log(
      `  cd "${worktreePath}" && cat PROMPT.md | ${adapter.bin} ${adapter.prompt_flag} "Execute the attached task brief" ${adapter.force_flag} --output-format json`
    );
  } else if (provider === 'grok') {
    const adapter = ADAPTERS.grok;
    const advisory = binaryAdvisory(adapter.bin);
    if (advisory) console.log(advisory);
    console.log(
      "Launch string (brief piped via stdin; --cwd points at our own pre-seeded worktree — never grok's own -w worktree creation, which would double-nest):"
    );
    console.log(
      `  cd "${worktreePath}" && cat PROMPT.md | ${adapter.bin} ${adapter.prompt_flag} "Execute the attached task brief" ${adapter.folder_flag} . ${adapter.force_flag}`
    );
  }
}

function cmdSet(positional, flags) {
  const taskId = positional[0];
  if (!taskId) {
    fail('usage: maestro set T-<id> [--issue X] [--status S] [--owner O] [--priority N] [--repo R]');
  }

  const registry = loadRegistry();
  const repo = resolveRepo(registry, flags.repo);
  const taskPath = findTaskFile(repo.path, taskId);
  if (!taskPath) fail(`no task ${taskId} found in ${repo.name}`);

  const patch = {};
  if (typeof flags.issue === 'string') patch.issue = flags.issue;
  if (typeof flags.status === 'string') patch.status = flags.status;
  if (typeof flags.owner === 'string') patch.owner = flags.owner;
  if (typeof flags.branch === 'string') patch.branch = flags.branch;
  if (typeof flags.worktree === 'string') patch.worktree = flags.worktree;
  if (flags.priority !== undefined) patch.priority = Number(flags.priority);

  if (!Object.keys(patch).length) {
    fail('nothing to set — pass at least one of --issue/--status/--owner/--priority/--branch/--worktree');
  }

  setTaskFields(taskPath, patch);
  const summary = Object.entries(patch)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  console.log(`Updated ${taskId} (${repo.name}): ${summary}`);
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
  if (!targetArg || !text) fail('usage: maestro say <T-id|fleet> "text" [--repo R]');

  const registry = loadRegistry();
  const { repo, target } = resolveChannelTarget(registry, targetArg, flags.repo);

  const { mid } = postMessage(repo, target, { kind: 'say', text });
  if (repo) refreshHeartbeat(repo, target);
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
  if (!targetArg || !text) fail('usage: maestro ask <T-id|fleet> "question" [--to who] [--repo R]');

  const registry = loadRegistry();
  const { repo, target } = resolveChannelTarget(registry, targetArg, flags.repo);

  const targetAddr = typeof flags.to === 'string' ? flags.to : '@andrew';
  const { mid } = postMessage(repo, target, { kind: 'ask', text, targetAddr, tag: 'open' });
  if (repo) refreshHeartbeat(repo, target);
  console.log(mid);
}

function cmdAnswer(positional, flags) {
  const mid = positional[0];
  const text = positional[1];
  if (!mid || !text) fail('usage: maestro answer <M-id> "text" [--repo R]');

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
    const answerLine = formatMessageLine({ ts, mid: answerMid, author: 'andrew', kind: 'answer', target: askAuthor, reId: mid, text });

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

  console.log(`Posted ${answerMid} (answer→${askAuthor} re:${mid}) to ${channelLabelFor(repo, target)} — ${mid} now #resolved`);
}

function cmdInbox(positional, flags) {
  const registry = loadRegistry();
  const forWho = normalizeWho(typeof flags.for === 'string' ? flags.for : 'andrew');

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

  const registry = loadRegistry();
  const { repo, target } = resolveChannelTarget(registry, targetArg, flags.repo);

  const { mid } = postMessage(repo, target, { kind: 'handoff', text, targetAddr: flags.to });
  if (repo) refreshHeartbeat(repo, target);
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

function cmdSync() {
  const registry = loadRegistry();
  const rows = [];

  for (const repo of registry.repos) {
    const tasksDir = tasksDirFor(repo.path);
    if (!existsSync(tasksDir)) continue;

    let files;
    try {
      files = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    } catch (e) {
      warn(`cannot read tasks dir for ${repo.name}: ${e.message}`);
      continue;
    }

    const worktreeBranches = worktreeBranchesFor(repo.path);

    for (const file of files) {
      const full = path.join(tasksDir, file);
      let data, body;
      try {
        ({ data, body } = parseFrontmatter(readFileSync(full, 'utf8')));
        if (!data.id) throw new Error('missing id field');
      } catch (e) {
        warn(`skipping malformed task file ${full}: ${e.message}`);
        continue;
      }
      void body;

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
          warn(`unreadable claim file ${claimPath}: ${e.message}`);
        }
      }

      const needsHuman = countNeedsHuman(path.join(repo.path, '.maestro', 'channels', `${id}.md`));

      rows.push({
        repoName: repo.name,
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
      });
    }
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
    })
  );
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(INDEX_PATH, indexLines.length ? `${indexLines.join('\n')}\n` : '');

  // Derived comms projections (comms spec §2, §7) — inbox.jsonl (every open
  // ask, any target) and the board's ⚑ block (just the ones for @andrew).
  const openAsks = collectOpenAsks(registry);
  writeFileSync(INBOX_PATH, openAsks.length ? `${openAsks.map((a) => JSON.stringify(a)).join('\n')}\n` : '');
  const needsYou = openAsks.filter((a) => normalizeWho(a.target) === 'andrew');

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
    if (m.kind === 'ask' && m.tag === 'open' && normalizeWho(m.target) === 'andrew') n++;
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

  lines.push(`${rows.length} task(s) tracked${staleCount ? ` · ${staleCount} STALE claim(s)` : ''}`, '');

  for (const [status, list] of groups) {
    lines.push(`## ${status} (${list.length})`);
    lines.push('');
    if (!list.length) {
      lines.push('_none_', '');
      continue;
    }
    lines.push('| id | title | owner | progress | priority | updated |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of [...list].sort((a, b) => a.priority - b.priority)) {
      const ownerCell = r.owner ? (r.stale ? `${r.owner} ⚠ STALE` : r.owner) : '—';
      const idCell = r.needsHuman ? `${r.globalId} ⚑` : r.globalId;
      lines.push(`| ${idCell} | ${r.title} | ${ownerCell} | ${r.progress} | ${r.priority} | ${r.updated} |`);
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

/* ---- dispatch --------------------------------------------------------------- */

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
  case 'done':
  case 'block':
  case 'release':
    fail(
      `'${sub}' isn't built yet. Supported: init, new, claim, heartbeat, sync, board, work, route, set, say, read, ask, answer, inbox, handoff.`
    );
    break;
  default:
    fail(
      `unknown subcommand '${sub}'. Supported: init, new, claim, heartbeat, sync, board, work, route, set, say, read, ask, answer, inbox, handoff.`
    );
}
