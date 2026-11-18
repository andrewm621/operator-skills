/* Runs template/workflow.js with stubbed agents: its control flow, for no tokens.
   This proves the rounds, gates, ceilings and time limit behave. It doesn't prove real agents
   build good pages; only a real run can show that. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, '..', 'template', 'workflow.js'), 'utf8').replace('export const meta', 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const ARGS = {
  out: '/tmp/run', skillDir: '/tmp/skill', client: 'Northfield', slug: 'nf', title: 'Northfield',
  sources: ['/tmp/a.md'], tracks: [{ key: 'orders', title: 'Orders' }], rules: ['No writes'],
};

const PLAN = {
  tracks: [{ key: 'orders', title: 'Orders', shape: 'options', options: [
    { slug: 'a', name: 'A', concept: 'c', forWho: 'w', primaryDevice: 'desktop', buildSpec: 's' },
    { slug: 'b', name: 'B', concept: 'c', forWho: 'w', primaryDevice: 'ipadL', buildSpec: 's' },
  ] }],
  dataNeeds: 'orders', conflicts: ['The cutoff is 6:00 on the call and 5:30 on the sheet'],
};
const BUILT = { summary: 's', clientSummary: 'c', answers: [], tradeoffs: 't', questions: [], knownGaps: [], demoTip: 'd' };
const HIGH = { file: 'a', severity: 'high', problem: 'p', fix: 'f' };

/* handlers: { 'critic:orders:r1': () => ... } overrides the default answer for a label prefix. */
async function run(args, handlers = {}) {
  const labels = [];
  const logs = [];
  const prompts = {};
  const pass = { ok: true, epoch: 1000, failureCount: 0, failures: [], warnings: [] };
  const agent = async (prompt, opts = {}) => {
    const label = opts.label;
    labels.push(label);
    prompts[label] = prompt;
    const key = Object.keys(handlers).filter((k) => label === k || label.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (key) return handlers[key](label, prompt);
    if (label === 'brief') return PLAN;
    if (label.startsWith('build:')) return BUILT;
    if (label.startsWith('gate:')) return pass;
    if (label.startsWith('critic:')) return { findings: [] };
    if (label.startsWith('verify:')) return { unresolved: [], newProblems: [] };
    return 'done';
  };
  const parallel = async (thunks) => Promise.all(thunks.map((f) => f().catch(() => null)));
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let value = item;
    for (const stage of stages) value = await stage(value, item, i);
    return value;
  }));
  const script = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', SOURCE);
  const result = await script(agent, parallel, pipeline, () => {}, (m) => logs.push(m), { ...ARGS, ...args }, {});
  return { result, labels, logs, prompts };
}
const count = (labels, prefix) => labels.filter((l) => l.startsWith(prefix)).length;

test('a clean run goes brief, foundation, builds, gate, critic, hub, audit, final gate', async () => {
  const { result, labels } = await run();
  assert.equal(labels[0], 'brief');
  assert.equal(labels[1], 'foundation');
  assert.equal(count(labels, 'build:'), 2);
  assert.equal(count(labels, 'critic:'), 1);
  assert.equal(count(labels, 'fix:'), 0);
  assert.equal(count(labels, 'verify:'), 0, 'nothing was fixed, so nothing needs verifying');
  assert.ok(labels.indexOf('hub-data') < labels.indexOf('audit'));
  assert.equal(labels.at(-1), 'gate:final');
  assert.equal(result.passedFinalGate, true);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.conflicts, PLAN.conflicts);
});

test('a failing gate gets a fix and a recheck, and stops at the ceiling instead of looping', async () => {
  const bad = { ok: false, epoch: 1000, failureCount: 1, failures: [{ rule: 'deny-term', detail: 'x' }], warnings: [] };
  const { result, labels } = await run({}, { 'gate:final': () => bad });
  assert.equal(count(labels, 'gatefix:final'), 2);
  assert.equal(result.passedFinalGate, false);
  assert.equal(result.finalFailures.length, 1);
});

test('the last fix is always re-checked, even with only one critique round', async () => {
  const { labels } = await run({ criticRounds: 1 }, { 'critic:orders:r1': () => ({ findings: [HIGH] }) });
  assert.equal(count(labels, 'fix:orders:r1'), 1);
  assert.equal(count(labels, 'verify:orders'), 1);
});

test('problems the re-check finds reach the result and the hub', async () => {
  const { result, prompts } = await run({}, {
    'critic:orders:r1': () => ({ findings: [HIGH] }),
    'verify:orders': () => ({ unresolved: [{ file: 'a', problem: 'p', whatISaw: 'still broken' }], newProblems: [{ file: 'b', problem: 'new' }] }),
  });
  assert.equal(result.unresolved.length, 2);
  assert.match(prompts['hub-data'], /still broken/);
  assert.match(prompts['hub-data'], /The cutoff is 6:00/, 'conflicts must reach the hub');
});

test('low findings alone stop the critique without a fix', async () => {
  const { labels } = await run({ criticRounds: 2 }, { 'critic:orders:r1': () => ({ findings: [{ ...HIGH, severity: 'low' }] }) });
  assert.equal(count(labels, 'critic:'), 1);
  assert.equal(count(labels, 'fix:'), 0);
});

test('past the time limit, round 2 is skipped and the result says so', async () => {
  const late = { ok: true, epoch: 2000, failureCount: 0, failures: [], warnings: [] };
  const { result, labels } = await run({ criticRounds: 2, deadlineEpoch: 1500 }, {
    'critic:orders:r1': () => ({ findings: [HIGH] }),
    'gate:': () => late,
  });
  assert.equal(count(labels, 'critic:'), 1);
  assert.ok(result.skipped.some((s) => /round 2/.test(s)));
  assert.equal(result.pastDeadline, true);
  assert.equal(count(labels, 'verify:orders'), 1, 'the time limit must not skip re-checking fixes already made');
});

test('within the time limit, round 2 runs', async () => {
  const { labels } = await run({ criticRounds: 2, deadlineEpoch: 5000 }, { 'critic:orders:r1': () => ({ findings: [HIGH] }) });
  assert.equal(count(labels, 'critic:'), 2);
});

test('zero critique rounds is allowed, and reported rather than hidden', async () => {
  const { result, labels } = await run({ criticRounds: 0 });
  assert.equal(count(labels, 'critic:'), 0);
  assert.ok(result.skipped.some((s) => /critique/.test(s)));
});

test('an option whose builder dies is reported, and the rest carry on', async () => {
  const { result, labels } = await run({}, { 'build:orders/a': () => null });
  assert.ok(result.skipped.some((s) => /orders\/a/.test(s)));
  assert.equal(count(labels, 'critic:'), 1);
});

test('a track shaped as stages reaches the hub as stages', async () => {
  const stages = { ...PLAN, tracks: [{ ...PLAN.tracks[0], shape: 'stages' }] };
  const { prompts } = await run({}, { brief: () => stages });
  assert.match(prompts['hub-data'], /"shape": "stages"/);
});

test('unresolved problems reach the hub as things that block the sign-off', async () => {
  const { prompts } = await run({}, {
    'critic:orders:r1': () => ({ findings: [HIGH] }),
    'verify:orders': () => ({ unresolved: [{ file: 'a', problem: 'p', whatISaw: 'still broken' }], newProblems: [] }),
  });
  assert.match(prompts['hub-data'], /openFindings/);
  assert.match(prompts['hub-data'], /blocks the sign-off/);
  assert.match(prompts['hub-data'], /agenda groups by that exact text/);
});

test('a gate that returns nothing stops the run instead of passing silently', async () => {
  await assert.rejects(run({}, { 'gate:orders:build': () => null }), /can't say whether the pages pass/);
});

test('missing args fail before any agent runs', async () => {
  await assert.rejects(run({ rules: undefined }), /Missing args\.rules/);
});

test('client rules reach every builder and critic', async () => {
  const { prompts } = await run({ rules: ['A rule only this client has'] });
  assert.match(prompts['build:orders/a'], /A rule only this client has/);
  assert.match(prompts['critic:orders:r1'], /A rule only this client has/);
});

test('meta stays a pure literal, as the Workflow tool requires', () => {
  const raw = readFileSync(path.join(HERE, '..', 'template', 'workflow.js'), 'utf8');
  const block = raw.slice(raw.indexOf('export const meta'), raw.indexOf('\n}\n') + 2);
  assert.ok(!/\$\{|\.\.\.|\(\)/.test(block.replace(/\(lows.*/, '')));
  assert.ok(!/Date\.now|Math\.random|new Date\(\)/.test(raw), 'these throw inside a workflow');
});
