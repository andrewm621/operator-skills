#!/usr/bin/env node
/* Gate: does the walkthrough show any real person's data? Run before ANY publish.

     node datasafety.mjs <dir> [--repo <path>] [--history] [--real-names <file>] [--json]

   Reads manifest.json:
     cast             the invented people (and addresses) the walkthrough shows
     realNames        strings that must never appear (client name, staff names)
     allow            street-address-looking phrases to ignore (product vocabulary; matched as a whole word
                      against address findings ONLY, so it cannot hide a name, email, phone or real name)
     datasafety.acknowledged   findings a human reviewed, as "kind:text" (printed for you below)
     mode             "shots" for screenshot walkthroughs: also needs datasafety.attestNoRealData: true

   Findings (all block publishing until fixed or acknowledged):
     real-name      a manifest.realNames entry (or one from --real-names) appears
     collision      a cast name is also in the app repo's data or docs (possibly a real person)
     email, phone, address   contact details in the page
     name           a given name that is not in the cast (a likely real person; cites repo docs that name them too)
     no-cast        manifest.json lists no cast, so invented and real cannot be told apart
   --history also searches the repo's git history for each cast name.

   Scanned raw (nothing is removed before scanning): script bodies (the JSON spec, owner scripts), HTML
   comments, every attribute value except class/id/style/src/href, CSS `content:` strings in <style>
   blocks and style attributes, and the page text. Given names come from data/us-given-names.txt
   (generic frequency data) minus data/name-homographs.txt (ordinary English words like "Mark").

   It is a heuristic net, not proof: a real name that is not in its built-in list and not in
   realNames gets through, so the skill's step 6 has the human read the visible text too.
   Exit 1 while any finding is unacknowledged. */

import { readFileSync, existsSync, statSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTarget, readManifest, repoRoot, gitSafe, GIT_LOG_FLAGS, positional, flag, has, decodeEntities, isMain } from './_lib.mjs';

/* Generic US given-name data (data/us-given-names.txt, SSA frequency list) minus ordinary-English homographs. */
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const wordList = (f) => new Set(readFileSync(path.join(DATA_DIR, f), 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
const HOMOGRAPHS = wordList('name-homographs.txt');
const FIRST_NAMES = new Set([...wordList('us-given-names.txt')].filter((n) => !HOMOGRAPHS.has(n)));

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.sql', '.yaml', '.yml', '.html', '.toml', '.env', '.sample']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.wt', '.wrangler', 'coverage']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Phones. International needs a country code right after the "+" (+1 415 555 0132, +442071838750).
   Formatted US numbers need a separator or parentheses: (555)123-4567, 555-123-4567, 555.123.4567.
   A bare 10-digit run (5551234567) is only treated as a phone in prose, not inside script bodies, where
   epoch seconds and timing math look exactly like one. */
const PHONE_INTL = /(?<![\w)\]])\+[1-9]\d{0,2}[\s().-]*\d[\d\s().-]{5,14}\d/g;
const PHONE_FORMATTED = /\(\d{3}\)\s?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]?\d{4}\b|\b\d{3}[\s.-]?\d{3}[\s.-]\d{4}\b/g;
const PHONE_BARE = /(?<![\w.])\d{10}(?![\w.])/g;
const NOT_TEXT_ATTRS = new Set(['class', 'id', 'style', 'src', 'href']);
const TAG_RE = /<\/?[a-zA-Z!][^>]*>/g;          // a tag starts with a letter: "2 < 3 Karen" is text, not a tag
const ATTR_RE = /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

const CSS_CONTENT_RE = /content\s*:\s*(["'])(.*?)\1/gs;

/** The page split into the places text hides: markup text, attribute values, comments, CSS
    `content:` strings, and script bodies (kept apart because they are code, not prose). */
export function pageParts(html) {
  const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  let rest = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const scripts = [...rest.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const styles = [...rest.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  rest = rest.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const attrs = [], styleAttrs = [];
  for (const tag of rest.matchAll(TAG_RE)) {
    for (const m of tag[0].matchAll(ATTR_RE)) {
      const v = m[2] ?? m[3] ?? m[4] ?? '', k = m[1].toLowerCase();
      if (k === 'style') styleAttrs.push(v);
      else if (!NOT_TEXT_ATTRS.has(k)) attrs.push(v);
    }
  }
  const css = [...styles, ...styleAttrs].flatMap((c) => [...c.matchAll(CSS_CONTENT_RE)].map((m) => m[2]));
  const body = rest.replace(TAG_RE, ' ');
  const dec = (a) => decodeEntities(a.join('\n'));
  return { markup: dec([body, ...comments, ...attrs, ...css]), scripts: dec(scripts) };
}

/** Everything a viewer or the source-viewer could read, as one string. */
export function visibleText(html) {
  const p = pageParts(html);
  return p.markup + '\n' + p.scripts;
}

function listRepoFiles(root, exclude) {
  try {
    const out = gitSafe(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.']);
    return out.split('\0').filter(Boolean).map((f) => path.join(root, f)).filter((f) => !exclude(f));
  } catch {
    const acc = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (!exclude(p)) acc.push(p);
      }
    })(root);
    return acc;
  }
}

/** Load the repo's text files once: [{ file, lines }]. */
export function loadRepoText(root, isOwn) {
  const out = [];
  let total = 0;
  for (const f of listRepoFiles(root, (p) => (isOwn && isOwn(p)) || p.split(path.sep).some((s) => SKIP_DIRS.has(s)))) {
    if (!TEXT_EXT.has(path.extname(f).toLowerCase()) && path.basename(f) !== '.env.example') continue;
    let st; try { st = lstatSync(f); } catch { continue; }   // lstat: a symlink in the repo is not read
    if (!st.isFile() || st.size > 1024 * 1024) continue;
    total += st.size;
    if (total > 80 * 1024 * 1024) break;
    out.push({ file: path.relative(root, f), lines: readFileSync(f, 'utf8').split('\n') });
  }
  return out;
}

function findInRepo(repoText, re) {
  for (const { file, lines } of repoText) {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return { file, line: i + 1 };
  }
  return null;
}

export function datasafety(arg, opts = {}) {
  const target = resolveTarget(arg);
  const manifest = readManifest(target);
  const html = readFileSync(target.src, 'utf8');
  const root = opts.repo ? path.resolve(opts.repo) : repoRoot(target, manifest);
  const cast = manifest.cast || [];
  const acknowledged = new Set((manifest.datasafety || {}).acknowledged || []);
  const findings = [];
  const add = (kind, text, detail) => findings.push({ kind, text, detail, key: `${kind}:${text}`, acknowledged: acknowledged.has(`${kind}:${text}`) });

  const raw = visibleText(html);

  /* Every scan runs on the raw text. "allow" is applied later, to address findings only. */
  const realNames = [...(manifest.realNames || [])];
  if (opts.realNames && existsSync(opts.realNames)) realNames.push(...readFileSync(opts.realNames, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
  const parts = pageParts(html);
  const text = raw;
  const proseOnly = parts.markup;
  const allowWord = (a) => (manifest.allow || []).some((p) => String(p).trim() && new RegExp(`(?<!\\w)${escapeRe(String(p).trim())}(?!\\w)`, 'i').test(a));

  /* cast */
  if (!cast.length) add('no-cast', 'manifest.cast', 'list every invented person the walkthrough shows in manifest.json "cast"');
  const castTokens = new Set(cast.flatMap((n) => String(n).toLowerCase().split(/\s+/)));

  /* known real names */
  for (const n of realNames) {
    if (new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(raw)) add('real-name', n, 'listed as a real name (manifest.realNames / --real-names) and it appears in the page');
  }

  /* the app repo's data and docs */
  /* The walkthrough's own files name the cast on purpose; everything else under the repo is evidence. */
  const OWN = new Set(['walkthrough.src.html', 'walkthrough.html', 'manifest.json', 'storyboard.md']);
  const ownDirs = new Set([target.dir, realpathSync(target.dir)]);
  const isOwn = (p) => ownDirs.has(path.dirname(p)) && OWN.has(path.basename(p));
  const repoText = existsSync(root) ? loadRepoText(root, isOwn) : [];
  for (const n of cast) {
    const hit = findInRepo(repoText, new RegExp(`\\b${escapeRe(String(n))}\\b`, 'i'));
    if (hit) add('collision', String(n), `cast name "${n}" is also in the repo at ${hit.file}:${hit.line}; invent a different one`);
    if (opts.history) {
      try {
        const log = gitSafe(root, ['log', ...GIT_LOG_FLAGS, '-S' + n, '--oneline', '-n', '3', '--', '.']);
        if (log) add('collision', String(n), `cast name "${n}" appears in git history:\n        ${log.split('\n').join('\n        ')}`);
      } catch { /* not a git repo */ }
    }
  }

  /* contact details */
  const dedupe = (t, re) => [...new Set([...t.matchAll(re)].map((m) => m[0].trim()))];
  for (const e of dedupe(text, /[\w.+-]+@[\w-]+\.[\w.-]+/g)) add('email', e, 'an email address');
  const phones = new Set([...dedupe(text, PHONE_INTL), ...dedupe(text, PHONE_FORMATTED), ...dedupe(proseOnly, PHONE_BARE)]);
  for (const p of phones) add('phone', p, 'a phone number');
  for (const a of dedupe(text, /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pkwy|Hwy|Cir|Pl)\b\.?/g)) {
    if (!cast.some((c) => String(c).includes(a)) && !allowWord(a)) add('address', a, 'a street address; use one that is plainly invented (or list it in cast) and acknowledge it');
  }

  /* given names that are not in the cast */
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Z][a-z]{1,14}|[A-Z]{2,15})(?=\b|['’]s)/g)) {
    const lw = m[1].toLowerCase(), w = lw[0].toUpperCase() + lw.slice(1);
    if (!FIRST_NAMES.has(lw) || castTokens.has(lw) || seen.has(lw)) continue;
    seen.add(lw);
    const hit = findInRepo(repoText, new RegExp(`\\b${w}\\b`));
    add('name', w, hit ? `"${w}" is not in the cast and is also named in the repo at ${hit.file}:${hit.line}: likely a real person` : `"${w}" is not in the cast; if it is a person, add them to cast (invented) or replace it with a role`);
  }

  /* screenshot mode needs an explicit attestation */
  if (manifest.mode === 'shots' && !(manifest.datasafety || {}).attestNoRealData) {
    add('attest', 'attestNoRealData', 'screenshot mode: confirm the images show no real data (and redact boxes cover the rest), then set datasafety.attestNoRealData: true');
  }

  const open = findings.filter((f) => !f.acknowledged);
  return { findings, open, ok: open.length === 0, castCount: cast.length, repoFiles: repoText.length };
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const r = datasafety(positional(argv, ['repo', 'real-names'])[0], { repo: flag(argv, 'repo'), history: has(argv, 'history'), realNames: flag(argv, 'real-names') });
    if (has(argv, 'json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`datasafety: ${r.castCount} cast member(s); searched ${r.repoFiles} repo text files`);
      for (const f of r.findings) console.log(`  ${f.acknowledged ? '✓ (acknowledged)' : '✗'} [${f.kind}] ${f.text}\n      ${f.detail}`);
      if (r.ok) console.log('\nNo unresolved findings. Now read the page text yourself before you publish.');
      else {
        console.log(`\n${r.open.length} unresolved finding(s). Fix them in the walkthrough, or after a human has reviewed one, add its key to manifest.json datasafety.acknowledged:`);
        for (const f of r.open) console.log(`    "${f.key}"`);
      }
    }
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error('datasafety: ' + e.message);
    process.exit(1);
  }
}
