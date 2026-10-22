import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wrap } from '../scripts/wrap.mjs';
import { copyFixture, edit, rm, quiet } from './_helpers.mjs';

test('wrap inlines motion.js verbatim and the player, with $$ and $& intact', () => {
  const dir = copyFixture();
  try {
    const r = wrap(dir);
    const built = readFileSync(r.target.built, 'utf8');
    assert.ok(built.includes('Motion Scene Runtime'), 'motion.js inlined');
    assert.ok(built.includes('$$("#wtDots .wt-dot, #wtSteps button")'), 'String.replace must not eat $$ in the runtime');
    assert.ok(!built.includes('<!-- wt:runtime -->'));
    assert.doesNotMatch(built, /^\s*<!doctype/i, 'the artifact page has no doctype');
    const test_ = readFileSync(r.target.test, 'utf8');
    assert.match(test_, /^<!doctype html>/i);
    assert.match(readFileSync(r.target.testNarrow, 'utf8'), /__WT_MODE="narrow"/);
  } finally { rm(dir); }
});

test('wrap refuses a page with a doctype or no runtime marker', () => {
  const dir = copyFixture();
  try {
    edit(dir, 'walkthrough.src.html', (h) => '<!doctype html>\n' + h);
    assert.throws(() => wrap(dir), /no doctype/);
    edit(dir, 'walkthrough.src.html', (h) => h.replace('<!doctype html>\n', '').replace('<!-- wt:runtime -->', ''));
    assert.throws(() => wrap(dir), /wt:runtime/);
  } finally { rm(dir); }
});
