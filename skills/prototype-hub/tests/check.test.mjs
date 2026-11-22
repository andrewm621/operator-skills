/* node --test skills/prototype-hub/tests/
   Each test builds a small fictional run in a temp folder, breaks one thing, and confirms the
   check catches it. A clean page must also pass, or the gate is just noise. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { pagesVersion, runCheck, scanCss, scanText } from '../scripts/check.mjs';
import { findChrome } from '../scripts/_cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, '..');
const NEW = path.join(SKILL, 'scripts', 'new.mjs');

const CONFIG = {
  client: 'Northfield Bakery', title: 'Northfield prototypes', slug: 'nf-test',
  sources: ['/tmp/notes.md'], tracks: [{ key: 'orders', title: 'Orders' }], rules: ['No writes'],
  denyTerms: ['Northfield', 'Dana', 'HDR'],
  denyPatterns: [{ pattern: '\\bORD-\\d{5}\\b', why: 'A real order number' }],
  allowPhrases: ['Only if Dana approves'],
  devices: ['desktop', 'phone'],
};

const page = (body, extra = '') => `<!DOCTYPE html><html data-mode="light"><head><meta charset="utf-8"><title>Test page</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="../shared/theme.css"><link rel="stylesheet" href="../kit/kit.css"><link rel="stylesheet" href="../shared/proto.css">${extra}</head><body data-kit>
<main class="page" id="root">${body}</main>
<script src="../shared/data.js"></script><script src="../shared/kit.js"></script>
<script>Kit.mountProtoLabel("Test");</script></body></html>`;

function setup(t, html = page('<h1>Orders</h1>')) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proto-hub-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'run');
  const cfg = path.join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify(CONFIG));
  execFileSync('node', [NEW, out, '--config', cfg]);
  writeFileSync(path.join(out, 'shared', 'data.js'), 'window.PROTO_DATA = { meta: { slug: "nf-test" } };\n');
  mkdirSync(path.join(out, 'orders'));
  writeFileSync(path.join(out, 'orders', 'a.html'), html);
  return out;
}
const rules = (r) => r.failures.map((f) => f.rule);
const hasChrome = !!findChrome();

test('a clean page passes', async (t) => {
  const r = await runCheck(setup(t), { browser: false });
  assert.deepEqual(r.failures, []);
  assert.equal(r.ok, true);
  assert.equal(typeof r.epoch, 'number');
});

test('catches a denied name on screen, and in a code comment', async (t) => {
  const r = await runCheck(setup(t, page('<p>Ask Dana</p><!-- from Northfield -->')), { browser: false });
  assert.equal(rules(r).filter((x) => x === 'deny-term').length, 2);
});

test('deny terms are whole-word and case-sensitive, so CSS class .hdr is not HDR', () => {
  assert.deepEqual(scanText('.hdr { color: red } Danish pastry', CONFIG, 'a.html'), []);
  assert.equal(scanText('Reviewed by HDR', CONFIG, 'a.html').length, 1);
});

test('an allowed phrase passes, but the same name elsewhere still fails', () => {
  assert.deepEqual(scanText('Only if Dana approves', CONFIG, 'a.html'), []);
  assert.equal(scanText('Only if Dana approves. Call Dana.', CONFIG, 'a.html').length, 1);
});

test('catches a denied pattern and a street address', async (t) => {
  const r = await runCheck(setup(t, page('<p>ORD-12345 to 412 Maple Street</p>')), { browser: false });
  assert.ok(rules(r).includes('deny-pattern'));
  assert.ok(rules(r).includes('street-address'));
});

test('catches a CDN, a web font and a remote fetch, static', async (t) => {
  const extra = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">\n<script src="//cdn.example.com/x.js"></script>\n';
  const r = await runCheck(setup(t, page('<script>fetch("https://api.example.com/x")</script>', extra)), { browser: false });
  assert.equal(rules(r).filter((x) => x === 'external-ref').length, 3);
});

test('catches a missing local file and a page with no kit', async (t) => {
  const r = await runCheck(setup(t, '<!DOCTYPE html><title>x</title><img src="../nope.png">'), { browser: false });
  assert.ok(rules(r).includes('broken-ref'));
  assert.ok(rules(r).includes('no-label'));
});

test('catches shared data that names someone real', async (t) => {
  const out = setup(t);
  writeFileSync(path.join(out, 'shared', 'data.js'), 'window.PROTO_DATA = { meta: {}, owner: "Dana" };\n');
  const r = await runCheck(out, { browser: false });
  assert.ok(r.failures.some((f) => f.rule === 'deny-term' && f.page.startsWith('shared')));
});

test('the hub may name people, but must list every page and only real files', async (t) => {
  const out = setup(t);
  writeFileSync(path.join(out, 'hub-data.js'), `window.PROTO_HUB = { meta: { client: "Dana at Northfield" }, tracks: [{ key: "x", options: [{ slug: "gone", file: "orders/gone.html" }] }] };`);
  const r = await runCheck(out, { browser: false });
  assert.ok(rules(r).includes('hub-bad-file'));
  assert.ok(rules(r).includes('hub-missing-page'));
  assert.ok(!rules(r).includes('deny-term'));
});

test('new.mjs refuses a folder that already has files, and a config missing a field', (t) => {
  const out = setup(t);
  const cfg = path.join(path.dirname(out), 'config.json');
  assert.equal(spawnSync('node', [NEW, out, '--config', cfg]).status, 1);
  const bad = path.join(path.dirname(out), 'bad.json');
  writeFileSync(bad, JSON.stringify({ client: 'x' }));
  const r = spawnSync('node', [NEW, path.join(path.dirname(out), 'other'), '--config', bad], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /denyTerms/);
});

test('browser: a clean page passes at every size', { skip: !hasChrome }, async (t) => {
  const r = await runCheck(setup(t, page('<button class="btn" onclick="document.getElementById(\'root\').append(\'done\')">Go</button>')));
  assert.deepEqual(r.failures, []);
});

test('browser: catches a thrown error, sideways scroll and an external request', { skip: !hasChrome }, async (t) => {
  const html = page(`<div style="width:900px;height:20px">wide</div><script>throw new Error("boom")</script>
    <script>var i = new Image(); i.src = "https://tracker.example.com/p.gif"; document.body.appendChild(i);</script>`);
  const r = await runCheck(setup(t, html));
  assert.ok(rules(r).includes('page-error'), 'page-error');
  assert.ok(rules(r).includes('external-request'), 'external-request');
  const overflow = r.failures.filter((f) => f.rule === 'overflow-x');
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0].viewport, 'phone');
});

test('browser: overflow-x hidden does not hide content cut off at the edge', { skip: !hasChrome }, async (t) => {
  const html = page('<style>html, body { overflow-x: hidden; }</style><div class="cutoff" style="width:900px">wide</div>');
  const r = await runCheck(setup(t, html));
  const clipped = r.failures.filter((f) => f.rule === 'clipped-x');
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].viewport, 'phone');
  assert.match(clipped[0].detail, /cutoff/);
});

test('browser: a wide table inside its own scrolling frame is fine', { skip: !hasChrome }, async (t) => {
  const html = page('<div class="scroller"><div class="wide">a wide table</div></div>', '<style>.scroller { overflow-x: auto; } .wide { width: 900px; }</style>');
  const r = await runCheck(setup(t, html));
  assert.deepEqual(r.failures, []);
});

test('browser: an already-selected chip and a jump link are not called dead', { skip: !hasChrome }, async (t) => {
  const html = page(`<button class="chip" aria-pressed="true">Selected</button>
    <button class="btn" onclick="window.scrollTo(0, 800)">Jump down</button><div style="height:3000px"></div>`);
  const r = await runCheck(setup(t, html));
  assert.deepEqual(r.warnings.filter((w) => w.rule === 'possibly-dead-control'), []);
});

test('browser: warns about a dead button and fails a click that throws', { skip: !hasChrome }, async (t) => {
  const html = page(`<button class="btn" id="dead">Get directions</button>
    <button class="btn" onclick="nothing.here()">Save</button>`);
  const r = await runCheck(setup(t, html));
  assert.ok(r.warnings.some((w) => w.rule === 'possibly-dead-control' && /Get directions/.test(w.detail)));
  assert.ok(rules(r).includes('click-error'));
});

/* ---------- The kit gate ---------- */

test('new.mjs scaffolds the vendored kit and a theme.css that imports one vars file', (t) => {
  const out = setup(t);
  assert.ok(readFileSync(path.join(out, 'kit', 'kit.lock.json'), 'utf8').includes('"rev"'));
  const theme = readFileSync(path.join(out, 'shared', 'theme.css'), 'utf8');
  assert.match(theme, /@import url\("\.\.\/kit\/themes\/house\.vars\.css"\);/);
  assert.ok(!existsSync(path.join(out, 'shared', 'tokens.css')), 'tokens.css is gone');
  assert.equal(spawnSync('node', [path.join(out, 'kit', 'render.mjs'), 'verify'], { encoding: 'utf8' }).status, 0);
});

test('new.mjs takes a vendored theme or a client vars file, and refuses an unknown theme', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'proto-hub-theme-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (theme, name) => {
    const cfg = path.join(dir, `${name}.json`);
    writeFileSync(cfg, JSON.stringify({ ...CONFIG, theme }));
    return spawnSync('node', [NEW, path.join(dir, name), '--config', cfg], { encoding: 'utf8' });
  };
  assert.equal(run('paper', 'a').status, 0);
  assert.match(readFileSync(path.join(dir, 'a', 'shared', 'theme.css'), 'utf8'), /kit\/themes\/paper\.vars\.css/);
  cpSync(path.join(SKILL, 'kit', 'themes', 'verdant.vars.css'), path.join(dir, 'copperline.vars.css'));
  assert.equal(run('copperline.vars.css', 'b').status, 0);
  assert.match(readFileSync(path.join(dir, 'b', 'shared', 'theme.css'), 'utf8'), /@import url\("copperline\.vars\.css"\)/);
  assert.ok(existsSync(path.join(dir, 'b', 'shared', 'copperline.vars.css')));
  const bad = run('neon', 'c');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /isn't vendored here/);
  assert.ok(!existsSync(path.join(dir, 'c')));
});

test('kit-lint: an inline style and an unlabelled section fail, through the run\'s own kit/render.mjs', async (t) => {
  const r = await runCheck(setup(t, page('<section><h2>Orders</h2></section><p style="color:red">x</p>')), { browser: false });
  const lint = r.failures.filter((f) => f.rule === 'kit-lint');
  assert.ok(lint.some((f) => /inline style/.test(f.detail) && f.page === 'orders/a.html'), JSON.stringify(lint));
  assert.ok(lint.some((f) => /accessible label/.test(f.detail)));
});

test('kit-verify: an edited kit file fails', async (t) => {
  const out = setup(t);
  writeFileSync(path.join(out, 'kit', 'kit.css'), readFileSync(path.join(out, 'kit', 'kit.css'), 'utf8') + '\n/* mine */\n');
  const r = await runCheck(out, { browser: false });
  assert.ok(r.failures.some((f) => f.rule === 'kit-verify' && /kit\.css/.test(f.detail)), JSON.stringify(r.failures));
});

test('a page\'s own CSS: colours, a :root token block, old token names and old --muted meaning fail', async (t) => {
  const css = '<style>:root { --brand: #2f4a3c; } .x { color: var(--ink); border-color: var(--line-strong); } .y { color: var(--muted); background: rgb(0 0 0); }</style>';
  const r = await runCheck(setup(t, page('<h1>Orders</h1>', css)), { browser: false });
  const got = rules(r);
  assert.ok(got.includes('colour-literal'));
  assert.ok(got.includes('token-block'));
  assert.equal(r.failures.filter((f) => f.rule === 'legacy-token').length, 3, JSON.stringify(r.failures));
  assert.ok(r.failures.some((f) => /--muted is a surface/.test(f.detail)));
});

test('theme vars are fine: var(), color-mix of vars, and --muted as a surface pass', () => {
  assert.deepEqual(scanCss('.a { color: var(--muted-foreground); background: var(--muted); border-color: color-mix(in oklch, var(--primary) 30%, var(--card)); }', 'a.css'), []);
});

test('data-theme as a dark toggle fails; a page missing a kit sheet or data-kit fails', async (t) => {
  const html = page('<h1>Orders</h1>').replace('<html data-mode="light">', '<html data-theme="dark">').replace('<link rel="stylesheet" href="../shared/proto.css">', '').replace('<body data-kit>', '<body>');
  const r = await runCheck(setup(t, html), { browser: false });
  assert.ok(rules(r).includes('data-theme'));
  const noKit = r.failures.filter((f) => f.rule === 'no-kit').map((f) => f.detail).join(' | ');
  assert.match(noKit, /shared\/proto\.css/);
  assert.match(noKit, /data-kit/);
});

test('theme: shared/theme.css that declares tokens or imports a missing file fails', async (t) => {
  const out = setup(t);
  writeFileSync(path.join(out, 'shared', 'theme.css'), '@import url("../kit/themes/nope.vars.css");\n:root { --primary: var(--card); }\n');
  const r = await runCheck(out, { browser: false });
  const theme = r.failures.filter((f) => f.rule === 'theme').map((f) => f.detail).join(' | ');
  assert.match(theme, /nope\.vars\.css, which isn't there/);
  assert.match(theme, /declares tokens/);
});

test('a run with no kit/ fails, and a run made before kit only warns', async (t) => {
  const out = setup(t);
  rmSync(path.join(out, 'kit'), { recursive: true });
  let r = await runCheck(out, { browser: false });
  assert.ok(rules(r).includes('kit-missing'));
  writeFileSync(path.join(out, 'shared', 'tokens.css'), '/* old */');
  r = await runCheck(out, { browser: false });
  assert.ok(!rules(r).includes('kit-missing'));
  assert.ok(r.warnings.some((w) => w.rule === 'legacy-run'));
});

/* The example hub, with a real page behind each option. */
function setupExample(t) {
  const out = setup(t);
  cpSync(path.join(SKILL, 'template', 'hub-data.example.js'), path.join(out, 'hub-data.js'));
  rmSync(path.join(out, 'orders', 'a.html'));
  writeFileSync(path.join(out, 'orders', 'orders-a-one-list.html'), page('<h1>Orders</h1>'));
  mkdirSync(path.join(out, 'delivery'));
  writeFileSync(path.join(out, 'delivery', 'delivery-a-load.html'), page('<h1>Load</h1>'));
  writeFileSync(path.join(out, 'delivery', 'delivery-b-drop.html'), page('<h1>Drop</h1>'));
  return out;
}
const readGate = (out) => {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(path.join(out, 'gate-result.js'), 'utf8'), sandbox);
  return sandbox.window.PROTO_GATE;
};

test('new.mjs leaves a blank gate result, so the hub opens cleanly before the first run', (t) => {
  assert.equal(readGate(setup(t)), null);
});

test('a full run writes the result and a hash of each page, and a partial run leaves it alone', async (t) => {
  const out = setup(t);
  await runCheck(out, { browser: false, pages: ['orders/a.html'] });
  assert.equal(readGate(out), null, 'a run of one page says nothing about the whole set');
  const r = await runCheck(out, { browser: false });
  const g = readGate(out);
  assert.equal(g.version, r.version);
  assert.equal(g.browser, false);
  assert.equal(typeof g.at, 'string');
  assert.ok(g.pages['orders/a.html']);
  assert.ok(g.pages['shared/kit.js'], 'shared files change what a page shows');
});

test('the version follows the pages, not the hub', async (t) => {
  const out = setup(t);
  const one = pagesVersion(out).version;
  writeFileSync(path.join(out, 'hub-data.js'), 'window.PROTO_HUB = { meta: {}, tracks: [] };');
  writeFileSync(path.join(out, 'shared', 'README.md'), 'notes for the builders');
  assert.equal(pagesVersion(out).version, one, 'hub text and builder notes do not change what gets shown');
  writeFileSync(path.join(out, 'orders', 'a.html'), page('<h1>Changed</h1>'));
  assert.notEqual(pagesVersion(out).version, one);
});

test('the hub template loads the example content without errors', { skip: !hasChrome }, async (t) => {
  const out = setupExample(t);
  const r = await runCheck(out, { click: false });
  assert.deepEqual(r.failures, []);
  assert.match(readFileSync(path.join(out, 'index.html'), 'utf8'), /window\.PROTO_HUB|PROTO_HUB/);
});

test('hub: the sign-off blocks, signs, goes out of date, and its record holds up', { skip: !hasChrome }, async (t) => {
  const out = setupExample(t);
  await runCheck(out, { click: false });
  const { launch } = await import('../scripts/_cdp.mjs');
  const browser = await launch();
  t.after(() => browser.close());
  const p = await browser.page({ width: 1180, height: 820, touch: true });
  await p.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const text = (id) => p.eval(`document.getElementById("${id}").textContent`);
  const settle = () => new Promise((r) => setTimeout(r, 400));

  /* A real-device check, a checklist item, an open finding, two directions and one decision. */
  assert.equal(await p.eval(`document.getElementById('signBtn').disabled`), true);
  assert.match(await text('signBadge'), /6 things block this/);
  assert.match(await text('gateLine'), /Gate passed/);

  /* The verbs follow the shape of the track. */
  const verbs = (key) => p.eval(`[...document.querySelectorAll('#${key} .verdict')].slice(0, 3).map((b) => b.textContent).join('/')`);
  assert.equal(await verbs('orders'), 'Keep/Combine/Drop');
  assert.equal(await verbs('delivery'), 'OK/Change/Later');

  await p.eval(`(() => {
    document.querySelector('#direction-orders [data-base-chip="orders"][data-value="orders-a-one-list"]').click();
    document.querySelector('#direction-delivery .verdict[data-slug="delivery-a-load"][data-v="ok"]').click();
    document.querySelector('#direction-delivery .verdict[data-slug="delivery-b-drop"][data-v="change"]').click();
    document.querySelector('[data-decision] .tri[data-s="decided"]').click();
  })()`);
  assert.match(await text('decisionCount'), /0 of 1 sorted/, 'Decided with no answer is not sorted');
  await p.eval(`(() => { const a = document.querySelector('[data-decision] input[id^="ans-"]'); a.value = 'It is 5:30'; a.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await settle();
  assert.match(await text('decisionCount'), /1 of 1 sorted/);
  assert.match(await text('signBadge'), /3 things block this/);

  await p.eval(`(() => { for (let i = 0; i < 9; i++) { const b = [...document.querySelectorAll('#blockerList button')].find((x) => x.textContent !== 'Undo'); if (b) b.click(); } })()`);
  assert.match(await text('signBadge'), /Ready to sign/);
  assert.equal(await p.eval(`document.getElementById('signBtn').disabled`), true, 'it needs a name');
  await p.eval(`(() => { const n = document.getElementById('signName'); n.value = 'Sam Tester'; n.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('signBtn').click(); })()`);
  assert.match(await text('signBadge'), /Signed off/);

  const output = (key) => p.eval(`(() => { document.querySelector('[data-out="${key}"]').click(); return document.getElementById('outText').value; })()`);
  const record = await output('record');
  const data = JSON.parse(record.slice(record.indexOf('```json') + 7, record.lastIndexOf('```')));
  assert.equal(data.signoff.status, 'signed');
  assert.equal(data.signoff.by, 'Sam Tester');
  assert.equal(data.direction[0].base, 'orders-a-one-list');
  assert.equal(data.direction[1].parts[1].call, 'change');
  assert.equal(data.decisions[0].answer, 'It is 5:30');
  assert.match(await output('fix'), /Start from Orders A[\s\S]*Part 2: Change/);
  assert.match(await output('agenda'), /Internal draft[\s\S]*ALREADY DECIDED[\s\S]*It is 5:30/);

  /* Changing a page only counts once the gate has rerun, and then the sign-off names the file. */
  writeFileSync(path.join(out, 'orders', 'orders-a-one-list.html'), page('<h1>Changed</h1>'));
  await runCheck(out, { browser: false });
  await p.reload();
  assert.match(await text('signBadge'), /Out of date/);
  assert.match(await text('signState'), /orders-a-one-list\.html/);
  assert.match(await text('blockerList'), /browser checks/, 'a run with no browser is not enough to sign on');
  assert.deepEqual(p.problems, []);
});
