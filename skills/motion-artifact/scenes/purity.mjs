#!/usr/bin/env node
/* Prove a scene is a pure function of time, at the DOM level.

     node purity.mjs scene.html [--samples 14]

   For each sampled t it compares two ways of arriving there:

     warm — one page, seeked forward through the whole timeline, landing on t
     cold — a freshly loaded page, seeked straight to t and nothing else

   If those disagree, some cue depends on *how you reached t* rather than on t.
   Such a scene looks right when played from the start and renders wrong under
   --from/--to, or when someone scrubs backward.

   Why DOM and not pixels: comparing rendered frames across two --from offsets
   is unreliable, because the renderer computes t as `from + f*1000/fps` and in
   IEEE754 that is not bit-identical to `(f+shift)*1000/fps`. A sub-millisecond
   difference moves a tweening element by a subpixel and reports a purity failure
   that isn't one. body.innerHTML carries everything cues write — text, classes
   and inline styles — and compares exactly. */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const scene = argv.find((a) => !a.startsWith('--'));
if (!scene) { console.error('usage: node purity.mjs scene.html [--samples N]'); process.exit(1); }
const i = argv.indexOf('--samples');
const SAMPLES = i === -1 ? 14 : Number(argv[i + 1]);
const absScene = path.resolve(scene);

/* Same search order as render.mjs — kept local so this stays runnable alone. */
async function resolveBrowser() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(pw)) {
    for (const b of (await readdir(pw)).filter((x) => x.startsWith('chromium')).sort().reverse()) {
      for (const leaf of ['chrome-linux/chrome', 'chrome-linux/headless_shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(pw, b, leaf);
        if (existsSync(p)) return p;
      }
    }
  }
  const root = path.join(process.env.HOME || '', '.cache/puppeteer/chrome-headless-shell');
  if (existsSync(root)) {
    for (const b of (await readdir(root)).sort().reverse()) {
      for (const leaf of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64',
        'chrome-headless-shell-linux64', 'chrome-headless-shell-win64']) {
        const p = path.join(root, b, leaf, 'chrome-headless-shell');
        if (existsSync(p)) return p;
        if (existsSync(p + '.exe')) return p + '.exe';
      }
    }
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(p)) return p;
  }
  throw new Error('No Chrome found. Set CHROME_PATH.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        const h = this.handlers.get(m.method); this.handlers.delete(m.method); h(m.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  once(method) { return new Promise((r) => this.handlers.set(method, r)); }
}

const port = 9300 + Math.floor(Math.random() * 300);
const profile = await mkdtemp(path.join(tmpdir(), 'motion-purity-'));
const browser = await resolveBrowser();
const proc = spawn(browser, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--allow-file-access-from-files', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

const why = { exited: false, code: null, stderr: '' };
proc.stderr.on('data', (d) => { why.stderr += d; });
proc.on('exit', (c) => { why.exited = true; why.code = c; });

let cdp;
try {
  for (let n = 0; n < 100 && !cdp; n++) {
    if (why.exited) throw new Error('Chrome exited (code ' + why.code + ')\n' + why.stderr.trim());
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        cdp = new CDP(ws);
      }
    } catch { /* not up yet */ }
    if (!cdp) await sleep(100);
  }
  if (!cdp) throw new Error('could not attach to Chrome');

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__motionExport = true;' });

  async function load() {
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: 'file://' + absScene });
    await loaded;
    for (let n = 0; n < 100; n++) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: 'window.__motion ? String(__motion.duration) : ""', returnByValue: true
      });
      if (r.result.value) return Number(r.result.value);
      await sleep(30);
    }
    throw new Error('scene never exposed window.__motion — did you call scene.mount()?');
  }

  async function seek(t) {
    await cdp.send('Runtime.evaluate', { expression: `window.__motion.seek(${t})` });
  }
  async function snap() {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'document.body.innerHTML', returnByValue: true
    });
    return r.result.value;
  }

  const duration = await load();
  const times = Array.from({ length: SAMPLES }, (_, k) =>
    Math.round((duration * (k + 1)) / (SAMPLES + 1)));

  // warm: one page walked forward, snapshotting as it passes each sample
  const warm = {};
  for (const t of times) { await seek(t); warm[t] = await snap(); }

  // cold: a fresh document per sample, seeked straight there
  const cold = {};
  for (const t of times) { await load(); await seek(t); cold[t] = await snap(); }

  const bad = times.filter((t) => warm[t] !== cold[t]);
  if (!bad.length) {
    console.log(`  ✓ ${path.basename(absScene)} — pure at ${SAMPLES} samples across ${(duration / 1000).toFixed(1)}s`);
    process.exitCode = 0;
  } else {
    console.log(`  ✗ ${path.basename(absScene)} — IMPURE at t=${bad.join(', ')}ms`);
    const t = bad[0];
    const w = warm[t].split('\n'), c = cold[t].split('\n');
    for (let k = 0; k < Math.max(w.length, c.length); k++) {
      if (w[k] !== c[k]) {
        console.log(`\n    first difference at t=${t}ms:`);
        console.log(`      warm (played forward): ${(w[k] || '').trim().slice(0, 150)}`);
        console.log(`      cold (seeked direct):  ${(c[k] || '').trim().slice(0, 150)}`);
        break;
      }
    }
    console.log('\n    A cue is carrying state between seeks. Usual causes: an element');
    console.log('    written by two cues, or a states() entry whose keys leave a property');
    console.log('    unset so the previous value survives.');
    process.exitCode = 1;
  }
} finally {
  try { cdp?.ws.close(); } catch { /* already gone */ }
  proc.kill();
  await new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); setTimeout(r, 2000); });
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
