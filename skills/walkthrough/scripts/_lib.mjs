/* Shared helpers for the walkthrough scripts. Zero dependencies, Node 22+. */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
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

/* ---- git, hardened ------------------------------------------------------
   Walkthroughs come from repos we may not trust, and git runs code named in a repo's own
   .git/config (core.fsmonitor, core.hooksPath, core.sshCommand, aliases, pagers, diff.external,
   textconv). Every git call in these scripts goes through gitSafe: execFile with no shell,
   those settings forced off on the command line (which outranks repo config), every
   filter.<name> driver the config defines replaced by a plain `cat`, a scrubbed environment, and
   external diff and textconv drivers disabled by the callers' flags. */

export const GIT_HARDEN = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'safe.bareRepository=explicit',
  '-c', 'core.pager=cat',
  '-c', 'core.sshCommand=false',
  '-c', 'core.editor=false',
  '-c', 'protocol.ext.allow=never',
  '-c', 'diff.external=',
];
/** Flags every diff/log call adds so repo-defined external diff and textconv drivers never run. */
export const GIT_NO_DRIVERS = ['--no-ext-diff', '--no-textconv'];

function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EDITOR', 'GIT_EXEC_PATH', 'GIT_CONFIG_COUNT']) delete env[k];
  return env;
}

/** Names of the filter drivers (clean/smudge/process) the repo or user config defines. Listing config runs nothing. */
function filterOverrides(cwd) {
  let names = [];
  try {
    const out = execFileSync('git', ['-C', cwd, ...GIT_HARDEN, 'config', '--name-only', '--get-regexp', '^filter\\.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv() });
    names = [...new Set(out.split('\n').map((l) => /^filter\.(.+)\.[^.]+$/.exec(l.trim())).filter(Boolean).map((m) => m[1]))];
  } catch { /* no filters, or not a repo */ }
  return names.flatMap((n) => ['-c', `filter.${n}.clean=cat`, '-c', `filter.${n}.smudge=cat`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
}

/** Run git in `cwd`. Throws on a non-zero exit. Returns trimmed stdout. */
export function gitSafe(cwd, args, { stderr = 'ignore', maxBuffer = 256 * 1024 * 1024 } = {}) {
  return execFileSync('git', ['-C', cwd, ...GIT_HARDEN, ...filterOverrides(cwd), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', stderr], env: gitEnv(), maxBuffer }).trim();
}
/** Like gitSafe, but null instead of throwing. */
export function gitTry(cwd, args, opts) { try { return gitSafe(cwd, args, opts); } catch { return null; } }
/** The git top-level that actually contains `dir`, or null. Never derived from manifest.json. */
export function gitTopLevel(dir) { return gitTry(dir, ['rev-parse', '--show-toplevel']); }

/** The first symlink anywhere under `dir` (by lstat, not following), or null. */
export function findSymlink(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return p;
    if (e.isDirectory()) { const f = findSymlink(p); if (f) return f; }
  }
  return null;
}

/** The app repo root that manifest labels and mirrors are relative to.
    Default: the git top-level the walkthrough lives in (docs/walkthroughs/<slug>/ sits inside the
    app repo), else the walkthrough dir. manifest.repo may only narrow that: it must be a relative
    path that stays inside the top-level (or inside the dir when there is no git repo), must not
    escape through symlinks, and must not be a nested repository of its own. A manifest from an
    untrusted repo cannot point the scripts (and so git) at some other directory. */
export function repoRoot(target, manifest) {
  const dirReal = realpathSync(target.dir);
  const top = gitTopLevel(target.dir);
  const topReal = top ? realpathSync(top) : dirReal;
  if (!manifest.repo) return top || target.dir;
  const rel = String(manifest.repo);
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error(`manifest.repo "${rel}" must be a relative path inside the app repo, not an absolute one`);
  const resolved = path.resolve(target.dir, rel);
  if (!existsSync(resolved)) throw new Error(`manifest.repo "${rel}" does not exist`);
  const real = realpathSync(resolved);
  const inside = (p, base) => p === base || p.startsWith(base + path.sep);
  if (!inside(real, topReal)) throw new Error(`manifest.repo "${rel}" resolves outside the repo that contains the walkthrough (${topReal}); refusing`);
  if (real !== topReal && existsSync(path.join(real, '.git'))) throw new Error(`manifest.repo "${rel}" is a nested git repository; refusing`);
  return resolved;
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

/** The real file for a request path, or null. Never follows a symlink: every component below the
    root must lstat as a plain file or directory, and the final realpath must sit under the real root. */
function servePath(root, rel) {
  const base = path.resolve(root);
  let baseReal;
  try { baseReal = realpathSync(base); } catch { return null; }
  const file = path.resolve(base, '.' + path.sep + rel);
  if (!file.startsWith(base + path.sep)) return null;
  try {
    let cur = base;
    for (const part of path.relative(base, file).split(path.sep)) {
      cur = path.join(cur, part);
      if (lstatSync(cur).isSymbolicLink()) return null;
    }
    const real = realpathSync(file);
    if (!real.startsWith(baseReal + path.sep) || !statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

export function serveDir(root) {
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain' };
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let file = null;
      try { file = servePath(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)); } catch { /* malformed URL */ }
      if (!file) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}
