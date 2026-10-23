import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL = path.resolve(HERE, '..');
export const FIXTURE = path.join(SKILL, 'fixtures', 'minimal');

/** A throwaway copy of the fixture (without build output). */
export function copyFixture({ git = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-test-'));
  cpSync(FIXTURE, dir, { recursive: true, filter: (s) => !s.includes(`${path.sep}.wt`) && !s.endsWith('walkthrough.html') });
  if (git) {
    // deploy.mjs derives a repo identity from the app repo's root commit
    const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' });
    g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'init');
  }
  return dir;
}
export function edit(dir, file, fn) {
  const p = path.join(dir, file);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}
export function editManifest(dir, fn) {
  const p = path.join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(p, 'utf8'));
  fn(m);
  writeFileSync(p, JSON.stringify(m, null, 2));
}
export const rm = (dir) => rmSync(dir, { recursive: true, force: true });

/** Run fn with console.log captured (the scripts print as they go). */
export async function quiet(fn) {
  const real = console.log; const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try { return { value: await fn(), lines }; } finally { console.log = real; }
}
