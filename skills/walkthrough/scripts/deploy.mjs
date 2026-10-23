#!/usr/bin/env node
/* Publish a walkthrough to a public Cloudflare Workers static-assets site.
   Deliberately slow and paranoid. Without --yes it changes nothing.

     node deploy.mjs <dir> [--name wt-<slug>] [--account <id>] [--yes] [--confirm-screenshots] [--wrangler <bin>]

   What it does, in order:
     1. refuses if datasafety.mjs has unresolved findings (real names, collisions, contact details)
     2. builds the site in a temp dir: index.html (noindex,nofollow meta), 404.html, robots.txt
        (Disallow: /), and a _headers file (X-Robots-Tag: noindex). Not Pages: wrangler now
        creates Workers, so this is `wrangler deploy` with an assets config.
     3. resolves the Cloudflare account (--account, CLOUDFLARE_ACCOUNT_ID, deploy.json, or the
        only account wrangler whoami lists; with several it stops and asks) and prints it. An id
        from deploy.json (a file in the repo, so untrusted) must be 32 hex digits AND be one of
        the accounts wrangler whoami says you are logged in to.
     4. THE GUARD: asks Cloudflare whether a Worker with that name already exists, via BOTH
        `versions list` and `deployments list`. It is "free" only if both say "does not exist".
        If the Worker exists and none of its versions carries the exact tag
        walkthrough:<slug>:<repo id> it REFUSES, so it will not overwrite a Worker this skill did
        not create, nor one created from another repo that happens to share the slug. <repo id>
        is 8 hex digits of the app repo's root commit. Any other answer (auth error, network,
        one list found and the other not, anything unrecognised) also refuses.
     5. with --yes: wrangler deploy --tag walkthrough:<slug>:<repo id> --message "operator-walkthrough ...",
        then fetches /robots.txt and the headers of / from the live URL and reports them.
        A screenshot-mode walkthrough (manifest mode "shots") also needs --confirm-screenshots.

   deploy.json (optional, next to manifest.json): { "name": "...", "accountId": "..." }
   Test hook: --wrangler <path> (or WT_WRANGLER) swaps the wrangler binary for a stub. */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveTarget, readManifest, repoRoot, flag, has, positional, isMain } from './_lib.mjs';
import { wrap, SKELETON_HEAD, SKELETON_TAIL } from './wrap.mjs';
import { datasafety } from './datasafety.mjs';

const execFileP = promisify(execFile);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'walkthrough';
export const tagFor = (slug, repoId) => `walkthrough:${slug}:${repoId}`;

/** A stable identity for the app repo the walkthrough lives in: 8 hex digits of its root commit.
    Two repos that both call a walkthrough "weekly" must not be able to overwrite each other's Worker. */
export function repoIdentity(root) {
  try {
    const roots = execFileSync('git', ['-C', root, 'rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean).sort();
    if (roots.length) return roots[0].slice(0, 8);
  } catch { /* no commits, or not a git repo */ }
  try {
    const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (url) return createHash('sha1').update(url.replace(/\.git$/, '').toLowerCase()).digest('hex').slice(0, 8);
  } catch { /* no origin */ }
  return null;
}

async function runWrangler(bin, args, { cwd, env } = {}) {
  const [cmd, ...pre] = Array.isArray(bin) ? bin : bin.split(/\s+/);
  try {
    const r = await execFileP(cmd, [...pre, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', WRANGLER_SEND_METRICS: 'false', ...env }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, out: stripAnsi(r.stdout || ''), err: stripAnsi(r.stderr || '') };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, out: stripAnsi(e.stdout || ''), err: stripAnsi(e.stderr || e.message || '') };
  }
}

const NOT_FOUND = /code:\s*10007|worker does not exist|does not exist on your account/i;

/** The JSON array in wrangler's output, tolerating banner or "[WARNING] ..." lines before it. */
function parseJsonArray(text) {
  const lines = text.trim().split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimStart().startsWith('[')) continue;
    try { const v = JSON.parse(lines.slice(i).join('\n')); if (Array.isArray(v)) return v; } catch { /* a [WARNING] line, keep looking */ }
  }
  return null;
}

/** Does `name` exist, and if so did this skill create it from this repo? Never trusts exit codes alone.
    absent   BOTH versions list and deployments list say the Worker does not exist: safe to create
    owned    exists and a version/deployment carries the exact tag: safe to update
    foreign  exists, no exact tag: REFUSE
    unknown  anything else, including any mix of answers (auth, network, one list found and one not): REFUSE */
export async function checkOwnership({ wrangler, name, slug, repoId, account, cwd }) {
  const tag = tagFor(slug, repoId);
  const env = account ? { CLOUDFLARE_ACCOUNT_ID: account } : {};
  const lists = [], seen = [];
  for (const sub of ['versions', 'deployments']) {
    const r = await runWrangler(wrangler, [sub, 'list', '--name', name, '--json'], { cwd, env });
    const arr = parseJsonArray(r.out);
    const text = r.out + '\n' + r.err;
    if (arr) { seen.push('list'); lists.push(...arr); }
    else if (NOT_FOUND.test(text)) seen.push('absent');
    else return { state: 'unknown', detail: `could not tell whether "${name}" exists (wrangler ${sub} list exit ${r.code}):\n${text.trim().slice(0, 600)}` };
  }
  if (seen.every((x) => x === 'absent')) return { state: 'absent', detail: 'Cloudflare reports no Worker with that name (versions and deployments agree).' };
  if (seen.some((x) => x === 'absent')) return { state: 'unknown', detail: `Cloudflare gave mixed answers for "${name}" (versions: ${seen[0]}, deployments: ${seen[1]}); not treating the name as free.` };
  const owned = lists.some((x) => {
    const a = (x && x.annotations) || {};
    return a['workers/tag'] === tag || String(a['workers/message'] || '').split(/\s+/).includes(tag);
  });
  return owned
    ? { state: 'owned', detail: `found a version tagged ${tag}.` }
    : { state: 'foreign', detail: `a Worker named "${name}" exists and none of its recent versions is tagged ${tag}. It was not created by this skill from this repo.` };
}

const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const accountsIn = (text) => [...new Set([...text.matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]))];

/** Order: --account, CLOUDFLARE_ACCOUNT_ID (both yours), then deploy.json (a file in the repo: untrusted).
    An id from deploy.json must be well-formed and be one of the accounts wrangler is logged in to. */
export async function resolveAccount({ flagValue, deployJson, env = process.env, wrangler }) {
  const fromUser = flagValue || env.CLOUDFLARE_ACCOUNT_ID;
  const fromFile = (deployJson || {}).accountId;
  const pick = fromUser || fromFile;
  if (pick) {
    if (!ACCOUNT_RE.test(String(pick))) throw new Error(`account id "${pick}" is not 32 hex digits`);
    const source = flagValue ? '--account' : env.CLOUDFLARE_ACCOUNT_ID ? 'CLOUDFLARE_ACCOUNT_ID' : 'deploy.json';
    if (!fromUser) {
      const r = await runWrangler(wrangler, ['whoami']);
      if (!accountsIn(r.out + r.err).includes(pick)) throw new Error(`deploy.json names account ${pick}, which wrangler whoami does not list for the logged-in user; refusing (pass --account or set CLOUDFLARE_ACCOUNT_ID yourself if it is yours)`);
    }
    return { id: pick, source };
  }
  const r = await runWrangler(wrangler, ['whoami']);
  const found = accountsIn(r.out + r.err);
  if (found.length === 1) return { id: found[0], source: 'wrangler whoami (only account)' };
  throw new Error(found.length ? `wrangler is logged in to ${found.length} accounts; set CLOUDFLARE_ACCOUNT_ID, deploy.json accountId or --account so the right one is used` : 'could not determine the Cloudflare account: run `wrangler login`, or set CLOUDFLARE_ACCOUNT_ID');
}

export function buildSite(page, outDir, title) {
  const site = path.join(outDir, 'site');
  mkdirSync(site, { recursive: true });
  const head = SKELETON_HEAD.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">');
  writeFileSync(path.join(site, 'index.html'), head + page + SKELETON_TAIL);
  writeFileSync(path.join(site, '404.html'), '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Not found</title><p style="font:16px system-ui;margin:3rem">Not found.</p>\n');
  writeFileSync(path.join(site, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(path.join(site, '_headers'), '/*\n  X-Robots-Tag: noindex, nofollow\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n');
  return site;
}

export async function deploy(arg, opts = {}) {
  const log = opts.log || console.log;
  const target = resolveTarget(arg);
  const manifest = readManifest(target);
  const deployJson = existsSync(path.join(target.dir, 'deploy.json')) ? JSON.parse(readFileSync(path.join(target.dir, 'deploy.json'), 'utf8')) : {};
  const wrangler = opts.wrangler || process.env.WT_WRANGLER || 'wrangler';
  const slug = slugify(manifest.slug || path.basename(target.dir));
  const name = opts.name || deployJson.name || `wt-${slug}`;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error(`"${name}" is not a valid Worker name (lowercase letters, digits, dashes)`);
  const repoId = repoIdentity(repoRoot(target, manifest));
  if (!repoId) throw new Error('cannot derive a repo identity (the app repo has no commits and no origin remote); commit first so the Worker tag can name this repo');
  const tag = tagFor(slug, repoId);
  const result = { name, tag, slug, repoId, state: null, deployed: false, url: null };

  /* 1. real data gate */
  const ds = datasafety(target.dir);
  if (!ds.ok) {
    log(`  ✗ datasafety has ${ds.open.length} unresolved finding(s). Run datasafety.mjs, resolve them, then deploy.`);
    result.refused = 'datasafety';
    return result;
  }
  log('  ✓ datasafety: no unresolved findings');

  /* 2. build the site */
  const built = wrap(target);
  const page = readFileSync(built.target.built, 'utf8');
  const work = mkdtempSync(path.join(tmpdir(), 'wt-deploy-'));
  try {
    const site = buildSite(page, work);
    log(`  ✓ site built: index.html (${(Buffer.byteLength(page) / 1024).toFixed(0)} KB, noindex), 404.html, robots.txt, _headers`);

    /* 3. account */
    const acct = await resolveAccount({ flagValue: opts.account, deployJson, wrangler });
    log(`  account  ${acct.id}  (from ${acct.source})`);
    log(`  worker   ${name}   tag ${tag}`);
    log(`  cast     ${(manifest.cast || []).join(', ') || '(none)'}`);

    /* 4. the guard */
    const own = await checkOwnership({ wrangler, name, slug, repoId, account: acct.id, cwd: work });
    result.state = own.state;
    if (own.state === 'foreign' || own.state === 'unknown') {
      log(`  ✗ REFUSING to deploy: ${own.detail}`);
      log(own.state === 'foreign' ? '    Pick another name (--name or deploy.json) or delete that Worker yourself if it is yours to delete.' : '    Fix the error above and run again.');
      result.refused = own.state;
      return result;
    }
    log(`  ✓ guard: ${own.state === 'absent' ? 'name is free' : 'existing Worker is ours'} (${own.detail})`);

    const config = { name, compatibility_date: new Date().toISOString().slice(0, 10), account_id: acct.id, assets: { directory: './site', not_found_handling: '404-page' }, workers_dev: true };
    writeFileSync(path.join(work, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
    const args = ['deploy', '--config', path.join(work, 'wrangler.jsonc'), '--tag', tag, '--message', `operator-walkthrough ${tag}`];

    if (opts.yes && manifest.mode === 'shots' && !opts.confirmScreenshots) {
      log('  \u2717 REFUSING: this is a screenshot walkthrough, so the public page publishes real product screenshots.');
      log('    Ask the user a second time, naming the images, then re-run with --yes --confirm-screenshots.');
      result.refused = 'screenshots';
      return result;
    }

    if (!opts.yes) {
      log(`\n  Dry run: nothing was uploaded. It would run:\n    wrangler ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n  Show the user the account, Worker name, guard result and cast above, wait for an explicit yes, then re-run with --yes.`);
      return result;
    }

    /* 5. deploy and verify */
    const r = await runWrangler(wrangler, args, { cwd: work, env: { CLOUDFLARE_ACCOUNT_ID: acct.id } });
    if (r.code !== 0) { log(`  ✗ wrangler deploy failed:\n${(r.out + r.err).trim().slice(0, 800)}`); result.refused = 'deploy-failed'; return result; }
    result.deployed = true;
    const url = (r.out + r.err).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
    result.url = url ? url[0] : null;
    log(`  ✓ deployed ${result.url || '(URL not found in wrangler output)'}`);
    if (result.url && !opts.noVerify) {
      try {
        const robots = await fetch(result.url + '/robots.txt');
        log(`  ${robots.ok && /Disallow:\s*\//.test(await robots.text()) ? '✓' : '!'} robots.txt served (Disallow: /)`);
        const home = await fetch(result.url + '/');
        const xr = home.headers.get('x-robots-tag');
        log(`  ${xr && /noindex/i.test(xr) ? '✓' : '!'} X-Robots-Tag on /: ${xr || 'MISSING (the _headers file was not applied; the noindex meta tag still protects the page)'}`);
      } catch (e) { log(`  ! could not verify the live site: ${e.message}`); }
    }
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const r = await deploy(positional(argv, ['name', 'account', 'wrangler'])[0], { name: flag(argv, 'name'), account: flag(argv, 'account'), wrangler: flag(argv, 'wrangler'), yes: has(argv, 'yes'), confirmScreenshots: has(argv, 'confirm-screenshots') });
    process.exit(r.refused ? 1 : 0);
  } catch (e) {
    console.error('deploy: ' + e.message);
    process.exit(1);
  }
}
