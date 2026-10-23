import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkOwnership, deploy, resolveAccount, slugify, buildSite, repoIdentity, tagFor } from '../scripts/deploy.mjs';
import { copyFixture, editManifest, rm, quiet, HERE } from './_helpers.mjs';

const STUB = ['node', path.join(HERE, 'stub-wrangler.mjs')];
const ACCT = 'a'.repeat(32);
const SLUG = 'lendhand-fixture';

/** Point the stub at a scenario; returns a reader for the calls it logged. */
function scenario(name, extra = {}) {
  process.env.STUB_SCENARIO = name;
  delete process.env.STUB_ACCOUNTS; delete process.env.STUB_TAG;
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'wt-stublog-')), 'calls.jsonl');
  process.env.STUB_LOG = log;
  Object.assign(process.env, extra);
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}
const own = (repoId = 'deadbeef') => checkOwnership({ wrangler: STUB, name: 'wt-x', slug: SLUG, repoId, account: ACCT });
const OWNED = { STUB_TAG: tagFor(SLUG, 'deadbeef') };

/* ---- the ownership guard ---- */
test('a Worker that does not exist (both lists say so) is "absent"', async () => { scenario('absent'); assert.equal((await own()).state, 'absent'); });
test('a tagged version means owned', async () => { scenario('owned-tag', OWNED); assert.equal((await own()).state, 'owned'); });
test('the exact tag token in a deployment message also means owned', async () => { scenario('owned-message', OWNED); assert.equal((await own()).state, 'owned'); });
test('JSON preceded by a [WARNING] line still parses', async () => { scenario('warning-prefix', OWNED); assert.equal((await own()).state, 'owned'); });
test('an existing Worker with no tag is foreign', async () => { scenario('foreign'); assert.equal((await own()).state, 'foreign'); });
test('a Worker tagged for a different walkthrough is foreign', async () => { scenario('other-tag', OWNED); assert.equal((await own()).state, 'foreign'); });
test('the same slug from a DIFFERENT repo is foreign (the repo id is part of the tag)', async () => {
  scenario('owned-tag', { STUB_TAG: tagFor(SLUG, '11111111') });
  const r = await own('22222222');
  assert.equal(r.state, 'foreign'); assert.match(r.detail, /not created by this skill from this repo/);
});
test('an old-style tag without a repo id is foreign: exact match only', async () => { scenario('old-style-tag', OWNED); assert.equal((await own()).state, 'foreign'); });
test('an auth error is unknown, never absent', async () => {
  scenario('auth-error');
  const r = await own();
  assert.equal(r.state, 'unknown'); assert.match(r.detail, /10000/);
});
test('unparseable output is unknown', async () => { scenario('garbage'); assert.equal((await own()).state, 'unknown'); });
test('FAIL-OPEN guard: versions finds the Worker but deployments says not-found is unknown, not absent', async () => {
  scenario('mixed-versions-array');
  const r = await own();
  assert.equal(r.state, 'unknown'); assert.match(r.detail, /mixed answers/);
});
test('FAIL-OPEN guard: the reverse mix is unknown too', async () => {
  scenario('mixed-deployments-array');
  assert.equal((await own()).state, 'unknown');
});

/* ---- deploy() end to end against the stub ---- */
async function gitFixture() {
  const dir = copyFixture({ git: true });
  const repoId = repoIdentity(path.join(dir, 'app-src'));
  assert.match(repoId, /^[0-9a-f]{8}$/);
  return { dir, repoId, tag: tagFor(SLUG, repoId) };
}

test('deploy refuses a foreign Worker and never runs wrangler deploy, even with --yes', async () => {
  const calls = scenario('foreign');
  const { dir } = await gitFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true }));
    assert.equal(value.refused, 'foreign'); assert.equal(value.deployed, false);
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('deploy refuses on mixed answers and never runs wrangler deploy', async () => {
  const calls = scenario('mixed-versions-array');
  const { dir } = await gitFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true }));
    assert.equal(value.refused, 'unknown');
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('deploy refuses when it cannot tell (auth error)', async () => {
  const calls = scenario('auth-error');
  const { dir } = await gitFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true }));
    assert.equal(value.refused, 'unknown');
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('without --yes it is a dry run that prints account, worker, tag, guard result and cast', async () => {
  const calls = scenario('absent');
  const { dir, tag } = await gitFixture();
  try {
    const { value, lines } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT }));
    const text = lines.join('\n');
    assert.equal(value.state, 'absent'); assert.equal(value.deployed, false); assert.equal(value.refused, undefined);
    assert.match(text, /Dry run/); assert.ok(text.includes(ACCT)); assert.ok(text.includes(tag)); assert.match(text, /cast\s+Maya Okafor, Theo Brandt/); assert.match(text, /guard: name is free/);
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('with --yes on a free name it deploys with the walkthrough:<slug>:<repo id> tag and the pinned account', async () => {
  const calls = scenario('absent');
  const { dir, tag } = await gitFixture();
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, noVerify: true }));
    assert.equal(value.deployed, true); assert.equal(value.url, 'https://wt-stub.example-sub.workers.dev');
    const d = calls().find((c) => c.args[0] === 'deploy');
    assert.equal(d.args[d.args.indexOf('--tag') + 1], tag);
    assert.equal(d.account, ACCT);
  } finally { rm(dir); }
});

test('with --yes on an owned Worker it redeploys', async () => {
  const { dir, tag } = await gitFixture();
  const calls = scenario('owned-tag', { STUB_TAG: tag });
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, noVerify: true }));
    assert.equal(value.state, 'owned'); assert.equal(value.deployed, true);
    assert.ok(calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('a Worker created from another repo with the same slug is refused', async () => {
  const { dir } = await gitFixture();
  const calls = scenario('owned-tag', { STUB_TAG: tagFor(SLUG, '99999999') });
  try {
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, noVerify: true }));
    assert.equal(value.refused, 'foreign');
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
  } finally { rm(dir); }
});

test('deploy refuses while datasafety has findings, before any wrangler call', async () => {
  const calls = scenario('absent');
  const { dir } = await gitFixture();
  try {
    const p = path.join(dir, 'walkthrough.src.html');
    writeFileSync(p, readFileSync(p, 'utf8').replace('Maya needs a drill', 'Karen needs a drill'));
    const { value } = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true }));
    assert.equal(value.refused, 'datasafety');
    assert.equal(calls().length, 0);
  } finally { rm(dir); }
});

test('deploy needs a repo identity: an app repo with no commits and no origin is an error', async () => {
  scenario('absent');
  const dir = copyFixture();   // no git
  try { await assert.rejects(quiet(() => deploy(dir, { wrangler: STUB, account: ACCT })), /repo identity/); } finally { rm(dir); }
});

test('repoIdentity differs between repos and is stable within one', () => {
  const mk = (msg) => { const d = mkdtempSync(path.join(tmpdir(), 'wt-rid-')); const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' }); g('init', '-q'); writeFileSync(path.join(d, 'a'), msg); g('add', '-A'); g('commit', '-qm', msg); return d; };
  const a = mk('one'), b = mk('two');
  try {
    assert.notEqual(repoIdentity(a), repoIdentity(b));
    assert.equal(repoIdentity(a), repoIdentity(a));
  } finally { rm(a); rm(b); }
});

test('a screenshot-mode walkthrough needs a second confirmation before it publishes', async () => {
  const calls = scenario('absent');
  const { dir } = await gitFixture();
  try {
    editManifest(dir, (m) => { m.mode = 'shots'; m.datasafety = { acknowledged: [], attestNoRealData: true }; });
    const a = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, noVerify: true }));
    assert.equal(a.value.refused, 'screenshots');
    assert.ok(!calls().some((c) => c.args[0] === 'deploy'));
    const b = await quiet(() => deploy(dir, { wrangler: STUB, account: ACCT, yes: true, confirmScreenshots: true, noVerify: true }));
    assert.equal(b.value.deployed, true);
  } finally { rm(dir); }
});

/* ---- accounts ---- */
test('several accounts and none chosen: it stops instead of guessing', async () => {
  scenario('absent', { STUB_ACCOUNTS: 'a'.repeat(32) + ',' + 'b'.repeat(32) });
  await assert.rejects(resolveAccount({ wrangler: STUB, env: {} }), /2 accounts/);
  process.env.STUB_ACCOUNTS = 'a'.repeat(32);
  assert.equal((await resolveAccount({ wrangler: STUB, env: {} })).id, 'a'.repeat(32));
});
test('--account and CLOUDFLARE_ACCOUNT_ID beat deploy.json', async () => {
  scenario('absent');
  const env = { CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32) };
  assert.equal((await resolveAccount({ wrangler: STUB, env, deployJson: { accountId: 'd'.repeat(32) } })).source, 'CLOUDFLARE_ACCOUNT_ID');
  assert.equal((await resolveAccount({ wrangler: STUB, env, flagValue: 'e'.repeat(32) })).source, '--account');
});
test('a deploy.json accountId must be well-formed and listed by wrangler whoami', async () => {
  scenario('absent', { STUB_ACCOUNTS: 'a'.repeat(32) });
  await assert.rejects(resolveAccount({ wrangler: STUB, env: {}, deployJson: { accountId: 'not-an-id' } }), /32 hex/);
  await assert.rejects(resolveAccount({ wrangler: STUB, env: {}, deployJson: { accountId: 'b'.repeat(32) } }), /does not list/);
  const ok = await resolveAccount({ wrangler: STUB, env: {}, deployJson: { accountId: 'a'.repeat(32) } });
  assert.equal(ok.id, 'a'.repeat(32)); assert.equal(ok.source, 'deploy.json');
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

test('slugify makes a safe Worker name part', () => { assert.equal(slugify('Acme Weekly_Plan!'), 'acme-weekly-plan'); });
