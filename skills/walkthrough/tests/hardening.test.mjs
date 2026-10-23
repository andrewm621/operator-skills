/* A walkthrough directory comes from a repo we may not trust. These tests plant what an attacker would:
   a manifest.repo that points elsewhere, a .git/config that names programs, and symlinks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot, resolveTarget, readManifest, serveDir, gitSafe, findSymlink } from '../scripts/_lib.mjs';
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
test('planted core.fsmonitor, hooksPath, filter and textconv never run through stale, stamp, datasafety --history, repoIdentity or a deploy dry run', async () => {
  const dir = copyFixture({ git: true });
  const marker = path.join(mkdtempSync(path.join(tmpdir(), 'wt-marker-')), 'ran');
  const script = path.join(path.dirname(marker), 'evil.sh');
  writeFileSync(script, `#!/bin/sh\necho "$0 $*" >> "${marker}"\ncat\n`); chmodSync(script, 0o755);
  try {
    const first = readdirSync(path.join(dir, 'app-src'))[0];
    const file = path.join(dir, 'app-src', first);
    editManifest(dir, (m) => { m.mirrors = { plan: ['app-src/' + first] }; });
    writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil diff=evil\n');
    g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'attrs');
    // the plant: what a malicious repo would ship in .git/config
    g(dir, 'config', 'core.fsmonitor', script);
    g(dir, 'config', 'core.hooksPath', path.dirname(script));
    g(dir, 'config', 'core.sshCommand', script);
    g(dir, 'config', 'filter.evil.clean', script); g(dir, 'config', 'filter.evil.process', script);
    g(dir, 'config', 'diff.evil.textconv', script); g(dir, 'config', 'diff.evil.command', script);
    g(dir, 'config', 'diff.external', script);
    writeFileSync(file, readFileSync(file, 'utf8') + '\n// edit\n');   // a dirty tracked file forces the filters to be consulted

    // control: plain git does run the plant, so the assertions below mean something
    execFileSync('git', ['-C', dir, 'status', '--porcelain'], { stdio: 'ignore' });
    assert.ok(existsSync(marker), 'control: unhardened git must trigger the planted program (the test is not testing anything otherwise)');
    rmSync(marker);

    gitSafe(dir, ['status', '--porcelain']); gitSafe(dir, ['diff', '--no-ext-diff', '--no-textconv', '--stat']);
    stamp(dir, { force: true });
    staleReport(dir);
    datasafety(dir, { history: true });
    repoIdentity(dir, dir);
    process.env.STUB_SCENARIO = 'absent'; delete process.env.STUB_LOG;
    await quiet(() => deploy(dir, { wrangler: STUB, account: 'a'.repeat(32) }));
    assert.equal(existsSync(marker), false, existsSync(marker) ? 'a planted program ran:\n' + readFileSync(marker, 'utf8') : '');
  } finally { rm(dir); rm(path.dirname(marker)); }
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
