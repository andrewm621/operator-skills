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

test('email, phone and street addresses are flagged; selectors in <style> are not names', () => {
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

/* ---- allow cannot hide anything but an address ---- */
const allowCase = (page, allow, extra = {}) => {
  const { repo, wt } = setup({ page, extra: { allow, ...extra } });
  try { return datasafety(wt); } finally { rmSync(repo, { recursive: true, force: true }); }
};

test('manifest.allow cannot hide a given name, by whole phrase, substring or single letter', () => {
  for (const allow of [['Karen Smith'], ['Karen'], ['aren'], ['K'], ['KAREN'], ["Karen's"]]) {
    const r = allowCase('<p>Karen Smith</p>', allow);
    assert.ok(hasName(r, 'Karen'), `allow ${JSON.stringify(allow)} must not hide Karen`);
    assert.equal(r.ok, false);
  }
});

test('manifest.allow cannot hide an email: "@", the domain, or the address itself', () => {
  for (const allow of [['@'], ['acme.com'], ['jdoe@acme.com'], ['jdoe']]) {
    const r = allowCase('<p>mail jdoe@acme.com</p>', allow);
    assert.ok(kinds(r).includes('email'), `allow ${JSON.stringify(allow)} must not hide the email`);
  }
});

test('manifest.allow cannot hide a phone number, listed or by fragment', () => {
  for (const allow of [['555-123-4567'], ['555'], ['-']]) {
    assert.ok(kinds(allowCase('<p>call 555-123-4567</p>', allow)).includes('phone'), JSON.stringify(allow));
  }
});

test('manifest.allow cannot hide a realNames entry', () => {
  const r = allowCase('<p>Built for Acmeco.</p>', ['Acmeco', 'cmeco'], { realNames: ['Acmeco'] });
  assert.ok(kinds(r).includes('real-name'));
});

test('manifest.allow does drop an address finding, but only as a whole word', () => {
  assert.equal(kinds(allowCase('<p>Visit 100 Main St today</p>', ['Main St'])).includes('address'), false);
  assert.equal(kinds(allowCase('<p>Visit 100 Main St today</p>', ['Mai'])).includes('address'), true, 'a fragment is not a whole word');
  assert.equal(kinds(allowCase('<p>Visit 100 Main St today</p>', ['Pine St'])).includes('address'), true);
});

test('the same allow entry that drops an address leaves a name in the same text flagged', () => {
  const r = allowCase('<p>Karen at 100 Main St</p>', ['Main St']);
  assert.equal(kinds(r).includes('address'), false);
  assert.ok(hasName(r, 'Karen'));
});

/* ---- CSS content strings, name list, caps ---- */
test('CSS content strings are scanned: <style> blocks and inline style attributes', () => {
  for (const page of ['<style>.x::after{content:"Karen Smith"}</style><p class="x">hi</p>', "<style>.x::before { content : 'Karen' }</style>", '<p style="content:\'Karen\'">hi</p>']) {
    const { repo, wt } = setup({ page });
    try { assert.ok(hasName(datasafety(wt), 'Karen'), page); } finally { rmSync(repo, { recursive: true, force: true }); }
  }
});

test('ALL-CAPS names are caught', () => {
  const { repo, wt } = setup({ page: '<h1>KAREN APPROVES</h1>' });
  try { assert.ok(hasName(datasafety(wt), 'Karen')); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('the name list is generic data: common names are in it, ordinary words ("Mark final") are not flagged', () => {
  const { repo, wt } = setup({ page: '<p>Sandra and Dorothy. Mark final. Grant access.</p>' });
  try {
    const r = datasafety(wt);
    assert.ok(hasName(r, 'Sandra') && hasName(r, 'Dorothy'));
    assert.ok(!hasName(r, 'Mark') && !hasName(r, 'Grant'));
  } finally { rmSync(repo, { recursive: true, force: true }); }
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

test('script bodies: epoch seconds and timing math are not phones, but a formatted number still is', () => {
  const ok = setup({ page: '<script>var t = 1700000000; var ms = 2000000000 + 1000000000; var n = a+1000000000;</script><p>hi</p>' });
  try { assert.ok(!kinds(datasafety(ok.wt)).includes('phone'), JSON.stringify(datasafety(ok.wt).findings)); } finally { rmSync(ok.repo, { recursive: true, force: true }); }
  const bad = setup({ page: '<script type="application/json" id="wt-spec">{"beats":[[0,"call 555-123-4567"]]}</script>' });
  try { assert.ok(kinds(datasafety(bad.wt)).includes('phone')); } finally { rmSync(bad.repo, { recursive: true, force: true }); }
});

test('a "+" needs a country code to count as a phone', () => {
  const { repo, wt } = setup({ page: '<p>a +0123 4567 8901 b, 3 +1 2 c</p>' });
  try { assert.ok(!kinds(datasafety(wt)).includes('phone')); } finally { rmSync(repo, { recursive: true, force: true }); }
});
