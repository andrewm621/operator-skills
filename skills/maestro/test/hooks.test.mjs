/* Tests for hooks/maestro-emit.sh and hooks/install.sh — run with:
   node --test skills/maestro/test/hooks.test.mjs
   Uses a scratch projects dir, a scratch TMPDIR and a scratch settings file only. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, statSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../events.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'hooks', 'maestro-emit.sh');
const INSTALL = path.join(HERE, '..', 'hooks', 'install.sh');
const MAESTRO_DIR = path.join(HERE, '..');
const SHIM = path.join(HERE, 'fixtures', 'maestro-shim.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'maestro-hook-'));
  mkdirSync(path.join(root, 'tmp'));
  mkdirSync(path.join(root, '.maestro'));
  return root;
}

function runHook(root, payload, extraEnv = {}) {
  const t = Date.now();
  const r = spawnSync('sh', [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, MAESTRO_MJS: SHIM, MAESTRO_PROJECTS: root, TMPDIR: path.join(root, 'tmp'), ...extraEnv },
  });
  return { ...r, ms: Date.now() - t };
}

async function waitForEvents(root, n, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const evts = readEvents(root, { now: Date.now() });
    if (evts.length >= n) return evts;
    await sleep(50);
  }
  return readEvents(root, { now: Date.now() });
}

test('hook script: exits 0 fast, prints nothing, and the event lands in the background', async () => {
  const root = scratch();
  const r = runHook(root, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'deadbeef-0000', cwd: '/tmp' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.ok(r.ms < 300, `hook took ${r.ms}ms`);
  console.log(`# hook wall time: ${r.ms}ms`);
  const evts = await waitForEvents(root, 1);
  assert.equal(evts.length, 1);
  assert.equal(evts[0].type, 'claim');
  assert.equal(evts[0].actor.session, 'deadbeef');
  rmSync(root, { recursive: true });
});

test('hook script: fail-open on empty input, garbage, missing node and missing maestro.mjs', () => {
  const root = scratch();
  for (const [payload, env] of [
    ['', {}],
    ['not json at all', {}],
    [{ hook_event_name: 'Stop', session_id: 'x' }, { MAESTRO_NODE: '/nonexistent/node' }],
    [{ hook_event_name: 'Stop', session_id: 'x' }, { MAESTRO_MJS: '/nonexistent/maestro.mjs', HOME: root }],
  ]) {
    const r = runHook(root, payload, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
  rmSync(root, { recursive: true });
});

test('hook script: ordinary PostToolUse calls are throttled to one heartbeat per session', async () => {
  const root = scratch();
  const post = (cmd) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 'feedface-1111', cwd: '/tmp' });
  for (let i = 0; i < 4; i++) assert.equal(runHook(root, post(`ls ${i}`)).status, 0);
  await sleep(600);
  const beats = (await waitForEvents(root, 1)).filter((e) => e.type === 'heartbeat');
  assert.equal(beats.length, 1);
  // a commit is never throttled
  runHook(root, post('git commit -m "x"'));
  const all = await waitForEvents(root, 2);
  assert.ok(all.some((e) => e.type === 'output' && e.data.kind === 'commit'));
  rmSync(root, { recursive: true });
});

test('install.sh prints a valid hooks block without touching anything', () => {
  const root = scratch();
  const settings = path.join(root, 'settings.json');
  const r = spawnSync('sh', [INSTALL, '--settings', settings], { encoding: 'utf8', env: { ...process.env, MAESTRO_HOME: MAESTRO_DIR } });
  assert.equal(r.status, 0);
  const block = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(block.hooks).sort(), [
    'PermissionRequest', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'TaskCompleted', 'TaskCreated',
  ]);
  assert.equal(block.hooks.PostToolUse[0].matcher, 'Bash');
  assert.ok(block.hooks.Stop[0].hooks[0].command.endsWith('hooks/maestro-emit.sh'));
  assert.equal(existsSync(settings), false);
  rmSync(root, { recursive: true });
});

test('install.sh --apply merges only the hooks key, backs up first, and is idempotent', () => {
  const root = scratch();
  const settings = path.join(root, 'settings.json');
  const original = { model: 'opus', env: { TOKEN: 'keep-me' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: '/other/hook.sh' }] }], Notification: [{ hooks: [{ type: 'command', command: '/n.sh' }] }] } };
  writeFileSync(settings, `${JSON.stringify(original, null, 4)}\n`);
  for (let i = 0; i < 2; i++) {
    const r = spawnSync('sh', [INSTALL, '--apply', '--settings', settings], { encoding: 'utf8', env: { ...process.env, MAESTRO_HOME: MAESTRO_DIR } });
    assert.equal(r.status, 0, r.stderr);
  }
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.env, { TOKEN: 'keep-me' });
  assert.deepEqual(after.hooks.Notification, original.hooks.Notification);
  assert.equal(after.hooks.Stop.length, 2); // theirs + exactly one of ours, even after two applies
  assert.equal(after.hooks.Stop[0].hooks[0].command, '/other/hook.sh');
  assert.ok(after.hooks.Stop[1].hooks[0].command.endsWith('maestro-emit.sh'));
  assert.ok(readdirSync(root).some((f) => f.startsWith('settings.json.bak-maestro-')));
  assert.match(readFileSync(settings, 'utf8'), /^\{\n {4}"model"/); // indentation preserved
  rmSync(root, { recursive: true });
});

test('install.sh --apply refuses to touch a settings file that is not valid JSON', () => {
  const root = scratch();
  const settings = path.join(root, 'settings.json');
  writeFileSync(settings, '{ nope');
  const r = spawnSync('sh', [INSTALL, '--apply', '--settings', settings], { encoding: 'utf8', env: { ...process.env, MAESTRO_HOME: MAESTRO_DIR } });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(settings, 'utf8'), '{ nope');
  rmSync(root, { recursive: true });
});

test('hook script: a symlink planted at the throttle stamp is never written through', async () => {
  const root = scratch();
  const victim = path.join(root, 'victim.txt');
  writeFileSync(victim, 'precious');
  const run = path.join(root, '.maestro', 'run');
  mkdirSync(run, { recursive: true });
  symlinkSync(victim, path.join(run, 'hb-sh-cafebabe-2222'));
  const r = runHook(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'cafebabe-2222', cwd: '/tmp' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  await sleep(400);
  assert.equal(readFileSync(victim, 'utf8'), 'precious');
  assert.equal(readEvents(root, { now: Date.now() }).length, 0); // refused -> no heartbeat
  // a dangling symlink must not be created through either
  const ghost = path.join(root, 'ghost.txt');
  symlinkSync(ghost, path.join(run, 'hb-sh-feedbeef-3333'));
  runHook(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'feedbeef-3333', cwd: '/tmp' });
  await sleep(400);
  assert.equal(existsSync(ghost), false);
  rmSync(root, { recursive: true });
});

test('hook script: the stamp dir is private (0700) and nothing lands in the shared tmp dir', async () => {
  const root = scratch();
  runHook(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'abc12345-4444', cwd: '/tmp' });
  await sleep(400);
  assert.equal(statSync(path.join(root, '.maestro', 'run')).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(path.join(root, 'tmp')), []);
  rmSync(root, { recursive: true });
});

test('install.sh --apply: atomic write keeps the file mode, backup is 0600, no temp file left', () => {
  const root = scratch();
  const settings = path.join(root, 'settings.json');
  writeFileSync(settings, '{"model":"opus"}\n');
  chmodSync(settings, 0o640);
  const r = spawnSync('sh', [INSTALL, '--apply', '--settings', settings], { encoding: 'utf8', env: { ...process.env, MAESTRO_HOME: MAESTRO_DIR } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(settings).mode & 0o777, 0o640);
  const files = readdirSync(root);
  const backup = files.find((f) => f.startsWith('settings.json.bak-maestro-'));
  assert.equal(statSync(path.join(root, backup)).mode & 0o777, 0o600);
  assert.ok(!files.some((f) => f.includes('.tmp-maestro-')));
  rmSync(root, { recursive: true });
});

test('install.sh: hook path is the canonical install, not the checkout it runs from', () => {
  const root = scratch();
  const settings = path.join(root, 'settings.json');
  const env = { ...process.env, HOME: root };
  delete env.MAESTRO_HOME;
  // default: $HOME/Projects/operator-skills/skills/maestro/hooks/maestro-emit.sh (missing here -> warning on print)
  const printed = spawnSync('sh', [INSTALL, '--settings', settings], { encoding: 'utf8', env });
  assert.equal(printed.status, 0);
  assert.equal(JSON.parse(printed.stdout).hooks.Stop[0].hooks[0].command, path.join(root, 'Projects', 'operator-skills', 'skills', 'maestro', 'hooks', 'maestro-emit.sh'));
  assert.match(printed.stderr, /does not exist yet/);
  // --apply refuses a hook path that does not exist
  const refused = spawnSync('sh', [INSTALL, '--apply', '--settings', settings], { encoding: 'utf8', env });
  assert.equal(refused.status, 1);
  assert.equal(existsSync(settings), false);
  // MAESTRO_HOME overrides
  const custom = path.join(root, 'custom');
  mkdirSync(path.join(custom, 'hooks'), { recursive: true });
  writeFileSync(path.join(custom, 'hooks', 'maestro-emit.sh'), '#!/bin/sh\nexit 0\n');
  const ok = spawnSync('sh', [INSTALL, '--apply', '--settings', settings], { encoding: 'utf8', env: { ...env, MAESTRO_HOME: custom } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).hooks.Stop[0].hooks[0].command, path.join(custom, 'hooks', 'maestro-emit.sh'));
  rmSync(root, { recursive: true });
});
