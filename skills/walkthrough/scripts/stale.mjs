#!/usr/bin/env node
/* Which scenes of a walkthrough no longer match the app?

     node stale.mjs <dir> [--ci] [--json]

   Reads manifest.json:
     builtAtCommit   the app commit the walkthrough was last QA'd against (stamp.mjs writes it)
     repo            the app repo root, relative to the walkthrough dir (default: the dir itself)
     mirrors         { sceneId: [files in the app the scene copies] }
     labels          [{ text, file, scene }] strings copied from the app
     engine          { motion, player } pinned runtime versions

   A scene is STALE when a file it mirrors changed since builtAtCommit (committed or not), was
   renamed or deleted, or one of its labels is no longer in the source. Engine pin drift is
   reported separately (report.engine, and ok becomes false) without marking any single scene
   stale: after a runtime bump the whole walkthrough needs a full QA. This script never moves
   the baseline; only stamp.mjs, after a passing QA, does.

   Exit code: 0 unless --ci, which exits 1 when anything is stale or drifted. */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveTarget, readManifest, repoRoot, engineVersions, positional, has, isMain } from './_lib.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function tryGit(cwd, args) { try { return git(cwd, args); } catch { return null; } }

export function staleReport(arg) {
  const target = resolveTarget(arg);
  const manifest = readManifest(target, { required: true });
  const root = repoRoot(target, manifest);
  const mirrors = manifest.mirrors || {};
  const report = { scenes: {}, problems: [], engine: {}, baseline: manifest.builtAtCommit || null, head: null, stale: [] };
  const scene = (id) => (report.scenes[id] ||= { stale: false, reasons: [] });
  for (const id of Object.keys(mirrors)) scene(id);
  for (const l of manifest.labels || []) if (l.scene) scene(l.scene);

  /* engine drift */
  const actual = engineVersions();
  for (const k of ['motion', 'player']) {
    const pin = (manifest.engine || {})[k];
    if (!pin) report.problems.push(`engine.${k} is not pinned (run stamp.mjs after QA)`);
    else if (pin !== actual[k]) { report.engine[k] = { pinned: pin, actual: actual[k] }; report.problems.push(`engine.${k} drifted: pinned ${pin}, runtime ${actual[k]}; every scene needs a re-shoot`); }
  }

  /* labels no longer in the source */
  for (const l of manifest.labels || []) {
    const f = path.resolve(root, l.file || '');
    const target_ = l.scene ? scene(l.scene) : null;
    const isFile = l.file && existsSync(f) && statSync(f).isFile();   // a missing or empty "file" must not resolve to a directory and crash the read
    if (!isFile) { if (target_) { target_.stale = true; target_.reasons.push(`label "${l.text}": ${l.file || '(no file given)'} is gone or is not a file`); } continue; }
    if (!readFileSync(f, 'utf8').includes(l.text) && target_) { target_.stale = true; target_.reasons.push(`label "${l.text}" is no longer in ${l.file}`); }
  }

  /* file changes since the baseline */
  const base = manifest.builtAtCommit;
  if (!base) {
    report.problems.push('no builtAtCommit in manifest.json: nothing to compare against (run stamp.mjs after a passing QA)');
  } else if (tryGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    report.problems.push(`${root} is not a git repo; cannot diff against ${base}`);
  } else if (tryGit(root, ['cat-file', '-e', base + '^{commit}']) === null) {
    report.problems.push(`baseline commit ${base} is not in this repo (rebased or shallow clone?)`);
  } else {
    report.head = git(root, ['rev-parse', '--short', 'HEAD']);
    for (const [id, files] of Object.entries(mirrors)) {
      if (!files.length) continue;
      const s = scene(id);
      const status = git(root, ['diff', '--name-status', '-M', '--relative', base, 'HEAD', '--', ...files]).split('\n').filter(Boolean);
      for (const line of status) {
        const [st, ...p] = line.split('\t');
        s.stale = true;
        if (st.startsWith('D')) s.reasons.push(`${p[0]} was deleted`);
        else if (st.startsWith('R')) s.reasons.push(`${p[0]} was renamed to ${p[1]}`);
        else s.reasons.push(`${p[0]} changed`);
      }
      const dirty = git(root, ['status', '--porcelain', '--', ...files]).split('\n').filter(Boolean);
      for (const line of dirty) { s.stale = true; s.reasons.push(`${line.slice(3).trim()} has uncommitted edits`); }
      for (const f of files) {
        if (!existsSync(path.resolve(root, f)) && !s.reasons.some((r) => r.includes(f))) { s.stale = true; s.reasons.push(`${f} does not exist`); }
      }
      if (s.stale) {
        const log = tryGit(root, ['log', '--format=%h %s', '-n', '5', `${base}..HEAD`, '--', ...files]);
        if (log) s.commits = log.split('\n');
      }
    }
  }
  report.stale = Object.entries(report.scenes).filter(([, s]) => s.stale).map(([id]) => id);
  report.ok = !report.stale.length && !Object.keys(report.engine).length && !report.problems.length;
  return report;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const r = staleReport(positional(argv)[0]);
    if (has(argv, 'json')) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(`stale ${path.basename(path.resolve(positional(argv)[0]))}  (baseline ${r.baseline ? r.baseline.slice(0, 9) : 'none'}${r.head ? ', HEAD ' + r.head : ''})`);
      for (const [id, s] of Object.entries(r.scenes)) {
        if (!s.stale) { console.log(`  ✓ ${id}: fresh`); continue; }
        console.log(`  ✗ ${id}: STALE`);
        for (const x of s.reasons) console.log(`      - ${x}`);
        for (const c of s.commits || []) console.log(`        ${c}`);
      }
      for (const p of r.problems) console.log(`  ! ${p}`);
      console.log(r.ok ? '\nEvery scene matches the app.' : `\n${r.stale.length} stale scene(s)${r.stale.length ? ': ' + r.stale.join(', ') : ''}.`);
    }
    if (has(argv, 'ci') && !r.ok) process.exit(1);
  } catch (e) {
    console.error('stale: ' + e.message);
    process.exit(1);
  }
}
