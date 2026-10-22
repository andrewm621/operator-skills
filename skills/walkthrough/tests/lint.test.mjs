import test from 'node:test';
import assert from 'node:assert/strict';
import { lint } from '../scripts/lint.mjs';
import { copyFixture, edit, editManifest, rm, quiet, FIXTURE } from './_helpers.mjs';

const run = async (dir) => { const { value, lines } = await quiet(() => lint(dir)); return { r: value, text: lines.join('\n') }; };

test('the fixture passes lint with no warnings', async () => {
  const { r, text } = await run(FIXTURE);
  assert.equal(r.fails, 0, text);
  assert.equal(r.warns, 0, text);
});

const MUTATIONS = [
  ['CSS transition', (h) => h.replace('#cv .btn.dis{', '#cv .btn{transition:opacity .2s}\n#cv .btn.dis{'), /css-time/],
  ['CSS animation', (h) => h.replace('#cv .btn.dis{', '@keyframes x{from{opacity:0}}\n#cv .btn.dis{'), /css-time/],
  ['external script', (h) => h.replace('<!-- wt:runtime -->', '<script src="https://cdn.example.com/x.js"></script>\n<!-- wt:runtime -->'), /network/],
  ['external stylesheet outside Google Fonts', (h) => h.replace('<!-- /wt:fonts -->', '<link rel="stylesheet" href="https://example.com/a.css">\n<!-- /wt:fonts -->'), /network/],
  ['Date.now in an owner', (h) => h.replace('  WT.start();', '  WT.own("clock", function () { var n = Date.now(); });\n  WT.start();'), /purity/],
  ['setInterval in an owner', (h) => h.replace('  WT.start();', '  setInterval(function () {}, 10);\n  WT.start();'), /purity/],
  ['fetch in an owner', (h) => h.replace('  WT.start();', '  fetch("/x");\n  WT.start();'), /purity|network/],
  ['too few scenes', (h) => h.replace(/\{ id: "recap"[\s\S]*?\]\] \}\n/, '').replace('closing: "recap"', 'closing: "return"').replace('marks: { press: 9400, closed: 10100, zero: 11700 } },', 'marks: { press: 9400, closed: 10100, zero: 11700 } }'), /scenes|beats|closing|length/],
  ['beats out of order', (h) => h.replace('[4000, "Typing narrows the shelf as she goes."]', '[9000, "Typing narrows the shelf as she goes."]'), /beats/],
  ['move past the scene end', (h) => h.replace('[10200, 700, "#cardDrill", 0.5, 0.3]', '[12800, 700, "#cardDrill", 0.5, 0.3]'), /moves/],
  ['move to a missing id', (h) => h.replace('[300, 900, "#search", 0.4, 0.5]', '[300, 900, "#searchh", 0.4, 0.5]'), /moves/],
  ['wrong total length', (h) => h.replace('len: 10000,', 'len: 1000,').replace(/beats: \[\[0, "Search, reserve/, 'beats: [[0, "Search, reserve'), /length/],
  ['spec that touches the DOM', (h) => h.replace('WT.define({\n  brand', 'document.title = "x";\nWT.define({\n  brand'), /spec/],
  ['doctype in the artifact page', (h) => '<!doctype html>\n' + h, /contract/],
  ['duplicate id', (h) => h.replace('id="chipFri"', 'id="chipSat"'), /ids/],
  ['over-long caption speed (warning only)', (h) => h.replace('"Typing narrows the shelf as she goes."', '"Typing narrows the whole shelf down to only the matching tools as she keeps on typing one letter after another."'), null],
];

for (const [name, mutate, rule] of MUTATIONS) {
  test(`lint catches: ${name}`, async () => {
    const dir = copyFixture();
    try {
      edit(dir, 'walkthrough.src.html', mutate);
      const { r, text } = await run(dir);
      if (rule) { assert.ok(r.fails > 0, `expected a failure\n${text}`); assert.match(text, rule); }
      else { assert.equal(r.fails, 0, text); assert.ok(r.warns > 0, `expected a warning\n${text}`); }
    } finally { rm(dir); }
  });
}

test('lint catches a pinned label the app no longer has', async () => {
  const dir = copyFixture();
  try {
    edit(dir, 'app-src/PickupPass.tsx', (s) => s.replace(/Pickup pass/g, 'Collection slip'));
    const { r, text } = await run(dir);
    assert.ok(r.fails > 0); assert.match(text, /label "Pickup pass" is not in PickupPass\.tsx/);
  } finally { rm(dir); }
});

test('lint catches a pinned label that is not in the page', async () => {
  const dir = copyFixture();
  try {
    editManifest(dir, (m) => m.labels.push({ text: 'Zebra crossing', file: 'Browse.tsx', scene: 'browse' }));
    edit(dir, 'app-src/Browse.tsx', (s) => s + '\n// Zebra crossing\n');
    const { r, text } = await run(dir);
    assert.ok(r.fails > 0); assert.match(text, /not in the page/);
  } finally { rm(dir); }
});

test('lint fails when an engine pin drifts', async () => {
  const dir = copyFixture();
  try {
    editManifest(dir, (m) => { m.engine.motion = '1.0.0'; });
    const { r, text } = await run(dir);
    assert.ok(r.fails > 0); assert.match(text, /engine\.motion is pinned at 1\.0\.0/);
  } finally { rm(dir); }
});
