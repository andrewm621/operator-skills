/* A walkthrough directory comes from a repo we may not trust. These tests plant what an attacker would:
   a manifest.repo that points elsewhere, a .git/config that names programs, and symlinks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, readFileSync, readdirSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot, resolveTarget, readManifest, serveDir, gitSafe, gitTopLevel, findSymlink, GIT_LOG_FLAGS } from '../scripts/_lib.mjs';
import { wrap } from '../scripts/wrap.mjs';
import { staleReport } from '../scripts/stale.mjs';
import { stamp } from '../scripts/stamp.mjs';
import { datasafety } from '../scripts/datasafety.mjs';
import { deploy, repoIdentity } from '../scripts/deploy.mjs';
import { copyFixture, editManifest, edit, rm, quiet, HERE } from './_helpers.mjs';

process.env.HOME = mkdtempSync(path.join(tmpdir(), 'wt-home-'));   // never the real ~/.config
const STUB = ['node', path.join(HERE, 'stub-wrangler.mjs')];
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const root = (dir) => repoRoot(resolveTarget(dir), readManifest(resolveTarget(dir)));

/* ---- manifest.repo containment ---- */
test('manifest.repo may point at a folder inside the repo that contains the walkthrough', () => {
  const dir = copyFixture({ git: true });
  try { assert.equal(root(dir), path.join(dir, 'app-src')); } finally { rm(dir); }
});

test('manifest.repo is optional: the default is the git top-level', () => {
  const dir = copyFixture({ git: true });
  try {
    editManifest(dir, (m) => { delete m.repo; });
    assert.equal(root(dir), execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  } finally { rm(dir); }
});

test('manifest.repo that climbs out with ".." is refused', () => {
  const dir = copyFixture({ git: true });
  try {
    for (const repo of ['../../elsewhere', '..', '../', 'app-src/../../..']) {
      editManifest(dir, (m) => { m.repo = repo; });
      assert.throws(() => root(dir), /outside|does not exist/, repo);
    }
  } finally { rm(dir); }
});

test('an absolute manifest.repo is refused, even when it exists', () => {
  const dir = copyFixture({ git: true });
  try {
    for (const repo of [tmpdir(), '/', path.join(dir, 'app-src')]) {
      editManifest(dir, (m) => { m.repo = repo; });
      assert.throws(() => root(dir), /absolute/, repo);
    }
  } finally { rm(dir); }
});

test('a symlink inside the repo that leads outside it is refused', () => {
  const dir = copyFixture({ git: true }), outside = mkdtempSync(path.join(tmpdir(), 'wt-outside-'));
  try {
    symlinkSync(outside, path.join(dir, 'link'));
    editManifest(dir, (m) => { m.repo = 'link'; });
    assert.throws(() => root(dir), /outside/);
  } finally { rm(dir); rm(outside); }
});

test('a nested git repository is refused as manifest.repo', () => {
  const dir = copyFixture({ git: true });
  try {
    mkdirSync(path.join(dir, 'nested')); g(path.join(dir, 'nested'), 'init', '-q');
    editManifest(dir, (m) => { m.repo = 'nested'; });
    assert.throws(() => root(dir), /nested git repository/);
  } finally { rm(dir); }
});

test('without any git repo, manifest.repo must stay inside the walkthrough dir', () => {
  const dir = copyFixture();   // not a repo
  try {
    assert.equal(root(dir), path.join(dir, 'app-src'));
    editManifest(dir, (m) => { m.repo = '../x'; });
    assert.throws(() => root(dir), /outside|does not exist/);
  } finally { rm(dir); }
});

/* ---- a planted .git/config must not run anything ---- */
/** A marker-writing program that also passes stdin through (so it can stand in for a filter or a gpg). */
function evilProgram() {
  const d = mkdtempSync(path.join(tmpdir(), 'wt-marker-'));
  const script = path.join(d, 'evil.sh'), marker = path.join(d, 'ran');
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\ncat\n`); chmodSync(script, 0o755);
  return { dir: d, script, marker };
}

/** Give a commit a (fake) gpgsig header so log.showSignature has something to verify. */
function fakeSignHead(repo) {
  const raw = g(repo, 'cat-file', 'commit', 'HEAD');
  const signed = raw.replace(/\n\n/, '\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----\n\n');
  const id = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: signed + '\n', encoding: 'utf8' }).trim();
  g(repo, 'update-ref', 'HEAD', id);
}

test('planted fsmonitor, hooksPath, filter, textconv, gpg.program (log.showSignature) never run through stale, stamp, datasafety --history, repoIdentity or a deploy dry run', async () => {
  const dir = copyFixture({ git: true });
  const evil = evilProgram();
  try {
    const first = readdirSync(path.join(dir, 'app-src'))[0];
    const file = path.join(dir, 'app-src', first);
    editManifest(dir, (m) => { delete m.repo; m.mirrors = { plan: ['app-src/' + first] }; });
    writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil diff=evil\n');
    g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'attrs');
    stamp(dir, { force: true });                                            // baseline
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// committed change\n');
    g(dir, 'commit', '-qam', 'change'); fakeSignHead(dir);                  // a signed commit stale will log
    // the plant: what a malicious repo would ship in .git/config
    for (const [k, v] of [['core.fsmonitor', evil.script], ['core.hooksPath', evil.dir], ['core.sshCommand', evil.script],
      ['filter.evil.clean', evil.script], ['filter.evil.process', evil.script], ['diff.evil.textconv', evil.script],
      ['diff.evil.command', evil.script], ['diff.external', evil.script], ['log.showSignature', 'true'],
      ['gpg.program', evil.script], ['gpg.openpgp.program', evil.script], ['gpg.ssh.program', evil.script], ['gpg.x509.program', evil.script],
      ['pager.log', evil.script], ['pager.diff', evil.script], ['pager.status', evil.script]]) g(dir, 'config', k, v);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// edit\n');   // a dirty tracked file forces the filters to be consulted

    // controls: plain git does run the plant, so the assertions below mean something
    execFileSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'ignore' });
    assert.ok(existsSync(evil.marker), 'control: plain git status must trigger the planted fsmonitor/filter');
    rmSync(evil.marker);
    execFileSync('git', ['-C', dir, 'log', '-1'], { stdio: 'ignore' });
    assert.match(existsSync(evil.marker) ? readFileSync(evil.marker, 'utf8') : '', /--verify|status-fd/, 'control: plain git log must trigger the planted gpg.program');
    rmSync(evil.marker);

    const report = staleReport(dir);
    assert.ok(report.stale.includes('plan')); assert.ok(report.scenes.plan.commits, 'stale ran git log');
    datasafety(dir, { history: true });
    gitSafe(dir, ['status', '--porcelain']); gitSafe(dir, ['diff', '--no-ext-diff', '--no-textconv', '--stat']); gitSafe(dir, ['log', ...GIT_LOG_FLAGS, '-3']);
    repoIdentity(dir, dir);
    process.env.STUB_SCENARIO = 'absent'; delete process.env.STUB_LOG;
    await quiet(() => deploy(dir, { wrangler: STUB, account: 'a'.repeat(32) }));
    stamp(dir, { force: true });
    assert.equal(existsSync(evil.marker), false, existsSync(evil.marker) ? 'a planted program ran:\n' + readFileSync(evil.marker, 'utf8') : '');
  } finally { rm(dir); rm(evil.dir); }
});

test('a planted core.worktree cannot move the repo root: it stays the real top-level, and datasafety still sees the repo\'s own files', () => {
  const dir = copyFixture({ git: true });
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'wt-elsewhere-'));
  try {
    editManifest(dir, (m) => { delete m.repo; });
    mkdirSync(path.join(dir, 'docs')); writeFileSync(path.join(dir, 'docs', 'people.md'), 'Maya Okafor is a real customer.\n');
    g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'docs');
    const real = realpathSync(dir);
    assert.ok(datasafety(dir).findings.some((f) => f.kind === 'collision'), 'baseline: the collision is found');
    g(dir, 'config', 'core.worktree', elsewhere);
    assert.equal(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(), realpathSync(elsewhere), 'control: plain git is fooled');
    assert.equal(gitTopLevel(dir), real);
    assert.equal(realpathSync(root(dir)), real);
    const r = datasafety(dir);
    assert.ok(r.findings.some((f) => f.kind === 'collision' && /docs\/people\.md/.test(f.detail)), 'the collision cannot be silenced: ' + JSON.stringify(r.findings));
    assert.match(gitSafe(dir, ['ls-files']), /docs\/people\.md/);
  } finally { rm(dir); rm(elsewhere); }
});

test('a submodule\'s own filter driver never runs through stale, stamp or datasafety', () => {
  const dir = copyFixture({ git: true });
  const evil = evilProgram();
  const subSrc = mkdtempSync(path.join(tmpdir(), 'wt-sub-'));
  try {
    g(subSrc, 'init', '-q'); writeFileSync(path.join(subSrc, 'lib.txt'), 'one\n'); writeFileSync(path.join(subSrc, '.gitattributes'), '* filter=evil\n');
    g(subSrc, 'add', '-A'); g(subSrc, 'commit', '-qm', 'sub');
    execFileSync('git', ['-C', dir, '-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'submodule', 'add', '-q', subSrc, 'vendor'], { stdio: 'ignore' });
    g(dir, 'commit', '-qm', 'add submodule');
    const first = readdirSync(path.join(dir, 'app-src'))[0];
    editManifest(dir, (m) => { delete m.repo; m.mirrors = { plan: ['app-src/' + first, 'vendor'] }; });
    stamp(dir, { force: true });
    // the submodule's config (in the parent's .git/modules) names a clean filter; dirty its file so status would consult it
    const subGit = path.join(dir, '.git', 'modules', 'vendor');
    execFileSync('git', ['config', '--file', path.join(subGit, 'config'), 'filter.evil.clean', evil.script]);
    execFileSync('git', ['config', '--file', path.join(subGit, 'config'), 'filter.evil.process', evil.script]);
    writeFileSync(path.join(dir, 'vendor', 'lib.txt'), 'two\n');
    execFileSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'ignore' });
    assert.ok(existsSync(evil.marker), 'control: plain git status in the parent runs the submodule\'s filter');
    rmSync(evil.marker);
    staleReport(dir); datasafety(dir, { history: true });
    gitSafe(dir, ['status', '--porcelain', '--ignore-submodules=all']);
    stamp(dir, { force: true });
    assert.equal(existsSync(evil.marker), false, existsSync(evil.marker) ? 'a submodule program ran:\n' + readFileSync(evil.marker, 'utf8') : '');
  } finally { rm(dir); rm(evil.dir); rm(subSrc); }
});

/* ---- symlinked inputs ---- */
test('stamp, and every script, refuse a symlinked manifest.json, walkthrough.src.html, deploy.json or storyboard.md', () => {
  for (const name of ['manifest.json', 'walkthrough.src.html', 'deploy.json', 'storyboard.md']) {
    const dir = copyFixture({ git: true }), outside = mkdtempSync(path.join(tmpdir(), 'wt-victim-'));
    try {
      const victim = path.join(outside, 'victim.json'); writeFileSync(victim, '{"keep":"me"}');
      rmSync(path.join(dir, name), { force: true });
      symlinkSync(victim, path.join(dir, name));
      assert.throws(() => resolveTarget(dir), /symlink/, name);
      assert.throws(() => stamp(dir, { force: true }), /symlink/, name);
      assert.equal(readFileSync(victim, 'utf8'), '{"keep":"me"}', name + ': the link target is untouched');
    } finally { rm(dir); rm(outside); }
  }
});

/* ---- stale: inputs from the manifest ---- */
test('stale treats a label file that resolves outside the repo (".." or a symlink) as gone, and does not read it', () => {
  const dir = copyFixture({ git: true }), outside = mkdtempSync(path.join(tmpdir(), 'wt-outside-'));
  try {
    writeFileSync(path.join(outside, 'secret.tsx'), 'Check in');
    symlinkSync(path.join(outside, 'secret.tsx'), path.join(dir, 'app-src', 'linked.tsx'));
    editManifest(dir, (m) => { m.labels = [{ text: 'Check in', file: '../../../../../../' + path.relative('/', path.join(outside, 'secret.tsx')), scene: 'a' }, { text: 'Check in', file: 'app-src/linked.tsx', scene: 'b' }]; });
    const r = staleReport(dir);
    for (const id of ['a', 'b']) assert.match((r.scenes[id].reasons || []).join(' '), /gone or is not a file/, id);
  } finally { rm(dir); rm(outside); }
});

test('stale refuses a builtAtCommit that is not a hash (it would reach git as an option)', () => {
  const dir = copyFixture({ git: true });
  try {
    editManifest(dir, (m) => { m.builtAtCommit = '--output=/tmp/wt-should-not-exist'; m.mirrors = { plan: ['app-src/x'] }; });
    const r = staleReport(dir);
    assert.ok(r.problems.some((p) => /not a commit hash/.test(p)));
    assert.equal(existsSync('/tmp/wt-should-not-exist'), false);
  } finally { rm(dir); }
});

/* ---- symlinks and the static server ---- */
test('serveDir will not follow a symlink out of its root (file or directory), but serves real files', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wt-serve-'));
  const rootDir = path.join(base, 'root'), outside = path.join(base, 'outside');
  mkdirSync(rootDir); mkdirSync(outside);
  writeFileSync(path.join(outside, 'secret.txt'), 'SECRET'); writeFileSync(path.join(rootDir, 'ok.txt'), 'ok');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(rootDir, 'x'));
  symlinkSync(outside, path.join(rootDir, 'd'));
  symlinkSync(path.join(rootDir, 'ok.txt'), path.join(rootDir, 'inside-link.txt'));   // even a link that stays inside is refused
  const srv = await serveDir(rootDir);
  try {
    assert.equal(await (await fetch(srv.origin + '/ok.txt')).text(), 'ok');
    for (const p of ['/x', '/d/secret.txt', '/inside-link.txt', '/%2e%2e/outside/secret.txt', '/%']) {
      const r = await fetch(srv.origin + p);
      assert.equal(r.status, 404, p); assert.notEqual(await r.text(), 'SECRET', p);
    }
  } finally { await srv.close(); rm(base); }
});

test('wrap refuses a symlinked .wt and a symlinked walkthrough.html, and drops symlinks planted inside .wt', () => {
  const dir = copyFixture(), outside = mkdtempSync(path.join(tmpdir(), 'wt-outside-'));
  try {
    symlinkSync(outside, path.join(dir, '.wt'));
    assert.throws(() => wrap(dir), /symlink/);
    assert.deepEqual(existsSync(path.join(outside, 'test.html')), false, 'nothing was written through the link');
    rmSync(path.join(dir, '.wt'));

    mkdirSync(path.join(dir, '.wt'));
    writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, '.wt', 'x'));
    wrap(dir);
    assert.equal(findSymlink(path.join(dir, '.wt')), null, 'the planted link was removed');
    assert.ok(existsSync(path.join(dir, '.wt', 'test.html')));

    rmSync(path.join(dir, 'walkthrough.html'));
    symlinkSync(path.join(outside, 'target.html'), path.join(dir, 'walkthrough.html'));
    assert.throws(() => wrap(dir), /symlink/);
    assert.equal(existsSync(path.join(outside, 'target.html')), false);
  } finally { rm(dir); rm(outside); }
});
