/* Agent Ops P1a tests — `node --test skills/maestro/test/`.
   Every test runs a COPY of maestro.mjs against a scratch projects dir
   (MAESTRO_PROJECTS) holding throwaway git repos; nothing touches real state. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'maestro.mjs');

const STUB_EVENTS = `
import { appendFileSync } from 'node:fs';
export function appendEvent(evt, opts) {
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ evt, opts }) + '\\n');
  if (process.env.STUB_NEVER) return new Promise(() => {}); // a promise that never settles
}
export function cmdEmit(argv, ctx) { console.log(JSON.stringify({ fn: 'emit', argv, ctx })); return 3; }
export function cmdStatus(argv, ctx) { console.log(JSON.stringify({ fn: 'status', argv, ctx })); }
export function cmdWho(argv, ctx) { console.log(JSON.stringify({ fn: 'who', argv, ctx })); }
`;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/* A scratch universe: projects dir, copy of maestro.mjs (optionally with a stub
   events.mjs beside it), and helpers to make repos/tasks and run the CLI. */
function makeEnv({ events = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maestro-p1a-'))); // real path: macOS /var -> /private/var
  const projects = path.join(root, 'projects');
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(projects, '.maestro'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(SRC, path.join(bin, 'maestro.mjs'));
  if (events) writeFileSync(path.join(bin, 'events.mjs'), STUB_EVENTS);
  const stubLog = path.join(root, 'events.log');

  const repos = [];
  const registryPath = path.join(projects, '.maestro', 'registry.yaml');
  const writeRegistry = () =>
    writeFileSync(
      registryPath,
      `repos:\n${repos.map((r) => `  - name: ${r.name}\n    path: ${r.path}\n`).join('')}id_prefix_from: name\n`
    );

  const env = {
    root,
    projects,
    stubLog,
    repoPath: (name) => repos.find((r) => r.name === name).path,
    addRepo(name) {
      const p = path.join(projects, name.replace(/\W+/g, '-'));
      mkdirSync(p, { recursive: true });
      git(p, 'init', '-q', '-b', 'main');
      git(p, 'config', 'user.email', 't@example.com');
      git(p, 'config', 'user.name', 'Test');
      writeFileSync(path.join(p, 'a.txt'), 'base\n');
      git(p, 'add', '.');
      git(p, 'commit', '-qm', 'init');
      repos.push({ name, path: p });
      writeRegistry();
      return p;
    },
    run(args, { cwd = projects, extra = {} } = {}) {
      const r = spawnSync('node', [path.join(bin, 'maestro.mjs'), ...args], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          MAESTRO_PROJECTS: projects,
          MAESTRO_HANDLE: 'andrew',
          MAESTRO_HOST: 'Test.Local',
          MAESTRO_SESSION: 'sess-aaaa1111',
          XDG_CONFIG_HOME: path.join(root, 'cfg'),
          STUB_LOG: stubLog,
          ...extra,
        },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
    },
    ok(args, opts) {
      const r = env.run(args, opts);
      assert.equal(r.status, 0, `maestro ${args.join(' ')} failed:\n${r.out}`);
      return r;
    },
    /* Creates a task and returns its local id. */
    task(repo, title, sets = []) {
      const r = env.ok(['new', title, '--repo', repo]);
      const id = r.stdout.trim().split('\n').pop();
      if (sets.length) env.ok(['set', id, '--repo', repo, ...sets]);
      return id;
    },
    index() {
      env.ok(['sync']);
      const map = {};
      for (const line of readFileSync(path.join(projects, '.maestro', 'index.jsonl'), 'utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        map[row.id] = row;
      }
      return map;
    },
    claimFile: (repo, id) => path.join(env.repoPath(repo), '.maestro', 'locks', `${id}.claim.json`),
    claim: (repo, id) => JSON.parse(readFileSync(env.claimFile(repo, id), 'utf8')),
    backdate(repo, id, minutes) {
      const c = env.claim(repo, id);
      c.heartbeat = new Date(Date.now() - minutes * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      writeFileSync(env.claimFile(repo, id), JSON.stringify(c));
    },
    fm(repo, id) {
      const dir = path.join(env.repoPath(repo), '.maestro', 'tasks');
      const file = spawnSync('sh', ['-c', `ls "${dir}"/${id}-*.md`], { encoding: 'utf8' }).stdout.trim();
      return readFileSync(file, 'utf8');
    },
    field: (repo, id, key) => (env.fm(repo, id).match(new RegExp(`^${key}: (.*)$`, 'm')) || [])[1],
    checkAllBoxes(repo, id) {
      const f = path.join(env.repoPath(repo), '.maestro', 'todos', `${id}.todos.md`);
      writeFileSync(f, readFileSync(f, 'utf8').replace(/- \[ \]/g, '- [x]'));
    },
    events: () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  return env;
}

function withEnv(opts, fn) {
  if (typeof opts === 'function') [fn, opts] = [opts, {}];
  return async () => {
    const env = makeEnv(opts);
    try {
      await fn(env);
    } finally {
      env.cleanup();
    }
  };
}

/* ---- A. readiness -------------------------------------------------------------- */

test('ready / waiting_on: deps (local + global ids), blocked_by, resolved task blockers', withEnv((env) => {
  env.addRepo('app');
  env.addRepo('lib repo');
  const a = env.task('app', 'A');
  const b = env.task('app', 'B', [`--depends-on`, a]);
  const c = env.task('lib repo', 'C', [`--depends-on`, `app/${b}`]);
  const d = env.task('app', 'D', ['--blocked-by', '@andrew']);
  const e = env.task('app', 'E', ['--blocked-by', 'resource:zite,external:vendor']);
  const f = env.task('app', 'F', ['--depends-on', 'app/T-99']); // missing dep never resolves

  let idx = env.index();
  assert.equal(idx[`app/${a}`].ready, true);
  assert.deepEqual(idx[`app/${a}`].waiting_on, []);
  assert.equal(idx[`app/${b}`].ready, false);
  assert.deepEqual(idx[`app/${b}`].waiting_on, [`app/${a}`]);
  assert.deepEqual(idx[`lib repo/${c}`].waiting_on, [`app/${b}`]);
  assert.deepEqual(idx[`app/${d}`].waiting_on, ['@andrew']);
  assert.deepEqual(idx[`app/${e}`].waiting_on, ['resource:zite', 'external:vendor']);
  assert.deepEqual(idx[`app/${f}`].waiting_on, ['app/T-99']);
  assert.deepEqual(idx[`app/${b}`].depends_on, [`app/${a}`]);

  env.ok(['set', a, '--repo', 'app', '--status', 'done']);
  idx = env.index();
  assert.equal(idx[`app/${b}`].ready, true, 'dependent flips to ready once its dep is done');
  assert.equal(idx[`lib repo/${c}`].ready, false, 'C still waits on B');
  assert.equal(idx[`app/${a}`].ready, false, 'a done task is not ready');

  // a blocked_by that names a done task counts as resolved
  const g = env.task('app', 'G', ['--blocked-by', `app/${a}`]);
  assert.equal(env.index()[`app/${g}`].ready, true);

  const board = readFileSync(path.join(env.projects, '.maestro', 'board.md'), 'utf8');
  assert.match(board, /\| waiting on \|/);
  assert.match(board, /@andrew/);
  assert.match(board, /\d+ ready/);
}));

test('dependency cycles: never ready, waiting_on [cycle], warning printed', withEnv((env) => {
  env.addRepo('app');
  const x = env.task('app', 'X');
  const y = env.task('app', 'Y', ['--depends-on', x]);
  env.ok(['set', x, '--repo', 'app', '--depends-on', y]);
  const z = env.task('app', 'Z');
  env.ok(['set', z, '--repo', 'app', '--depends-on', z]);
  const ok = env.task('app', 'fine');
  const r = env.ok(['sync']);
  assert.match(r.stderr, /dependency cycle: .*->/);
  const idx = env.index();
  for (const id of [x, y, z]) {
    assert.equal(idx[`app/${id}`].ready, false);
    assert.deepEqual(idx[`app/${id}`].waiting_on, ['cycle']);
  }
  assert.equal(idx[`app/${ok}`].ready, true);
}));

test('claim/work refuse an unready task; --force overrides and is logged', withEnv((env) => {
  env.addRepo('app');
  const a = env.task('app', 'A');
  const b = env.task('app', 'B', ['--depends-on', a]);

  for (const verb of ['claim', 'work']) {
    const r = env.run([verb, b, '--repo', 'app']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not ready, waiting on: T-1/);
    assert.equal(existsSync(env.claimFile('app', b)), false);
  }

  const forced = env.run(['claim', b, '--repo', 'app', '--force']);
  assert.equal(forced.status, 0, forced.out);
  assert.match(forced.stderr, /--force/);
  assert.ok(existsSync(env.claimFile('app', b)));
  const thread = env.ok(['read', b, '--repo', 'app']).stdout;
  assert.match(thread, /forced claim past unmet readiness/);
}));

/* ---- B. release / block / done ----------------------------------------------------- */

test('release drops the claim, reopens, keeps the worktree', withEnv((env) => {
  env.addRepo('app');
  const t = env.task('app', 'work me');
  env.ok(['work', t, '--repo', 'app']);
  const wt = env.field('app', t, 'worktree');
  assert.ok(existsSync(wt));
  env.ok(['release', t, '--repo', 'app']);
  assert.equal(existsSync(env.claimFile('app', t)), false);
  assert.equal(env.field('app', t, 'status'), 'open');
  assert.equal(env.field('app', t, 'owner'), 'null');
  assert.ok(existsSync(wt), 'worktree kept');
  assert.equal(env.field('app', t, 'worktree'), wt, 'worktree path still recorded');
}));

test('block: validates --by, writes fields, keeps the claim, @handle files an ask', withEnv((env) => {
  env.addRepo('app');
  const t = env.task('app', 'blocky');
  env.ok(['claim', t, '--repo', 'app']);

  assert.notEqual(env.run(['block', t, '--by', 'nonsense', 'why', '--repo', 'app']).status, 0);
  assert.notEqual(env.run(['block', t, '--by', '@andrew', '--repo', 'app']).status, 0, 'reason required');

  const r = env.ok(['block', t, '--by', '@andrew,resource:zite', 'need the creds', '--repo', 'app']);
  assert.match(r.stdout, /Asked @andrew: M-1-1/);
  assert.equal(env.field('app', t, 'status'), 'blocked');
  assert.equal(env.field('app', t, 'blocked_by'), '[@andrew, resource:zite]');
  assert.equal(env.field('app', t, 'blocked_reason'), 'need the creds');
  assert.ok(existsSync(env.claimFile('app', t)), 'claim kept');
  assert.match(env.ok(['inbox']).stdout, /M-1-1/);
  assert.deepEqual(env.index()[`app/${t}`].waiting_on, ['@andrew', 'resource:zite']);

  // leaving blocked clears the blocker
  env.ok(['set', t, '--repo', 'app', '--status', 'in-progress']);
  assert.equal(env.field('app', t, 'blocked_by'), '[]');
}));

function readyForReview(env, repo, t, { commit = true } = {}) {
  env.ok(['work', t, '--repo', repo]);
  const wt = env.field(repo, t, 'worktree');
  if (commit) {
    writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
    git(wt, 'add', 'feature.txt');
    git(wt, 'commit', '-qm', 'feature');
  }
  env.checkAllBoxes(repo, t);
  env.ok(['set', t, '--repo', repo, '--status', 'review']);
  return wt;
}

test('done: preconditions (review status, boxes checked, no open asks)', withEnv((env) => {
  env.addRepo('app');
  const t = env.task('app', 'gate me');
  env.ok(['work', t, '--repo', 'app']);

  let r = env.run(['done', t, '--repo', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not 'review'/);
  assert.match(r.stderr, /2 of 2 Acceptance item\(s\) unchecked/);

  env.checkAllBoxes('app', t);
  env.ok(['set', t, '--repo', 'app', '--status', 'review']);
  const mid = env.ok(['ask', t, 'one more thing?', '--repo', 'app']).stdout.trim();
  r = env.run(['done', t, '--repo', 'app', '--no-merge']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`open ask.*${mid}`));
  assert.equal(env.field('app', t, 'status'), 'review', 'a refusal changes nothing');

  env.ok(['answer', mid, 'no', '--repo', 'app']);
  env.ok(['done', t, '--repo', 'app', '--no-merge']);
  assert.equal(env.field('app', t, 'status'), 'done');
  assert.equal(existsSync(env.claimFile('app', t)), false);
}));

test('done --no-merge: status + claim only, branch and worktree untouched', withEnv((env) => {
  const repo = env.addRepo('app');
  const t = env.task('app', 'keep branch');
  const wt = readyForReview(env, 'app', t);
  env.ok(['done', t, '--repo', 'app', '--no-merge']);
  assert.equal(env.field('app', t, 'status'), 'done');
  assert.ok(existsSync(wt));
  assert.match(git(repo, 'branch', '--list', 'maestro/*'), /maestro\//);
  assert.equal(existsSync(path.join(repo, 'feature.txt')), false, 'nothing merged');
}));

test('done: merges the branch, removes the worktree, deletes the branch', withEnv((env) => {
  const repo = env.addRepo('app');
  const t = env.task('app', 'ship it');
  const wt = readyForReview(env, 'app', t);
  const r = env.ok(['done', t, '--repo', 'app']);
  assert.match(r.stdout, /merged/);
  assert.equal(readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(existsSync(wt), false, 'worktree removed');
  assert.equal(git(repo, 'branch', '--list', 'maestro/*').trim(), '', 'branch deleted');
  assert.equal(env.field('app', t, 'status'), 'done');
  assert.equal(env.field('app', t, 'worktree'), 'null');
  assert.equal(existsSync(env.claimFile('app', t)), false);
}));

test('done: refuses (state untouched) on a dirty task worktree or a dirty default checkout', withEnv((env) => {
  const repo = env.addRepo('app');
  const t = env.task('app', 'dirty');
  const wt = readyForReview(env, 'app', t);

  writeFileSync(path.join(wt, 'wip.txt'), 'uncommitted\n');
  let r = env.run(['done', t, '--repo', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uncommitted/);

  rmSync(path.join(wt, 'wip.txt'));
  writeFileSync(path.join(repo, 'a.txt'), 'local edit\n'); // tracked change on main
  r = env.run(['done', t, '--repo', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uncommitted tracked changes/);
  assert.equal(env.field('app', t, 'status'), 'review');
  assert.ok(existsSync(wt));
}));

test('done: merge conflict aborts cleanly, blocks the task, exits non-zero', withEnv((env) => {
  const repo = env.addRepo('app');
  const t = env.task('app', 'conflicting');
  env.ok(['work', t, '--repo', 'app']);
  const wt = env.field('app', t, 'worktree');
  writeFileSync(path.join(wt, 'a.txt'), 'from branch\n');
  git(wt, 'commit', '-qam', 'branch edit');
  writeFileSync(path.join(repo, 'a.txt'), 'from main\n');
  git(repo, 'commit', '-qam', 'main edit');
  env.checkAllBoxes('app', t);
  env.ok(['set', t, '--repo', 'app', '--status', 'review']);

  const r = env.run(['done', t, '--repo', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /merge conflict/);
  assert.equal(existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false, 'merge aborted');
  assert.equal(readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'from main\n');
  assert.equal(env.field('app', t, 'status'), 'blocked');
  assert.equal(env.field('app', t, 'blocked_by'), '[conflict:main]');
  assert.match(env.field('app', t, 'blocked_reason'), /a\.txt/);
  assert.ok(existsSync(env.claimFile('app', t)), 'claim kept');
  assert.ok(existsSync(wt), 'worktree kept');
}));

/* ---- C. client / policy ------------------------------------------------------------- */

test('client: task field > policy repos map > null; extra frontmatter reaches the index', withEnv((env) => {
  env.addRepo('app');
  env.addRepo('lib repo');
  env.addRepo('loose');
  writeFileSync(
    path.join(env.projects, '.maestro', 'policy.yaml'),
    '# hand-kept\nrepos:\n  app: acme   # trailing comment\n  "lib repo": libco\nclients:\n  acme:\n    tier: 1\n'
  );
  const own = env.task('app', 'own', ['--client', 'acme', '--project', 'sdr', '--deadline', '2026-10-23', '--wu', 'AD-005', '--scope', 'src/**,docs', '--uses', 'composio:acme', '--budget-minutes', '90']);
  const viaMap = env.task('app', 'mapped');
  const quoted = env.task('lib repo', 'quoted key');
  const none = env.task('loose', 'unmapped');
  const idx = env.index();
  assert.equal(idx[`app/${own}`].client, 'acme');
  assert.equal(idx[`app/${viaMap}`].client, 'acme');
  assert.equal(idx[`lib repo/${quoted}`].client, 'libco');
  assert.equal(idx[`loose/${none}`].client, null);
  const row = idx[`app/${own}`];
  assert.equal(row.project, 'sdr');
  assert.equal(row.deadline, '2026-10-23');
  assert.equal(row.wu, 'AD-005');
  assert.deepEqual(row.scope, ['src/**', 'docs']);
  assert.deepEqual(row.uses, ['composio:acme']);
  assert.equal(row.budget_minutes, 90);
  env.ok(['set', own, '--repo', 'app', '--client', 'none']);
  assert.equal(env.index()[`app/${own}`].client, 'acme', 'clearing the field falls back to the policy map');
}));

/* ---- D. stable actor ids + resume ----------------------------------------------------- */

test('actor ids are role-level; claim records the session; --resume re-claims without a steal', withEnv((env) => {
  env.addRepo('app');
  const t = env.task('app', 'resumable');
  env.ok(['claim', t, '--repo', 'app']);
  let c = env.claim('app', t);
  assert.equal(c.owner, 'claude@test');
  assert.equal(c.session, 'sess-aaaa1111');
  assert.equal(c.provider, 'claude');

  // a plain second claim still fails; --resume from the SAME session is fine
  assert.notEqual(env.run(['claim', t, '--repo', 'app']).status, 0);
  env.ok(['claim', t, '--resume', '--repo', 'app']);

  // a LIVE claim held by another session of the same role needs --takeover
  const other = { extra: { MAESTRO_SESSION: 'sess-bbbb2222' } };
  const refused = env.run(['claim', t, '--resume', '--repo', 'app'], other);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /another live session \(sess-aaaa1111/);
  assert.equal(env.claim('app', t).session, 'sess-aaaa1111', 'refusal changes nothing');
  const took = env.ok(['claim', t, '--resume', '--takeover', '--repo', 'app'], other);
  assert.match(took.stdout, /Took over .* sess-aaaa1111 → sess-bbbb2222/);
  c = env.claim('app', t);
  assert.equal(c.session, 'sess-bbbb2222');
  assert.equal(env.field('app', t, 'status'), 'claimed');

  // a STALE claim resumes freely from any session
  env.backdate('app', t, 45);
  const stale = env.ok(['claim', t, '--resume', '--repo', 'app'], { extra: { MAESTRO_SESSION: 'sess-cccc3333' } });
  assert.match(stale.stdout, /Resumed .*claim was stale/);

  // other roles cannot resume it
  const otherRole = env.run(['claim', t, '--resume', '--repo', 'app'], { extra: { MAESTRO_PROVIDER: 'codex' } });
  assert.notEqual(otherRole.status, 0);
  assert.match(otherRole.stderr, /owned by claude@test/);

  // resume of nothing claims fresh; MAESTRO_PROVIDER picks the role
  const t2 = env.task('app', 'fresh');
  const r2 = env.ok(['claim', t2, '--resume', '--repo', 'app'], { extra: { MAESTRO_PROVIDER: 'codex' } });
  assert.match(r2.stdout, /No existing claim/);
  assert.equal(env.claim('app', t2).owner, 'codex@test');
}));

test('session id: MAESTRO_SESSION > CLAUDE_CODE_SESSION_ID > CLAUDE_SESSION_ID', withEnv((env) => {
  env.addRepo('app');
  const mk = (extra) => {
    const t = env.task('app', 'sess');
    env.ok(['claim', t, '--repo', 'app'], { extra });
    return env.claim('app', t).session;
  };
  assert.equal(mk({ MAESTRO_SESSION: 'm-1', CLAUDE_CODE_SESSION_ID: 'cc-1', CLAUDE_SESSION_ID: 'old-1' }), 'm-1');
  assert.equal(mk({ MAESTRO_SESSION: '', CLAUDE_CODE_SESSION_ID: 'cc-2', CLAUDE_SESSION_ID: 'old-2' }), 'cc-2');
  assert.equal(mk({ MAESTRO_SESSION: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: 'old-3' }), 'old-3');
  assert.match(mk({ MAESTRO_SESSION: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' }), /^[0-9a-f]{8}$/);
}));

test('legacy owners (user@claude) still parse and display', withEnv((env) => {
  env.addRepo('app');
  const t = env.task('app', 'old claim');
  env.ok(['claim', t, '--repo', 'app', '--owner', 'you@claude']);
  const board = env.ok(['board']).stdout;
  assert.match(board, /you@claude/);
}));

/* ---- E. reap ---------------------------------------------------------------------------- */

function reapFixture(env) {
  env.addRepo('app');
  const clean = env.task('app', 'clean abandoned');
  const dirty = env.task('app', 'dirty abandoned');
  const unpushed = env.task('app', 'committed abandoned');
  const young = env.task('app', 'merely stale');
  const live = env.task('app', 'live');
  const bare = env.task('app', 'claim only');
  for (const t of [clean, dirty, unpushed, young, live]) env.ok(['work', t, '--repo', 'app']);
  env.ok(['claim', bare, '--repo', 'app']);

  writeFileSync(path.join(env.field('app', dirty, 'worktree'), 'wip.txt'), 'uncommitted\n');
  const uw = env.field('app', unpushed, 'worktree');
  writeFileSync(path.join(uw, 'x.txt'), 'x\n');
  git(uw, 'add', 'x.txt');
  git(uw, 'commit', '-qm', 'local only');

  for (const t of [clean, dirty, unpushed, bare]) env.backdate('app', t, 100); // > 2x TTL (60m)
  env.backdate('app', young, 40); // stale, under 2x TTL
  return { clean, dirty, unpushed, young, live, bare };
}

test('reap --dry-run: classifies, mutates nothing, writes no run record', withEnv((env) => {
  const f = reapFixture(env);
  const r = env.ok(['reap', '--dry-run']);
  assert.match(r.stdout, /\[dry-run\]/);
  assert.match(r.stdout, new RegExp(`would release[\\s\\S]*app/${f.clean}`));
  assert.match(r.stdout, new RegExp(`would release[\\s\\S]*app/${f.bare}`));
  assert.match(r.stdout, /needs you: abandoned work/);
  assert.match(r.stdout, new RegExp(`app/${f.dirty}.*1 uncommitted file`));
  assert.match(r.stdout, new RegExp(`app/${f.unpushed}.*1 unpushed commit`));
  for (const t of [f.clean, f.dirty, f.unpushed, f.young, f.live, f.bare]) {
    assert.ok(existsSync(env.claimFile('app', t)), `${t} claim untouched by a dry run`);
  }
  assert.equal(existsSync(path.join(env.projects, '.maestro', 'events', '_system', 'reaper.jsonl')), false);
}));

test('reap: releases only clean abandoned claims, tells fleet, logs the run', withEnv((env) => {
  const f = reapFixture(env);
  const r = env.ok(['reap']);
  assert.match(r.stdout, /2 released, 2 need you/);

  for (const t of [f.clean, f.bare]) {
    assert.equal(existsSync(env.claimFile('app', t)), false, `${t} released`);
    assert.equal(env.field('app', t, 'owner'), 'null');
    assert.equal(env.field('app', t, 'status'), 'open');
  }
  assert.ok(existsSync(env.field('app', f.clean, 'worktree')), 'worktree kept for the released task');
  for (const t of [f.dirty, f.unpushed, f.young, f.live]) {
    assert.ok(existsSync(env.claimFile('app', t)), `${t} claim kept`);
  }

  const fleet = readFileSync(path.join(env.projects, '.maestro', 'channels', 'fleet.md'), 'utf8');
  assert.match(fleet, new RegExp(`reaped app/${f.clean} from claude@test`));
  assert.doesNotMatch(fleet, new RegExp(`reaped app/${f.dirty}`));

  const lines = readFileSync(path.join(env.projects, '.maestro', 'events', '_system', 'reaper.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.ok, true);
  assert.deepEqual(rec.released.sort(), [`app/${f.clean}`, `app/${f.bare}`].sort());
  assert.equal(rec.needs_you.length, 2);
  assert.equal(rec.live, 1);
  assert.equal(rec.stale, 1);

  env.ok(['reap']);
  assert.equal(readFileSync(path.join(env.projects, '.maestro', 'events', '_system', 'reaper.jsonl'), 'utf8').trim().split('\n').length, 2, 'one record per run');
}));

/* ---- F. event hooks + dispatcher -------------------------------------------------------- */

test('events: hook points call appendEvent with the agreed contract', withEnv({ events: true }, (env) => {
  env.addRepo('app');
  writeFileSync(path.join(env.projects, '.maestro', 'policy.yaml'), 'repos:\n  app: acme\n');
  const t = env.task('app', 'evented');
  env.ok(['claim', t, '--repo', 'app']);
  env.ok(['heartbeat', t, '--repo', 'app']);
  env.ok(['heartbeat', t, '--repo', 'app']); // throttled: no second heartbeat event
  const mid = env.ok(['ask', t, 'q?', '--repo', 'app']).stdout.trim();
  env.ok(['answer', mid, 'a', '--repo', 'app']);
  env.ok(['say', 'fleet', 'hello']);
  env.ok(['block', t, '--by', 'external:vendor', 'waiting', '--repo', 'app']);
  env.ok(['release', t, '--repo', 'app']);

  const events = env.events();
  const types = events.map((e) => e.evt.type + (e.evt.data?.action ? `:${e.evt.data.action}` : ''));
  assert.deepEqual(types, ['claim:acquire', 'heartbeat', 'message', 'message', 'message', 'state', 'claim:release', 'state']);

  const claim = events[0];
  assert.equal(claim.opts.projectsDir, env.projects);
  assert.equal(claim.evt.task, `app/${t}`);
  assert.equal(claim.evt.actor, 'claude@test');
  assert.equal(claim.evt.session, 'sess-aaaa1111');
  assert.equal(claim.evt.client, 'acme');

  assert.equal(events[2].evt.data.kind, 'ask');
  assert.equal(events[2].evt.to, '@andrew');
  assert.equal(events[3].evt.data.kind, 'answer');
  assert.deepEqual(events[3].evt.refs, [mid]);
  assert.equal(events[4].evt.task, null, 'fleet messages have no task');
  assert.deepEqual(events[5].evt.data, { from: 'claimed', to: 'blocked', blocked_by: ['external:vendor'] });
}));

test('events: emit/status/who dispatch with ctx; a missing module is exit 1; other verbs unaffected', withEnv({ events: true }, (env) => {
  const repo = env.addRepo('app');
  const r = env.run(['emit', 'progress', 'todos=1/2'], { cwd: repo });
  assert.equal(r.status, 3, 'numeric return becomes the exit code');
  const call = JSON.parse(r.stdout);
  assert.deepEqual(call.argv, ['progress', 'todos=1/2']);
  assert.deepEqual(Object.keys(call.ctx).sort(), ['actor', 'handle', 'host', 'projectsDir', 'repo', 'session']);
  assert.equal(call.ctx.actor, 'claude@test');
  assert.equal(call.ctx.host, 'test');
  assert.equal(call.ctx.handle, 'andrew');
  assert.equal(call.ctx.repo.name, 'app');
  assert.equal(JSON.parse(env.ok(['status', '--json']).stdout).fn, 'status');
  assert.equal(JSON.parse(env.ok(['who', 'src/x.ts']).stdout).fn, 'who');
}));

test('events module missing: emit/status/who say so and exit 1; everything else works', withEnv((env) => {
  env.addRepo('app');
  for (const verb of ['emit', 'status', 'who']) {
    const r = env.run([verb]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /events module not installed/);
  }
  const t = env.task('app', 'no events needed');
  env.ok(['claim', t, '--repo', 'app']);
}));

/* ---- security: frontmatter `worktree:` / `branch:` are untrusted ------------------------- */

test('done/reap never inspect or remove a worktree path outside the Maestro root', withEnv((env) => {
  const repo = env.addRepo('app');
  const victim = path.join(env.root, 'victim');
  mkdirSync(victim, { recursive: true });
  writeFileSync(path.join(victim, 'precious.txt'), 'keep me\n');
  // a "repo" whose config would run a command if git ever status-ed it
  git(victim, 'init', '-q', '-b', 'main');
  const marker = path.join(env.root, 'PWNED');
  git(victim, 'config', 'core.fsmonitor', `touch ${marker}; true`);

  const t = env.task('app', 'evil worktree');
  env.ok(['work', t, '--repo', 'app']);
  const realWt = env.field('app', t, 'worktree');
  env.checkAllBoxes('app', t);
  env.ok(['set', t, '--repo', 'app', '--status', 'review', '--worktree', victim]);

  // done: warns, merges the real branch, never touches the victim dir
  const r = env.ok(['done', t, '--repo', 'app']);
  assert.match(r.stderr, new RegExp(`app/${t}: recorded worktree '${victim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' is not the worktree git has for branch`));
  assert.ok(existsSync(path.join(victim, 'precious.txt')), 'victim dir not removed');
  assert.equal(existsSync(marker), false, 'no git config command executed in the victim dir');
  assert.equal(existsSync(realWt), false, "the worktree git has for the task's branch is the one torn down");
  assert.equal(env.field('app', t, 'worktree'), 'null', 'cleared because the git-derived worktree was removed');

  // reap: an untrusted worktree makes the claim "needs you", never auto-released
  const t2 = env.task('app', 'evil reap');
  env.ok(['work', t2, '--repo', 'app']);
  env.ok(['set', t2, '--repo', 'app', '--worktree', victim]);
  env.backdate('app', t2, 100);
  const reap = env.ok(['reap']);
  assert.match(reap.stdout, new RegExp(`needs you[\\s\\S]*app/${t2}[\\s\\S]*not a Maestro/git worktree`));
  assert.ok(existsSync(env.claimFile('app', t2)));
  assert.ok(existsSync(path.join(victim, 'precious.txt')));
  assert.equal(existsSync(marker), false);

  // a branch name shaped like a git option is refused
  const t3 = env.task('app', 'evil branch');
  env.ok(['work', t3, '--repo', 'app']);
  env.checkAllBoxes('app', t3);
  env.ok(['set', t3, '--repo', 'app', '--status', 'review']);
  const taskFile = spawnSync('sh', ['-c', `ls "${env.repoPath('app')}"/.maestro/tasks/${t3}-*.md`], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(taskFile, readFileSync(taskFile, 'utf8').replace(/^branch: .*$/m, 'branch: --upload-pack=x'));
  const b = env.run(['done', t3, '--repo', 'app']);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /not a plain branch name/);
}));

test('a worktree path under the Maestro root is still untrusted unless git lists it for THIS repo', withEnv((env) => {
  env.addRepo('app');
  env.addRepo('other');
  const other = env.task('other', 'neighbour');
  env.ok(['work', other, '--repo', 'other']);
  const neighbourWt = env.field('other', other, 'worktree'); // under the root, listed by `other`, not by `app`
  writeFileSync(path.join(neighbourWt, 'precious.txt'), 'keep me\n');

  const stray = path.join(env.projects, '.maestro', 'worktrees', 'app', 'T-77'); // under the root, listed by nobody
  mkdirSync(stray, { recursive: true });
  writeFileSync(path.join(stray, 'precious.txt'), 'keep me too\n');

  for (const target of [neighbourWt, stray]) {
    const t = env.task('app', `points at ${path.basename(target)}`);
    env.ok(['work', t, '--repo', 'app']);
    env.checkAllBoxes('app', t);
    env.ok(['set', t, '--repo', 'app', '--status', 'review', '--worktree', target]);
    const r = env.ok(['done', t, '--repo', 'app']);
    assert.match(r.stderr, /is not the worktree git has for branch/);
    assert.ok(existsSync(path.join(target, 'precious.txt')), `${target} left alone`);

    const t2 = env.task('app', `reap ${path.basename(target)}`);
    env.ok(['work', t2, '--repo', 'app']);
    env.ok(['set', t2, '--repo', 'app', '--worktree', target]);
    env.backdate('app', t2, 100);
    assert.match(env.ok(['reap']).stdout, new RegExp(`needs you[\\s\\S]*app/${t2}[\\s\\S]*not a Maestro/git worktree`));
    assert.ok(existsSync(env.claimFile('app', t2)));
  }
}));

/* ---- review fixes: cross-task worktree, tags, events, `--`, gate ---------------------------- */

test("done on T-1 with worktree: pointing at T-2's live worktree leaves T-2 untouched and checks T-1's own", withEnv((env) => {
  const repo = env.addRepo('app');
  const t1 = env.task('app', 'victim writer');
  const t2 = env.task('app', 'innocent bystander');
  const wt1 = readyForReview(env, 'app', t1);
  env.ok(['work', t2, '--repo', 'app']);
  const wt2 = env.field('app', t2, 'worktree');
  writeFileSync(path.join(wt2, 'gitignored-or-wip.txt'), 'must survive\n');
  env.ok(['set', t1, '--repo', 'app', '--worktree', wt2]);

  // T-1's OWN worktree is what gets dirty-checked, so uncommitted work there blocks done
  writeFileSync(path.join(wt1, 'wip.txt'), 'uncommitted\n');
  let r = env.run(['done', t1, '--repo', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uncommitted/);
  assert.ok(existsSync(path.join(wt2, 'gitignored-or-wip.txt')));

  rmSync(path.join(wt1, 'wip.txt'));
  r = env.ok(['done', t1, '--repo', 'app']);
  assert.match(r.stdout, /worktree removed, branch deleted/);
  assert.equal(existsSync(wt1), false, "T-1's own worktree torn down");
  assert.equal(readFileSync(path.join(wt2, 'gitignored-or-wip.txt'), 'utf8'), 'must survive\n', "T-2's worktree untouched");
  assert.ok(existsSync(env.claimFile('app', t2)));
  assert.match(git(repo, 'branch', '--list', 'maestro/*'), /T-2/);
}));

test('done refuses a branch field that is not the task\'s own maestro branch', withEnv((env) => {
  env.addRepo('app');
  const t1 = env.task('app', 'one');
  const t2 = env.task('app', 'two');
  readyForReview(env, 'app', t1);
  env.ok(['work', t2, '--repo', 'app']);
  const b2 = env.field('app', t2, 'branch');
  env.ok(['set', t1, '--repo', 'app', '--branch', b2]);
  const r = env.run(['done', t1, '--repo', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not this task's maestro\/T-1-\* branch/);
}));

test('a tag named like the task branch does not hijack merge or reap (refs/heads/ is used)', withEnv((env) => {
  const repo = env.addRepo('app');
  const t = env.task('app', 'tagged');
  const wt = readyForReview(env, 'app', t);
  const branch = env.field('app', t, 'branch');
  git(repo, 'tag', branch, 'main'); // tag points at base; bare `branch` would now be ambiguous
  const r = env.ok(['done', t, '--repo', 'app']);
  assert.match(r.stdout, /branch deleted/);
  assert.equal(readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'feature\n', 'the BRANCH was merged, not the tag');
  assert.equal(existsSync(wt), false);
}));

test('steal and takeover events carry both prev_owner and from', withEnv({ events: true }, (env) => {
  env.addRepo('app');
  const t = env.task('app', 'stealable');
  env.ok(['claim', t, '--repo', 'app', '--owner', 'old@box']);
  env.backdate('app', t, 45);
  env.ok(['claim', t, '--repo', 'app', '--steal']);
  const steal = env.events().map((e) => e.evt).find((e) => e.data.action === 'steal');
  assert.equal(steal.data.prev_owner, 'old@box');
  assert.equal(steal.data.from, 'old@box');
}));

test('reap: recent-events check matches the 8-char lowercase session token in the file name', withEnv((env) => {
  env.addRepo('app');
  const live = env.task('app', 'silent but evented');
  const quiet = env.task('app', 'silent');
  const uuid = '7F3A9C1E-1111-2222-3333-444455556666';
  env.ok(['claim', live, '--repo', 'app'], { extra: { MAESTRO_SESSION: uuid } });
  env.ok(['claim', quiet, '--repo', 'app'], { extra: { MAESTRO_SESSION: 'ffffffff-0000-0000-0000-000000000000' } });
  for (const t of [live, quiet]) env.backdate('app', t, 100);
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(path.join(env.projects, '.maestro', 'events', day), { recursive: true });
  writeFileSync(path.join(env.projects, '.maestro', 'events', day, 'claude@test-7f3a9c1e.jsonl'), '{}\n');

  const r = env.ok(['reap']);
  assert.match(r.stdout, /1 with recent events, 1 released/);
  assert.ok(existsSync(env.claimFile('app', live)), 'claim with a recent event file is left alone');
  assert.equal(existsSync(env.claimFile('app', quiet)), false);
}));

test('`--` terminator: text starting with - is accepted after it, rejected without it', withEnv((env) => {
  env.addRepo('app');
  const t = env.task('app', 'dashes');
  const bare = env.run(['say', t, '-5% churn', '--repo', 'app']);
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /starts with '-'.*after '--'/);

  env.ok(['say', t, '--repo', 'app', '--', '--flaglike text']);
  env.ok(['say', t, '--repo', 'app', '--', '-5% churn']);
  const thread = env.ok(['read', t, '--repo', 'app']).stdout;
  assert.match(thread, /say: --flaglike text/);
  assert.match(thread, /say: -5% churn/);

  env.ok(['block', t, '--by', '@andrew', '--repo', 'app', '--', '--needs a decision']);
  assert.equal(env.field('app', t, 'blocked_reason'), '--needs a decision');
  assert.notEqual(env.run(['block', t, '--by', '@andrew', '-x reason', '--repo', 'app']).status, 0);
}));

test('claim gate: a task the sync scan cannot read is not silently let through', withEnv((env) => {
  const repo = env.addRepo('app');
  env.task('app', 'fine');
  mkdirSync(path.join(repo, '.maestro', 'tasks'), { recursive: true });
  writeFileSync(path.join(repo, '.maestro', 'tasks', 'T-9-broken.md'), 'no frontmatter fences here\n');
  const r = env.run(['claim', 'T-9', '--repo', 'app']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not evaluate readiness of T-9/);
  assert.equal(existsSync(env.claimFile('app', 'T-9')), false);
}));

test('sync warns once about depends_on naming a task that does not exist', withEnv((env) => {
  env.addRepo('app');
  env.task('app', 'a', ['--depends-on', 'app/T-99']);
  env.task('app', 'b', ['--depends-on', 'app/T-99,T-1']);
  const r = env.ok(['sync']);
  const hits = r.stderr.split('\n').filter((l) => /do not exist/.test(l));
  assert.equal(hits.length, 1);
  assert.match(hits[0], /app\/T-99 \(named by app\/T-1, app\/T-2\)/);
}));

test('events pending forever never hang the CLI (success and failure paths)', withEnv({ events: true }, (env) => {
  env.addRepo('app');
  const t = env.task('app', 'never settles', []);
  const started = Date.now();
  const ok = env.run(['claim', t, '--repo', 'app'], { extra: { STUB_NEVER: '1' } });
  assert.equal(ok.status, 0, ok.out);
  assert.ok(Date.now() - started < 4000);
  // failure path after events were queued in the same process (merge conflict -> fail()): exit 1, never 13
  const repo = env.repoPath('app');
  const c = env.task('app', 'conflicting');
  env.ok(['work', c, '--repo', 'app']);
  const wt = env.field('app', c, 'worktree');
  writeFileSync(path.join(wt, 'a.txt'), 'branch\n');
  git(wt, 'commit', '-qam', 'b');
  writeFileSync(path.join(repo, 'a.txt'), 'main\n');
  git(repo, 'commit', '-qam', 'm');
  env.checkAllBoxes('app', c);
  env.ok(['set', c, '--repo', 'app', '--status', 'review']);
  const bad = env.run(['done', c, '--repo', 'app'], { extra: { STUB_NEVER: '1' } });
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.stderr, /merge conflict/);
  assert.equal(env.field('app', c, 'status'), 'blocked');
}));

test('policy.yaml: canonical pairs plus the tolerated item / header forms; reaper needs_you carries `since`', withEnv((env) => {
  env.addRepo('a');
  env.addRepo('b c');
  env.addRepo('d');
  writeFileSync(
    path.join(env.projects, '.maestro', 'policy.yaml'),
    'repos:\n  a: one\n  - "b c": two\n  three:\n    - d\nhard_terms:\n  - Acme Corp\n'
  );
  const ids = ['a', 'b c', 'd'].map((r) => [r, env.task(r, `t in ${r}`)]);
  const idx = env.index();
  assert.deepEqual(ids.map(([r, t]) => idx[`${r}/${t}`].client), ['one', 'two', 'three']);

  // since = the claim's last heartbeat
  const t = env.task('a', 'abandoned dirty');
  env.ok(['work', t, '--repo', 'a']);
  writeFileSync(path.join(env.field('a', t, 'worktree'), 'wip.txt'), 'x\n');
  env.backdate('a', t, 100);
  const hb = env.claim('a', t).heartbeat;
  env.ok(['reap']);
  const rec = JSON.parse(readFileSync(path.join(env.projects, '.maestro', 'events', '_system', 'reaper.jsonl'), 'utf8').trim());
  assert.equal(rec.needs_you[0].id, `a/${t}`);
  assert.equal(rec.needs_you[0].since, hb);
  assert.deepEqual(Object.keys(rec.needs_you[0]).sort(), ['age_min', 'branch', 'id', 'owner', 'reason', 'since', 'status', 'worktree']);
}));
