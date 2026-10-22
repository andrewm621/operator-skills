#!/usr/bin/env node
/* Publish a walkthrough to a public Cloudflare Workers static-assets site.
   Deliberately slow and paranoid. Without --yes it changes nothing.

     node deploy.mjs <dir> [--name wt-<slug>] [--account <id>] [--yes] [--confirm-screenshots] [--wrangler <bin>]

   What it does, in order:
     1. refuses if datasafety.mjs has unresolved findings (real names, collisions, contact details)
     2. builds the site in a temp dir: index.html (noindex,nofollow meta), 404.html, robots.txt
        (Disallow: /), and a _headers file (X-Robots-Tag: noindex). Not Pages: wrangler now
        creates Workers, so this is `wrangler deploy` with an assets config.
     3. resolves the Cloudflare account (--account, deploy.json, CLOUDFLARE_ACCOUNT_ID, or the
        only account wrangler whoami lists; with several it stops and asks) and prints it
     4. THE GUARD: asks Cloudflare whether a Worker with that name already exists. If it does and
        none of its versions carries the tag walkthrough:<slug>, it REFUSES. It will not
        overwrite a Worker this skill did not create. An unrecognised answer (auth error, network,
        anything but "does not exist") also refuses.
     5. with --yes: wrangler deploy --tag walkthrough:<slug> --message "operator-walkthrough ...",
        then fetches /robots.txt and the headers of / from the live URL and reports them.
        A screenshot-mode walkthrough (manifest mode "shots") also needs --confirm-screenshots.

   deploy.json (optional, next to manifest.json): { "name": "...", "accountId": "..." }
   Test hook: --wrangler <path> (or WT_WRANGLER) swaps the wrangler binary for a stub. */

import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveTarget, readManifest, flag, has, positional, isMain } from './_lib.mjs';
import { wrap, SKELETON_HEAD, SKELETON_TAIL } from './wrap.mjs';
import { datasafety } from './datasafety.mjs';

const execFileP = promisify(execFile);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'walkthrough';
export const tagFor = (slug) => `walkthrough:${slug}`;

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

function parseJsonArray(text) {
  const t = text.trim();
  const i = t.indexOf('[');
  if (i === -1) return null;
  try { const v = JSON.parse(t.slice(i)); return Array.isArray(v) ? v : null; } catch { return null; }
}

/** Does `name` exist, and if so did this skill create it? Never trusts exit codes alone.
    absent   Cloudflare says the Worker does not exist: safe to create
    owned    exists and a version/deployment carries the tag: safe to update
    foreign  exists, no tag: REFUSE
    unknown  anything else (auth, network, unexpected output): REFUSE */
export async function checkOwnership({ wrangler, name, slug, account, cwd }) {
  const tag = tagFor(slug);
  const env = account ? { CLOUDFLARE_ACCOUNT_ID: account } : {};
  const lists = [];
  for (const sub of ['versions', 'deployments']) {
    const r = await runWrangler(wrangler, [sub, 'list', '--name', name, '--json'], { cwd, env });
    const arr = parseJsonArray(r.out);
    if (arr) { lists.push(...arr); continue; }
    const text = r.out + '\n' + r.err;
    if (NOT_FOUND.test(text)) return { state: 'absent', detail: 'Cloudflare reports no Worker with that name.' };
    return { state: 'unknown', detail: `could not tell whether "${name}" exists (wrangler ${sub} list exit ${r.code}):\n${text.trim().slice(0, 600)}` };
  }
  const owned = lists.some((x) => {
    const a = x.annotations || {};
    return a['workers/tag'] === tag || String(a['workers/message'] || '').split(/\s+/).includes(tag);
  });
  return owned
    ? { state: 'owned', detail: `found a version tagged ${tag}.` }
    : { state: 'foreign', detail: `a Worker named "${name}" exists and none of its recent versions is tagged ${tag}. It was not created by this skill.` };
}

export async function resolveAccount({ flagValue, deployJson, env = process.env, wrangler }) {
  const explicit = flagValue || (deployJson || {}).accountId || env.CLOUDFLARE_ACCOUNT_ID;
  if (explicit) return { id: explicit, source: flagValue ? '--account' : (deployJson || {}).accountId ? 'deploy.json' : 'CLOUDFLARE_ACCOUNT_ID' };
  const r = await runWrangler(wrangler, ['whoami']);
  const found = [...new Set([...(r.out + r.err).matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1]))];
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
  const tag = tagFor(slug);
  const result = { name, tag, slug, state: null, deployed: false, url: null };

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

    /* 4. the guard */
    const own = await checkOwnership({ wrangler, name, slug, account: acct.id, cwd: work });
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
      log(`\n  Dry run: nothing was uploaded. It would run:\n    wrangler ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n  Re-run with --yes after the user has approved the name, account and URL.`);
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
