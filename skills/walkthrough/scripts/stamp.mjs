#!/usr/bin/env node
/* Move a walkthrough's baseline. Run this only after QA passed (lint, audit, purity, frames read).

     node stamp.mjs <dir> [--force]

   Writes into manifest.json:
     builtAtCommit   the app repo's HEAD
     builtAt         today's date
     engine          the runtime versions this walkthrough was QA'd with

   It refuses when the app repo has uncommitted edits to the mirrored files (the baseline
   would point at code that is not committed); --force stamps anyway. It only edits
   manifest.json. It never commits, pushes or publishes. */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveTarget, readManifest, repoRoot, engineVersions, positional, has, isMain } from './_lib.mjs';

function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

export function stamp(arg, { force = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  const target = resolveTarget(arg);
  const manifest = readManifest(target, { required: true });
  const root = repoRoot(target, manifest);
  let head;
  try { head = git(root, ['rev-parse', 'HEAD']); }
  catch { throw new Error(`${root} is not a git repo; nothing to stamp against`); }
  const files = Object.values(manifest.mirrors || {}).flat();
  if (files.length && !force) {
    const dirty = git(root, ['status', '--porcelain', '--', ...files]);
    if (dirty) throw new Error(`mirrored files have uncommitted edits:\n${dirty}\ncommit them first (the baseline must be a real commit), or pass --force`);
  }
  const before = { builtAtCommit: manifest.builtAtCommit || null, engine: manifest.engine || null };
  manifest.builtAtCommit = head;
  manifest.builtAt = today;
  manifest.engine = engineVersions();
  const raw = readFileSync(target.manifestPath, 'utf8');
  writeFileSync(target.manifestPath, JSON.stringify(manifest, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  return { head, before, engine: manifest.engine };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const r = stamp(positional(argv)[0], { force: has(argv, 'force') });
    console.log(`  ✓ stamped manifest.json: builtAtCommit ${r.head.slice(0, 9)} (was ${r.before.builtAtCommit ? r.before.builtAtCommit.slice(0, 9) : 'none'}), motion ${r.engine.motion}, player ${r.engine.player}`);
    console.log('    Review and commit manifest.json yourself; this script never commits.');
  } catch (e) {
    console.error('stamp: ' + e.message);
    process.exit(1);
  }
}
