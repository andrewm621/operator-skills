#!/usr/bin/env node
/* Static checks for a walkthrough. No browser needed.

     node lint.mjs <dir | walkthrough.src.html>

   Page contract   no doctype/html/head/body, a <title>, the claude:viewport-fit-sides meta,
                   unique ids, the canvas and runtime markers
   Purity          no CSS transition/animation; no timers, clocks, randomness or network in
                   the authored scripts. (motion-artifact's check.mjs enforces the same two
                   CSS/JS rules for its own scenes; it assumes a canvas the size of the page,
                   so it does not fit a page with a shell. Duplicated here on purpose.)
   Spec            the #wt-spec JSON (parsed, never executed): 5-8 scenes, 3-5 beats each (the closing scene
                   is exempt), 60-90 s total, ordered beats, moves/clicks/marks inside the scene,
                   caption reading speed, #selectors that exist
   Size            warn at 150 KB, fail at 500 KB (override: manifest limits.warnKB / limits.failKB)
   Manifest        engine pins match the runtimes; every pinned label is in the page AND in
                   the app source it was copied from (skipped in screenshot mode) */

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveTarget, readManifest, repoRoot, engineVersions, scriptById, styleBlocks, allScripts, ids, decodeEntities, reporter, isMain, TEMPLATE_DIR, findMotionDir } from './_lib.mjs';

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const REQUIRED_IDS = ['cv', 'wtShell', 'wtWrap', 'wtSizer', 'wtPlay', 'wtPrev', 'wtNext', 'wtRestart', 'wtSteps', 'wtDots', 'wtCapTx', 'wtCapEy', 'wtProg', 'wtCur', 'wtRip'];

/** Remove /* *\/ and // comments from JS while leaving string literals alone. */
export function stripJsComments(code) {
  return code.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str || '');
}
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

/** The spec is JSON in <script type="application/json" id="wt-spec">. It is parsed, never executed:
    lint reads files from untrusted repos, and a JS spec would have to be run to be read. */
export function evalSpec(html) {
  const m = /<script\b([^>]*\bid=["']wt-spec["'][^>]*)>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return { error: 'missing <script type="application/json" id="wt-spec"> (the spec is JSON, not code)' };
  if (!/\btype=["']application\/json["']/.test(m[1])) return { error: 'the wt-spec script must have type="application/json" (otherwise the browser tries to run it as JavaScript)' };
  let spec;
  try { spec = JSON.parse(m[2]); }
  catch (e) { return { error: `wt-spec is not valid JSON (no comments, functions or trailing commas): ${e.message}` }; }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: 'wt-spec must be a JSON object' };
  return { spec };
}

const words = (s) => (s.trim().match(/\S+/g) || []).length;

export function lint(arg, opts = {}) {
  const target = resolveTarget(arg);
  const r = reporter('lint');
  const src = readFileSync(target.src, 'utf8');
  const manifest = readManifest(target);
  const name = path.basename(path.dirname(target.src)) + '/' + path.basename(target.src);
  console.log(`lint ${name}`);

  /* ---- page contract ---- */
  const markup = stripHtmlComments(src).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  if (/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(markup)) r.fail('contract', 'the artifact page has no doctype, <html>, <head> or <body>');
  else r.pass('no doctype/html/head/body (artifact page contract)');
  if (!/<title>[^<]+<\/title>/.test(src)) r.fail('contract', 'missing <title>'); else r.pass('has <title>');
  if (!/<meta\s+name="claude:viewport-fit-sides"\s+content="cover"/.test(src)) r.fail('contract', 'missing <meta name="claude:viewport-fit-sides" content="cover">'); else r.pass('has the viewport-fit-sides meta');
  for (const [open, label] of [['<!-- wt:canvas -->', 'wt:canvas'], ['<!-- /wt:canvas -->', '/wt:canvas'], ['<!-- wt:runtime -->', 'wt:runtime']]) {
    if (src.split(open).length !== 2) r.fail('contract', `expected exactly one <!-- ${label} --> marker`);
  }
  const allIds = ids(stripHtmlComments(src));
  const dup = allIds.filter((v, i) => allIds.indexOf(v) !== i);
  if (dup.length) r.fail('ids', `duplicate id(s): ${[...new Set(dup)].join(', ')}`); else r.pass(`${allIds.length} ids, all unique`);
  const missingIds = REQUIRED_IDS.filter((x) => !allIds.includes(x));
  if (missingIds.length) r.fail('chrome', `missing chrome id(s): ${missingIds.join(', ')} (copy template/player.html)`);

  /* ---- no CSS transition / animation ---- */
  const css = [...styleBlocks(src).map(stripCssComments), ...[...src.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1])].join('\n');
  const motionCss = css.match(/\btransition(?:-[a-z]+)?\s*:|\banimation(?:-[a-z-]+)?\s*:|@keyframes/g);
  if (motionCss) r.fail('css-time', `CSS ${[...new Set(motionCss)].join(', ')}: CSS runs on wall-clock time, so frames stop being a function of t. Drive it from an owner.`);
  else r.pass('no CSS transition or animation');

  /* ---- no network ---- */
  const bare = stripHtmlComments(src);
  const urls = [...bare.matchAll(/(?:href|src|action|poster|data|srcset)\s*=\s*["']\s*((?:https?:)?\/\/[^"'\s]+)/gi)].map((m) => m[1])
    .concat([...css.matchAll(/(?:@import\s+(?:url\()?\s*["']?|url\(\s*["']?)((?:https?:)?\/\/[^"')\s]+)/gi)].map((m) => m[1]));
  const external = urls.filter((u) => { try { return !FONT_HOSTS.includes(new URL(u.startsWith('//') ? 'https:' + u : u).hostname); } catch { return true; } });
  if (external.length) r.fail('network', `external reference(s) outside Google Fonts: ${[...new Set(external)].slice(0, 4).join(', ')}. The page must be self-contained.`);
  else r.pass('no external references (Google Fonts excepted)');

  /* ---- authored scripts ---- */
  const authored = allScripts(src).filter((s) => !/\bid=["'](?:wt-theme|wt-motion|wt-player)["']/.test(s.attrs) && !/\btype=["']application\/json["']/.test(s.attrs));
  const authoredJs = stripJsComments(authored.map((s) => s.body).join('\n'));
  const banned = [
    [/\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/, 'reads the clock'],
    [/\bMath\.random\b/, 'uses randomness'],
    [/\bsetInterval\b|\bsetTimeout\b|\brequestAnimationFrame\b|\brequestIdleCallback\b/, 'schedules work (WT owns the clock)'],
    [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b|\bEventSource\b|\bimportScripts\b|\bimport\s*\(/, 'touches the network'],
    [/\blocalStorage\b|\bsessionStorage\b|\bdocument\.cookie\b/, 'persists state'],
  ];
  let clean = true;
  for (const [re, why] of banned) {
    const m = authoredJs.match(re);
    if (m) { r.fail('purity', `authored script ${why}: ${m[0]}. Every frame must be a pure function of t.`); clean = false; }
  }
  if (/<iframe\b/i.test(bare)) { r.fail('network', 'an <iframe> pulls in another page'); clean = false; }
  if (clean) r.pass('authored scripts: no clock, randomness, timers or network');
  if (/\.addEventListener\s*\(/.test(stripJsComments(scriptById(src, 'wt-owners') || ''))) r.warn('purity', 'wt-owners adds an event listener; owners should only paint state for t');
  if (/\.createElement\s*\(|\.appendChild\s*\(|\.insertBefore\s*\(|\.insertAdjacentHTML\s*\(|\.innerHTML\s*=|\.cloneNode\s*\(/.test(stripJsComments(scriptById(src, 'wt-owners') || ''))) r.warn('purity', 'wt-owners builds DOM; build everything up front in markup and toggle it (a cue that creates nodes cannot be scrubbed)');

  /* ---- spec ---- */
  const { spec, error } = evalSpec(src);
  if (error) r.fail('spec', error);
  else lintSpec(spec, src, r);

  /* ---- size ---- */
  const lim = manifest.limits || {};
  const warnKB = lim.warnKB || 150, failKB = lim.failKB || 500;
  let bytes;
  try { bytes = statSync(target.src).size + statSync(path.join(findMotionDir(), 'scenes', 'motion.js')).size + statSync(path.join(TEMPLATE_DIR, 'player.js')).size; } catch { bytes = statSync(target.src).size; }
  const kb = bytes / 1024;
  if (kb >= failKB) r.fail('size', `${kb.toFixed(0)} KB built; the limit here is ${failKB} KB (inline images and fonts are the usual cause)`);
  else if (kb >= warnKB) r.warn('size', `${kb.toFixed(0)} KB built; warning at ${warnKB} KB`);
  else r.pass(`size ${kb.toFixed(0)} KB built (warn ${warnKB}, fail ${failKB})`);

  /* ---- manifest ---- */
  lintManifest(target, manifest, src, r);
  return r;
}

function lintSpec(spec, html, r) {
  const scenes = spec.scenes || [];
  const idSet = new Set(ids(stripHtmlComments(html)));
  if (scenes.length < 5 || scenes.length > 8) r.fail('scenes', `${scenes.length} scenes; a walkthrough has 5-8`);
  else r.pass(`${scenes.length} scenes`);
  const seen = new Set();
  let total = 0, bad = false;
  const closing = spec.closing || null;
  if (closing && scenes.length && scenes[scenes.length - 1].id !== closing) r.fail('closing', `closing scene '${closing}' must be the last scene`);
  for (const sc of scenes) {
    const tag = `scene '${sc.id}'`;
    if (!sc.id || seen.has(sc.id)) { r.fail('scenes', `${tag}: missing or duplicate id`); bad = true; continue; }
    seen.add(sc.id);
    if (!(sc.len > 0)) { r.fail('scenes', `${tag}: len must be a positive number of ms`); bad = true; continue; }
    total += sc.len;
    if (!sc.name || !sc.title) r.fail('scenes', `${tag}: needs name and title`);
    if (!sc.lede) r.warn('scenes', `${tag}: no lede (the narration column will be empty under the title)`);
    const beats = sc.beats || [];
    const isClosing = sc.id === closing;
    if (isClosing ? beats.length < 1 : beats.length < 3 || beats.length > 5) { r.fail('beats', `${tag}: ${beats.length} beats; ${isClosing ? 'the closing scene needs at least 1' : '3-5 per scene'}`); bad = true; }
    let prev = -1;
    beats.forEach((b, i) => {
      if (!Array.isArray(b) || typeof b[0] !== 'number' || typeof b[1] !== 'string') { r.fail('beats', `${tag}: beat ${i + 1} must be [ms, "caption"]`); bad = true; return; }
      if (i === 0 && b[0] !== 0) { r.fail('beats', `${tag}: the first beat must start at 0 or the caption band is blank`); bad = true; }
      if (b[0] <= prev) { r.fail('beats', `${tag}: beat ${i + 1} (${b[0]}) is not after the previous beat`); bad = true; }
      if (b[0] >= sc.len) { r.fail('beats', `${tag}: beat ${i + 1} starts at ${b[0]}, past the scene length ${sc.len}`); bad = true; }
      const end = i + 1 < beats.length ? beats[i + 1][0] : sc.len;
      const wps = words(b[1]) / Math.max(0.001, (end - b[0]) / 1000);
      if (wps > 4) r.warn('reading', `${tag}: beat ${i + 1} is ${words(b[1])} words in ${((end - b[0]) / 1000).toFixed(1)}s (${wps.toFixed(1)} words/s; keep under about 4)`);
      if (b[1].length > 110) r.warn('reading', `${tag}: beat ${i + 1} caption is ${b[1].length} characters; the band shows two lines`);
      prev = b[0];
    });
    const sel = (s, what) => {
      if (typeof s !== 'string') { r.fail('moves', `${tag}: ${what} needs a CSS selector string`); bad = true; return; }
      const m = /^#([\w-]+)$/.exec(s);
      if (m && !idSet.has(m[1])) { r.fail('moves', `${tag}: ${what} targets ${s}, which is not in the page`); bad = true; }
    };
    const moves = sc.moves || [], clicks = sc.clicks || [];
    if (!moves.length && !isClosing) r.warn('moves', `${tag}: no cursor moves`);
    for (const m of moves) {
      if (!(m[0] >= 0) || !(m[1] >= 0) || m[0] + m[1] > sc.len) { r.fail('moves', `${tag}: move to ${m[2]} runs outside 0..${sc.len} (${m[0]}+${m[1]})`); bad = true; }
      sel(m[2], 'a move');
    }
    for (const c of clicks) {
      if (!(c[0] >= 0) || c[0] > sc.len) { r.fail('clicks', `${tag}: click on ${c[1]} at ${c[0]} is outside 0..${sc.len}`); bad = true; }
      sel(c[1], 'a click');
    }
    for (const [k, v] of Object.entries(sc.marks || {})) {
      if (typeof v !== 'number' || v < 0 || v > sc.len) { r.fail('marks', `${tag}: mark '${k}' = ${v} is outside 0..${sc.len}`); bad = true; }
    }
  }
  if (total < 60000 || total > 90000) r.fail('length', `${(total / 1000).toFixed(1)} s total; a walkthrough runs 60-90 s`);
  else r.pass(`${(total / 1000).toFixed(1)} s total`);
  if (!bad && scenes.length) r.pass('beats, moves, clicks and marks are ordered and inside their scenes');
  const c = spec.canvas || {};
  if (!Array.isArray(c.wide) || !Array.isArray(c.narrow)) r.fail('canvas', 'canvas needs wide:[w,h] and narrow:[w,h]');
}

function lintManifest(target, manifest, html, r) {
  const engine = readEngine(manifest, r);
  const labels = manifest.labels || [];
  if (manifest.mode === 'shots') { r.pass('screenshot mode: label check skipped'); return engine; }
  if (!labels.length) { r.warn('labels', 'manifest.json pins no labels; fidelity mode copies real button text, so pin the ones the walkthrough shows'); return engine; }
  const visible = decodeEntities(stripHtmlComments(html));
  const root = repoRoot(target, manifest);
  let bad = false;
  for (const l of labels) {
    if (!visible.includes(l.text)) { r.fail('labels', `label "${l.text}" is pinned but not in the page`); bad = true; }
    if (!l.file) { r.fail('labels', `label "${l.text}" has no source file`); bad = true; continue; }
    const f = path.resolve(root, l.file);
    if (!existsSync(f)) { r.fail('labels', `label "${l.text}": source file ${l.file} not found under ${path.relative(target.dir, root) || '.'}`); bad = true; continue; }
    if (!readFileSync(f, 'utf8').includes(l.text)) { r.fail('labels', `label "${l.text}" is not in ${l.file} any more (the app changed; update the walkthrough or the pin)`); bad = true; }
  }
  if (!bad) r.pass(`${labels.length} pinned labels are in the page and in the app source`);
  for (const sid of Object.keys(manifest.mirrors || {})) {
    const { spec } = evalSpec(html);
    if (spec && !(spec.scenes || []).some((s) => s.id === sid)) r.warn('mirrors', `manifest.mirrors names scene '${sid}', which does not exist`);
  }
  if (!(manifest.cast || []).length) r.warn('cast', 'manifest.json lists no cast; datasafety.mjs cannot tell invented names from real ones');
  return engine;
}

function readEngine(manifest, r) {
  const actual = engineVersions();
  const pin = manifest.engine || {};
  let ok = true;
  for (const k of ['motion', 'player']) {
    if (!pin[k]) { r.warn('engine', `manifest.json does not pin engine.${k} (run stamp.mjs)`); ok = false; }
    else if (pin[k] !== actual[k]) { r.fail('engine', `engine.${k} is pinned at ${pin[k]} but the runtime is ${actual[k]}. Re-run QA (purity, audit, shoot), then stamp.mjs.`); ok = false; }
  }
  if (ok) r.pass(`engine pins match (motion ${actual.motion}, player ${actual.player})`);
  return actual;
}

if (isMain(import.meta.url)) {
  try {
    const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
    process.exitCode = lint(arg).done();
  } catch (e) {
    console.error('lint: ' + e.message);
    process.exit(1);
  }
}
