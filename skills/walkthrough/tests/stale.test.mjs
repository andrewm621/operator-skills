import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { staleReport } from '../scripts/stale.mjs';
import { stamp } from '../scripts/stamp.mjs';
import { engineVersions } from '../scripts/_lib.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();

/** A temp app repo with two mirrored files, and a walkthrough dir beside it. */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-stale-'));
  const app = path.join(root, 'app'), wt = path.join(root, 'wt');
  mkdirSync(path.join(app, 'src'), { recursive: true }); mkdirSync(wt);
  writeFileSync(path.join(app, 'src/Board.tsx'), 'export const a = "Mark final";\n');
  writeFileSync(path.join(app, 'src/Nav.tsx'), 'export const b = "Job sites";\n');
  git(app, 'init', '-q'); git(app, 'add', '.'); git(app, 'commit', '-qm', 'init');
  writeFileSync(path.join(wt, 'walkthrough.src.html'), '<title>x</title>');
  writeFileSync(path.join(wt, 'manifest.json'), JSON.stringify({
    slug: 't', repo: '../app', engine: engineVersions(),
    mirrors: { plan: ['src/Board.tsx'], nav: ['src/Nav.tsx'] },
    labels: [{ text: 'Mark final', file: 'src/Board.tsx', scene: 'plan' }, { text: 'Job sites', file: 'src/Nav.tsx', scene: 'nav' }],
  }, null, 2));
  stamp(wt);
  return { root, app, wt };
}

test('a fresh walkthrough reports nothing stale', () => {
  const { root, wt } = setup();
  try { const r = staleReport(wt); assert.deepEqual(r.stale, []); assert.equal(r.ok, true); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a committed change to one mirrored file flags only that scene, with the commit subject', () => {
  const { root, app, wt } = setup();
  try {
    writeFileSync(path.join(app, 'src/Nav.tsx'), 'export const b = "Job sites";\n// sidebar\n');
    git(app, 'commit', '-qam', 'Sidebar nav');
    const r = staleReport(wt);
    assert.deepEqual(r.stale, ['nav']);
    assert.match(r.scenes.nav.reasons.join('\n'), /src\/Nav\.tsx changed/);
    assert.match(r.scenes.nav.commits.join('\n'), /Sidebar nav/);
    assert.equal(r.scenes.plan.stale, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uncommitted edits count, and stamp refuses to baseline them', () => {
  const { root, app, wt } = setup();
  try {
    writeFileSync(path.join(app, 'src/Board.tsx'), 'export const a = "Mark final";\n// wip\n');
    assert.deepEqual(staleReport(wt).stale, ['plan']);
    assert.throws(() => stamp(wt), /uncommitted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a rename and a delete are reported', () => {
  const { root, app, wt } = setup();
  try {
    renameSync(path.join(app, 'src/Board.tsx'), path.join(app, 'src/PlanBoard.tsx'));
    git(app, 'add', '-A'); git(app, 'commit', '-qm', 'rename board');
    git(app, 'rm', '-q', 'src/Nav.tsx'); git(app, 'commit', '-qm', 'drop nav');
    const r = staleReport(wt);
    assert.deepEqual(r.stale.sort(), ['nav', 'plan']);
    assert.match(r.scenes.plan.reasons.join(' '), /deleted|renamed/);
    assert.match(r.scenes.nav.reasons.join(' '), /deleted/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a label that left the source flags its scene even with no file diff in the mirrors', () => {
  const { root, app, wt } = setup();
  try {
    writeFileSync(path.join(app, 'src/Board.tsx'), 'export const a = "Finalize";\n');
    git(app, 'commit', '-qam', 'rename button');
    const r = staleReport(wt);
    assert.ok(r.scenes.plan.reasons.some((x) => /label "Mark final" is no longer in/.test(x)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('engine pin drift is reported and does not mark scenes stale on its own', () => {
  const { root, wt } = setup();
  try {
    const p = path.join(wt, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8')); m.engine.motion = '0.0.1'; writeFileSync(p, JSON.stringify(m));
    const r = staleReport(wt);
    assert.equal(r.ok, false);
    assert.equal(r.engine.motion.pinned, '0.0.1');
    assert.deepEqual(r.stale, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no baseline commit is a problem, not a crash', () => {
  const { root, wt } = setup();
  try {
    const p = path.join(wt, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8')); delete m.builtAtCommit; writeFileSync(p, JSON.stringify(m));
    assert.match(staleReport(wt).problems.join(' '), /no builtAtCommit/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a label whose file is a directory or missing does not crash', () => {
  const { root, wt } = setup();
  try {
    const p = path.join(wt, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.labels.push({ text: 'x', file: 'src', scene: 'plan' }, { text: 'y', file: '', scene: 'nav' });
    writeFileSync(p, JSON.stringify(m));
    const r = staleReport(wt);
    assert.ok(r.scenes.plan.reasons.some((x) => /is not a file/.test(x)));
    assert.ok(r.scenes.nav.reasons.some((x) => /no file given/.test(x)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
