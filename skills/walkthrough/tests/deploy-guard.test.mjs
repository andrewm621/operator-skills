import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkOwnership, deploy, resolveAccount, slugify, buildSite } from '../scripts/deploy.mjs';
import { copyFixture, rm, quiet, HERE } from './_helpers.mjs';

const STUB = ['node', path.join(HERE, 'stub-wrangler.mjs')];
const ACCT = 'a'.repeat(32);
function scenario(name, extra = {}) {
  process.env.STUB_SCENARIO = name; process.env.STUB_SLUG = 'lendhand-fixture';
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'wt-stublog-')), 'calls.jsonl');
  process.env.STUB_LOG = log;
  Object.assign(process.env, extra);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}
const own = (slug = 'lendhand-fixture') => checkOwnership({ wrangler: STUB, name: 'wt-x', slug, account: ACCT });

test('a Worker that does not exist is "absent" (not-found is told apart from errors by its text)', async () => {
  scenario('absent');
  assert.equal((await own()).state, 'absent');
});
test('a tagged version means owned', async () => { scenario('owned-tag'); assert.equal((await own()).state, 'owned'); });
test('the tag token in a deployment message also means owned', async () => { scenario('owned-message'); assert.equal((await own()).state, 'owned'); });
test('an existing Worker with no tag is foreign', async () => { scenario('foreign'); assert.equal((await own()).state, 'foreign'); });
test('a Worker tagged for a different walkthrough is foreign', async () => { scenario('other-tag'); assert.equal((await own()).state, 'foreign'); });
test('an auth error is unknown, never absent', async () => {
  scenario('auth-error');
  const r = await own();
  assert.equal(r.state, 'unknown'); assert.match(r.detail, /10000/);
});
test('unparseable output is unknown', async () => { scenario('garbage'); assert.equal((await own()).state, 'unknown'); });

test('deploy refuses a foreign Worker and never runs wrangler deploy, even with --yes', async () => {
  const calls = scenario('foreign');
  const dir = copyFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true }));
    assert.equal(value.refused, 'foreign');
    assert.equal(value.deployed, false);
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'), 'wrangler deploy must not be called');
  } finally { rm(dir); }
});

test('deploy refuses when it cannot tell (auth error)', async () => {
  const calls = scenario('auth-error');
  const dir = copyFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true }));
    assert.equal(value.refused, 'unknown');
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('without --yes it is a dry run: the guard runs, nothing is deployed', async () => {
  const calls = scenario('absent');
  const dir = copyFixture();
  try {
    const { value, lines } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT }));
    assert.equal(value.state, 'absent'); assert.equal(value.deployed, false); assert.equal(value.refused, undefined);
    assert.match(lines.join('\n'), /Dry run/);
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('with --yes on a free name it deploys with the walkthrough:<slug> tag and the pinned account', async () => {
  const calls = scenario('absent');
  const dir = copyFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, noVerify: true }));
    assert.equal(value.deployed, true);
    assert.equal(value.url, 'https://wt-stub.example-sub.workers.dev');
    const d = calls().find((c) => c.args[0] === 'deploy');
    assert.ok(d, 'deploy was called');
    assert.equal(d.args[d.args.indexOf('--tag') + 1], 'walkthrough:lendhand-fixture');
    assert.equal(d.account, ACCT);
  } finally { rm(dir); }
});

test('with --yes on an owned Worker it redeploys', async () => {
  const calls = scenario('owned-tag');
  const dir = copyFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, noVerify: true }));
    assert.equal(value.state, 'owned'); assert.equal(value.deployed, true);
    assert.ok(calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('deploy refuses while datasafety has findings, before any wrangler call', async () => {
  const calls = scenario('absent');
  const dir = copyFixture();
  try {
    const p = path.join(dir, 'walkthrough.src.html');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(p, readFileSync(p, 'utf8').replace('Maya needs a drill', 'Linda needs a drill'));
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true }));
    assert.equal(value.refused, 'datasafety');
    assert.equal(calls().length, 0);
  } finally { rm(dir); }
});

test('with several Cloudflare accounts and none chosen, it stops instead of guessing', async () => {
  scenario('absent', { STUB_ACCOUNTS: 'a'.repeat(32) + ',' + 'b'.repeat(32) });
  await assert.rejects(resolveAccount({ wrangler: STUB, env: {} }), /2 accounts/);
  process.env.STUB_ACCOUNTS = 'a'.repeat(32);
  assert.equal((await resolveAccount({ wrangler: STUB, env: {} })).id, 'a'.repeat(32));
  assert.equal((await resolveAccount({ wrangler: STUB, env: { CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32) } })).source, 'CLOUDFLARE_ACCOUNT_ID');
  delete process.env.STUB_ACCOUNTS;
});

test('the published site is noindex three ways', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'wt-site-'));
  try {
    const site = buildSite('<title>x</title><p>hi</p>', out);
    assert.match(readFileSync(path.join(site, 'index.html'), 'utf8'), /<meta name="robots" content="noindex,nofollow">/);
    assert.match(readFileSync(path.join(site, 'robots.txt'), 'utf8'), /Disallow: \//);
    assert.match(readFileSync(path.join(site, '_headers'), 'utf8'), /X-Robots-Tag: noindex/);
    assert.match(readFileSync(path.join(site, 'index.html'), 'utf8'), /^<!doctype html>/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('slugify makes a safe Worker name part', () => { assert.equal(slugify('Langston Weekly_Plan!'), 'langston-weekly-plan'); });

test('a screenshot-mode walkthrough needs a second confirmation before it publishes', async () => {
  const calls = scenario('absent');
  const dir = copyFixture();
  try {
    const { editManifest } = await import('./_helpers.mjs');
    editManifest(dir, (m) => { m.mode = 'shots'; m.datasafety = { acknowledged: [], attestNoRealData: true }; });
    const a = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, noVerify: true }));
    assert.equal(a.value.refused, 'screenshots');
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
    const b = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, confirmScreenshots: true, noVerify: true }));
    assert.equal(b.value.deployed, true);
  } finally { rm(dir); }
});
