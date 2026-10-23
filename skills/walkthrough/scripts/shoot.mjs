#!/usr/bin/env node
/* Screenshot a walkthrough's resting frames for review.

     node shoot.mjs <dir> [--configs light,dark,phone,tablet] [--scenes id,id] [--beats]
                          [--out <dir>] [--driver agent-browser|chrome] [--session name]

   Per config it drives window.__walk.seek(t) to each frame, waits for fonts, and writes
   PNGs plus a contact sheet. Frames: the first frame, the middle and last beat of each scene
   (every beat with --beats), and the final frame. A "resting" frame is just before the next
   beat starts, when everything has settled.

   Configs: light and dark (1280x800), phone (390x844), tablet (820x1100).
   Pages load from a local http server over wrap.mjs's standards-mode test page, so frames
   render the way the published page does. The browser is headless with its own session:
   never the user's browser. */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveTarget, serveDir, flag, has, positional, isMain } from './_lib.mjs';
import { launchBrowser, waitFor } from './_browser.mjs';
import { wrap } from './wrap.mjs';

export const CONFIGS = {
  light: { width: 1280, height: 800, scheme: 'light', theme: 'light' },
  dark: { width: 1280, height: 800, scheme: 'dark', theme: 'dark' },
  phone: { width: 390, height: 844, scheme: 'light', theme: 'light' },
  tablet: { width: 820, height: 1100, scheme: 'light', theme: 'light' },
};

/** Scene ids come from the page, which may come from an untrusted repo: never let one steer a file path or the contact sheet's markup. */
export const safeName = (s) => String(s).replace(/[^\w-]/g, '_').slice(0, 60) || '_';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The PNG path for a frame, guaranteed to stay inside `out`. */
export function frameFile(out, config, name) {
  const root = path.resolve(out);
  const file = path.resolve(root, `${safeName(config)}-${safeName(name)}.png`);
  if (!file.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${root}: ${file}`);
  return file;
}

/** Frames to shoot, from the page's own metadata. */
export function framePlan(meta, { scenes = null, beats = false } = {}) {
  const frames = [];
  const END = meta.duration;
  const rest = (i) => (i + 1 < meta.beats.length ? meta.beats[i + 1] : END) - 40;
  const sceneOf = (t) => { let k = 0; for (let i = 0; i < meta.scenes.length; i++) if (t >= meta.scenes[i]) k = i; return k; };
  if (!scenes) frames.push({ name: '00-first', t: 0 });
  meta.ids.forEach((id, si) => {
    if (scenes && !scenes.includes(id)) return;
    const idx = meta.beats.map((_, i) => i).filter((i) => sceneOf(meta.beats[i]) === si);
    const picks = beats ? idx.map((i, j) => ({ i, tag: 'b' + (j + 1) }))
      : [...new Set([idx[Math.floor((idx.length - 1) / 2)], idx[idx.length - 1]])].filter((x) => x !== undefined)
        .map((i) => ({ i, tag: i === idx[idx.length - 1] ? 'end' : 'mid' }));
    for (const p of picks) frames.push({ name: `s${si + 1}-${safeName(id)}-${p.tag}`, t: rest(p.i) });
  });
  if (!scenes) frames.push({ name: '99-final', t: END });
  return frames;
}

export function contactHtml(config, frames, size) {
  const cols = size.width >= 1000 ? 3 : 5;
  const imgW = size.width >= 1000 ? 520 : 200;
  const cells = frames.map((f) => `<figure><img src="${encodeURIComponent(`${safeName(config)}-${safeName(f.name)}.png`)}" width="${imgW}"><figcaption>${esc(f.name)}</figcaption></figure>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:14px;background:#222;font:12px system-ui;color:#ddd}main{display:grid;grid-template-columns:repeat(${cols},${imgW}px);gap:14px}figure{margin:0}img{display:block;border:1px solid #444}figcaption{padding:4px 0}</style><main>${cells}</main>`;
}

export async function shoot(arg, opts = {}) {
  const target = resolveTarget(arg);
  wrap(target);
  const out = path.resolve(opts.out || path.join(target.scratch, 'shots'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const configs = (opts.configs || 'light,dark,phone,tablet').split(',').map((s) => s.trim());
  for (const c of configs) if (!CONFIGS[c]) throw new Error(`unknown config '${c}' (${Object.keys(CONFIGS).join(', ')})`);

  const server = await serveDir(target.scratch);
  const outServer = await serveDir(out);
  const b = await launchBrowser({ driver: opts.driver, session: opts.session || 'wt-shoot-' + process.pid });
  const written = [];
  try {
    console.log(`  browser: ${b.name}`);
    for (const c of configs) {
      const cfg = CONFIGS[c];
      await b.open(`${server.origin}/test.html?autoplay=0&theme=${cfg.theme}`, cfg);
      await waitFor(b, 'window.__walk ? true : false');
      try { await waitFor(b, 'document.fonts.status === "loaded"', { timeout: 6000 }); }
      catch { console.log(`  ! [fonts] fonts did not finish loading for ${c}; frames use the fallback stack`); }
      const meta = await b.eval('JSON.stringify({duration:__walk.duration,ids:__walk.ids,scenes:__walk.scenes,beats:__walk.beats})').then(JSON.parse);
      const frames = framePlan(meta, { scenes: opts.scenes ? opts.scenes.split(',') : null, beats: !!opts.beats });
      for (const f of frames) {
        await b.eval(`window.__walk.seek(${f.t}); window.__walk.t`);
        await new Promise((r) => setTimeout(r, 90));
        const file = frameFile(out, c, f.name);
        await b.screenshot(file);
        written.push(file);
      }
      if (!opts.noContact) {
        writeFileSync(path.join(out, `contact-${safeName(c)}.html`), contactHtml(c, frames, cfg));
        const cols = cfg.width >= 1000 ? 3 : 5;
        const rows = Math.ceil(frames.length / cols);
        const cellH = Math.round((cfg.width >= 1000 ? 520 : 200) * cfg.height / cfg.width) + 30;
        const wide = cfg.width >= 1000 ? 1640 : 1100;
        await b.open(`${outServer.origin}/contact-${c}.html`, { width: wide, height: rows * cellH + 30, scheme: 'dark' });
        await new Promise((r) => setTimeout(r, 400));
        const sheet = frameFile(out, 'contact', c);
        await b.screenshot(sheet);
        written.push(sheet);
      }
    }
  } finally {
    await b.close();
    await server.close();
    await outServer.close();
  }
  return written;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const arg = positional(argv, ['configs', 'scenes', 'out', 'driver', 'session'])[0];
    const files = await shoot(arg, {
      configs: flag(argv, 'configs'), scenes: flag(argv, 'scenes'), beats: has(argv, 'beats'),
      out: flag(argv, 'out'), driver: flag(argv, 'driver', 'auto'), session: flag(argv, 'session'),
    });
    for (const f of files) console.log(f);
    console.log(`\n${files.length} files. Read each PNG and note defects before publishing; this script does not judge them.`);
  } catch (e) {
    console.error('shoot: ' + e.message);
    process.exit(1);
  }
}
