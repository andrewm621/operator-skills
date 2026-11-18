/* A tiny driver for a throwaway headless Chrome. No dependencies: it uses Node's built-in
   WebSocket. Chrome runs with its own temporary profile, so it never touches the user's
   browser, tabs or sign-ins.

     const browser = await launch();
     const page = await browser.page({ width: 1440, height: 900, touch: false });
     await page.goto('file:///abs/path.html');
     const title = await page.eval('document.title');
     page.problems   // console errors, exceptions, failed loads and blocked external requests
     await page.close();
     await browser.close();
*/

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) || null;
}

/* Dialogs would hang a headless page, and print does nothing useful here. */
const STUBS = `(() => {
  window.alert = () => {}; window.confirm = () => true; window.prompt = () => ''; window.print = () => {};
})();`;

export async function launch() {
  const exe = findChrome();
  if (!exe) throw new Error('No Chrome found. Install Chrome or set CHROME_PATH.');
  const profile = mkdtempSync(path.join(tmpdir(), 'proto-hub-chrome-'));
  const proc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--allow-file-access-from-files',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });

  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  if (!existsSync(portFile)) { proc.kill(); rmSync(profile, { recursive: true, force: true }); throw new Error('Chrome did not start.'); }
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');

  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });

  let nextId = 0;
  const pending = new Map();
  const sessions = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.sessionId && sessions.has(m.sessionId)) {
      sessions.get(m.sessionId)(m.method, m.params);
    }
  });
  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.delete(id)) reject(new Error('Chrome timed out on ' + method)); }, 30000).unref();
    });
  }

  return {
    async page({ width = 1440, height = 900, touch = false } = {}) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const problems = [];
      const externals = new Set();
      const inflight = new Set();
      let loaded = null;
      sessions.set(sessionId, (method, p) => {
        if (method === 'Runtime.exceptionThrown') {
          const d = p.exceptionDetails;
          problems.push({ rule: 'page-error', detail: (d.exception && d.exception.description || d.text || 'Exception').split('\n')[0] });
        } else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
          problems.push({ rule: 'console-error', detail: p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
        } else if (method === 'Log.entryAdded' && p.entry.level === 'error') {
          if (!/ERR_BLOCKED|ERR_FAILED/.test(p.entry.text || '') || !/^https?:/.test(p.entry.url || '')) {
            problems.push({ rule: 'console-error', detail: `${p.entry.text} ${p.entry.url || ''}`.trim().slice(0, 300) });
          }
        } else if (method === 'Fetch.requestPaused') {
          externals.add(p.request.url);
          problems.push({ rule: 'external-request', detail: p.request.url.slice(0, 200) });
          send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
        } else if (method === 'Network.requestWillBeSent') {
          inflight.add(p.requestId);
        } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
          inflight.delete(p.requestId);
          if (method === 'Network.loadingFailed' && !p.canceled && !/BLOCKED|ERR_ABORTED/.test(p.errorText || '')) {
            problems.push({ rule: 'failed-load', detail: `${p.errorText || 'failed'} (${p.type || 'resource'})` });
          }
        } else if (method === 'Page.loadEventFired' && loaded) {
          loaded();
        }
      });
      for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await send(domain + '.enable', {}, sessionId);
      await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }, { urlPattern: 'ws*' }] }, sessionId);
      await send('Page.addScriptToEvaluateOnNewDocument', { source: STUBS }, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);

      const page = {
        problems,
        async goto(url) {
          const done = new Promise((resolve) => { loaded = resolve; setTimeout(resolve, 15000).unref(); });
          await send('Page.navigate', { url }, sessionId);
          await done;
          for (let i = 0; i < 20 && inflight.size; i++) await sleep(50);
          await sleep(200);
        },
        async reload() {
          const done = new Promise((resolve) => { loaded = resolve; setTimeout(resolve, 15000).unref(); });
          await send('Page.reload', {}, sessionId);
          await done;
          await sleep(120);
        },
        async eval(expression) {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
          return r.result.value;
        },
        async screenshot(file) {
          const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
          writeFileSync(file, Buffer.from(data, 'base64'));
        },
        async close() {
          sessions.delete(sessionId);
          await send('Target.closeTarget', { targetId }).catch(() => {});
        },
      };
      return page;
    },
    async close() {
      try { ws.close(); } catch { /* already closed */ }
      proc.kill();
      await sleep(150);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
