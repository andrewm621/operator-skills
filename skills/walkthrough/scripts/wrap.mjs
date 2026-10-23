#!/usr/bin/env node
/* Build a walkthrough: inline the runtimes into walkthrough.src.html.

     node wrap.mjs <dir | walkthrough.src.html>

   Writes, next to the source:
     walkthrough.html        the artifact page: no doctype, <title>, the
                             claude:viewport-fit-sides meta, runtimes inlined. This is what gets published.
     .wt/test.html           the same page inside a standards-mode skeleton, so local
                             checks render the way a published page does
     .wt/test.narrow.html    test.html forced to the narrow layout (for a phone-size export or purity run)

   The runtimes are motion-artifact's scenes/motion.js (verbatim) and this skill's
   template/player.js. Nothing is forked: the engine version is pinned in
   manifest.json and lint.mjs fails if it drifts. */

import { readFileSync, writeFileSync, mkdirSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { findSymlink, findMotionDir, engineVersions, TEMPLATE_DIR, resolveTarget, readManifest, isMain } from './_lib.mjs';

export const SKELETON_HEAD = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  + '<style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n</head><body>\n';
export const SKELETON_TAIL = '\n</body></html>\n';

/** A literal </script> inside inlined code would end the block early. */
function safeInline(code, what) {
  if (/<\/script/i.test(code)) throw new Error(`${what} contains "</script"; it cannot be inlined`);
  return code;
}

export function wrap(arg) {
  const target = typeof arg === 'string' ? resolveTarget(arg) : arg;
  const src = readFileSync(target.src, 'utf8');

  const marker = '<!-- wt:runtime -->';
  if (src.split(marker).length !== 2) throw new Error(`${path.basename(target.src)} needs exactly one ${marker}`);
  const markup = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(markup)) throw new Error('the artifact page has no doctype, <html>, <head> or <body>; wrap.mjs adds the skeleton for local checks only');

  const motion = readFileSync(path.join(findMotionDir(), 'scenes', 'motion.js'), 'utf8');
  const player = readFileSync(path.join(TEMPLATE_DIR, 'player.js'), 'utf8');
  const v = engineVersions();
  const inlined = `<script id="wt-motion">\n${safeInline(motion, 'motion.js')}\n</script>\n<script id="wt-player">\n${safeInline(player, 'player.js')}\n</script>`;

  const banner = `<!-- BUILT by wrap.mjs from walkthrough.src.html: motion ${v.motion}, player ${v.player}. Edit the source, not this file. -->\n`;
  const page = banner + src.replace(marker, () => inlined);

  /* .wt/ must be a real directory, any symlink inside it is removed, and nothing we write may be one: a planted
     link would redirect the write, or later make the static server hand out a file outside .wt/. */
  const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
  for (const p of [target.scratch, target.built]) if (isLink(p)) throw new Error(`${p} is a symlink; refusing to build through it (delete it and re-run)`);
  mkdirSync(target.scratch, { recursive: true });
  for (let l; (l = findSymlink(target.scratch)); ) rmSync(l, { force: true });   // drop planted links, keep earlier shots
  for (const p of [target.test, target.testNarrow]) if (isLink(p)) rmSync(p, { force: true });
  writeFileSync(target.built, page);
  writeFileSync(target.test, SKELETON_HEAD + page + SKELETON_TAIL);
  writeFileSync(target.testNarrow, SKELETON_HEAD + '<script>window.__WT_MODE="narrow";</script>\n' + page + SKELETON_TAIL);

  const manifest = readManifest(target);
  const pinned = manifest.engine || {};
  return { target, bytes: Buffer.byteLength(page), engine: v, pinned };
}

if (isMain(import.meta.url)) {
  try {
    const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
    const r = wrap(arg);
    console.log(`  ✓ built ${path.relative(process.cwd(), r.target.built)} (${(r.bytes / 1024).toFixed(1)} KB; motion ${r.engine.motion}, player ${r.engine.player})`);
    console.log(`  ✓ wrote .wt/test.html and .wt/test.narrow.html (standards-mode skeletons for local checks)`);
    for (const k of ['motion', 'player']) {
      if (r.pinned[k] && r.pinned[k] !== r.engine[k]) console.log(`  ! manifest pins ${k} ${r.pinned[k]} but the runtime is ${r.engine[k]}; re-run QA, then stamp.mjs`);
    }
  } catch (e) {
    console.error('wrap: ' + e.message);
    process.exit(1);
  }
}
