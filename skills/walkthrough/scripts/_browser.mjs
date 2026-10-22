/* A tiny headless-browser interface for audit.mjs and shoot.mjs.

     const b = await launchBrowser({ driver: 'auto', session: 'wt-myslug' });
     await b.open(url, { width: 1280, height: 800, scheme: 'light' });
     const value = await b.eval('window.__walk.duration');   // JSON-serializable result
     await b.screenshot('/path/out.png');
     await b.close();

   Two drivers behind it:
     agent-browser  the default on a dev machine: HEADLESS, with its own named --session, so it
                    never touches the user's browser, tabs or windows. Never CDP, never Dia,
                    never Claude-in-Chrome unless the user asked for it by name.
     chrome         drives a throwaway headless Chrome over CDP with its own profile. Used when
                    agent-browser is not installed (CI) or with --driver chrome. */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChrome } from './_lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const execFileP = promisify(execFile);

function haveAgentBrowser() {
  try { execFileSync('agent-browser', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

export async function launchBrowser({ driver = 'auto', session = 'wt-' + process.pid } = {}) {
  let which = driver;
  if (which === 'auto') which = process.env.CI || !haveAgentBrowser() ? 'chrome' : 'agent-browser';
  if (which === 'agent-browser') return agentBrowserDriver(session);
  if (which === 'chrome') return chromeDriver();
  throw new Error(`unknown driver '${driver}' (use agent-browser or chrome)`);
}

/* ---- agent-browser ------------------------------------------------------ */

function agentBrowserDriver(session) {
  // Async on purpose: the caller's static server lives in this process, and a blocking
  // exec would stop it from answering the page load the CLI is waiting on.
  const run = async (args) => (await execFileP('agent-browser', ['--session', session, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
  return {
    name: 'agent-browser (headless, session ' + session + ')',
    async open(url, { width = 1280, height = 800, scheme = 'light' } = {}) {
      await run(['set', 'viewport', String(width), String(height)]);
      await run(['set', 'media', scheme]);
      await run(['open', url]);
    },
    async eval(js) {
      const out = JSON.parse(await run(['eval', '--json', js]));
      if (!out.success) throw new Error('eval failed: ' + (out.error || 'unknown'));
      return out.data.result;
    },
    async screenshot(file) { await run(['screenshot', file]); },
    async close() { try { await run(['close']); } catch { /* already gone */ } },
  };
}

/* ---- direct Chrome over CDP -------------------------------------------- */

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

async function chromeDriver() {
  const port = 9600 + Math.floor(Math.random() * 300);
  const profile = mkdtempSync(path.join(tmpdir(), 'wt-chrome-'));
  const proc = spawn(findChrome(), [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const why = { exited: false, code: null, stderr: '' };
  proc.stderr.on('data', (d) => { why.stderr += d; });
  proc.on('exit', (c) => { why.exited = true; why.code = c; });

  let cdp = null;
  for (let n = 0; n < 100 && !cdp; n++) {
    if (why.exited) throw new Error('Chrome exited (code ' + why.code + ')\n' + why.stderr.trim());
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
        cdp = new CDP(ws);
      }
    } catch { /* not up yet */ }
    if (!cdp) await sleep(100);
  }
  if (!cdp) throw new Error('could not attach to Chrome');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  return {
    name: 'chrome (headless, own profile)',
    async open(url, { width = 1280, height = 800, scheme = 'light' } = {}) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
    },
    async eval(js) {
      const r = await cdp.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async screenshot(file) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    async close() {
      try { cdp.ws.close(); } catch { /* gone */ }
      proc.kill();
      await new Promise((r) => { if (proc.exitCode !== null) return r(); proc.once('exit', r); setTimeout(r, 2000); });
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Poll an expression until it is truthy (or time out). */
export async function waitFor(b, expr, { timeout = 8000, step = 80 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await b.eval(expr); } catch { /* page not ready */ }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for: ' + expr);
    await sleep(step);
  }
}
