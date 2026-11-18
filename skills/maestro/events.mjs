/* events.mjs — Maestro's append-only event log, hook mapper and read-only
   projections (Agent Ops design §3, §6, §7; vault 01-Projects/agent-ops/).

   Zero dependencies: Node built-ins only. Imported by maestro.mjs (the `emit`,
   `status` and `who` verbs) and by maestro-dashboard (fleet / needs-you /
   bottlenecks / health). Importing this file has NO side effects.

   Exports
     appendEvent(evt, opts)           validate + redact + append ONE line; never throws, false on failure
     cmdEmit(argv, ctx)               `maestro emit <type> [--task T] [--from-hook [EVT]] [k=v ...]`
     cmdStatus(argv, ctx)             `maestro status [--task|--client|--project|--actor] [--all] [--json]`
     cmdWho(argv, ctx)                `maestro who <path|T-id|resource:name> [--json]`
     buildProjections(dir, opts)      {fleet, needs_you, bottlenecks, health} for the dashboard
     deriveA2aState(type, data)       Maestro event -> A2A task state
     resolveProjectsDir() resolveHandle() locateCwd() loadRegistry() loadPolicy() loadTasks()
     readEvents() redactValue() EVENT_TYPES

   Event path:  <projects>/.maestro/events/YYYY-MM-DD/<actor-id-slug>-<session>.jsonl
   One file per actor-session, one O_APPEND write (< 4 KB) per event, never git-tracked.
   Secrets never go in here: resource NAMES only, and secret-shaped strings are redacted. */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/* ---- constants ------------------------------------------------------------ */

export const EVENT_TYPES = ['claim', 'heartbeat', 'progress', 'output', 'error', 'message', 'handoff', 'approval', 'receipt', 'state'];
const DEFAULT_TTL_SECONDS = 1800;
const LIVE_SECONDS = 600; // "live" = an event in the last 10 minutes
const HEARTBEAT_THROTTLE_MS = 600_000; // <= 1 hook heartbeat per 10 min per session
const MAX_LINE_BYTES = 4000;
const MAX_NOTE = 240;
const RED_SECONDS = 900; // sync / reaper age that turns the dashboard header red
const HOME = os.homedir();

/* ---- config (same precedence as maestro.mjs: env, then config.yaml, then default) */

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

export function resolveProjectsDir() {
  return path.resolve(expandHome(process.env.MAESTRO_PROJECTS || readConfigScalar('paths', 'projects') || '~/Projects'));
}

export function resolveHandle() {
  let user = process.env.USER;
  try {
    user = user || os.userInfo().username;
  } catch {
    /* ignore */
  }
  return String(process.env.MAESTRO_HANDLE || readConfigScalar('owner', 'handle') || user || 'me').replace(/^@/, '');
}

/* Pinned host id: MAESTRO_HOST, then identity.host in config.yaml, then os.hostname(). A Mac
   with no HostName set takes its name from the network (mac-293, mac-1224, andrews-macbook-air
   ...), which split one machine into many actors; pinning it keeps actor ids stable. Same
   normalisation as maestro.mjs SHORT_HOST so the hook path and the CLI agree. */
let hostShortCache = null;
function hostShort() {
  if (hostShortCache === null) {
    hostShortCache =
      String(process.env.MAESTRO_HOST || readConfigScalar('identity', 'host') || os.hostname())
        .split('.')[0]
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'host';
  }
  return hostShortCache;
}

/* ---- small utilities ------------------------------------------------------- */

function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'task';
}

function fileSlug(s, fallback) {
  const out = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 60);
  return out || fallback;
}

const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
const isoSeconds = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function makeId(ms = Date.now()) {
  let t = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[n % 32] + t;
    n = Math.floor(n / 32);
  }
  const r = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i] & 31];
  return t + rand;
}

/* Session ids are UUIDs; events carry the first 8 chars (matches `claude agents` ids). */
/* The token that identifies a session in event file names and in `actor.session`: the first 8
   characters, lowercased. Anyone who knows a full session id (a hook's session_id, a UUID in
   MAESTRO_SESSION / CLAUDE_CODE_SESSION_ID) can find that session's file with
   `-${sessionFileToken(id)}.jsonl`. */
export function sessionFileToken(session) {
  return session ? String(session).slice(0, 8).toLowerCase() : null;
}
const shortSession = sessionFileToken;
const hash16 = (s) => sha256hex(s).slice(0, 16);

function normalizeWho(who) {
  return String(who || '').replace(/^@/, '').toLowerCase();
}

/* ---- redaction + truncation ---------------------------------------------------- */

/* Secret-shaped strings are replaced, never rejected: the event still lands, the
   secret does not. */
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
];

/* High-entropy runs (base64 / base64url tokens). Ordinary slugs and branch names
   ("maestro/T-14-autonomous-development-prompts") have almost no capitals or digits, a real
   32+ char random token has several of each, so require >=4 upper, >=3 digit, >=4 lower. */
const ENTROPY_RUN = /[A-Za-z0-9+=_-]{32,}/g;
const looksRandom = (run) =>
  (run.match(/[A-Z]/g) || []).length >= 4 && (run.match(/\d/g) || []).length >= 3 && (run.match(/[a-z]/g) || []).length >= 4;

export function redactString(s) {
  let out = String(s);
  for (const re of SECRET_RES) out = out.replace(re, '[redacted]');
  return out.replace(ENTROPY_RUN, (run) => (looksRandom(run) ? '[redacted]' : run));
}

export function redactValue(v, depth = 0) {
  if (depth > 6) return null;
  if (typeof v === 'string') return redactString(v);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, depth + 1));
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val, depth + 1);
    return out;
  }
  return v;
}

function clip(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

/* ---- A2A state mapping (design §3) ---------------------------------------------- */

const STATUS_TO_A2A = {
  open: 'submitted',
  claimed: 'working',
  'in-progress': 'working',
  review: 'input-required',
  done: 'completed',
};

export function deriveA2aState(type, data = {}) {
  const d = isPlainObject(data) ? data : {};
  switch (type) {
    case 'claim':
      return d.action === 'release' ? 'submitted' : 'working';
    case 'heartbeat':
    case 'progress':
    case 'output':
      return 'working';
    case 'error':
      if (d.class === 'auth') return 'auth-required';
      if (d.class === 'crash' || d.class === 'budget') return 'failed';
      if (d.class === 'ratelimit' || d.class === 'conflict') return 'input-required';
      return 'working';
    case 'message':
      return d.kind === 'ask' ? 'input-required' : 'working';
    case 'handoff':
      return 'submitted';
    case 'approval':
      if (d.decision === 'denied' || d.decision === 'rejected') return 'rejected';
      if (d.decision === 'granted' || d.decision === 'approved') return 'working';
      return 'input-required';
    case 'receipt': {
      const o = String(d.outcome ?? '');
      if (o === 'failed') return 'failed';
      if (o === 'canceled') return 'canceled';
      if (o === 'rejected') return 'rejected';
      if (o === 'completed' || o === 'done' || o === 'success' || o === 'ok') return 'completed';
      return 'input-required'; // turn_end: waiting for the next prompt
    }
    case 'state': {
      const to = String(d.to ?? '');
      if (to === 'canceled' || to === 'ended') return to === 'ended' ? 'completed' : 'canceled';
      if (to === 'blocked') {
        const by = String(d.blocked_by ?? '');
        return /^(resource:(cred|auth|token|key)|auth)/i.test(by) ? 'auth-required' : 'input-required';
      }
      return STATUS_TO_A2A[to] ?? 'working';
    }
    default:
      return 'working';
  }
}

/* ---- appendEvent -------------------------------------------------------------------- */

function normalizeActor(evt, opts) {
  let a = evt.actor ?? opts.actor ?? null;
  if (typeof a === 'string') a = { id: a };
  if (!isPlainObject(a)) a = {};
  const id = a.id || (os.userInfo().username ? `${os.userInfo().username}@cli` : 'unknown@cli');
  const probe = `${id} ${a.provider ?? ''}`.toLowerCase();
  const provider = a.provider || ['claude', 'codex', 'cursor', 'grok'].find((p) => probe.includes(p)) || 'unknown';
  const session = shortSession(a.session ?? evt.session ?? opts.session ?? null);
  return { id: String(id), agent_id: a.agent_id ?? null, session, provider };
}

function shrinkStrings(v, n) {
  if (typeof v === 'string') return clip(v, n);
  if (Array.isArray(v)) return v.map((x) => shrinkStrings(x, n));
  if (isPlainObject(v)) {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = shrinkStrings(val, n);
    return o;
  }
  return v;
}

/* Build the full record without touching the disk (exported for tests/tools). */
export function buildEvent(evt, opts = {}) {
  if (!isPlainObject(evt)) return null;
  if (!EVENT_TYPES.includes(evt.type)) return null;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const data = redactValue(isPlainObject(evt.data) ? { ...evt.data } : {});
  for (const k of ['note', 'message']) {
    if (typeof data[k] === 'string') data[k] = clip(data[k], MAX_NOTE);
  }
  const task = evt.task ? redactString(evt.task) : null;
  const rec = {
    v: 1,
    id: makeId(now.getTime()),
    ts: isoSeconds(now),
    trace_id: task ? sha256hex(task).slice(0, 32) : null,
    span_id: evt.span_id && /^[0-9a-f]{16}$/.test(evt.span_id) ? evt.span_id : randomBytes(8).toString('hex'),
    parent_span_id: evt.parent_span_id ?? null,
    type: evt.type,
    a2a_state: deriveA2aState(evt.type, data),
    actor: normalizeActor(evt, opts),
    task,
    client: evt.client ? redactString(evt.client) : null,
    project: evt.project ? redactString(evt.project) : null,
    wu: evt.wu ? redactString(evt.wu) : null,
    to: evt.to ? redactString(evt.to) : null,
    refs: asArray(evt.refs).slice(0, 20).map((r) => redactString(r)),
    data,
  };
  return rec;
}

export function eventFilePath(projectsDir, rec) {
  const day = rec.ts.slice(0, 10);
  const name = `${fileSlug(rec.actor.id, 'unknown')}-${fileSlug(rec.actor.session, 'nosession')}.jsonl`;
  return path.join(projectsDir, '.maestro', 'events', day, name);
}

/* Append exactly one event line. Contract with maestro.mjs (P1a): never throws;
   returns true when a line was written, false for any failure or invalid input. */
export function appendEvent(evt, opts = {}) {
  try {
    const rec = buildEvent(evt, opts);
    if (!rec) return false;
    const projectsDir = opts.projectsDir || resolveProjectsDir();
    const file = eventFilePath(projectsDir, rec);
    mkdirSync(path.dirname(file), { recursive: true });

    let line = `${JSON.stringify(rec)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      rec.data = shrinkStrings(rec.data, 120);
      line = `${JSON.stringify(rec)}\n`;
    }
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      rec.refs = rec.refs.slice(0, 5);
      line = `${JSON.stringify(rec)}\n`;
    }
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      rec.data = { truncated: true };
      line = `${JSON.stringify(rec)}\n`;
    }
    const fd = openSync(file, 'a'); // O_APPEND
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/* ---- file readers (all tolerant: missing / malformed -> empty) ---------------------- */

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJsonlFile(file) {
  const text = readText(file);
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn / malformed line */
    }
  }
  return out;
}

function parseFlatFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
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
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (/^-?\d+$/.test(val)) data[key] = Number(val);
    else data[key] = val.replace(/^["']|["']$/g, '');
  }
  return data;
}

/* Lenient registry reader (same line-based shape as maestro.mjs loadRegistry, but
   returns [] instead of exiting when there is no registry). */
export function loadRegistry(projectsDir) {
  const raw = readText(path.join(projectsDir, '.maestro', 'registry.yaml'));
  const repos = [];
  if (!raw) return { repos };
  let current = null;
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    let m;
    if ((m = trimmed.match(/^-\s*name:\s*(.+)$/))) {
      current = { name: m[1].trim(), path: '' };
      repos.push(current);
    } else if (current && (m = trimmed.match(/^path:\s*(.+)$/))) {
      current.path = m[1].trim();
    }
  }
  return { repos };
}

/* policy.yaml (hand-kept, optional): `repos:` map of repo -> client, `hard_terms:` list.
   Not a YAML parser: top-level `key:` sections with indented `k: v` or `- item` lines.
   `error` is null for a missing file (legitimately no terms) and a short reason when the
   file exists but cannot be read or parsed, so masking callers can fail CLOSED. */
export function loadPolicy(projectsDir) {
  const policy = { repos: {}, hard_terms: [], error: null };
  const file = path.join(projectsDir, '.maestro', 'policy.yaml');
  if (!existsSync(file)) return policy; // absent is legitimate: no repo map, no hard terms
  const raw = readText(file);
  if (raw === null) {
    policy.error = 'policy.yaml exists but cannot be read';
    return policy;
  }
  let section = null;
  let group = null;
  const unq = (s) => s.trim().replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  const bad = (n, why) => {
    if (!policy.error) policy.error = `policy.yaml line ${n}: ${why}`;
  };
  raw.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(#|$)/.test(line)) return;
    if (/^\S/.test(line)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      section = m ? m[1] : null;
      group = null;
      if (!m) return bad(n, 'expected a top-level "key:"');
      if (m[1] === 'hard_terms' && m[2].trim().startsWith('[')) {
        const v = m[2].trim().replace(/\s+#.*$/, '');
        if (!v.endsWith(']')) return bad(n, 'unterminated inline list');
        policy.hard_terms = v
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(unq)
          .filter(Boolean);
        section = null;
      }
      return;
    }
    if (section === 'repos') {
      // Accepted shapes: `repo: client`, `- repo: client`, and a client header
      // (`client:`) followed by `- repo` lines. A bare `- repo` with no client is ignored.
      let body = line.trim();
      const isItem = body === '-' || body.startsWith('- ');
      if (isItem) body = body.slice(1).trim();
      const kv = body.match(/^(?:"([^"]+)"|'([^']+)'|([^:#]+?))\s*:\s*(.*)$/);
      if (kv) {
        const key = (kv[1] ?? kv[2] ?? kv[3]).trim();
        const val = unq(kv[4]);
        if (val) policy.repos[key] = val;
        else group = key;
      } else if (isItem && body) {
        if (group) policy.repos[unq(body)] = group;
      } else bad(n, 'expected "repo: client" or "- repo" under repos');
    } else if (section === 'hard_terms') {
      const m = line.match(/^\s+-\s*(.+)$/);
      if (m) policy.hard_terms.push(unq(m[1]));
      else bad(n, 'expected "- term" under hard_terms');
    }
  });
  policy.hard_terms = policy.hard_terms.filter(Boolean);
  return policy;
}

function clientForRepo(policy, repoName) {
  if (!repoName) return null;
  return policy.repos[repoName] ?? policy.repos[slugify(repoName)] ?? null;
}

/* cwd -> {repo, task, client, worktree}. A cwd inside
   <projects>/.maestro/worktrees/<repo-slug>/T-n/ is bound to that task; a cwd inside a
   registered repo only gives repo + client (an "untasked" session). */
/* realpath with a per-process cache; a path that does not exist resolves to itself. Registry
   paths and session cwds both go through it, so a repo registered through a symlink
   (e.g. ~/notes -> ~/vault) still matches the cwd a session reports. */
const realCache = new Map();
function realOrSelf(p) {
  if (!realCache.has(p)) {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      /* missing path: compare as given */
    }
    realCache.set(p, r);
  }
  return realCache.get(p);
}

const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

export function locateCwd(cwd, projectsDir, registry = loadRegistry(projectsDir), policy = loadPolicy(projectsDir)) {
  const out = { repo: null, task: null, client: null, worktree: null };
  if (!cwd || typeof cwd !== 'string') return out;
  const wtRoot = path.join(projectsDir, '.maestro', 'worktrees');
  const rel = path.relative(wtRoot, cwd);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const [slug, tid] = rel.split(path.sep);
    if (slug && /^T-\d+$/.test(tid || '')) {
      const repo = registry.repos.find((r) => slugify(r.name) === slug)?.name ?? slug;
      out.repo = repo;
      out.task = `${repo}/${tid}`;
      out.worktree = path.join(wtRoot, slug, tid);
      out.client = clientForRepo(policy, repo);
      return out;
    }
  }
  const real = realOrSelf(cwd);
  const repos = registry.repos.filter((r) => r.path).map((r) => ({ r, paths: [...new Set([r.path, realOrSelf(r.path)])] }));
  let best = null;
  let bestLen = -1;
  for (const { r, paths } of repos) {
    for (const p of paths) {
      if ((within(cwd, p) || within(real, p)) && p.length > bestLen) {
        best = r;
        bestLen = p.length;
      }
    }
  }
  /* A session opened in the parent folder of exactly one registered repo (~/Projects/x/alpha for
     a repo at ~/Projects/x/alpha/app) belongs to that repo. Two or more repos below the cwd is
     ambiguous and stays unbound, and the projects root itself never binds. */
  if (!best) {
    const root = realOrSelf(projectsDir);
    if (real !== root && within(real, root)) {
      const below = repos.filter(({ paths }) => paths.some((p) => p !== real && within(p, real)));
      if (below.length === 1) best = below[0].r;
    }
  }
  if (best) {
    out.repo = best.name;
    out.client = clientForRepo(policy, best.name);
  }
  return out;
}

/* ---- tasks / claims / events / inbox snapshot ------------------------------------------ */

function findTaskFile(repoPath, taskId) {
  const dir = path.join(repoPath, '.maestro', 'tasks');
  try {
    const f = readdirSync(dir).find((n) => n === `${taskId}.md` || n.startsWith(`${taskId}-`));
    return f ? path.join(dir, f) : null;
  } catch {
    return null;
  }
}

const globalize = (repoName, id) => (String(id).includes('/') ? String(id) : `${repoName}/${id}`);

/* Index rows (index.jsonl is authoritative for status/owner/progress) merged with each task
   file's frontmatter for fields the index does not carry (depends_on, blocked_by, uses, ...).
   Falls back to scanning task files when there is no index yet. */
export function loadTasks(projectsDir, registry = loadRegistry(projectsDir), policy = loadPolicy(projectsDir)) {
  const rows = readJsonlFile(path.join(projectsDir, '.maestro', 'index.jsonl'));
  const byRepo = new Map(registry.repos.map((r) => [r.name, r]));
  const tasks = new Map();

  const add = (row, fm) => {
    const repoName = row.repo;
    const id = row.id.includes('/') ? row.id : `${repoName}/${row.id}`;
    const f = fm || {};
    const dependsOn = asArray(row.depends_on ?? f.depends_on).map((d) => globalize(repoName, d));
    tasks.set(id, {
      id,
      repo: repoName,
      task_id: id.slice(repoName.length + 1),
      title: row.title ?? f.title ?? '(untitled)',
      status: row.status ?? f.status ?? 'open',
      owner: row.owner ?? f.owner ?? null,
      progress: row.progress ?? '0/0',
      priority: row.priority ?? f.priority ?? 3,
      updated: row.updated ?? f.updated ?? '',
      needs_human: row.needs_human ?? 0,
      client: row.client ?? f.client ?? clientForRepo(policy, repoName),
      project: row.project ?? f.project ?? null,
      deadline: row.deadline ?? f.deadline ?? null,
      wu: row.wu ?? f.wu ?? null,
      depends_on: dependsOn,
      blocked_by: asArray(row.blocked_by ?? f.blocked_by),
      blocked_reason: row.blocked_reason ?? f.blocked_reason ?? null,
      uses: asArray(row.uses ?? f.uses),
      scope: asArray(row.scope ?? f.scope),
      ready: row.ready ?? null,
      waiting_on: row.waiting_on ?? null,
    });
  };

  if (rows.length) {
    for (const row of rows) {
      if (!row || !row.id || !row.repo) continue;
      const repo = byRepo.get(row.repo);
      const tid = row.id.includes('/') ? row.id.slice(row.repo.length + 1) : row.id;
      const file = repo ? findTaskFile(repo.path, tid) : null;
      const raw = file ? readText(file) : null;
      add(row, raw ? parseFlatFrontmatter(raw) : null);
    }
  } else {
    for (const repo of registry.repos) {
      let files = [];
      try {
        files = readdirSync(path.join(repo.path, '.maestro', 'tasks')).filter((n) => n.endsWith('.md'));
      } catch {
        continue;
      }
      for (const n of files) {
        const raw = readText(path.join(repo.path, '.maestro', 'tasks', n));
        const fm = raw ? parseFlatFrontmatter(raw) : null;
        if (fm?.id) add({ id: fm.id, repo: repo.name }, fm);
      }
    }
  }

  /* Local readiness for rows the index (pre-P1a) did not annotate. */
  for (const t of tasks.values()) {
    if (t.ready !== null) continue;
    const unmet = t.depends_on.filter((d) => tasks.get(d)?.status !== 'done');
    t.waiting_on = unmet;
    t.ready = t.status === 'open' && unmet.length === 0 && t.blocked_by.length === 0;
  }
  return tasks;
}

export function loadClaims(registry, now = Date.now()) {
  const claims = [];
  for (const repo of registry.repos) {
    const dir = path.join(repo.path, '.maestro', 'locks');
    let files = [];
    try {
      files = readdirSync(dir).filter((n) => n.endsWith('.claim.json'));
    } catch {
      continue;
    }
    for (const n of files) {
      try {
        const c = JSON.parse(readFileSync(path.join(dir, n), 'utf8'));
        const hb = Date.parse(c.heartbeat);
        const ttl = c.ttl_seconds ?? DEFAULT_TTL_SECONDS;
        const age = Number.isNaN(hb) ? Infinity : Math.floor((now - hb) / 1000);
        claims.push({
          task: `${repo.name}/${c.task}`,
          repo: repo.name,
          owner: c.owner,
          provider: c.provider ?? null,
          claimed_at: c.claimed_at ?? null,
          heartbeat: c.heartbeat ?? null,
          heartbeat_age_sec: Number.isFinite(age) ? age : null,
          ttl_seconds: ttl,
          stale: age > ttl,
        });
      } catch {
        /* unreadable claim: ignore here; sync warns about it */
      }
    }
  }
  return claims;
}

function dayDirs(now, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/* Events from the last `days` UTC day-dirs (today + yesterday by default), oldest first. */
export function readEvents(projectsDir, { now = Date.now(), days = 2, sinceMs = 0 } = {}) {
  const out = [];
  for (const day of dayDirs(now, days)) {
    const dir = path.join(projectsDir, '.maestro', 'events', day);
    let files = [];
    try {
      files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const n of files) {
      for (const e of readJsonlFile(path.join(dir, n))) {
        if (!e || !e.ts || !e.type) continue;
        if (sinceMs && Date.parse(e.ts) < sinceMs) continue;
        out.push(e);
      }
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

function readInbox(projectsDir) {
  return readJsonlFile(path.join(projectsDir, '.maestro', 'inbox.jsonl'));
}

/* ---- hook payload -> events ------------------------------------------------------------- */

function classifyStopFailure(err) {
  switch (err) {
    case 'rate_limit':
      return 'ratelimit';
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'cloud_credential_error':
      return 'auth';
    case 'billing_error':
      return 'budget';
    default:
      return 'tool';
  }
}

/* Token usage from a Claude Code transcript JSONL. Verified shape (Claude Code 2.1.304):
   `assistant` records carry message.usage {input_tokens, cache_creation_input_tokens,
   cache_read_input_tokens, output_tokens}; one API message is split across several records
   (apiBlockIndex) that repeat the SAME usage, so we de-duplicate by message.id. cost_usd stays
   null: subscription auth has no per-token price. duration_sec is first-to-last record (wall);
   active_sec sums inter-record gaps under 10 min (design B1). Returns null if unknown. */
export function usageFromTranscript(file) {
  try {
    const p = expandHome(String(file || ''));
    if (!p || !existsSync(p)) return null;
    if (statSync(p).size > 120 * 1024 * 1024) return null;
    const byMsg = new Map();
    let first = null;
    let last = null;
    let prev = null;
    let active = 0;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (!Number.isNaN(ts)) {
        if (first === null || ts < first) first = ts;
        if (last === null || ts > last) last = ts;
        if (prev !== null && ts > prev && ts - prev < LIVE_SECONDS * 1000) active += ts - prev;
        prev = ts;
      }
      const m = o.message;
      if (o.type === 'assistant' && m && isPlainObject(m.usage) && m.id) byMsg.set(m.id, m.usage);
    }
    if (!byMsg.size) return null;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    for (const u of byMsg.values()) {
      input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      cacheRead += u.cache_read_input_tokens || 0;
      output += u.output_tokens || 0;
    }
    return {
      tokens_in: input,
      tokens_out: output,
      tokens_cache_read: cacheRead,
      cost_usd: null,
      duration_sec: first !== null && last !== null ? Math.round((last - first) / 1000) : null,
      active_sec: first !== null ? Math.round(active / 1000) : null,
    };
  } catch {
    return null;
  }
}

function gitShortHead(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/* Map one hook payload (stdin JSON) to zero or more partial events. Event names verified
   against https://code.claude.com/docs/en/hooks (2026-10-21). */
export function hookToEvents(p, ctx = {}) {
  if (!isPlainObject(p) || !p.hook_event_name) return [];
  return mapHookEvents(p, ctx).map((e) => ({ ...e, data: { ...e.data, via: 'hook' } }));
}

function mapHookEvents(p, ctx) {
  const projectsDir = ctx.projectsDir || resolveProjectsDir();
  const loc = locateCwd(p.cwd, projectsDir);
  const session = shortSession(p.session_id);
  const host = ctx.host || hostShort();
  const actor = { id: `claude@${host}`, agent_id: p.agent_id ?? null, session, provider: 'claude' };
  const base = { actor, task: loc.task, client: loc.client };
  const sessionSpan = p.session_id ? hash16(`session:${p.session_id}`) : undefined;
  const name = p.hook_event_name;

  switch (name) {
    case 'SessionStart':
      return [
        {
          ...base,
          type: 'claim',
          span_id: sessionSpan,
          data: {
            action: p.source === 'startup' || !p.source ? 'acquire' : 'resume',
            source: p.source ?? null,
            repo: loc.repo,
            worktree: loc.worktree,
            untasked: !loc.task,
            model: p.model ?? null,
            ...(p.session_title ? { note: p.session_title } : {}),
          },
        },
      ];
    case 'SessionEnd':
      return [{ ...base, type: 'state', data: { from: 'working', to: 'ended', reason: p.reason ?? null } }];
    case 'Stop':
      return [
        {
          ...base,
          type: 'receipt',
          data: {
            outcome: 'turn_end',
            scope: 'session_cumulative',
            usage: usageFromTranscript(p.transcript_path),
          },
        },
      ];
    case 'StopFailure':
      return [
        {
          ...base,
          type: 'error',
          data: { class: classifyStopFailure(p.error), api_error: p.error ?? null, message: p.error_details ?? p.error ?? 'stop failure' },
        },
      ];
    case 'SubagentStart':
      return [
        {
          ...base,
          type: 'claim',
          span_id: p.agent_id ? hash16(`agent:${p.agent_id}`) : undefined,
          parent_span_id: sessionSpan ?? null,
          data: { action: 'acquire', subagent: true, agent_type: p.agent_type ?? null },
        },
      ];
    case 'SubagentStop':
      return [
        {
          ...base,
          type: 'output',
          span_id: p.agent_id ? hash16(`agent:${p.agent_id}`) : undefined,
          parent_span_id: sessionSpan ?? null,
          data: { kind: 'report', ref: p.agent_type ?? null, subagent: true },
        },
      ];
    case 'TaskCreated':
    case 'TaskCompleted':
      return [
        {
          ...base,
          type: 'progress',
          data: {
            todos: null,
            note: p.task_subject ?? null,
            claude_task_id: p.task_id ?? null,
            claude_task: name === 'TaskCreated' ? 'created' : 'completed',
          },
        },
      ];
    case 'PermissionRequest':
    case 'PreToolUse':
      return [
        {
          ...base,
          type: 'approval',
          data: { action_type: p.tool_name ?? null, decision: 'requested', reversibility: null, mode: p.permission_mode ?? null },
        },
      ];
    case 'PostToolUse': {
      const cmd = String(p.tool_input?.command ?? '');
      if (p.tool_name === 'Bash' && /\bgit\b[^|;&\n]*\bcommit\b/.test(cmd)) {
        const sha = gitShortHead(p.cwd);
        return [{ ...base, type: 'output', refs: sha ? [`sha:${sha}`] : [], data: { kind: 'commit', ref: sha ? `sha:${sha}` : null } }];
      }
      if (p.tool_name === 'Bash' && /\bgh\s+pr\s+create\b/.test(cmd)) {
        const resp = typeof p.tool_response === 'string' ? p.tool_response : JSON.stringify(p.tool_response ?? '');
        const url = resp.match(/https:\/\/github\.com\/[^\s"\\]+\/pull\/\d+/)?.[0] ?? null;
        return [{ ...base, type: 'output', refs: url ? [url] : [], data: { kind: 'pr', ref: url } }];
      }
      return [{ ...base, type: 'heartbeat', data: { throttled: true } }];
    }
    default:
      return [];
  }
}

/* Per-session heartbeat throttle (hook heartbeats only): at most one per 10 minutes.
   Stamps live in a private dir (<projects>/.maestro/run, mode 0700), never in shared /tmp.
   A stamp that is a symlink (or anything but a regular file) is refused, creation uses
   O_NOFOLLOW without O_TRUNC, and refreshing uses utimes, so a planted link can never be
   used to truncate or touch another file. On any problem the heartbeat is skipped. */
function heartbeatDue(session, projectsDir) {
  try {
    const dir = path.join(projectsDir, '.maestro', 'run');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const stamp = path.join(dir, `hb-${fileSlug(session, 'nosession')}`);
    let st = null;
    try {
      st = lstatSync(stamp);
    } catch {
      /* no stamp yet */
    }
    if (st) {
      if (st.isSymbolicLink() || !st.isFile()) return false;
      if (Date.now() - st.mtimeMs < HEARTBEAT_THROTTLE_MS) return false;
      const t = new Date();
      utimesSync(stamp, t, t);
      return true;
    }
    closeSync(openSync(stamp, fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600));
    return true;
  } catch {
    return false;
  }
}

/* ---- cmdEmit ----------------------------------------------------------------------------- */

const BOOLEAN_FLAGS = new Set(['all', 'json', 'verbose', 'from-hook']);

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (key === 'from-hook') {
        // `--from-hook` alone, or `--from-hook SessionStart` (design §7 form)
        if (next !== undefined && /^[A-Z][A-Za-z]+$/.test(next)) {
          flags[key] = next;
          i++;
        } else flags[key] = true;
      } else if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function readStdinJson(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        resolve(buf.trim() ? JSON.parse(buf) : null);
      } catch {
        resolve(null);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function setPath(obj, dotted, value) {
  const parts = dotted.split('.').slice(0, 3);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const coerce = (v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : v);

/* `maestro emit` is best-effort and always returns exit code 0. */
export async function cmdEmit(argv, ctx = {}) {
  try {
    const { positional, flags } = parseArgv(argv);
    const projectsDir = ctx.projectsDir || resolveProjectsDir();
    const opts = { projectsDir };

    if (flags['from-hook']) {
      const payload = await readStdinJson();
      let evts = hookToEvents(payload, { projectsDir, host: ctx.host });
      if (typeof flags['from-hook'] === 'string' && payload && !payload.hook_event_name) {
        evts = hookToEvents({ ...payload, hook_event_name: flags['from-hook'] }, { projectsDir, host: ctx.host });
      }
      for (const e of evts) {
        if (e.type === 'heartbeat' && !heartbeatDue(e.actor?.session, projectsDir)) continue;
        appendEvent(e, opts);
      }
      return 0;
    }

    const type = positional[0];
    const loc = locateCwd(process.cwd(), projectsDir);
    const data = {};
    const top = {};
    for (const arg of positional.slice(1)) {
      const eq = arg.indexOf('=');
      if (eq < 1) continue;
      const k = arg.slice(0, eq);
      const v = arg.slice(eq + 1);
      if (['to', 'client', 'project', 'wu'].includes(k)) top[k] = v;
      else if (k === 'refs') top.refs = v.split(',').filter(Boolean);
      else setPath(data, k, coerce(v));
    }
    const task = typeof flags.task === 'string' ? flags.task : loc.task;
    const evt = {
      type,
      task: task || null,
      client: top.client ?? (typeof flags.client === 'string' ? flags.client : loc.client),
      project: top.project ?? (typeof flags.project === 'string' ? flags.project : null),
      wu: top.wu ?? null,
      to: top.to ?? null,
      refs: top.refs ?? [],
      parent_span_id: typeof flags['parent-span'] === 'string' ? flags['parent-span'] : null,
      actor: ctx.actor,
      session: ctx.session,
      data,
    };
    const ok = appendEvent(evt, opts);
    if (!ok) console.error(`maestro: emit: nothing recorded (type '${type ?? ''}' must be one of: ${EVENT_TYPES.join(', ')})`);
  } catch {
    /* never fail the caller */
  }
  return 0;
}

/* ---- projections --------------------------------------------------------------------------- */

const sec = (ms) => Math.max(0, Math.floor(ms / 1000));

function lastOf(arr) {
  return arr.length ? arr[arr.length - 1] : null;
}

function agentSessionMap(claudeAgents) {
  if (!Array.isArray(claudeAgents)) return null;
  const m = new Map();
  for (const a of claudeAgents) {
    if (a && a.sessionId) m.set(sessionFileToken(a.sessionId), a);
  }
  return m;
}

/* A listed agent counts as "busy" when the CLI says so (interactive: status busy;
   background: state working). Anything else listed is alive-but-waiting. */
function agentBusy(a) {
  return a ? a.status === 'busy' || a.state === 'working' : false;
}

function buildFleet(ctx) {
  const { now, events, claims, agents, registry, policy, projectsDir } = ctx;
  const sessions = new Map();
  for (const e of events) {
    const actor = e.actor || {};
    if (/^reaper@/i.test(String(actor.id ?? ''))) continue; // the reaper is infrastructure, not a fleet member
    // One row per session: a session id survives a host rename (mac-1224 -> andrews-macbook-air
    // overnight) and a human verb run inside it, so the actor is an attribute, not the key.
    const key = actor.session ? `session|${actor.session}` : `${actor.id ?? 'unknown'}|nosession`;
    let s = sessions.get(key);
    if (!s) {
      s = { key, actor, session: actor.session ?? null, task: null, client: null, repo: null, events: [], subagents: new Set(), ended: false, viaHook: false };
      sessions.set(key, s);
    }
    if (actor.provider && actor.provider !== 'unknown') s.actor = actor; // latest agent identity wins over a human verb
    s.events.push(e);
    if (e.data?.via === 'hook') s.viaHook = true;
    if (e.task) s.task = e.task;
    if (e.client) s.client = e.client;
    if (e.data?.repo) s.repo = e.data.repo;
    if (e.actor?.agent_id) s.subagents.add(e.actor.agent_id);
    if (e.type === 'state' && e.data?.to === 'ended') s.ended = true;
    if (e.type === 'claim' && e.data?.action && e.data.action !== 'release' && !e.data?.subagent) s.ended = false;
  }

  const cards = [];
  const matchedAgents = new Set();
  let endedCount = 0;

  for (const s of sessions.values()) {
    if (s.ended) {
      endedCount++;
      continue;
    }
    const last = lastOf(s.events);
    const lastMs = Date.parse(last.ts);
    const age = sec(now - lastMs);
    const agent = agents ? agents.get(s.session) : null;
    if (agent) matchedAgents.add(s.session);
    const claim = s.task ? claims.find((c) => c.task === s.task) : null;
    if (!s.repo && agent?.cwd) s.repo = locateCwd(agent.cwd, projectsDir, registry, policy).repo;
    if (!s.repo && s.task) s.repo = s.task.split('/')[0];
    const ttl = claim?.ttl_seconds ?? DEFAULT_TTL_SECONDS;
    const untasked = !s.task;
    const crashedErr = last.type === 'error' && last.data?.class === 'crash';
    // Only a hook-reported claude session is expected to appear in `claude agents`; CLI-minted
    // ids and codex / cursor / grok actors never do, so their absence proves nothing.
    const vanished = agents && !agent && !!s.task && age > LIVE_SECONDS && s.actor.provider === 'claude' && s.viaHook;

    let state;
    let reason = null;
    if (crashedErr) {
      state = 'crashed';
      reason = 'last event was error:crash';
    } else if (vanished) {
      state = 'crashed';
      reason = 'task-bound session no longer listed by `claude agents`, no SessionEnd';
    } else if (agentBusy(agent) && age >= LIVE_SECONDS) {
      state = 'silent';
      reason = 'agent reports busy but no events';
    } else if (untasked) {
      state = age < ttl ? 'untasked' : 'stale';
    } else if (age < LIVE_SECONDS) state = 'live';
    else if (age < ttl) state = 'idle';
    else state = 'stale';

    cards.push({
      key: s.key,
      actor: { id: s.actor.id ?? 'unknown', provider: s.actor.provider ?? 'unknown' },
      session: s.session,
      client: s.client ?? (s.task ? clientForRepo(policy, s.task.split('/')[0]) : null),
      task: s.task,
      repo: s.repo,
      untasked,
      state,
      reason,
      source: 'events',
      name: agent?.name ?? null,
      last_event_ts: last.ts,
      last_event_age_sec: age,
      last_event_type: last.type,
      a2a_state: last.a2a_state ?? null,
      subagents: s.subagents.size,
      errors_1h: s.events.filter((e) => e.type === 'error' && now - Date.parse(e.ts) < 3_600_000).length,
      ttl_sec: ttl,
    });
  }

  /* Claims with no event-bearing session: card from the claim heartbeat. */
  for (const c of claims) {
    if (cards.some((x) => x.task === c.task)) continue;
    const age = c.heartbeat_age_sec ?? Infinity;
    cards.push({
      key: `claim|${c.task}`,
      actor: { id: c.owner ?? 'unknown', provider: c.provider ?? 'unknown' },
      session: null,
      client: clientForRepo(policy, c.repo),
      task: c.task,
      repo: c.repo,
      untasked: false,
      state: age < LIVE_SECONDS ? 'live' : age < c.ttl_seconds ? 'idle' : 'stale',
      reason: 'claim heartbeat only (no hook events)',
      source: 'claim',
      name: null,
      last_event_ts: c.heartbeat,
      last_event_age_sec: Number.isFinite(age) ? age : null,
      last_event_type: 'heartbeat',
      a2a_state: null,
      subagents: 0,
      errors_1h: 0,
      ttl_sec: c.ttl_seconds,
    });
  }

  /* Sessions `claude agents` knows but no hook has reported: never invisible. */
  if (agents) {
    for (const [short, a] of agents) {
      if (matchedAgents.has(short)) continue;
      if (Array.from(sessions.values()).some((s) => s.session === short)) continue;
      const loc = locateCwd(a.cwd, projectsDir, registry, policy);
      cards.push({
        key: `agents|${short}`,
        actor: { id: `claude@${hostShort()}`, provider: 'claude' },
        session: short,
        client: loc.client,
        task: loc.task,
        repo: loc.repo,
        untasked: !loc.task,
        state: agentBusy(a) ? 'silent' : loc.task ? 'idle' : 'untasked',
        reason: 'listed by `claude agents`, no hook events (hooks not installed or not firing)',
        source: 'claude-agents',
        name: a.name ?? null,
        last_event_ts: null,
        last_event_age_sec: null,
        last_event_type: null,
        a2a_state: null,
        subagents: 0,
        errors_1h: 0,
        ttl_sec: DEFAULT_TTL_SECONDS,
      });
    }
  }

  const order = { crashed: 0, silent: 1, stale: 2, untasked: 3, live: 4, idle: 5 };
  cards.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || (a.last_event_age_sec ?? 1e12) - (b.last_event_age_sec ?? 1e12));
  return { cards, endedCount };
}

/* Abandoned dirty worktrees, from the reaper's most recent run. Every line of
   events/_system/reaper.jsonl is a FULL snapshot:
     {ts, host, ok, released:[id], needs_you:[{id, worktree, branch, reason, ...}]}
   so only the last line counts; older lines are history and must not accumulate. */
function readAbandoned(projectsDir) {
  const lines = readJsonlFile(path.join(projectsDir, '.maestro', 'events', '_system', 'reaper.jsonl'));
  const last = lastOf(lines);
  if (!last || !Array.isArray(last.needs_you)) return [];
  return last.needs_you
    .filter((o) => isPlainObject(o) && (o.id || o.worktree))
    .map((o) => ({ ts: o.since ?? o.ts ?? last.ts, task: o.id ?? null, worktree: o.worktree ?? null, detail: o.reason ?? null }));
}

function buildNeedsYou(ctx) {
  const { now, handle, tasks, events, inbox, projectsDir } = ctx;
  const me = normalizeWho(handle);
  const items = [];
  const ageOf = (ts) => {
    const t = Date.parse(ts);
    return Number.isNaN(t) ? null : sec(now - t);
  };

  for (const a of inbox) {
    if (normalizeWho(a.target) !== me) continue;
    const age = ageOf(a.ts);
    const channelTask = a.channel && a.channel !== 'fleet' ? tasks.get(a.channel) : null;
    items.push({
      kind: 'ask',
      id: `${a.channel}/${a.mid}`,
      mid: a.mid,
      channel: a.channel,
      repo: a.channel.includes('/') ? a.channel.split('/')[0] : null,
      client: channelTask?.client ?? null,
      task: channelTask?.id ?? null,
      title: `${a.author} asked`,
      text: a.text,
      author: a.author,
      since: a.ts,
      age_sec: age,
      severity: age !== null && age > 86_400 ? 'red' : null,
    });
  }

  for (const t of tasks.values()) {
    if (t.status === 'review') {
      const upd = Date.parse(t.updated.length === 16 ? `${t.updated}:00Z` : t.updated);
      const age = Number.isNaN(upd) ? null : sec(now - upd);
      items.push({
        kind: 'review',
        id: t.id,
        client: t.client,
        task: t.id,
        title: t.title,
        text: null,
        since: Number.isNaN(upd) ? null : new Date(upd).toISOString(),
        age_sec: age,
        severity: age !== null && age > 2 * 86_400 ? 'amber' : null,
      });
    }
    if (t.status !== 'done' && t.blocked_by.some((b) => normalizeWho(b) === me)) {
      const upd = Date.parse(t.updated.length === 16 ? `${t.updated}:00Z` : t.updated);
      const age = Number.isNaN(upd) ? null : sec(now - upd);
      items.push({
        kind: 'blocked',
        id: `${t.id}#blocked`,
        client: t.client,
        task: t.id,
        title: t.title,
        text: t.blocked_reason,
        since: Number.isNaN(upd) ? null : new Date(upd).toISOString(),
        age_sec: age,
        severity: age !== null && age > 86_400 ? 'red' : null,
      });
    }
  }

  /* A session whose latest event is a permission request is waiting on you. */
  const lastBySession = new Map();
  for (const e of events) lastBySession.set(`${e.actor?.id}|${e.actor?.session}`, e);
  for (const e of lastBySession.values()) {
    if (e.type !== 'approval' || e.data?.decision !== 'requested') continue;
    const age = ageOf(e.ts);
    if (age === null || age > 3600) continue;
    items.push({
      kind: 'approval',
      id: `approval|${e.actor?.id}|${e.actor?.session}|${e.ts}`,
      client: e.client ?? null,
      task: e.task ?? null,
      title: `${e.actor?.id ?? 'agent'} waiting on permission: ${e.data?.action_type ?? 'tool'}`,
      text: null,
      since: e.ts,
      age_sec: age,
      severity: null,
    });
  }

  for (const ab of readAbandoned(projectsDir)) {
    if (ab.worktree && !existsSync(ab.worktree)) continue;
    if (ab.task && tasks.get(ab.task)?.status === 'done') continue;
    const age = ageOf(ab.ts);
    items.push({
      kind: 'abandoned',
      id: `abandoned|${ab.task ?? ab.worktree}`,
      client: ab.task ? (tasks.get(ab.task)?.client ?? null) : null,
      task: ab.task,
      title: 'Abandoned work: dirty worktree',
      text: ab.detail,
      since: ab.ts ?? null,
      age_sec: age,
      severity: 'red',
    });
  }

  items.sort((a, b) => (b.age_sec ?? -1) - (a.age_sec ?? -1)); // oldest first
  return items;
}

function dependentCounts(tasks) {
  const rev = new Map();
  for (const t of tasks.values()) {
    for (const d of t.depends_on) {
      if (!rev.has(d)) rev.set(d, []);
      rev.get(d).push(t.id);
    }
  }
  const count = (id) => {
    const seen = new Set();
    const stack = [...(rev.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n) || tasks.get(n)?.status === 'done') continue;
      seen.add(n);
      stack.push(...(rev.get(n) ?? []));
    }
    return seen.size;
  };
  return count;
}

function buildBottlenecks(ctx) {
  const { now, tasks, claims, events, projectsDir } = ctx;

  const staleClaims = claims
    .filter((c) => c.stale && tasks.get(c.task)?.status !== 'done')
    .map((c) => ({ task: c.task, owner: c.owner, age_sec: c.heartbeat_age_sec, ttl_sec: c.ttl_seconds, client: tasks.get(c.task)?.client ?? null }))
    .sort((a, b) => (b.age_sec ?? 0) - (a.age_sec ?? 0));

  const hourAgo = now - 3_600_000;
  const byClass = new Map();
  for (const e of events) {
    if (e.type !== 'error' || Date.parse(e.ts) < hourAgo) continue;
    const cls = e.data?.class ?? 'unknown';
    if (!byClass.has(cls)) byClass.set(cls, { class: cls, count: 0, tasks: new Set(), actors: new Set(), last_ts: e.ts, sample: null });
    const g = byClass.get(cls);
    g.count++;
    if (e.task) g.tasks.add(e.task);
    if (e.actor?.id) g.actors.add(e.actor.id);
    g.last_ts = e.ts;
    g.sample = e.data?.message ?? g.sample;
  }
  const errorClusters = Array.from(byClass.values())
    .filter((g) => g.count >= 3)
    .map((g) => ({ class: g.class, count: g.count, tasks: Array.from(g.tasks), actors: Array.from(g.actors), last_ts: g.last_ts, sample: g.sample }))
    .sort((a, b) => b.count - a.count);

  const steals = events
    .filter((e) => e.type === 'claim' && e.data?.action === 'steal')
    .map((e) => ({ ts: e.ts, task: e.task, actor: e.actor?.id ?? null, from: e.data?.from ?? e.data?.prev_owner ?? null }))
    .reverse();

  /* Stalled = in flight (claimed / in-progress / blocked) with no event for 2h, ranked by how
     many unfinished tasks transitively depend on it. */
  const dependents = dependentCounts(tasks);
  const lastEventByTask = new Map();
  for (const e of events) if (e.task) lastEventByTask.set(e.task, Date.parse(e.ts));
  const claimByTask = new Map(claims.map((c) => [c.task, c]));
  const stalled = [];
  for (const t of tasks.values()) {
    if (!['claimed', 'in-progress', 'blocked'].includes(t.status)) continue;
    const c = claimByTask.get(t.id);
    const lastEv = Math.max(lastEventByTask.get(t.id) ?? 0, c?.heartbeat ? Date.parse(c.heartbeat) || 0 : 0);
    const idle = lastEv ? sec(now - lastEv) : null;
    if (t.status !== 'blocked' && idle !== null && idle < 7200) continue;
    const n = dependents(t.id);
    if (n === 0) continue;
    stalled.push({ task: t.id, title: t.title, status: t.status, owner: t.owner, client: t.client, dependents: n, idle_sec: idle, blocked_by: t.blocked_by });
  }
  stalled.sort((a, b) => b.dependents - a.dependents || (b.idle_sec ?? 0) - (a.idle_sec ?? 0));

  let paused = [];
  try {
    paused = readdirSync(path.join(projectsDir, '.maestro', 'pause')).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''));
  } catch {
    /* no pause dir */
  }

  return { stale_claims: staleClaims, error_clusters: errorClusters, steals, stalled_tasks: stalled.slice(0, 10), paused_providers: paused };
}

function buildHealth(ctx) {
  const { now, projectsDir } = ctx;
  let syncMs = null;
  try {
    syncMs = statSync(path.join(projectsDir, '.maestro', 'index.jsonl')).mtimeMs;
  } catch {
    /* never synced */
  }
  const reaperFile = path.join(projectsDir, '.maestro', 'events', '_system', 'reaper.jsonl');
  const reaperLines = readJsonlFile(reaperFile);
  let reaperMs = null;
  const lastLine = lastOf(reaperLines);
  if (lastLine?.ts && !Number.isNaN(Date.parse(lastLine.ts))) reaperMs = Date.parse(lastLine.ts);
  else {
    try {
      reaperMs = statSync(reaperFile).mtimeMs;
    } catch {
      /* never ran */
    }
  }
  const part = (ms) => ({
    ts: ms === null ? null : new Date(ms).toISOString(),
    age_sec: ms === null ? null : sec(now - ms),
    red: ms === null || sec(now - ms) > RED_SECONDS,
  });
  return { now: new Date(now).toISOString(), red_threshold_sec: RED_SECONDS, last_sync: part(syncMs), last_reaper: { ...part(reaperMs), ok: lastLine?.ok ?? null } };
}

/* Everything the dashboard needs, in one pass. `claudeAgents` is the parsed output of
   `claude agents --json` (or null/undefined when the CLI is missing or failed). */
export function buildProjections(projectsDir = resolveProjectsDir(), opts = {}) {
  const now = opts.now ?? Date.now();
  const registry = loadRegistry(projectsDir);
  const policy = loadPolicy(projectsDir);
  const tasks = loadTasks(projectsDir, registry, policy);
  const claims = loadClaims(registry, now);
  const events = readEvents(projectsDir, { now, days: 2, sinceMs: now - 86_400_000 });
  const inbox = readInbox(projectsDir);
  const ctx = {
    now,
    projectsDir,
    handle: opts.handle ?? resolveHandle(),
    registry,
    policy,
    tasks,
    claims,
    events,
    inbox,
    agents: agentSessionMap(opts.claudeAgents),
  };
  const { cards, endedCount } = buildFleet(ctx);
  return {
    generated: new Date(now).toISOString(),
    fleet: { actors: cards, ended: endedCount, agents_cli: ctx.agents !== null },
    needs_you: buildNeedsYou(ctx),
    bottlenecks: buildBottlenecks(ctx),
    health: buildHealth(ctx),
  };
}

/* ---- status / who ---------------------------------------------------------------------------- */

const fmtAge = (s) => {
  if (s === null || s === undefined || !Number.isFinite(s)) return '?';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
};

function resolveCtx(ctx = {}) {
  const projectsDir = ctx.projectsDir || resolveProjectsDir();
  const registry = loadRegistry(projectsDir);
  const policy = loadPolicy(projectsDir);
  const now = Date.now();
  return {
    projectsDir,
    handle: ctx.handle || resolveHandle(),
    registry,
    policy,
    now,
    tasks: loadTasks(projectsDir, registry, policy),
    claims: loadClaims(registry, now),
    events: readEvents(projectsDir, { now, days: 2 }),
    inbox: readInbox(projectsDir),
  };
}

function eventSummary(e) {
  const d = e.data || {};
  const bit = d.note || d.message || d.action || d.kind || d.outcome || d.decision || d.to || '';
  return `${e.type}${bit ? `:${clip(String(bit), 40)}` : ''}`;
}

function taskView(t, c) {
  const events = c.events.filter((e) => e.task === t.id);
  const last = lastOf(events);
  const claim = c.claims.find((x) => x.task === t.id) ?? null;
  const asks = c.inbox.filter((a) => a.channel === t.id);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    owner: claim?.owner ?? t.owner,
    progress: t.progress,
    client: t.client,
    project: t.project,
    priority: t.priority,
    ready: t.ready,
    waiting_on: t.waiting_on ?? [],
    depends_on: t.depends_on,
    blocked_by: t.blocked_by,
    open_asks: asks.length,
    uses: t.uses,
    scope: t.scope,
    last_event: last ? { ts: last.ts, type: last.type, actor: last.actor?.id ?? null, summary: eventSummary(last), age_sec: sec(c.now - Date.parse(last.ts)) } : null,
    claim: claim ? { owner: claim.owner, heartbeat: claim.heartbeat, age_sec: claim.heartbeat_age_sec, stale: claim.stale } : null,
  };
}

function ownTaskId(token, c, ctx) {
  if (!token) return null;
  if (c.tasks.has(token)) return token;
  const repo = ctx.repo || locateCwd(process.cwd(), c.projectsDir, c.registry, c.policy).repo;
  if (/^T-\d+$/.test(token) && repo && c.tasks.has(`${repo}/${token}`)) return `${repo}/${token}`;
  const hits = Array.from(c.tasks.keys()).filter((id) => id.endsWith(`/${token}`));
  return hits.length === 1 ? hits[0] : null;
}

export async function cmdStatus(argv, ctx = {}) {
  try {
    const { flags } = parseArgv(argv);
    const c = resolveCtx(ctx);
    const here = locateCwd(process.cwd(), c.projectsDir, c.registry, c.policy);
    const repoName = ctx.repo?.name ?? ctx.repo ?? here.repo;
    const callerClient = clientForRepo(c.policy, typeof repoName === 'string' ? repoName : null) ?? here.client;

    let scope = 'all';
    let filter = () => true;
    if (typeof flags.task === 'string') {
      const id = ownTaskId(flags.task, c, ctx);
      scope = `task=${flags.task}`;
      filter = (t) => t.id === id;
    } else if (typeof flags.client === 'string') {
      scope = `client=${flags.client}`;
      filter = (t) => t.client === flags.client;
    } else if (typeof flags.project === 'string') {
      scope = `project=${flags.project}`;
      filter = (t) => t.project === flags.project;
    } else if (typeof flags.actor === 'string') {
      scope = `actor=${flags.actor}`;
      const actorTasks = new Set(c.events.filter((e) => e.actor?.id === flags.actor && e.task).map((e) => e.task));
      for (const cl of c.claims) if (cl.owner === flags.actor) actorTasks.add(cl.task);
      filter = (t) => actorTasks.has(t.id);
    } else if (!flags.all && callerClient) {
      scope = `client=${callerClient}`;
      filter = (t) => t.client === callerClient;
    } else if (!flags.all) {
      scope = 'all (client not resolvable here)';
    }

    const inScope = Array.from(c.tasks.values()).filter(filter);
    const wantAll = flags.all || typeof flags.task === 'string';
    const shown = (wantAll ? inScope : inScope.filter((t) => t.status !== 'done')).map((t) => taskView(t, c));

    const scopeTasks = new Set(inScope.map((t) => t.id));
    const sessions = new Map();
    for (const e of c.events) {
      if (flags.actor ? e.actor?.id !== flags.actor : !scopeTasks.has(e.task) && !(e.client && scope === `client=${e.client}`)) continue;
      sessions.set(`${e.actor?.id}|${e.actor?.session}`, e);
    }
    const actors = Array.from(sessions.values())
      .map((e) => ({ actor: e.actor?.id, session: e.actor?.session, task: e.task, age_sec: sec(c.now - Date.parse(e.ts)), last: eventSummary(e) }))
      .filter((a) => a.age_sec < 86_400)
      .sort((a, b) => a.age_sec - b.age_sec);
    const asks = c.inbox.filter((a) => scopeTasks.has(a.channel));

    if (flags.json) {
      console.log(JSON.stringify({ scope, generated: new Date(c.now).toISOString(), tasks: shown, actors, open_asks: asks.length }, null, 2));
      return 0;
    }

    const lines = [`maestro status · scope: ${scope} · ${isoSeconds(new Date(c.now))}`];
    const order = ['review', 'blocked', 'in-progress', 'claimed', 'open', 'done'];
    const sorted = [...shown].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.priority - b.priority);
    lines.push(`TASKS (${shown.length}${wantAll ? '' : ' not done'}) · open asks ${asks.length}`);
    const budget = 40 - lines.length - 2 - Math.min(actors.length, 8) - 1;
    for (const t of sorted.slice(0, Math.max(budget, 5))) {
      const flagsTxt = [t.ready ? 'ready' : t.status === 'open' && t.waiting_on.length ? `waits ${t.waiting_on.length}` : '', t.claim?.stale ? 'STALE' : '', t.open_asks ? `asks ${t.open_asks}` : '']
        .filter(Boolean)
        .join(' ');
      lines.push(`  ${t.id.padEnd(22)} ${t.status.padEnd(11)} ${String(t.owner ?? '-').padEnd(20)} ${t.progress.padEnd(5)} ${flagsTxt}${t.last_event ? ` · ${fmtAge(t.last_event.age_sec)} ${t.last_event.summary}` : ''}`);
    }
    if (sorted.length > Math.max(budget, 5)) lines.push(`  … ${sorted.length - Math.max(budget, 5)} more (use --json)`);
    lines.push(`ACTORS (${actors.length} active in 24h)`);
    for (const a of actors.slice(0, 8)) lines.push(`  ${String(a.actor).padEnd(18)} ${String(a.session ?? '-').padEnd(9)} ${String(a.task ?? 'untasked').padEnd(22)} ${fmtAge(a.age_sec)} ${a.last}`);
    if (actors.length > 8) lines.push(`  … ${actors.length - 8} more`);
    console.log(lines.slice(0, 40).join('\n'));
    return 0;
  } catch (e) {
    console.error(`maestro: status failed: ${e.message}`);
    return 1;
  }
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export async function cmdWho(argv, ctx = {}) {
  try {
    const { positional, flags } = parseArgv(argv);
    const target = positional[0];
    if (!target) {
      console.error('usage: maestro who <path|T-id|resource:name> [--json]');
      return 1;
    }
    const c = resolveCtx(ctx);
    const out = { target, kind: null, tasks: [], recent_events: [] };
    let matchEvent = () => false;

    if (/^resource:/.test(target) || /^[a-z]+:[A-Za-z0-9._-]+$/.test(target)) {
      out.kind = 'resource';
      const hits = Array.from(c.tasks.values()).filter((t) => t.uses.includes(target) || t.blocked_by.includes(target));
      out.tasks = hits.map((t) => ({ ...taskView(t, c), match: t.uses.includes(target) ? 'uses' : 'blocked_by' }));
      matchEvent = (e) => asArray(e.refs).includes(target) || e.data?.resource === target;
    } else {
      const tid = ownTaskId(target, c, ctx);
      if (tid) {
        out.kind = 'task';
        out.tasks = [{ ...taskView(c.tasks.get(tid), c), match: 'task' }];
        matchEvent = (e) => e.task === tid;
      } else {
        out.kind = 'path';
        let repoName = null;
        let rel = target;
        const abs = path.resolve(target);
        const loc = locateCwd(abs, c.projectsDir, c.registry, c.policy);
        if (loc.task) {
          const t = c.tasks.get(loc.task);
          out.tasks = t ? [{ ...taskView(t, c), match: 'worktree' }] : [];
          matchEvent = (e) => e.task === loc.task;
          rel = '';
        } else {
          const repo = c.registry.repos.find((r) => r.path && (abs === r.path || abs.startsWith(r.path + path.sep)));
          if (repo) {
            repoName = repo.name;
            rel = path.relative(repo.path, abs);
          } else {
            repoName = ctx.repo?.name ?? ctx.repo ?? locateCwd(process.cwd(), c.projectsDir, c.registry, c.policy).repo;
          }
          rel = rel.split(path.sep).join('/');
          const hits = Array.from(c.tasks.values()).filter(
            (t) => t.status !== 'done' && (!repoName || t.repo === repoName) && t.scope.some((g) => globToRegExp(g).test(rel))
          );
          out.tasks = hits.map((t) => ({ ...taskView(t, c), match: 'scope' }));
          matchEvent = (e) => asArray(e.refs).some((r) => r === rel || r === target) || e.data?.path === rel || e.data?.path === target;
        }
      }
    }
    out.recent_events = c.events
      .filter(matchEvent)
      .slice(-5)
      .reverse()
      .map((e) => ({ ts: e.ts, type: e.type, actor: e.actor?.id ?? null, task: e.task, summary: eventSummary(e) }));

    if (flags.json) {
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    const lines = [`maestro who ${target} (${out.kind})`];
    if (!out.tasks.length) lines.push('  no claim, scope or uses match');
    for (const t of out.tasks.slice(0, 12)) {
      lines.push(`  ${t.id} [${t.status}] owner=${t.owner ?? '-'}${t.claim?.stale ? ' STALE' : ''} match=${t.match}${t.uses.length ? ` uses=${t.uses.join(',')}` : ''}${t.scope.length ? ` scope=${t.scope.join(',')}` : ''}`);
    }
    if (out.recent_events.length) {
      lines.push('recent events');
      for (const e of out.recent_events) lines.push(`  ${e.ts} ${e.actor ?? '-'} ${e.task ?? '-'} ${e.summary}`);
    }
    console.log(lines.slice(0, 40).join('\n'));
    return 0;
  } catch (e) {
    console.error(`maestro: who failed: ${e.message}`);
    return 1;
  }
}
