import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { datasafety } from '../scripts/datasafety.mjs';
import { FIXTURE } from './_helpers.mjs';

/** An "app repo" whose seed data names a real-looking person, plus a walkthrough dir inside it. */
function setup({ page, cast = ['Maya Okafor'], extra = {} }) {
  const repo = mkdtempSync(path.join(tmpdir(), 'wt-ds-'));
  mkdirSync(path.join(repo, 'samples')); mkdirSync(path.join(repo, 'docs/walkthroughs/demo'), { recursive: true });
  writeFileSync(path.join(repo, 'samples/people.csv'), 'name,city\nDorothea Vance,Clinton\n');
  writeFileSync(path.join(repo, 'docs/USER-JOURNEYS.md'), '# Journeys\nLinda confirms the plan. Kathy books hotels.\n');
  const wt = path.join(repo, 'docs/walkthroughs/demo');
  writeFileSync(path.join(wt, 'walkthrough.src.html'), page);
  writeFileSync(path.join(wt, 'manifest.json'), JSON.stringify({ slug: 'demo', cast, ...extra }));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  return { repo, wt };
}
const kinds = (r) => r.findings.map((f) => f.kind);

test('the fixture is clean', () => {
  const r = datasafety(FIXTURE);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

test('a first name not in the cast is flagged, and cites the repo doc that names them', () => {
  const { repo, wt } = setup({ page: '<p>Linda confirms. Maya pastes.</p>' });
  try {
    const r = datasafety(wt);
    assert.equal(r.ok, false);
    const f = r.findings.find((x) => x.kind === 'name' && x.text === 'Linda');
    assert.ok(f, JSON.stringify(r.findings));
    assert.match(f.detail, /USER-JOURNEYS\.md:2/);
    assert.ok(!r.findings.some((x) => x.text === 'Maya'), 'cast first names are fine');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('Linda and Kathy possessives are caught too', () => {
  const { repo, wt } = setup({ page: '<p>Kathy’s week list. Linda\'s sheet.</p>' });
  try {
    const t = datasafety(wt).findings.filter((f) => f.kind === 'name').map((f) => f.text).sort();
    assert.deepEqual(t, ['Kathy', 'Linda']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('a cast name that is also in repo data is a collision', () => {
  const { repo, wt } = setup({ page: '<p>Dorothea Vance reserves a drill.</p>', cast: ['Dorothea Vance'] });
  try {
    const r = datasafety(wt);
    assert.ok(r.findings.some((f) => f.kind === 'collision' && /samples\/people\.csv:2/.test(f.detail)), JSON.stringify(r.findings));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('manifest.realNames are blocked, case-insensitively', () => {
  const { repo, wt } = setup({ page: '<p>Built for Langston Construction.</p>', extra: { realNames: ['langston'] } });
  try { assert.ok(kinds(datasafety(wt)).includes('real-name')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('email, phone and street addresses are flagged; names in <style> are not', () => {
  const { repo, wt } = setup({ page: '<style>.linda{color:red}</style><p>mail rosa@example.com or 864-555-0142, 14 Pine St</p>' });
  try {
    const k = kinds(datasafety(wt));
    for (const want of ['email', 'phone', 'address']) assert.ok(k.includes(want), want + ' in ' + k);
    assert.ok(!k.includes('name'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('acknowledged findings stop blocking; unacknowledged ones still do', () => {
  const { repo, wt } = setup({ page: '<p>14 Pine St and 9 Mill Rd</p>', extra: { datasafety: { acknowledged: ['address:14 Pine St'] } } });
  try {
    const r = datasafety(wt);
    assert.equal(r.ok, false);
    assert.deepEqual(r.open.map((f) => f.key), ['address:9 Mill Rd']);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('an empty cast blocks', () => {
  const { repo, wt } = setup({ page: '<p>hello</p>', cast: [] });
  try { assert.ok(kinds(datasafety(wt)).includes('no-cast')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('screenshot mode needs the attestation', () => {
  const { repo, wt } = setup({ page: '<p>hello</p>', extra: { mode: 'shots' } });
  try {
    assert.ok(kinds(datasafety(wt)).includes('attest'));
    const p = path.join(wt, 'manifest.json'); const m = JSON.parse(readFileSync(p, 'utf8')); m.datasafety = { attestNoRealData: true }; writeFileSync(p, JSON.stringify(m));
    assert.ok(!kinds(datasafety(wt)).includes('attest'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
