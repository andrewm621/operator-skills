import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveDir } from '../scripts/_lib.mjs';

test('serveDir does not serve a sibling directory that merely shares the root as a prefix', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'wt-serve-'));
  const root = path.join(base, 'site'), sibling = path.join(base, 'site-secret');
  mkdirSync(root); mkdirSync(sibling);
  writeFileSync(path.join(root, 'a.txt'), 'ok'); writeFileSync(path.join(sibling, 'x.txt'), 'secret');
  const srv = await serveDir(root);
  try {
    assert.equal(await (await fetch(srv.origin + '/a.txt')).text(), 'ok');
    for (const p of ['/../site-secret/x.txt', '/%2e%2e/site-secret/x.txt']) {
      const r = await fetch(srv.origin + p);
      assert.notEqual(await r.text(), 'secret', p);
    }
  } finally { await srv.close(); rmSync(base, { recursive: true, force: true }); }
});
