/* Shared helpers for the walkthrough scripts. Zero dependencies, Node 22+. */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, '..');
export const TEMPLATE_DIR = path.join(SKILL_DIR, 'template');

/* ---- reporting --------------------------------------------------------- */

export function reporter(name) {
  const r = { fails: 0, warns: 0, passes: 0 };
  r.pass = (msg) => { r.passes++; console.log(`  ✓ ${msg}`); };
  r.fail = (rule, msg) => { r.fails++; console.log(`  ✗ [${rule}] ${msg}`); };
  r.warn = (rule, msg) => { r.warns++; console.log(`  ! [${rule}] ${msg}`); };
  r.done = () => {
    console.log(`\n${name}: ${r.fails} failure${r.fails === 1 ? '' : 's'}, ${r.warns} warning${r.warns === 1 ? '' : 's'}`);
    return r.fails ? 1 : 0;
  };
  return r;
}

/** True when this module is the entry point (so a script can export for tests and still run as a CLI). */
export function isMain(metaUrl) {
  return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === metaUrl;
}

export function flag(argv, name, dflt) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
}
export const has = (argv, name) => argv.includes('--' + name);
/** Positional args: everything that is not a --flag or a flag's value. */
export function positional(argv, valueFlags = []) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { if (valueFlags.includes(argv[i].slice(2))) i++; continue; }
    out.push(argv[i]);
  }
  return out;
}

/* ---- locating things --------------------------------------------------- */

/** The motion-artifact skill folder. The sibling folder wins (a checkout or a
    symlinked skills/ dir); the rest cover a skill copied somewhere on its own. */
export function findMotionDir() {
  const home = homedir();
  const candidates = [
    process.env.MOTION_ARTIFACT_HOME,
    path.resolve(SKILL_DIR, '..', 'motion-artifact'),
    path.join(home, '.claude/skills/operator/motion-artifact'),
    path.join(home, '.codex/skills/motion-artifact'),
    path.join(home, '.cursor/skills/motion-artifact'),
    path.join(home, 'Projects/operator-skills/skills/motion-artifact'),
    path.join(home, 'operator-skills/skills/motion-artifact'),
  ];
  for (const c of candidates) {
    if (c && existsSync(path.join(c, 'scenes', 'motion.js'))) return c;
  }
  throw new Error('motion-artifact not found. Set MOTION_ARTIFACT_HOME to its skill folder (the one containing scenes/motion.js).');
}

export function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(pw)) {
    for (const b of readdirSync(pw).filter((x) => x.startsWith('chromium')).sort().reverse()) {
      for (const leaf of ['chrome-linux/chrome', 'chrome-linux/headless_shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(pw, b, leaf);
        if (existsSync(p)) return p;
      }
    }
  }
  const root = path.join(homedir(), '.cache/puppeteer/chrome-headless-shell');
  if (existsSync(root)) {
    for (const b of readdirSync(root).sort().reverse()) {
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

/** Versions of the two runtimes a walkthrough is built on, read from source. */
export function engineVersions() {
  const motion = readFileSync(path.join(findMotionDir(), 'scenes', 'motion.js'), 'utf8');
  const player = readFileSync(path.join(TEMPLATE_DIR, 'player.js'), 'utf8');
  return {
    motion: (/version:\s*'([^']+)'/.exec(motion) || [])[1] || null,
    player: (/var VERSION = "([^"]+)"/.exec(player) || [])[1] || null,
  };
}

/* ---- a walkthrough directory ------------------------------------------- */

/** Accepts a walkthrough dir or its walkthrough.src.html. */
export function resolveTarget(arg) {
  if (!arg) throw new Error('give a walkthrough directory (or its walkthrough.src.html)');
  const abs = path.resolve(arg);
  if (!existsSync(abs)) throw new Error('no such path: ' + abs);
  const isDir = statSync(abs).isDirectory();
  const dir = isDir ? abs : path.dirname(abs);
  const src = isDir ? path.join(dir, 'walkthrough.src.html') : abs;
  if (!existsSync(src)) throw new Error('no walkthrough.src.html in ' + dir);
  return {
    dir, src,
    built: path.join(dir, 'walkthrough.html'),
    scratch: path.join(dir, '.wt'),
    test: path.join(dir, '.wt', 'test.html'),
    testNarrow: path.join(dir, '.wt', 'test.narrow.html'),
    manifestPath: path.join(dir, 'manifest.json'),
  };
}

export function readManifest(target, { required = false } = {}) {
  if (!existsSync(target.manifestPath)) {
    if (required) throw new Error('missing ' + target.manifestPath);
    return {};
  }
  try { return JSON.parse(readFileSync(target.manifestPath, 'utf8')); }
  catch (e) { throw new Error('manifest.json is not valid JSON: ' + e.message); }
}

/** The app repo root that manifest labels and mirrors are relative to: manifest.repo
    (relative to the walkthrough dir, or absolute) if set, else the git top-level the
    walkthrough lives in (docs/walkthroughs/<slug>/ sits inside the app repo), else the dir. */
export function repoRoot(target, manifest) {
  if (manifest.repo) return path.resolve(target.dir, manifest.repo);
  try {
    return execFileSync('git', ['-C', target.dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return target.dir; }
}

/* ---- tiny HTML helpers -------------------------------------------------- */

export function scriptById(html, id) {
  const m = new RegExp(`<script\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</script>`).exec(html);
  return m ? m[1] : null;
}
export function styleBlocks(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
}
export function allScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
}
export function ids(html) {
  return [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((m) => m[1]);
}
export function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&rarr;/g, '→').replace(/&le;/g, '≤')
    .replace(/&ge;/g, '≥').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/* ---- static server: scripts load pages over http so they behave like a deploy ---- */

export function serveDir(root) {
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' };
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const base = path.resolve(root);
      const file = path.resolve(base, '.' + path.sep + rel);
      if (!file.startsWith(base + path.sep) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}
