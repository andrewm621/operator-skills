/* Tests for skills/maestro/events.mjs — run with:  node --test skills/maestro/test/
   Every test works in a scratch projects dir; nothing touches ~/Projects/.maestro. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync, symlinkSync, statSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendEvent,
  buildEvent,
  buildProjections,
  cmdEmit,
  cmdStatus,
  cmdWho,
  deriveA2aState,
  hookToEvents,
  locateCwd,
  loadPolicy,
  readEvents,
  sessionFileToken,
  usageFromTranscript,
} from '../events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_MJS = path.join(HERE, '..', 'events.mjs');
const NOW = Date.parse('2026-10-21T15:00:00Z');
const ago = (sec) => new Date(NOW - sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function taskFile(repoPath, id, slug, fm) {
  const lines = ['---', `id: ${id}`, `title: ${slug}`];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  lines.push('---', '', '## Goal', slug, '');
  put(path.join(repoPath, '.maestro', 'tasks', `${id}-${slug}.md`), lines.join('\n'));
}

function claim(repoPath, id, owner, heartbeatAgoSec) {
  put(
    path.join(repoPath, '.maestro', 'locks', `${id}.claim.json`),
    JSON.stringify({ task: id, owner, provider: 'claude', pid: 1, claimed_at: ago(heartbeatAgoSec + 60), heartbeat: ago(heartbeatAgoSec), ttl_seconds: 1800 })
  );
}

/* A small but realistic projects dir. */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestro-events-'));
  const alpha = path.join(root, 'alpha');
  const beta = path.join(root, 'beta app');
  const g = path.join(root, '.maestro');
  put(path.join(g, 'registry.yaml'), `repos:\n  - name: alpha\n    path: ${alpha}\n  - name: beta app\n    path: ${beta}\nid_prefix_from: name\n`);
  put(path.join(g, 'policy.yaml'), 'repos:\n  alpha: acme\n  "beta app": globex\nhard_terms:\n  - Acme Corp\n  - Zebra\n');
  taskFile(alpha, 'T-1', 'build-auth', { status: 'in-progress', owner: 'claude@mac', priority: 1, scope: ['src/auth/**'], uses: ['composio:acme'], depends_on: [], updated: '2026-10-21T14:50' });
  taskFile(alpha, 'T-2', 'wire-ui', { status: 'open', owner: 'null', priority: 2, depends_on: ['T-1'], updated: '2026-10-21T10:00' });
  taskFile(alpha, 'T-3', 'review-me', { status: 'review', priority: 2, depends_on: [], updated: '2026-10-18T10:00' });
  taskFile(beta, 'T-1', 'stuck-thing', { status: 'blocked', blocked_by: ['@andrew'], blocked_reason: 'need Zebra decision', depends_on: [], updated: '2026-10-20T10:00' });
  taskFile(beta, 'T-2', 'downstream-a', { status: 'open', depends_on: ['T-1'], updated: '2026-10-20T10:00' });
  taskFile(beta, 'T-3', 'downstream-b', { status: 'open', depends_on: ['T-2'], updated: '2026-10-20T10:00' });
  claim(alpha, 'T-1', 'claude@mac', 120);
  claim(beta, 'T-1', 'codex@mac', 10_800);
  const row = (repo, id, title, status, owner, extra = {}) => JSON.stringify({ id: `${repo}/${id}`, repo, title, status, owner, progress: '1/3', priority: 2, updated: '2026-10-21T14:00', needs_human: 0, ...extra });
  put(
    path.join(g, 'index.jsonl'),
    [
      row('alpha', 'T-1', 'build-auth', 'in-progress', 'claude@mac'),
      row('alpha', 'T-2', 'wire-ui', 'open', null),
      row('alpha', 'T-3', 'review-me', 'review', null, { updated: '2026-10-18T10:00' }),
      row('beta app', 'T-1', 'stuck-thing', 'blocked', 'codex@mac', { updated: '2026-10-20T10:00' }),
      row('beta app', 'T-2', 'downstream-a', 'open', null),
      row('beta app', 'T-3', 'downstream-b', 'open', null),
    ].join('\n') + '\n'
  );
  put(path.join(g, 'inbox.jsonl'), JSON.stringify({ mid: 'M-1-1', channel: 'beta app/T-1', author: 'codex@mac', target: '@andrew', text: 'Which Zebra option?', ts: ago(30 * 3600) }) + '\n');
  return root;
}

function emitAt(root, evt, secAgo = 0) {
  return appendEvent(evt, { projectsDir: root, now: new Date(NOW - secAgo * 1000) });
}

const hostId = `claude@${os.hostname().split('.')[0].toLowerCase()}`;

/* ---------------------------------------------------------------- appendEvent */

test('appendEvent writes one schema-complete line to the per-actor-session file', () => {
  const root = fixture();
  const ok = emitAt(root, { type: 'progress', task: 'alpha/T-1', client: 'acme', actor: { id: 'claude@mac', session: '7f3a9c1e', agent_id: 'ag1', provider: 'claude' }, refs: ['M-3-2'], data: { todos: '4/9', note: 'guard wired' } });
  assert.equal(ok, true);
  const dir = path.join(root, '.maestro', 'events', '2026-10-21');
  assert.deepEqual(readdirSync(dir), ['claude-mac-7f3a9c1e.jsonl']);
  const lines = readFileSync(path.join(dir, 'claude-mac-7f3a9c1e.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.v, 1);
  assert.match(e.id, /^[0-9A-Z]{26}$/);
  assert.equal(e.ts, '2026-10-21T15:00:00Z');
  assert.match(e.trace_id, /^[0-9a-f]{32}$/);
  assert.match(e.span_id, /^[0-9a-f]{16}$/);
  assert.equal(e.parent_span_id, null);
  assert.equal(e.a2a_state, 'working');
  assert.deepEqual(e.actor, { id: 'claude@mac', agent_id: 'ag1', session: '7f3a9c1e', provider: 'claude' });
  assert.equal(e.task, 'alpha/T-1');
  assert.deepEqual(e.refs, ['M-3-2']);
  assert.equal(e.data.todos, '4/9');
  rmSync(root, { recursive: true });
});

test('trace_id is stable per task and null without a task', () => {
  const a = buildEvent({ type: 'progress', task: 'alpha/T-1' });
  const b = buildEvent({ type: 'output', task: 'alpha/T-1' });
  const c = buildEvent({ type: 'progress' });
  assert.equal(a.trace_id, b.trace_id);
  assert.equal(c.trace_id, null);
});

test('appendEvent rejects unknown types and never throws', () => {
  const root = fixture();
  assert.equal(emitAt(root, { type: 'nonsense' }), false);
  assert.equal(emitAt(root, null), false);
  assert.equal(emitAt(root, 'str'), false);
  assert.equal(appendEvent({ type: 'progress' }, { projectsDir: '/dev/null/cannot/write' }), false);
  const circular = { type: 'progress', data: {} };
  circular.data.self = circular;
  assert.doesNotThrow(() => appendEvent(circular, { projectsDir: root }));
  rmSync(root, { recursive: true });
});

test('secret-shaped strings are redacted; ordinary slugs and short shas survive', () => {
  const secrets = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-1234567890-abcdefghij',
    'AKIA' + 'TEST'.repeat(4), // built at runtime so the fixture isn't a literal key
    'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'Fake' + 'Token' + '0123456789'.repeat(2) + 'ABCDEFGHxyz', // fake high-entropy run
  ];
  const e = buildEvent({ type: 'error', data: { class: 'tool', message: `leaked ${secrets.join(' | ')} end`, ref: 'sha:ab12cd3ef456', branch: 'maestro/T-14-autonomous-development-prompts-and-more' } });
  for (const s of secrets) assert.ok(!e.data.message.includes(s), `still contains ${s}`);
  assert.equal((e.data.message.match(/\[redacted\]/g) || []).length, secrets.length);
  assert.equal(e.data.ref, 'sha:ab12cd3ef456');
  assert.equal(e.data.branch, 'maestro/T-14-autonomous-development-prompts-and-more');
});

test('note and message truncate to 240 chars; an oversized event is shrunk under 4 KB', () => {
  const root = fixture();
  const long = 'x'.repeat(1000);
  const e = buildEvent({ type: 'progress', data: { note: long, message: long } });
  assert.equal(e.data.note.length, 240);
  assert.equal(e.data.message.length, 240);
  emitAt(root, { type: 'output', actor: 'claude@mac', session: 's1', data: { big: Array.from({ length: 80 }, (_, i) => `field-${i}-${'y'.repeat(60)}`) } });
  const file = path.join(root, '.maestro', 'events', '2026-10-21', 'claude-mac-s1.jsonl');
  const raw = readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(raw) <= 4000, `line is ${Buffer.byteLength(raw)} bytes`);
  rmSync(root, { recursive: true });
});

test('a2a_state mapping follows design section 3', () => {
  assert.equal(deriveA2aState('claim', { action: 'acquire' }), 'working');
  assert.equal(deriveA2aState('claim', { action: 'release' }), 'submitted');
  assert.equal(deriveA2aState('message', { kind: 'ask' }), 'input-required');
  assert.equal(deriveA2aState('error', { class: 'auth' }), 'auth-required');
  assert.equal(deriveA2aState('error', { class: 'crash' }), 'failed');
  assert.equal(deriveA2aState('approval', { decision: 'requested' }), 'input-required');
  assert.equal(deriveA2aState('approval', { decision: 'denied' }), 'rejected');
  assert.equal(deriveA2aState('state', { to: 'review' }), 'input-required');
  assert.equal(deriveA2aState('state', { to: 'done' }), 'completed');
  assert.equal(deriveA2aState('state', { to: 'in-progress' }), 'working');
  assert.equal(deriveA2aState('state', { to: 'open' }), 'submitted');
  assert.equal(deriveA2aState('receipt', { outcome: 'completed' }), 'completed');
});

test('concurrent appenders to one file never tear a line', () => {
  const root = fixture();
  const script = `import {appendEvent} from ${JSON.stringify(EVENTS_MJS)}; for (let i=0;i<40;i++) appendEvent({type:'heartbeat',actor:'claude@mac',session:'shared'},{projectsDir:${JSON.stringify(root)}});`;
  const procs = Array.from({ length: 4 }, () => spawnSync(process.execPath, ['--input-type=module', '-e', script]));
  for (const p of procs) assert.equal(p.status, 0);
  const lines = readFileSync(path.join(root, '.maestro', 'events', new Date().toISOString().slice(0, 10), 'claude-mac-shared.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 160);
  for (const l of lines) JSON.parse(l);
  rmSync(root, { recursive: true });
});

/* ---------------------------------------------------------------- locate + policy */

test('locateCwd binds worktree cwds to tasks and repo cwds to clients', () => {
  const root = fixture();
  const reg = { repos: [{ name: 'alpha', path: path.join(root, 'alpha') }, { name: 'beta app', path: path.join(root, 'beta app') }] };
  const policy = loadPolicy(root);
  assert.deepEqual(policy.repos, { alpha: 'acme', 'beta app': 'globex' });
  assert.deepEqual(policy.hard_terms, ['Acme Corp', 'Zebra']);
  const wt = locateCwd(path.join(root, '.maestro', 'worktrees', 'beta-app', 'T-1', 'src'), root, reg, policy);
  assert.equal(wt.task, 'beta app/T-1');
  assert.equal(wt.client, 'globex');
  const plain = locateCwd(path.join(root, 'alpha', 'src'), root, reg, policy);
  assert.equal(plain.task, null);
  assert.equal(plain.repo, 'alpha');
  assert.equal(plain.client, 'acme');
  assert.deepEqual(locateCwd('/somewhere/else', root, reg, policy), { repo: null, task: null, client: null, worktree: null });
  rmSync(root, { recursive: true });
});

/* ---------------------------------------------------------------- hook mapping */

test('hookToEvents maps each supported hook event', () => {
  const root = fixture();
  const wt = path.join(root, '.maestro', 'worktrees', 'alpha', 'T-1');
  const base = { session_id: '7f3a9c1e-aaaa-bbbb-cccc-1234567890ab', cwd: wt, transcript_path: '/nonexistent.jsonl' };
  const map = (extra) => hookToEvents({ ...base, ...extra }, { projectsDir: root, host: 'mac' });

  const [start] = map({ hook_event_name: 'SessionStart', source: 'resume' });
  assert.equal(start.type, 'claim');
  assert.equal(start.task, 'alpha/T-1');
  assert.equal(start.client, 'acme');
  assert.equal(start.data.action, 'resume');
  assert.equal(start.actor.session, '7f3a9c1e');
  assert.equal(start.actor.id, 'claude@mac');

  const [fresh] = hookToEvents({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'abcdef12-0000', cwd: '/tmp' }, { projectsDir: root, host: 'mac' });
  assert.equal(fresh.task, null);
  assert.equal(fresh.data.untasked, true);
  assert.equal(fresh.data.action, 'acquire');

  const [stop] = map({ hook_event_name: 'Stop' });
  assert.equal(stop.type, 'receipt');
  assert.equal(stop.data.usage, null);

  const [sa] = map({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'Explore' });
  assert.equal(sa.type, 'claim');
  assert.equal(sa.actor.agent_id, 'agent-1');
  assert.ok(sa.parent_span_id);
  const [sz] = map({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'Explore' });
  assert.equal(sz.type, 'output');
  assert.equal(sz.span_id, sa.span_id);
  assert.equal(sz.parent_span_id, sa.parent_span_id);

  const [tc] = map({ hook_event_name: 'TaskCompleted', task_id: 't1', task_subject: 'Implement guard' });
  assert.equal(tc.type, 'progress');
  assert.equal(tc.data.note, 'Implement guard');

  const [perm] = map({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal(perm.type, 'approval');
  assert.equal(perm.data.decision, 'requested');
  assert.equal(map({ hook_event_name: 'PreToolUse', tool_name: 'Edit' })[0].type, 'approval');

  const [pr] = map({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, tool_response: { stdout: 'https://github.com/acme/app/pull/42\n' } });
  assert.equal(pr.type, 'output');
  assert.equal(pr.data.kind, 'pr');
  assert.equal(pr.data.ref, 'https://github.com/acme/app/pull/42');
  assert.equal(map({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })[0].type, 'heartbeat');

  const [end] = map({ hook_event_name: 'SessionEnd', reason: 'other' });
  assert.equal(end.type, 'state');
  assert.equal(end.data.to, 'ended');
  const [fail] = map({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429' });
  assert.equal(fail.type, 'error');
  assert.equal(fail.data.class, 'ratelimit');

  assert.deepEqual(map({ hook_event_name: 'SomethingNew' }), []);
  assert.deepEqual(hookToEvents(null, {}), []);
  rmSync(root, { recursive: true });
});

test('git commit PostToolUse records a short sha from the cwd repo', () => {
  const root = fixture();
  const repo = path.join(root, 'alpha');
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'x');
  const [e] = hookToEvents({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo, session_id: 's1234567-x' }, { projectsDir: root, host: 'mac' });
  assert.equal(e.data.kind, 'commit');
  assert.match(e.data.ref, /^sha:[0-9a-f]{12}$/);
  assert.equal(e.refs[0], e.data.ref);
  rmSync(root, { recursive: true });
});

test('usageFromTranscript sums tokens once per API message (de-duplicated by message.id)', () => {
  const root = fixture();
  const rec = (id, i, o, cr, cc, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc } } });
  const file = path.join(root, 't.jsonl');
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'user', timestamp: '2026-10-21T14:00:00.000Z' }),
      rec('m1', 2, 100, 1000, 50, '2026-10-21T14:00:10.000Z'),
      rec('m1', 2, 100, 1000, 50, '2026-10-21T14:00:12.000Z'), // second content block of the same API message
      rec('m2', 3, 40, 2000, 0, '2026-10-21T14:01:00.000Z'),
      'not json',
    ].join('\n')
  );
  const u = usageFromTranscript(file);
  assert.deepEqual(u, { tokens_in: 2 + 1000 + 50 + 3 + 2000, tokens_out: 140, tokens_cache_read: 3000, cost_usd: null, duration_sec: 60, active_sec: 10 + 2 + 48 });
  assert.equal(usageFromTranscript(path.join(root, 'missing.jsonl')), null);
  rmSync(root, { recursive: true });
});

/* ---------------------------------------------------------------- cmdEmit */

test('cmdEmit manual form appends an event with k=v data and exits 0', async () => {
  const root = fixture();
  const code = await cmdEmit(['progress', '--task', 'alpha/T-1', 'todos=4/9', 'note=guard wired', 'usage.tokens_in=12', 'client=acme'], { projectsDir: root, actor: 'codex@mac', session: 'c0dex001' });
  assert.equal(code, 0);
  const [e] = readEvents(root, { now: Date.now() });
  assert.equal(e.type, 'progress');
  assert.equal(e.task, 'alpha/T-1');
  assert.equal(e.client, 'acme');
  assert.equal(e.actor.provider, 'codex');
  assert.equal(e.data.todos, '4/9');
  assert.equal(e.data.usage.tokens_in, 12);
  assert.equal(await cmdEmit(['bogus-type'], { projectsDir: root }), 0);
  rmSync(root, { recursive: true });
});

test('cmdEmit --from-hook reads the payload on stdin (end to end)', () => {
  const root = fixture();
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'abcdef12-1111', cwd: path.join(root, '.maestro', 'worktrees', 'alpha', 'T-2') });
  const script = `import {cmdEmit} from ${JSON.stringify(EVENTS_MJS)}; process.exitCode = await cmdEmit(['--from-hook'], {projectsDir:${JSON.stringify(root)}, host:'mac'});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: payload, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const evts = readEvents(root, { now: Date.now() });
  assert.equal(evts.length, 1);
  assert.equal(evts[0].task, 'alpha/T-2');
  assert.equal(evts[0].data.action, 'acquire');
  rmSync(root, { recursive: true });
});

test('cmdEmit --from-hook with garbage stdin is a silent no-op', () => {
  const root = fixture();
  const script = `import {cmdEmit} from ${JSON.stringify(EVENTS_MJS)}; process.exitCode = await cmdEmit(['--from-hook'], {projectsDir:${JSON.stringify(root)}});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: '{{{{', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
  assert.deepEqual(readEvents(root, { now: Date.now() }), []);
  rmSync(root, { recursive: true });
});

/* ---------------------------------------------------------------- projections */

function seedEvents(root) {
  // live task-bound session
  emitAt(root, { type: 'claim', task: 'alpha/T-1', client: 'acme', actor: { id: 'claude@mac', session: 'live0001', provider: 'claude' }, data: { action: 'acquire' } }, 3600);
  emitAt(root, { type: 'progress', task: 'alpha/T-1', client: 'acme', actor: { id: 'claude@mac', session: 'live0001', provider: 'claude' }, data: { note: 'working', via: 'hook' } }, 60);
  // idle untasked session
  emitAt(root, { type: 'claim', actor: { id: 'claude@mac', session: 'free0002', provider: 'claude' }, data: { action: 'acquire', untasked: true } }, 900);
  // stale session (task-bound, old)
  emitAt(root, { type: 'progress', task: 'beta app/T-1', client: 'globex', actor: { id: 'codex@mac', session: 'old00003', provider: 'codex' }, data: {} }, 4 * 3600);
  // ended session: excluded
  emitAt(root, { type: 'state', task: 'alpha/T-3', actor: { id: 'claude@mac', session: 'end00004', provider: 'claude' }, data: { to: 'ended' } }, 100);
  // crashed
  emitAt(root, { type: 'error', task: 'alpha/T-2', actor: { id: 'claude@mac', session: 'crash005', provider: 'claude' }, data: { class: 'crash', message: 'boom' } }, 200);
  // 3 test errors within the hour + 1 steal
  for (let i = 0; i < 3; i++) emitAt(root, { type: 'error', task: 'beta app/T-1', actor: { id: 'codex@mac', session: 'err00007', provider: 'codex' }, data: { class: 'test', message: 'fail' } }, 600 + i);
  emitAt(root, { type: 'claim', task: 'beta app/T-1', actor: { id: 'claude@mac', session: 'thief008', provider: 'claude' }, data: { action: 'steal', prev_owner: 'codex@mac' } }, 500);
  // pending permission request
  emitAt(root, { type: 'approval', task: 'alpha/T-1', client: 'acme', actor: { id: 'claude@mac', session: 'perm0006', provider: 'claude' }, data: { action_type: 'Bash', decision: 'requested' } }, 120);
}

test('buildProjections: fleet states', () => {
  const root = fixture();
  seedEvents(root);
  const p = buildProjections(root, { now: NOW, handle: 'andrew' });
  const bySession = Object.fromEntries(p.fleet.actors.filter((a) => a.session).map((a) => [a.session, a]));
  assert.equal(bySession.live0001.state, 'live');
  assert.equal(bySession.live0001.client, 'acme');
  assert.equal(bySession.free0002.state, 'untasked');
  assert.equal(bySession.old00003.state, 'stale');
  assert.equal(bySession.crash005.state, 'crashed');
  assert.equal(bySession.end00004, undefined);
  assert.equal(p.fleet.ended, 1);
  assert.equal(bySession.perm0006.state, 'live');
  assert.equal(bySession.err00007.errors_1h, 3);
  // alpha/T-1 has a claim AND a session -> no duplicate claim-only card; beta T-1's claim is covered by old00003
  assert.ok(!p.fleet.actors.some((a) => a.source === 'claim'));
  rmSync(root, { recursive: true });
});

test('buildProjections: claude agents data adds unseen sessions and flags silent / vanished ones', () => {
  const root = fixture();
  seedEvents(root);
  const claudeAgents = [
    { kind: 'interactive', pid: 1, sessionId: 'noevents-1111-2222', cwd: '/elsewhere', status: 'idle', name: 'ad hoc' },
    { kind: 'interactive', pid: 2, sessionId: 'old00003-1111', cwd: path.join(root, 'beta app'), status: 'busy', name: 'busy one' },
    { kind: 'interactive', pid: 3, sessionId: 'free0002-9999', cwd: '/x', status: 'idle' },
  ];
  const p = buildProjections(root, { now: NOW, claudeAgents });
  const by = Object.fromEntries(p.fleet.actors.filter((a) => a.session).map((a) => [a.session, a]));
  assert.equal(by.noevents.state, 'untasked');
  assert.equal(by.noevents.source, 'claude-agents');
  assert.equal(by.old00003.state, 'silent'); // listed busy, no events for 4h
  assert.equal(by.live0001.state, 'live'); // recent events win over "not listed" (age < 10m)
  assert.equal(p.fleet.agents_cli, true);
  const vanished = buildProjections(root, { now: NOW + 20 * 60_000, claudeAgents: [] });
  assert.equal(vanished.fleet.actors.find((a) => a.session === 'live0001').state, 'crashed');
  rmSync(root, { recursive: true });
});

test('buildProjections: needs-you is oldest first and covers asks, review, blocked_by, approvals', () => {
  const root = fixture();
  seedEvents(root);
  put(
    path.join(root, '.maestro', 'events', '_system', 'reaper.jsonl'),
    [JSON.stringify({ ts: ago(5000), host: 'mac', ok: true, released: [], needs_you: [{ id: 'alpha/T-2', worktree: root, branch: 'maestro/T-2-x', reason: 'dirty worktree' }] })].join('\n') + '\n'
  );
  const p = buildProjections(root, { now: NOW, handle: 'andrew' });
  const kinds = p.needs_you.map((i) => i.kind);
  assert.deepEqual(kinds.slice().sort(), ['abandoned', 'approval', 'ask', 'blocked', 'review']);
  for (let i = 1; i < p.needs_you.length; i++) assert.ok(p.needs_you[i - 1].age_sec >= p.needs_you[i].age_sec, 'not oldest first');
  const ask = p.needs_you.find((i) => i.kind === 'ask');
  assert.equal(ask.severity, 'red'); // > 24h
  assert.equal(ask.client, 'globex');
  assert.equal(p.needs_you.find((i) => i.kind === 'review').severity, 'amber'); // > 2d
  rmSync(root, { recursive: true });
});

test('buildProjections: bottlenecks', () => {
  const root = fixture();
  seedEvents(root);
  const p = buildProjections(root, { now: NOW });
  const b = p.bottlenecks;
  assert.deepEqual(b.stale_claims.map((c) => c.task), ['beta app/T-1']);
  assert.equal(b.error_clusters.length, 1);
  assert.equal(b.error_clusters[0].class, 'test');
  assert.equal(b.error_clusters[0].count, 3);
  assert.equal(b.steals.length, 1);
  assert.equal(b.steals[0].task, 'beta app/T-1');
  assert.equal(b.steals[0].from, 'codex@mac'); // P1a sends data.prev_owner
  assert.equal(b.stalled_tasks[0].task, 'beta app/T-1');
  assert.equal(b.stalled_tasks[0].dependents, 2); // T-2 and (transitively) T-3
  rmSync(root, { recursive: true });
});

test('buildProjections: health ages and red threshold', () => {
  const root = fixture();
  const idx = path.join(root, '.maestro', 'index.jsonl');
  utimesSync(idx, new Date(NOW - 20 * 60_000), new Date(NOW - 20 * 60_000));
  put(path.join(root, '.maestro', 'events', '_system', 'reaper.jsonl'), JSON.stringify({ ts: ago(120), ok: true }) + '\n');
  const h = buildProjections(root, { now: NOW }).health;
  assert.equal(h.last_sync.red, true);
  assert.equal(h.last_sync.age_sec, 1200);
  assert.equal(h.last_reaper.red, false);
  assert.equal(h.last_reaper.age_sec, 120);
  const bare = mkdtempSync(path.join(os.tmpdir(), 'maestro-empty-'));
  const hb = buildProjections(bare, { now: NOW }).health;
  assert.equal(hb.last_sync.red, true);
  assert.equal(hb.last_sync.ts, null);
  assert.equal(hb.last_reaper.ts, null);
  assert.deepEqual(buildProjections(bare, { now: NOW }).fleet.actors, []);
  rmSync(root, { recursive: true });
  rmSync(bare, { recursive: true });
});

/* ---------------------------------------------------------------- status / who */

async function capture(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: logs.join('\n') };
  } finally {
    console.log = orig;
  }
}

test('cmdStatus --task --json returns the D2 fields', async () => {
  const root = fixture();
  seedEvents(root);
  const { code, out } = await capture(() => cmdStatus(['--task', 'alpha/T-2', '--json'], { projectsDir: root, handle: 'andrew' }));
  assert.equal(code, 0);
  const j = JSON.parse(out);
  const t = j.tasks[0];
  assert.equal(t.id, 'alpha/T-2');
  assert.equal(t.status, 'open');
  assert.equal(t.ready, false);
  assert.deepEqual(t.waiting_on, ['alpha/T-1']);
  assert.ok('owner' in t && 'progress' in t && 'last_event' in t && 'open_asks' in t && 'uses' in t);
  const one = await capture(() => cmdStatus(['--task', 'alpha/T-1', '--json'], { projectsDir: root }));
  const t1 = JSON.parse(one.out).tasks[0];
  assert.deepEqual(t1.uses, ['composio:acme']);
  assert.equal(t1.last_event.type, 'progress');
  rmSync(root, { recursive: true });
});

test('cmdStatus human output is <= 40 lines and scopes to the caller client by default', async () => {
  const root = fixture();
  seedEvents(root);
  const { out } = await capture(() => cmdStatus(['--client', 'acme'], { projectsDir: root }));
  assert.ok(out.split('\n').length <= 40);
  assert.match(out, /client=acme/);
  assert.match(out, /alpha\/T-1/);
  assert.doesNotMatch(out, /beta app\/T-1/);
  const all = await capture(() => cmdStatus(['--all'], { projectsDir: root }));
  assert.match(all.out, /beta app\/T-1/);
  const scoped = await capture(() => cmdStatus([], { projectsDir: root, repo: 'beta app' }));
  assert.match(scoped.out, /client=globex/);
  assert.doesNotMatch(scoped.out, /alpha\/T-1/);
  rmSync(root, { recursive: true });
});

test('cmdWho resolves a task, a scope path, and a resource', async () => {
  const root = fixture();
  seedEvents(root);
  const t = JSON.parse((await capture(() => cmdWho(['alpha/T-1', '--json'], { projectsDir: root }))).out);
  assert.equal(t.kind, 'task');
  assert.equal(t.tasks[0].owner, 'claude@mac');

  const p = JSON.parse((await capture(() => cmdWho([path.join(root, 'alpha', 'src', 'auth', 'guard.ts'), '--json'], { projectsDir: root }))).out);
  assert.equal(p.kind, 'path');
  assert.deepEqual(p.tasks.map((x) => x.id), ['alpha/T-1']);
  assert.equal(p.tasks[0].match, 'scope');

  const miss = JSON.parse((await capture(() => cmdWho([path.join(root, 'alpha', 'docs', 'readme.md'), '--json'], { projectsDir: root }))).out);
  assert.deepEqual(miss.tasks, []);

  const r = JSON.parse((await capture(() => cmdWho(['composio:acme', '--json'], { projectsDir: root }))).out);
  assert.equal(r.kind, 'resource');
  assert.deepEqual(r.tasks.map((x) => x.id), ['alpha/T-1']);

  const human = (await capture(() => cmdWho(['composio:acme'], { projectsDir: root }))).out;
  assert.match(human, /alpha\/T-1/);
  assert.equal((await capture(() => cmdWho([], { projectsDir: root }))).code, 1);
  rmSync(root, { recursive: true });
});

test('heartbeat throttle stamp: private dir, one heartbeat per window, refreshed not truncated', async () => {
  const root = fixture();
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'beefcafe-0001', cwd: '/tmp' });
  const run = () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `import {cmdEmit} from ${JSON.stringify(EVENTS_MJS)}; process.exitCode = await cmdEmit(['--from-hook'], {projectsDir:${JSON.stringify(root)}, host:'mac'});`], { input: payload, encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(run().status, 0);
  assert.equal(readEvents(root, { now: Date.now() }).filter((e) => e.type === 'heartbeat').length, 1);
  const dir = path.join(root, '.maestro', 'run');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const stamp = path.join(dir, 'hb-beefcafe');
  assert.equal(statSync(stamp).mode & 0o777, 0o600);
  // age the stamp past the window: the next emit refreshes it and heartbeats again
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(stamp, old, old);
  run();
  assert.equal(readEvents(root, { now: Date.now() }).filter((e) => e.type === 'heartbeat').length, 2);
  assert.ok(Date.now() - statSync(stamp).mtimeMs < 60_000);
  rmSync(root, { recursive: true });
});

test('heartbeat throttle stamp: a planted symlink is refused and its target is not truncated', () => {
  const root = fixture();
  const victim = path.join(root, 'victim.txt');
  writeFileSync(victim, 'precious data');
  const dir = path.join(root, '.maestro', 'run');
  mkdirSync(dir, { recursive: true });
  symlinkSync(victim, path.join(dir, 'hb-beefcafe'));
  // an aged-out target must not even have its mtime refreshed through the link
  const old = new Date(Date.now() - 3600_000);
  utimesSync(victim, old, old);
  const payload = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'beefcafe-0001', cwd: '/tmp' });
  const script = `import {cmdEmit} from ${JSON.stringify(EVENTS_MJS)}; process.exitCode = await cmdEmit(['--from-hook'], {projectsDir:${JSON.stringify(root)}, host:'mac'});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: payload, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'precious data');
  assert.ok(Math.abs(statSync(victim).mtimeMs - old.getTime()) < 2000, 'target mtime was touched through the symlink');
  assert.ok(lstatSync(path.join(dir, 'hb-beefcafe')).isSymbolicLink());
  assert.equal(readEvents(root, { now: Date.now() }).filter((e) => e.type === 'heartbeat').length, 0);

  // a dangling link must not be created through, either
  const ghost = path.join(root, 'ghost.txt');
  symlinkSync(ghost, path.join(dir, 'hb-deadbeef'));
  spawnSync(process.execPath, ['--input-type=module', '-e', script], { input: payload.replace('beefcafe', 'deadbeef'), encoding: 'utf8' });
  assert.throws(() => statSync(ghost));
  rmSync(root, { recursive: true });
});

test('loadPolicy: absent file is fine, a malformed or unreadable file reports an error', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestro-policy-'));
  const file = path.join(root, '.maestro', 'policy.yaml');
  assert.equal(loadPolicy(root).error, null); // absent: legitimately no terms
  assert.deepEqual(loadPolicy(root).hard_terms, []);
  put(file, 'repos:\n  alpha: acme\nhard_terms:\n  - Zebra\n');
  assert.equal(loadPolicy(root).error, null);
  put(file, 'hard_terms: [Zebra, Acme\n');
  assert.match(loadPolicy(root).error, /unterminated/);
  put(file, 'repos:\n  alpha acme\n');
  assert.match(loadPolicy(root).error, /line 2/);
  put(file, 'hard_terms:\n  Zebra\n');
  assert.match(loadPolicy(root).error, /line 2/);
  put(file, 'this is not yaml\n');
  assert.match(loadPolicy(root).error, /line 1/);
  rmSync(file);
  mkdirSync(file); // a directory where the file should be: exists but unreadable
  assert.match(loadPolicy(root).error, /cannot be read/);
  rmSync(root, { recursive: true });
});

/* ---------------------------------------------------------------- review fixes */

test('sessionFileToken: a full session UUID and a hook session_id land in the same file', () => {
  const root = fixture();
  const uuid = '7F3A9C1E-AAAA-4BBB-8CCC-1234567890AB';
  assert.equal(sessionFileToken(uuid), '7f3a9c1e');
  assert.equal(sessionFileToken(null), null);
  // P1a path: a claim event carrying the full UUID (MAESTRO_SESSION / CLAUDE_CODE_SESSION_ID)
  appendEvent({ type: 'claim', actor: { id: 'claude@mac', session: uuid }, data: { action: 'acquire' } }, { projectsDir: root, now: new Date(NOW) });
  // hook path: the same session as the hook payload reports it
  const [hookEvt] = hookToEvents({ hook_event_name: 'Stop', session_id: uuid.toLowerCase(), cwd: '/tmp' }, { projectsDir: root, host: 'mac' });
  appendEvent(hookEvt, { projectsDir: root, now: new Date(NOW) });
  const dir = path.join(root, '.maestro', 'events', '2026-10-21');
  assert.deepEqual(readdirSync(dir), [`claude-mac-${sessionFileToken(uuid)}.jsonl`]);
  assert.equal(readEvents(root, { now: NOW }).length, 2);
  rmSync(root, { recursive: true });
});

test('hook-sourced events are tagged data.via = hook', () => {
  const evts = hookToEvents({ hook_event_name: 'SessionStart', session_id: 'abcdef12-0', cwd: '/tmp' }, { host: 'mac' });
  assert.equal(evts[0].data.via, 'hook');
  assert.equal(hookToEvents({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'x', cwd: '/tmp' }, {})[0].data.via, 'hook');
});

test('fleet: only hook-reported claude sessions can be "crashed" for vanishing; reaper is not a fleet member', () => {
  const root = fixture();
  const task = 'alpha/T-1';
  const old = 20 * 60; // 20 minutes: past the live window
  emitAt(root, { type: 'progress', task, actor: { id: 'claude@mac', session: 'hook0001', provider: 'claude' }, data: { via: 'hook' } }, old);
  emitAt(root, { type: 'progress', task, actor: { id: 'you@cli', session: 'cli00002', provider: 'claude' }, data: {} }, old);
  emitAt(root, { type: 'progress', task, actor: { id: 'codex@mac', session: 'cdx00003', provider: 'codex' }, data: { via: 'hook' } }, old);
  emitAt(root, { type: 'progress', task, actor: { id: 'cursor@route', session: 'cur00004', provider: 'cursor' }, data: {} }, old);
  emitAt(root, { type: 'heartbeat', actor: { id: 'reaper@mac', session: 'rea00005', provider: 'unknown' }, data: {} }, 30);
  const p = buildProjections(root, { now: NOW, claudeAgents: [] });
  const by = Object.fromEntries(p.fleet.actors.filter((a) => a.session).map((a) => [a.session, a]));
  assert.equal(by.hook0001.state, 'crashed');
  for (const s of ['cli00002', 'cdx00003', 'cur00004']) assert.notEqual(by[s].state, 'crashed', s);
  assert.equal(by.rea00005, undefined);
  rmSync(root, { recursive: true });
});

test('needs-you abandoned: only the last reaper snapshot counts, task = needs_you[].id', () => {
  const root = fixture();
  const file = path.join(root, '.maestro', 'events', '_system', 'reaper.jsonl');
  const snap = (agoSec, needs) => JSON.stringify({ ts: ago(agoSec), host: 'mac', ok: true, released: [], needs_you: needs });
  put(file, [snap(900, [{ id: 'alpha/T-2', worktree: root, branch: 'b', reason: 'dirty' }, { id: 'beta app/T-2', worktree: root, branch: 'b2', reason: 'unpushed' }]), snap(300, [{ id: 'alpha/T-2', worktree: root, branch: 'b', reason: 'dirty' }])].join('\n') + '\n');
  let ab = buildProjections(root, { now: NOW, handle: 'andrew' }).needs_you.filter((i) => i.kind === 'abandoned');
  assert.deepEqual(ab.map((i) => i.task), ['alpha/T-2']);
  assert.equal(ab[0].text, 'dirty');
  put(file, [snap(900, [{ id: 'alpha/T-2', worktree: root, reason: 'dirty' }]), snap(300, [])].join('\n') + '\n');
  ab = buildProjections(root, { now: NOW, handle: 'andrew' }).needs_you.filter((i) => i.kind === 'abandoned');
  assert.deepEqual(ab, []); // the latest run cleared it
  rmSync(root, { recursive: true });
});

test('loadPolicy accepts dashes in keys, "- repo: client" items and client-grouped lists', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestro-policy-'));
  const file = path.join(root, '.maestro', 'policy.yaml');
  put(file, 'repos:\n  - alpha: acme\n  - "beta app": globex\n  rebel:\n    - agencyos\n    - rebelcal\n  plain-repo: initech\nhard-terms-x: 1\nhard_terms:\n  - Zebra\n');
  const p = loadPolicy(root);
  assert.equal(p.error, null);
  assert.deepEqual(p.repos, { alpha: 'acme', 'beta app': 'globex', agencyos: 'rebel', rebelcal: 'rebel', 'plain-repo': 'initech' });
  assert.deepEqual(p.hard_terms, ['Zebra']);
  rmSync(root, { recursive: true });
});

test('locateCwd: symlinked registry path, and a parent folder of exactly one repo', () => {
  const root = fixture();
  const real = path.join(root, 'vault-real');
  mkdirSync(path.join(real, 'notes'), { recursive: true });
  symlinkSync(real, path.join(root, 'vault-link'));
  mkdirSync(path.join(root, 'studio', 'alpha', 'app'), { recursive: true });
  mkdirSync(path.join(root, 'studio', 'widgets', 'app'), { recursive: true });
  const reg = {
    repos: [
      { name: 'knowledge', path: path.join(root, 'vault-link') },
      { name: 'alpha', path: path.join(root, 'studio', 'alpha', 'app') },
      { name: 'widgets', path: path.join(root, 'studio', 'widgets', 'app') },
      { name: 'alpha', path: path.join(root, 'alpha') },
    ],
  };
  const policy = loadPolicy(root);
  // registered through a symlink, session reports the real path
  assert.equal(locateCwd(path.join(real, 'notes'), root, reg, policy).repo, 'knowledge');
  // and the other way round still works
  assert.equal(locateCwd(path.join(root, 'vault-link', 'notes'), root, reg, policy).repo, 'knowledge');
  // parent of exactly one repo binds to it
  assert.equal(locateCwd(path.join(root, 'studio', 'alpha'), root, reg, policy).repo, 'alpha');
  // parent of two repos is ambiguous; the projects root never binds
  assert.equal(locateCwd(path.join(root, 'studio'), root, reg, policy).repo, null);
  assert.equal(locateCwd(root, root, reg, policy).repo, null);
  rmSync(root, { recursive: true });
});

test('fleet: one row per session across a host rename and a human verb', () => {
  const root = fixture();
  const task = 'alpha/T-1';
  emitAt(root, { type: 'progress', task, actor: { id: 'claude@mac-1224', session: 'sess0001', provider: 'claude' }, data: { via: 'hook' } }, 600);
  emitAt(root, { type: 'progress', task, actor: { id: 'claude@andrews-macbook-air', session: 'sess0001', provider: 'claude' }, data: { via: 'hook' } }, 60);
  emitAt(root, { type: 'message', task, actor: { id: 'andrew', session: 'sess0001', provider: 'unknown' }, data: {} }, 30);
  const p = buildProjections(root, { now: NOW });
  const rows = p.fleet.actors.filter((a) => a.session === 'sess0001');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor.id, 'claude@andrews-macbook-air');
  assert.equal(rows[0].repo, 'alpha');
  rmSync(root, { recursive: true });
});

test('hostShort honours MAESTRO_HOST (agents-only fleet card)', () => {
  const root = fixture();
  const script = `import { buildProjections } from ${JSON.stringify(EVENTS_MJS)};
const p = buildProjections(${JSON.stringify(root)}, { now: ${NOW}, claudeAgents: [{ sessionId: 'abcd1234-0000-0000-0000-000000000000', cwd: '/nowhere', status: 'idle', name: 'x' }] });
process.stdout.write(p.fleet.actors.find((a) => a.source === 'claude-agents').actor.id);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, MAESTRO_HOST: 'Pinned.Host.local' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'claude@pinned');
  rmSync(root, { recursive: true });
});
