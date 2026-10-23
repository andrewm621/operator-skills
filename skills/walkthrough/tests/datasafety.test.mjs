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
  writeFileSync(path.join(repo, 'docs/USER-JOURNEYS.md'), '# Journeys\nKaren confirms the plan. Brian books hotels.\n');
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
  const { repo, wt } = setup({ page: '<p>Karen confirms. Maya pastes.</p>' });
  try {
    const r = datasafety(wt);
    assert.equal(r.ok, false);
    const f = r.findings.find((x) => x.kind === 'name' && x.text === 'Karen');
    assert.ok(f, JSON.stringify(r.findings));
    assert.match(f.detail, /USER-JOURNEYS\.md:2/);
    assert.ok(!r.findings.some((x) => x.text === 'Maya'), 'cast first names are fine');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('possessives are caught too', () => {
  const { repo, wt } = setup({ page: '<p>Brian’s week list. Karen\'s sheet.</p>' });
  try {
    const t = datasafety(wt).findings.filter((f) => f.kind === 'name').map((f) => f.text).sort();
    assert.deepEqual(t, ['Brian', 'Karen']);
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
  const { repo, wt } = setup({ page: '<p>Built for Acme Builders.</p>', extra: { realNames: ['acme'] } });
  try { assert.ok(kinds(datasafety(wt)).includes('real-name')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('email, phone and street addresses are flagged; names in <style> are not', () => {
  const { repo, wt } = setup({ page: '<style>.karen{color:red}</style><p>mail rosa@example.com or 864-555-0142, 14 Pine St</p>' });
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

/* ---- what gets scanned ---- */
const hasName = (r, w) => r.findings.some((f) => f.kind === 'name' && f.text === w);

test('a name in an owner script string is caught (scripts are scanned raw)', () => {
  const { repo, wt } = setup({ page: '<script id="wt-owners">WT.own("x", function (t) { txt(el, "Karen Smith"); });</script>' });
  try { assert.ok(hasName(datasafety(wt), 'Karen')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('a name in the JSON spec is caught, even after a literal < in a caption', () => {
  const page = '<script type="application/json" id="wt-spec">{"scenes":[{"beats":[[0,"3 < 4 and 5 > 2"],[3000,"Karen books it"]]}]}</script>';
  const { repo, wt } = setup({ page });
  try { assert.ok(hasName(datasafety(wt), 'Karen')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('a < in visible text does not swallow the text after it', () => {
  const { repo, wt } = setup({ page: '<p>2 < 3 Karen waits</p>' });
  try { assert.ok(hasName(datasafety(wt), 'Karen')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('names in attribute values are caught: value, data-*, single-quoted title, bare, aria-label', () => {
  for (const page of ['<input value="Karen">', '<div data-name="Karen"></div>', "<span title='Karen'></span>", '<b alt=Karen></b>', '<i aria-label="Karen"></i>']) {
    const { repo, wt } = setup({ page });
    try { assert.ok(hasName(datasafety(wt), 'Karen'), page); } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('class, id, style, src and href values are not scanned', () => {
  const { repo, wt } = setup({ page: '<a class="Karen" id="Brian" style="--x:Karen" href="/Brian"><img src="/Karen.png"></a>' });
  try { assert.deepEqual(datasafety(wt).findings.filter((f) => f.kind === 'name'), []); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('a name in an HTML comment is caught (comments ship in the page source)', () => {
  const { repo, wt } = setup({ page: '<!-- built for Karen --><p>hi</p>' });
  try { assert.ok(hasName(datasafety(wt), 'Karen')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

/* ---- allow cannot hide a person ---- */
test('manifest.allow cannot hide a given name', () => {
  const { repo, wt } = setup({ page: '<p>Karen Smith</p>', extra: { allow: ['Karen Smith', 'Karen'] } });
  try {
    const r = datasafety(wt);
    assert.ok(hasName(r, 'Karen'), 'still flagged');
    assert.equal(r.findings.filter((f) => f.kind === 'allow').length, 2, 'both entries rejected and reported');
    assert.equal(r.ok, false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('manifest.allow cannot hide a realNames entry (checked on the unfiltered text)', () => {
  const { repo, wt } = setup({ page: '<p>Built for Acme Builders.</p>', extra: { realNames: ['acme'], allow: ['Acme Builders'] } });
  try {
    const k = kinds(datasafety(wt));
    assert.ok(k.includes('real-name')); assert.ok(k.includes('allow'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('only the human acknowledged key clears a name that allow tried to hide', () => {
  const { repo, wt } = setup({ page: '<p>Karen Smith</p>', extra: { allow: ['Karen Smith'], datasafety: { acknowledged: ['name:Karen', 'allow:Karen Smith'] } } });
  try { assert.equal(datasafety(wt).ok, true); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('harmless allow entries still work', () => {
  const { repo, wt } = setup({ page: '<p>Hall B opens at nine. Tile Cutter sale.</p>', extra: { allow: ['Hall B'] } });
  try { assert.equal(kinds(datasafety(wt)).includes('allow'), false); } finally { rmSync(repo, { recursive: true, force: true }); }
});

/* ---- phone numbers ---- */
test('phone formats: parenthesised, bare 10 digits, dashed, dotted, +1 spaced, E.164', () => {
  for (const n of ['(555)123-4567', '5551234567', '555-123-4567', '555.123.4567', '+1 415 555 0132', '+442071838750', '(864) 555-0142']) {
    const { repo, wt } = setup({ page: `<p>call ${n} now</p>` });
    try { assert.ok(kinds(datasafety(wt)).includes('phone'), n); } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('ordinary numbers are not phone numbers', () => {
  const { repo, wt } = setup({ page: '<p>Sat 24, 10 am. 214 tools. 1000 x 560. 2026-10-22. $12.50</p>' });
  try { assert.ok(!kinds(datasafety(wt)).includes('phone')); } finally { rmSync(repo, { recursive: true, force: true }); }
});
