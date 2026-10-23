#!/usr/bin/env node
/* Gate: does the walkthrough show any real person's data? Run before ANY publish.

     node datasafety.mjs <dir> [--repo <path>] [--history] [--real-names <file>] [--json]

   Reads manifest.json:
     cast             the invented people (and addresses) the walkthrough shows
     realNames        strings that must never appear (client name, staff names)
     allow            phrases to ignore (product vocabulary that merely looks like a name; never a person)
     datasafety.acknowledged   findings a human reviewed, as "kind:text" (printed for you below)
     mode             "shots" for screenshot walkthroughs: also needs datasafety.attestNoRealData: true

   Findings (all block publishing until fixed or acknowledged):
     real-name      a manifest.realNames entry (or one from --real-names) appears (checked before "allow")
     allow          a manifest.allow entry that contains a given name or real name; it is ignored and cannot hide anything
     collision      a cast name is also in the app repo's data or docs (possibly a real person)
     email, phone, address   contact details in the page
     name           a given name that is not in the cast (a likely real person; cites repo docs that name them too)
     no-cast        manifest.json lists no cast, so invented and real cannot be told apart
   --history also searches the repo's git history for each cast name.

   Scanned raw: script bodies (the JSON spec, owner scripts), HTML comments, every attribute value
   except class/id/style/src/href, and the page text.

   It is a heuristic net, not proof: a real name that is not in its built-in list and not in
   realNames gets through, so the skill's step 6 has the human read the visible text too.
   Exit 1 while any finding is unacknowledged. */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveTarget, readManifest, repoRoot, positional, flag, has, decodeEntities, isMain } from './_lib.mjs';

/* Common US given names. Ambiguous words (Mark, Will, Grant, Rose, Hunter, Bill, Pat, ...) are left out on purpose. */
const FIRST_NAMES = new Set(`aaron abigail adam alan albert alexander alexis alice alyssa amanda amber amy andrea andrew angela anna
anthony arthur ashley austin barbara benjamin betty billy bobby brandon brenda brian brittany bruce bryan carl
carol carolyn catherine chad charles charlotte christian christina christine christopher clarence clayton
colton crystal cynthia daniel danielle darrell david deborah debra denise dennis derek diana diane donald
donna dorothy douglas dustin dwayne dylan edward elijah emily emma eric ethan eugene evelyn frank gabriel gary
george gerald gloria gregory hannah harold heather helen henry isabella jacob jacqueline james jane janet
janice jason jeffrey jennifer jeremy jerry jesse jessica john johnny jonathan jordan jose joseph joshua joyce
juan judy julie justin karen kate katherine kathleen kayla keith kelly kenneth kevin kimberly kyle lance larry
laura lauren lawrence leon lisa logan louis madison marcus margaret maria marie martha matthew megan melissa
michael michelle monica nancy natalie nathan nicholas nicole noah olivia pamela patricia patrick paul peter
philip rachel ralph randy raymond rebecca rhonda richard ricky robert roger ronald roy russell ruth ryan
samantha samuel sandra sarah scott sean sharon shawn sherry shirley sophia stephanie stephen steven susan
tammy teresa terry thomas tiffany timothy todd tommy tonya travis trevor tyler victoria vincent walter wanda
wayne william willie zachary`.split(/\s+/));

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.sql', '.yaml', '.yml', '.html', '.toml', '.env', '.sample']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.wt', '.wrangler', 'coverage']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* (555)123-4567, 555-123-4567, 555.123.4567, 5551234567, +1 415 555 0132, +442071838750 */
const PHONE_RE = /\+\d[\d\s().-]{7,16}\d|\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const NOT_TEXT_ATTRS = new Set(['class', 'id', 'style', 'src', 'href']);
const TAG_RE = /<\/?[a-zA-Z!][^>]*>/g;          // a tag starts with a letter: "2 < 3 Karen" is text, not a tag
const ATTR_RE = /([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Everything a viewer or the source-viewer could read, scanned raw:
    script bodies (captions live in the JSON spec and in owner scripts), HTML comments, every
    attribute value except class/id/style/src/href (single-quoted, double-quoted or bare),
    and the markup's text. Only <style> blocks are dropped. */
export function visibleText(html) {
  const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  let rest = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const scripts = [...rest.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  rest = rest.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const attrs = [];
  for (const tag of rest.matchAll(TAG_RE)) {
    for (const m of tag[0].matchAll(ATTR_RE)) {
      if (!NOT_TEXT_ATTRS.has(m[1].toLowerCase())) attrs.push(m[2] ?? m[3] ?? m[4] ?? '');
    }
  }
  const body = rest.replace(TAG_RE, ' ');
  return decodeEntities([body, ...scripts, ...comments, ...attrs].join('\n'));
}

function listRepoFiles(root, exclude) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
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
    let st; try { st = statSync(f); } catch { continue; }
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

  /* "allow" is for product vocabulary that merely looks like a name. It must never be able to hide a person:
     an entry that contains a given name or a known real name is ignored, and reported. */
  const realNames = [...(manifest.realNames || [])];
  if (opts.realNames && existsSync(opts.realNames)) realNames.push(...readFileSync(opts.realNames, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
  const allowOk = [];
  for (const phrase of manifest.allow || []) {
    const toks = String(phrase).toLowerCase().match(/[a-z]+/g) || [];
    const bad = toks.some((t) => FIRST_NAMES.has(t)) || realNames.some((n) => String(phrase).toLowerCase().includes(String(n).toLowerCase()));
    if (bad) add('allow', String(phrase), `manifest.allow entry "${phrase}" contains a given name or a known real name, so it is ignored. "allow" cannot hide a person; only a human adding this finding's key to datasafety.acknowledged can clear it`);
    else allowOk.push(phrase);
  }
  let text = raw;
  for (const phrase of allowOk) text = text.split(phrase).join(' ');

  /* cast */
  if (!cast.length) add('no-cast', 'manifest.cast', 'list every invented person the walkthrough shows in manifest.json "cast"');
  const castTokens = new Set(cast.flatMap((n) => String(n).toLowerCase().split(/\s+/)));

  /* known real names: checked on the UNFILTERED text */
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
        const log = execFileSync('git', ['-C', root, 'log', '-S' + n, '--oneline', '-n', '3', '--', '.'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (log) add('collision', String(n), `cast name "${n}" appears in git history:\n        ${log.split('\n').join('\n        ')}`);
      } catch { /* not a git repo */ }
    }
  }

  /* contact details */
  const dedupe = (re) => [...new Set([...text.matchAll(re)].map((m) => m[0].trim()))];
  for (const e of dedupe(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) add('email', e, 'an email address');
  for (const p of dedupe(PHONE_RE)) add('phone', p, 'a phone number');
  for (const a of dedupe(/\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pkwy|Hwy|Cir|Pl)\b\.?/g)) {
    if (!cast.some((c) => String(c).includes(a))) add('address', a, 'a street address; use one that is plainly invented (or list it in cast) and acknowledge it');
  }

  /* given names that are not in the cast */
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Z][a-z]{1,14})(?=\b|['’]s)/g)) {
    const w = m[1], lw = w.toLowerCase();
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
