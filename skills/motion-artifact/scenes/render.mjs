#!/usr/bin/env node
/* GENERATED from ../SKILL.md — do not edit here.
   Edit the renderer in SKILL.md, then run: node scenes/sync.mjs */
/* Motion renderer - deterministic frame export for Motion scenes.
   Zero dependencies: drives Chrome over CDP using Node's built-in WebSocket
   (Node 22+) and shells out to ffmpeg.

   This does NOT screen-record. It steps a virtual clock: for each frame it calls
   window.__motion.seek(frameIndex * 1000 / fps), waits two rAFs for paint, and
   captures. Output is identical on a fast desktop and a throttled laptop, and
   you can render 60fps from a machine that could never play it at 60fps.

   Usage:
     node render.mjs scene.html [options]

   Options:
     --format gif|mp4|webm|frames   default gif
     --out <path>                   default <scene>.<ext>
     --fps <n>                      default: scene's fps
     --width / --height <px>        default: scene's declared size
     --dpr <n>                      capture scale factor, default 2 (retina)
     --scale <px>                   output width; height auto. default: --width
     --from / --to <ms>             render a sub-range
     --keep-frames                  don't delete the PNG frames
     --chrome <path>                override the browser binary
*/

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ---- args ------------------------------------------------------------- */

const argv = process.argv.slice(2);
const scenePath = argv.find((a) => !a.startsWith('--'));
if (!scenePath) {
  console.error('usage: node render.mjs scene.html [--format gif|mp4|webm|frames] [--out file]');
  process.exit(1);
}
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
}
function has(name) { return argv.includes('--' + name); }

const format = flag('format', 'gif');
const dpr = Number(flag('dpr', 2));
const absScene = path.resolve(scenePath);
if (!existsSync(absScene)) { console.error('no such scene: ' + absScene); process.exit(1); }

/* ---- locate a browser -------------------------------------------------- */

async function resolveBrowser() {
  const override = flag('chrome');
  if (override) return override;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const root = path.join(process.env.HOME || '', '.cache/puppeteer/chrome-headless-shell');
  if (existsSync(root)) {
    const builds = (await readdir(root)).sort().reverse();
    for (const b of builds) {
      for (const leaf of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64',
        'chrome-headless-shell-linux64', 'chrome-headless-shell-win64']) {
        const p = path.join(root, b, leaf, 'chrome-headless-shell');
        if (existsSync(p)) return p;
        if (existsSync(p + '.exe')) return p + '.exe';
      }
    }
  }
  // Playwright's cache is where a lot of dev boxes and CI images keep Chromium.
  // Same versioned-build-dir shape as the puppeteer cache above.
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(pw)) {
    const builds = (await readdir(pw)).filter((b) => b.startsWith('chromium')).sort().reverse();
    for (const b of builds) {
      for (const leaf of [
        'chrome-linux/chrome',
        'chrome-linux/headless_shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-win/chrome.exe'
      ]) {
        const p = path.join(pw, b, leaf);
        if (existsSync(p)) return p;
      }
    }
  }

  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]) if (existsSync(p)) return p;

  throw new Error('No Chrome found. Pass --chrome <path> or set CHROME_PATH.');
}

/* ---- minimal CDP client ------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    // Killing the browser closes the socket from under us; without a listener
    // that surfaces as an unhandled 'error' and a stack trace on a clean run.
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        const h = this.handlers.get(msg.method);
        if (h) h(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method) {
    return new Promise((resolve) => this.handlers.set(method, (p) => { this.handlers.delete(method); resolve(p); }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, why) {
  for (let i = 0; i < 100; i++) {
    // Chrome exiting immediately (bad flags, missing libs, sandbox refusal) is
    // the common failure. Bail out with what Chrome actually said rather than
    // spending 10s retrying a socket that is never going to open.
    if (why.exited) {
      throw new Error(
        'Chrome exited immediately (code ' + why.code + ').\n' +
        (why.stderr.trim() || '(no stderr)') +
        '\nHint: on a bare container also check for missing shared libraries.'
      );
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        return new CDP(ws);
      }
    } catch { /* browser not up yet */ }
    await sleep(100);
  }
  throw new Error('could not attach to Chrome');
}

/* ---- ffmpeg ------------------------------------------------------------ */

function ffmpeg(args, label) {
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    console.error(String(r.stderr).split('\n').slice(-14).join('\n'));
    throw new Error(`ffmpeg failed (${label})`);
  }
}

/* ---- main -------------------------------------------------------------- */

const browser = await resolveBrowser();
const port = 9500 + Math.floor(Math.random() * 400);
const profile = await mkdtemp(path.join(tmpdir(), 'motion-profile-'));

const proc = spawn(browser, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--no-sandbox',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--allow-file-access-from-files',
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

// Keep Chrome's stderr and exit status so a launch failure can be reported as
// what it actually was, not as a generic "could not attach".
const why = { exited: false, code: null, stderr: '' };
proc.stderr.on('data', (d) => { why.stderr += d; });
proc.on('exit', (code) => { why.exited = true; why.code = code; });

let cdp;
const framesDir = await mkdtemp(path.join(tmpdir(), 'motion-frames-'));

try {
  cdp = await connect(port, why);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Set the export flag before the document runs so the rAF player stays parked.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__motionExport = true;' });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: 'file://' + absScene });
  await loaded;

  // Wait for the scene to call mount()
  let meta = null;
  for (let i = 0; i < 100; i++) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'window.__motion ? JSON.stringify({d:__motion.duration,f:__motion.fps,w:__motion.width,h:__motion.height}) : ""',
      returnByValue: true
    });
    if (r.result.value) { meta = JSON.parse(r.result.value); break; }
    await sleep(50);
  }
  if (!meta) throw new Error('scene never exposed window.__motion - did you call scene.mount()?');

  const width = Number(flag('width', meta.w));
  const height = Number(flag('height', meta.h));
  const fps = Number(flag('fps', meta.f));
  const from = Number(flag('from', 0));
  const to = Number(flag('to', meta.d));
  const outWidth = Number(flag('scale', width));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: false
  });

  const total = Math.max(1, Math.round(((to - from) / 1000) * fps));
  process.stderr.write(`motion: ${total} frames @ ${fps}fps  ${width}x${height} (dpr ${dpr})\n`);

  for (let f = 0; f < total; f++) {
    const t = from + (f * 1000) / fps;
    await cdp.send('Runtime.evaluate', {
      expression: `window.__motion.seek(${t}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
      awaitPromise: true
    });
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true
    });
    await writeFile(path.join(framesDir, `f_${String(f).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (f % 15 === 0 || f === total - 1) process.stderr.write(`\r  frame ${f + 1}/${total}`);
  }
  process.stderr.write('\n');

  const base = absScene.replace(/\.html?$/i, '');
  const pattern = path.join(framesDir, 'f_%05d.png');

  if (format === 'frames') {
    const dest = flag('out', base + '-frames');
    await mkdir(dest, { recursive: true });
    for (const f of await readdir(framesDir)) {
      await writeFile(path.join(dest, f), await (await import('node:fs/promises')).readFile(path.join(framesDir, f)));
    }
    console.log(dest);
  } else if (format === 'gif') {
    const out = flag('out', base + '.gif');
    const palette = path.join(framesDir, 'palette.png');
    const scaleF = `fps=${fps},scale=${outWidth}:-1:flags=lanczos`;
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-vf', `${scaleF},palettegen=stats_mode=diff`, palette], 'palettegen');
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-i', palette, '-lavfi',
      `${scaleF} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      '-loop', '0', out], 'paletteuse');
    console.log(out);
  } else if (format === 'mp4') {
    const out = flag('out', base + '.mp4');
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-vf',
      `scale=${outWidth}:-2:flags=lanczos`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-crf', '18', '-movflags', '+faststart', out], 'x264');
    console.log(out);
  } else if (format === 'webm') {
    const out = flag('out', base + '.webm');
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-vf',
      `scale=${outWidth}:-2:flags=lanczos`, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', out], 'vp9');
    console.log(out);
  } else {
    throw new Error('unknown --format: ' + format);
  }
} finally {
  try { cdp?.ws.close(); } catch { /* already gone */ }
  proc.kill();
  // Chrome keeps flushing its profile for a moment after kill(); deleting it too
  // eagerly throws ENOTEMPTY on a render that already succeeded.
  await new Promise((r) => {
    if (proc.exitCode !== null) return r();
    proc.once('exit', r);
    setTimeout(r, 2000);
  });
  // Cleanup must never fail a render that already wrote its output.
  if (!has('keep-frames') && format !== 'frames') await rm(framesDir, { recursive: true, force: true }).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
