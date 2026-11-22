#!/usr/bin/env node
/* The automated gate. Runs in seconds, so it runs after every build and every fix, instead of
   leaving names, broken pages and overflow for an expensive reviewer to find.

     node check.mjs <out dir> [--pages a.html,b/c.html] [--json] [--no-browser] [--no-click]

   Reads <out dir>/prototype-hub.config.json. Exit 0 when there are no failures, 1 otherwise.

   Static (every prototype page and shared/ file, comments included, since view-source shows them)
     deny-term        a word from config.denyTerms. Case-sensitive, whole word
     deny-pattern     a regex from config.denyPatterns ({ pattern, why })
     street-address   anything shaped like a street address (config.checkStreetAddresses: false to skip)
     external-ref     a page that points at http(s), a CDN or a web font
     broken-ref       a relative src or href whose file isn't there
     no-label         a page that doesn't load shared/kit.js, so it has no prototype label

   Kit (every page and the hub are Theme Core kit pages: shared/theme.css, kit/kit.css, shared/proto.css)
     kit-missing      the run has no kit/ folder (a run made before kit: a warning, legacy-run, instead)
     kit-verify       kit/ no longer matches kit/kit.lock.json (node kit/render.mjs verify)
     kit-lint         node kit/render.mjs check on every page and the hub: an inline style, a colour
                      in markup, an unknown data-block or option, an unsafe link, an unlabelled section
     no-kit           a page that doesn't load the theme, kit.css and proto.css, or has no data-kit
     theme            shared/theme.css is missing, imports a file that isn't there, or declares tokens
     colour-literal   a hex, rgb(), hsl() or oklch() colour in a page's <style> or a shared .css file
     token-block      a :root rule that declares custom properties (the theme holds every token)
     legacy-token     a name from the deleted tokens.css (--paper, --ink, --forest ...), or --muted /
                      --accent read as a text colour (in Theme Core they are surfaces)
     data-theme       data-theme used for light/dark; kit reads data-mode on <html>

   Hub
     hub-data         hub-data.js doesn't load, or has no meta or tracks
     hub-bad-file     an option's file doesn't exist
     hub-missing-page a prototype page the hub doesn't list

   Browser (a throwaway headless Chrome, every page at every device in config.devices)
     page-error, console-error, failed-load, external-request, overflow-x, no-title
     clipped-x        content cut off at the screen edge, which overflow-x: hidden would otherwise hide
     click-error      a click on a control threw
     Warnings, not failures: small-target (touch sizes only), possibly-dead-control

   Allowed exceptions: config.allowPhrases are removed from the text before the deny checks,
   for a required label that has to name someone.

   A full run (no --pages) also writes <out dir>/gate-result.js, which the hub reads from file://:
   the result plus a hash of every page and shared file. That hash is what a sign-off is tied to.
   A browser can't hash the pages itself, so the hub only sees a page change after the gate reruns. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

export const DEVICES = {
  desktop: { width: 1440, height: 900, touch: false },
  ipadL: { width: 1180, height: 820, touch: true },
  ipadP: { width: 820, height: 1180, touch: true },
  phone: { width: 390, height: 844, touch: true },
};

const MAX_REPORTED = 60;
const NOT_PAGES = new Set(['index.html']);
const INTERNAL_FILES = new Set(['README.md']);
const STREET = /\b\d{2,5}\s+[A-Z][a-z]+(?:\s[A-Z][a-z]+)?\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Hwy|Highway)\b/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

export function loadConfig(out) {
  const file = path.join(out, 'prototype-hub.config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/* What the kit gate reads. Names from the deleted tokens.css, mapped to what replaces them. */
const LEGACY_TOKENS = {
  paper: 'background', ink: 'foreground', forest: 'primary', 'forest-dark': 'foreground', 'on-forest': 'primary-foreground',
  over: 'destructive', 'over-ink': 'tone-destructive-fg', 'over-tint': 'tone-destructive-bg', under: 'success',
  'under-tint': 'tone-success-bg', pin: 'warning', 'pin-ink': 'tone-warning-fg', 'pin-tint': 'tone-warning-bg',
  manual: 'info', 'manual-tint': 'tone-info-bg', 'neutral-tint': 'secondary', line: 'border', 'line-strong': 'input',
  'font-sans': 'kit-body-font', 'font-serif': 'kit-heading-font', 'font-mono': 'kit-mono-font', 'radius-sm': 'proto-radius-sm',
  target: 'kit-target', 'border-w': 'proto-line', 'label-space': 'proto-label-space',
};
const LEGACY_RE = new RegExp(`var\\(\\s*--(${Object.keys(LEGACY_TOKENS).map(escapeRe).join('|')})\\s*[,)]`, 'g');
const OLD_MEANING = /(?:^|[;{\s])(?:color|fill|stroke|text-decoration-color|caret-color)\s*:\s*var\(\s*--(muted|accent)\s*\)/g;
const COLOUR_VALUE = /:[^;{}]*?(#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\()/g;
const TOKEN_BLOCK = /:root\b[^{]*\{[^}]*--[\w-]+\s*:/;

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/* The CSS a page carries: its <style> blocks, as [offset, css] so line numbers hold. */
function styleBlocks(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => [m.index + m[0].indexOf(m[1]), m[1]]);
}

/* Colours, token blocks and old token names in one page's CSS (or one shared .css file). */
export function scanCss(text, file, blocks = [[0, text]]) {
  const failures = [];
  for (const [offset, css] of blocks) {
    const at = (i) => lineAt(text, offset + i);
    for (const m of css.matchAll(COLOUR_VALUE)) failures.push({ page: file, rule: 'colour-literal', line: at(m.index), detail: `${m[1]}${m[1].endsWith('(') ? '...)' : ''}: colours come from the theme; use a Theme Core var such as var(--primary)` });
    const block = TOKEN_BLOCK.exec(css);
    if (block) failures.push({ page: file, rule: 'token-block', line: at(block.index), detail: 'a :root rule declares custom properties; tokens come from the theme in shared/theme.css' });
    for (const m of css.matchAll(LEGACY_RE)) failures.push({ page: file, rule: 'legacy-token', line: at(m.index), detail: `--${m[1]} was removed with tokens.css; use var(--${LEGACY_TOKENS[m[1]]})` });
    for (const m of css.matchAll(OLD_MEANING)) failures.push({ page: file, rule: 'legacy-token', line: at(m.index), detail: `--${m[1]} is a surface in Theme Core; text uses var(--${m[1]}-foreground)` });
  }
  return failures;
}

/* The theme every page loads first: an @import of a vars file that exists, and nothing else. */
export function checkTheme(out) {
  const file = path.join(out, 'shared', 'theme.css');
  if (!existsSync(file)) return [{ page: 'shared/theme.css', rule: 'theme', detail: 'missing; new.mjs writes it from config.theme' }];
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = [...css.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s]+)["']?\s*\)?/g)].map((m) => m[1]);
  const failures = [];
  if (imports.length !== 1 || !imports[0].endsWith('.vars.css')) failures.push({ page: 'shared/theme.css', rule: 'theme', detail: 'must @import exactly one <slug>.vars.css' });
  for (const href of imports) if (!existsSync(path.resolve(out, 'shared', href))) failures.push({ page: 'shared/theme.css', rule: 'theme', detail: `imports ${href}, which isn't there` });
  if (/--[\w-]+\s*:/.test(css)) failures.push({ page: 'shared/theme.css', rule: 'theme', detail: 'declares tokens; it only imports the theme' });
  return failures;
}

/* The run's vendored kit: verify the copy, and lint every page and the hub with it. */
export function checkKit(out, files) {
  const render = path.join(out, 'kit', 'render.mjs');
  if (!existsSync(render)) {
    const legacy = existsSync(path.join(out, 'shared', 'tokens.css'));
    return legacy
      ? { failures: [], warnings: [{ page: 'kit/', rule: 'legacy-run', detail: 'made before kit (shared/tokens.css, no kit/); kit checks skipped. New runs from new.mjs are on kit' }] }
      : { failures: [{ page: 'kit/', rule: 'kit-missing', detail: 'no kit/render.mjs; new.mjs copies the skill\'s kit/ into every run' }], warnings: [] };
  }
  const node = (args) => spawnSync(process.execPath, [render, ...args], { cwd: out, encoding: 'utf8' });
  const failures = [];
  const verify = node(['verify']);
  if (verify.status !== 0) {
    const lines = verify.stderr.split('\n').filter((l) => /^\s+(missing|edited)\s/.test(l)).map((l) => l.trim());
    failures.push({ page: 'kit/', rule: 'kit-verify', detail: `kit/ differs from kit.lock.json: ${lines.join('; ') || verify.stderr.trim().split('\n').pop()}` });
  }
  if (files.length) {
    const lint = node(['check', ...files]);
    let current = null;
    for (const line of `${lint.stdout}\n${lint.stderr}`.split('\n')) {
      const head = /^(.+?): \d+ problem\(s\)$/.exec(line);
      if (head) { current = head[1]; continue; }
      const problem = /^\s+line (\d+): (.*)$/.exec(line);
      if (problem && current) failures.push({ page: current, rule: 'kit-lint', line: Number(problem[1]), detail: problem[2] });
    }
    if (lint.status !== 0 && !failures.some((f) => f.rule === 'kit-lint')) failures.push({ page: 'kit/', rule: 'kit-lint', detail: (lint.stderr || lint.stdout).trim().split('\n').pop() });
  }
  return { failures, warnings: [] };
}

/* A version for what a reviewer actually looked at: the prototype pages and shared/.
   The hub's own files are left out, because rewording a note doesn't change what gets shown. */
export function pagesVersion(out, files = walk(out)) {
  const tracked = files
    .filter((f) => (f.endsWith('.html') && !NOT_PAGES.has(f)) || ((f.startsWith('shared' + path.sep) || f.startsWith('kit' + path.sep)) && !INTERNAL_FILES.has(path.basename(f))))
    .sort();
  const pages = {};
  for (const f of tracked) pages[f.split(path.sep).join('/')] = createHash('sha256').update(readFileSync(path.join(out, f))).digest('hex').slice(0, 16);
  return { version: createHash('sha256').update(JSON.stringify(pages)).digest('hex').slice(0, 8), pages };
}

const GATE_FILE = 'gate-result.js';

function writeGateResult(out, data) {
  writeFileSync(path.join(out, GATE_FILE), `/* Written by check.mjs. Don't edit: run the check again. */\nwindow.PROTO_GATE = ${JSON.stringify(data)};\n`);
}

/* Removes the allowed phrases, then scans what's left line by line. */
export function scanText(text, config, file) {
  const failures = [];
  let clean = text;
  for (const phrase of config.allowPhrases || []) clean = clean.split(phrase).join(' ');
  const lines = clean.split('\n');
  const report = (rule, line, detail) => failures.push({ page: file, rule, line, detail });

  const terms = (config.denyTerms || []).map((t) => ({ t, re: new RegExp(`(?<![\\w-])${escapeRe(t)}(?![\\w-])`) }));
  const patterns = (config.denyPatterns || []).map((p) => ({ why: p.why || p.pattern, re: new RegExp(p.pattern) }));
  lines.forEach((line, i) => {
    for (const { t, re } of terms) if (re.test(line)) report('deny-term', i + 1, `"${t}" on this line: ${line.trim().slice(0, 120)}`);
    for (const { why, re } of patterns) if (re.test(line)) report('deny-pattern', i + 1, `${why}: ${line.trim().slice(0, 120)}`);
    if (config.checkStreetAddresses !== false && STREET.test(line)) report('street-address', i + 1, line.trim().slice(0, 120));
    if (/(?:src|href)\s*[:=]\s*["'`](?:https?:)?\/\//i.test(line)
      || /url\(\s*["']?https?:/i.test(line)
      || /@import\s+(?:url\()?["']?https?:/i.test(line)
      || /(?:fetch|XMLHttpRequest|EventSource|WebSocket|sendBeacon)\(\s*["'`](?:https?|wss?):/i.test(line)) {
      report('external-ref', i + 1, line.trim().slice(0, 120));
    }
  });
  return failures;
}

function checkPageFile(out, page, config) {
  const text = readFileSync(path.join(out, page), 'utf8');
  const failures = scanText(text, config, page);
  for (const m of text.matchAll(/\b(?:src|href)="([^"#:?]+)(?:[?#][^"]*)?"/g)) {
    if (!existsSync(path.resolve(out, path.dirname(page), m[1]))) failures.push({ page, rule: 'broken-ref', detail: m[1] });
  }
  if (!/shared\/kit\.js/.test(text)) failures.push({ page, rule: 'no-label', detail: 'does not load shared/kit.js, so the page has no prototype label or Reset demo' });
  failures.push(...kitPageFailures(text, page));
  return failures;
}

/* A page (or the hub) on kit: the three sheets, data-kit, its own CSS free of colours and old tokens, no data-theme. */
export function kitPageFailures(text, page) {
  const failures = [];
  const missing = ['shared/theme.css', 'kit/kit.css', 'shared/proto.css'].filter((sheet) => !new RegExp(`href="[^"]*${escapeRe(sheet)}"`).test(text));
  if (missing.length) failures.push({ page, rule: 'no-kit', detail: `doesn't load ${missing.join(', ')}` });
  if (!/<body\b[^>]*\sdata-kit\b/.test(text)) failures.push({ page, rule: 'no-kit', detail: '<body> has no data-kit, so kit.css does not apply' });
  failures.push(...scanCss(text, page, styleBlocks(text)));
  const theme = /\bdata-theme\s*=|\[data-theme\b|dataset\.theme\b|["']data-theme["']\s*,/.exec(text);
  if (theme) failures.push({ page, rule: 'data-theme', line: lineAt(text, theme.index), detail: 'light/dark is data-mode on <html> (light | dark | auto); data-theme does nothing on kit' });
  return failures;
}

export function checkHub(out, pages) {
  const file = path.join(out, 'hub-data.js');
  if (!existsSync(file)) return [];
  const failures = [];
  const sandbox = { window: {} };
  try { vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { timeout: 2000 }); }
  catch (e) { return [{ page: 'hub-data.js', rule: 'hub-data', detail: `doesn't load: ${e.message}` }]; }
  const hub = sandbox.window.PROTO_HUB;
  if (!hub || !hub.meta || !Array.isArray(hub.tracks)) return [{ page: 'hub-data.js', rule: 'hub-data', detail: 'needs window.PROTO_HUB with meta and tracks' }];
  const listed = new Set();
  for (const track of hub.tracks) {
    for (const option of track.options || []) {
      listed.add(option.file);
      if (!option.file || !existsSync(path.join(out, option.file))) failures.push({ page: 'hub-data.js', rule: 'hub-bad-file', detail: `${option.slug}: ${option.file}` });
    }
  }
  for (const page of pages) if (!listed.has(page)) failures.push({ page: 'hub-data.js', rule: 'hub-missing-page', detail: page });
  return failures;
}

/* Clicks each control on a fresh copy of the page. A click that changes nothing may be a dead control. */
async function probeClicks(page, url, name, report, warn, limit) {
  const SELECT = `[...document.querySelectorAll('button, [role=button], a[href="#"]')].filter((e) => {
    const r = e.getBoundingClientRect();
    /* A control already showing as selected is expected to do nothing when tapped again. */
    const active = ['aria-pressed', 'aria-selected', 'aria-current'].some((a) => { const v = e.getAttribute(a); return v && v !== 'false'; }) || e.classList.contains('is-active');
    return r.width > 0 && r.height > 0 && !e.disabled && !active && e.getAttribute('aria-disabled') !== 'true' && !e.classList.contains('proto-reset');
  })`;
  const total = await page.eval(`${SELECT}.length`);
  const count = Math.min(total, limit);
  if (total > limit) warn({ page: name, rule: 'click-cap', detail: `clicked the first ${limit} of ${total} controls` });
  for (let i = 0; i < count; i++) {
    const before = page.problems.length;
    const result = await page.eval(`(async () => {
      const list = ${SELECT}; const e = list[${i}];
      if (!e) return { gone: true };
      const label = (e.innerText || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 50);
      /* A jump link only moves the page, so the scroll position counts as a change. */
      const snap = () => document.body.innerHTML + location.href + '|' + scrollY + '|' + scrollX + '|' + (document.activeElement && document.activeElement.tagName === 'INPUT' ? 'focus' : '');
      const was = snap();
      e.click();
      await new Promise((r) => setTimeout(r, 90));
      return { label, changed: snap() !== was };
    })()`).catch((e) => ({ label: `control ${i}`, changed: true, threw: e.message }));
    for (const problem of page.problems.slice(before)) report({ page: name, rule: 'click-error', detail: `after "${result.label}": ${problem.detail}` });
    if (result.gone) continue;
    if (result.changed) {
      await page.eval('try { localStorage.clear(); } catch (e) {}').catch(() => {});
      await page.goto(url);
    } else {
      warn({ page: name, rule: 'possibly-dead-control', detail: `"${result.label}" changed nothing on screen` });
    }
  }
}

async function checkInBrowser(out, pages, config, opts) {
  const { launch } = await import('./_cdp.mjs');
  const failures = [];
  const warnings = [];
  const deviceKeys = (config.devices || Object.keys(DEVICES)).filter((k) => DEVICES[k]);
  const browser = await launch();
  try {
    for (const name of pages) {
      const url = pathToFileURL(path.resolve(out, name)).href;
      for (const key of deviceKeys) {
        const d = DEVICES[key];
        const page = await browser.page(d);
        await page.goto(url);
        const m = await page.eval(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, title: document.title,
          /* overflow-x: hidden on the page hides the scrollbar, not the problem, so look for what got cut off.
             Anything inside its own scrolling or clipping box is fine: that's a deliberate frame. */
          clipped: (() => {
            const cw = document.documentElement.clientWidth, out = [];
            for (const e of document.body.querySelectorAll('*')) {
              const r = e.getBoundingClientRect();
              if (!r.width || !r.height || r.right <= cw + 2 || r.left >= cw) continue;
              const s = getComputedStyle(e);
              if (s.position === 'fixed' || s.visibility === 'hidden') continue;
              let framed = false;
              for (let a = e.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
                const o = getComputedStyle(a).overflowX;
                if (o !== 'visible') { framed = true; break; }
                if (getComputedStyle(a).position === 'fixed') { framed = true; break; }
              }
              if (!framed) { out.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : '') + ' ends at ' + Math.round(r.right) + 'px'); if (out.length >= 3) break; }
            }
            return out;
          })(),
          small: [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button]')].filter((e) => {
            const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 40 || r.width < 40) && !e.closest('p, li, td, .small');
          }).slice(0, 4).map((e) => (e.innerText || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 30)) })`);
        for (const problem of page.problems) failures.push({ page: name, viewport: key, rule: problem.rule, detail: problem.detail });
        if (m.sw > m.cw + 2) failures.push({ page: name, viewport: key, rule: 'overflow-x', detail: `page is ${m.sw}px wide in a ${m.cw}px screen` });
        else if (m.clipped.length) failures.push({ page: name, viewport: key, rule: 'clipped-x', detail: `cut off at the ${m.cw}px screen edge: ${m.clipped.join('; ')}` });
        if (!m.title.trim()) failures.push({ page: name, viewport: key, rule: 'no-title', detail: 'empty <title>' });
        if (d.touch && m.small.length) warnings.push({ page: name, viewport: key, rule: 'small-target', detail: `under 40px: ${m.small.join(', ')}` });
        if (opts.click && key === deviceKeys[0] && !NOT_PAGES.has(name)) {
          await probeClicks(page, url, name, (f) => failures.push(f), (w) => warnings.push(w), config.clickLimit || 30);
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { failures, warnings };
}

/* The same problem at four sizes is one problem to fix. */
function collapse(list) {
  const seen = new Map();
  for (const item of list) {
    const key = `${item.page}|${item.rule}|${item.line || ''}|${item.detail}`;
    if (seen.has(key)) {
      if (item.viewport) seen.get(key).viewport += `, ${item.viewport}`;
    } else {
      seen.set(key, { ...item });
    }
  }
  return [...seen.values()];
}

export async function runCheck(out, opts = {}) {
  const config = loadConfig(out);
  const files = walk(out);
  const allPages = files.filter((f) => f.endsWith('.html') && !NOT_PAGES.has(f));
  const pages = opts.pages || allPages;
  const missing = pages.filter((p) => !existsSync(path.join(out, p)));

  let failures = missing.map((p) => ({ page: p, rule: 'missing-page', detail: 'file not found' }));
  const present = pages.filter((p) => !missing.includes(p));
  for (const page of present) failures.push(...checkPageFile(out, page, config));
  for (const file of files.filter((f) => f.startsWith('shared' + path.sep) && !INTERNAL_FILES.has(path.basename(f)))) {
    const text = readFileSync(path.join(out, file), 'utf8');
    failures.push(...scanText(text, config, file));
    if (file.endsWith('.css') && !file.endsWith('.vars.css')) failures.push(...scanCss(text, file.split(path.sep).join('/')));
  }
  const hubPage = !opts.pages && existsSync(path.join(out, 'index.html')) ? ['index.html'] : [];
  if (hubPage.length) failures.push(...kitPageFailures(readFileSync(path.join(out, 'index.html'), 'utf8'), 'index.html'));
  failures.push(...checkTheme(out));
  const kit = checkKit(out, [...present, ...hubPage]);
  failures.push(...kit.failures);
  if (!opts.pages) failures.push(...checkHub(out, allPages));

  let warnings = [...kit.warnings];
  if (opts.browser !== false) {
    const hub = !opts.pages && existsSync(path.join(out, 'index.html')) && existsSync(path.join(out, 'hub-data.js')) ? ['index.html'] : [];
    /* The hub loads this file, so it has to exist before the hub is opened in the browser check. */
    if (hub.length && !existsSync(path.join(out, GATE_FILE))) writeGateResult(out, null);
    const seen = await checkInBrowser(out, [...present, ...hub], config, { click: opts.click !== false });
    failures.push(...seen.failures);
    warnings.push(...seen.warnings);
  }

  failures = collapse(failures);
  warnings = collapse(warnings);
  const { version, pages: pageHashes } = pagesVersion(out);
  const result = {
    ok: failures.length === 0,
    epoch: Math.floor(Date.now() / 1000), /* the workflow's only real clock */
    version,
    pagesChecked: present.length,
    failureCount: failures.length,
    warningCount: warnings.length,
    failures: failures.slice(0, MAX_REPORTED),
    warnings: warnings.slice(0, MAX_REPORTED),
    ...(failures.length > MAX_REPORTED || warnings.length > MAX_REPORTED ? { truncated: `Showing the first ${MAX_REPORTED} of each. Fix these and run it again.` } : {}),
  };
  /* Only a full run can say anything about the whole set. */
  if (!opts.pages && existsSync(path.join(out, 'index.html'))) {
    writeGateResult(out, {
      ...result,
      at: new Date().toISOString(),
      browser: opts.browser !== false,
      clicks: opts.browser !== false && opts.click !== false,
      devices: (config.devices || Object.keys(DEVICES)).filter((k) => DEVICES[k]),
      pages: pageHashes,
    });
  }
  return result;
}

function format(r) {
  const lines = [`${r.ok ? 'PASS' : 'FAIL'}: ${r.pagesChecked} pages, ${r.failureCount} failures, ${r.warningCount} warnings`];
  const row = (x) => `  ${x.rule}  ${x.page}${x.line ? ':' + x.line : ''}${x.viewport ? ` [${x.viewport}]` : ''}  ${x.detail}`;
  if (r.failures.length) lines.push('Failures:', ...r.failures.map(row));
  if (r.warnings.length) lines.push('Warnings:', ...r.warnings.map(row));
  if (r.truncated) lines.push(r.truncated);
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const out = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--pages');
  if (!out || !existsSync(out)) {
    console.error('usage: node check.mjs <out dir> [--pages a.html,b/c.html] [--json] [--no-browser] [--no-click]');
    process.exit(2);
  }
  const at = argv.indexOf('--pages');
  const result = await runCheck(out, {
    pages: at === -1 ? undefined : argv[at + 1].split(',').map((p) => p.trim()).filter(Boolean),
    browser: !argv.includes('--no-browser'),
    click: !argv.includes('--no-click'),
  });
  console.log(argv.includes('--json') ? JSON.stringify(result) : format(result));
  process.exit(result.ok ? 0 : 1);
}
