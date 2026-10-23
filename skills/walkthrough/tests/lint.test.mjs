import test from 'node:test';
import assert from 'node:assert/strict';
import { lint } from '../scripts/lint.mjs';
import { copyFixture, edit, editManifest, rm, quiet, FIXTURE } from './_helpers.mjs';

/** Edit the JSON spec as data. */
const spec = (fn) => (h) => h.replace(/(<script type="application\/json" id="wt-spec">)([\s\S]*?)(<\/script>)/, (m, a, body, c) => { const o = JSON.parse(body); fn(o); return a + '\n' + JSON.stringify(o, null, 1) + '\n' + c; });

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
  ['too few scenes', spec((o) => { o.scenes.splice(1, 3); }), /scenes/],
  ['beats out of order', spec((o) => { o.scenes[0].beats[1][0] = 9000; }), /beats/],
  ['move past the scene end', spec((o) => { o.scenes[0].moves[3][0] = 12800; }), /moves/],
  ['move to a missing id', spec((o) => { o.scenes[0].moves[0][2] = '#searchh'; }), /moves/],
  ['wrong total length', spec((o) => { o.scenes[4].len = 1000; }), /length/],
  ['spec with code in it (not JSON)', (h) => h.replace('<script type="application/json" id="wt-spec">\n{', '<script type="application/json" id="wt-spec">\nWT.define({'), /not valid JSON/],
  ['spec script without type=application/json', (h) => h.replace('<script type="application/json" id="wt-spec">', '<script id="wt-spec">'), /type="application\/json"/],
  ['doctype in the artifact page', (h) => '<!doctype html>\n' + h, /contract/],
  ['duplicate id', (h) => h.replace('id="chipFri"', 'id="chipSat"'), /ids/],
  ['over-long caption speed (warning only)', spec((o) => { o.scenes[0].beats[1][1] = 'Typing narrows the whole shelf down to only the matching tools as she keeps on typing one letter after another.'; }), null],
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

test('a malicious spec is rejected and never executed', async () => {
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const marker = path.join(tmpdir(), 'wt-pwned-' + process.pid);
  const dir = copyFixture();
  try {
    // JS that would write a file if anything ran it, in the places a vm-based reader would have run it
    const evil = `{"scenes":[]} ; this.constructor.constructor("process.mainModule.require('fs').writeFileSync('${marker}','x')")()`;
    edit(dir, 'walkthrough.src.html', (h) => h.replace(/(<script type="application\/json" id="wt-spec">)[\s\S]*?(<\/script>)/, `$1\n${evil}\n$2`));
    const { r, text } = await run(dir);
    assert.ok(r.fails > 0); assert.match(text, /not valid JSON/);
    assert.equal(existsSync(marker), false, 'the spec must never be executed');
    // and a spec that is valid JSON but hostile-looking is just data
    edit(dir, 'walkthrough.src.html', (h) => h.replace(/(<script type="application\/json" id="wt-spec">)[\s\S]*?(<\/script>)/, `$1\n{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":1}},"scenes":[]}\n$2`));
    await run(dir);
    assert.equal({}.polluted, undefined);
  } finally { rm(dir); }
});
