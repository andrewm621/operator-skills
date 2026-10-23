import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { framePlan, frameFile, safeName, contactHtml } from '../scripts/shoot.mjs';

const OUT = path.join(path.sep, 'tmp', 'wt-out');

test('a scene id with path traversal stays inside out', () => {
  const meta = { duration: 20000, ids: ['../../escape', 'ok'], scenes: [0, 10000], beats: [0, 3000, 6000, 10000, 13000, 16000] };
  const frames = framePlan(meta, {});
  for (const f of frames) {
    const file = frameFile(OUT, 'light', f.name);
    assert.ok(file.startsWith(OUT + path.sep), file);
    assert.equal(path.dirname(file), OUT);
  }
  assert.ok(frames.some((f) => f.name.includes('escape')), 'the id is still recognisable');
  assert.ok(!frames.some((f) => /[\\/]/.test(f.name)), 'no separators in frame names');
});

test('safeName strips separators and dots', () => {
  assert.equal(safeName('../x/..\\y'), '___x____y');
});

test('frameFile output is always a direct child of out', () => {
  for (const evil of ['../../etc/passwd', '..\\..\\x', '/abs/path', 'a/../../b', '\0', '']) {
    const f = frameFile(OUT, 'dark', evil);
    assert.equal(path.dirname(f), OUT, evil);
    assert.match(path.basename(f), /^dark-[\w-]+\.png$/);
  }
});

test('the contact sheet escapes names', () => {
  const html = contactHtml('light', [{ name: '"><script>alert(1)</script>', t: 0 }], { width: 1280 });
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;'));
});
