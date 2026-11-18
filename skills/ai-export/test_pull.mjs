// Tests for pull-chatgpt.js and download.js. No dependencies: node:test + node:vm, a fake window / location /
// fetch / document, and a fake chatgpt.com backend. Timers are stubbed so backoff and gaps run instantly (the
// requested delays are recorded). Never touches the network.
//
// Run:  node --test skills/ai-export/test_pull.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PULL = fs.readFileSync(path.join(HERE, 'pull-chatgpt.js'), 'utf8');
const DOWNLOAD = fs.readFileSync(path.join(HERE, 'download.js'), 'utf8');
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXItc2VjcmV0In0.c2lnbmF0dXJlLXNlY3JldA';
const P1 = 'g-p-' + 'b'.repeat(32), P2 = 'g-p-' + 'c'.repeat(32);
const PART_RE = /^chatgpt-account-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}-part-[0-9]{3}\.json$/;

// values made inside the vm have the vm realm's prototypes, so compare them as plain JSON
const deq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m);
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const iso = (s) => new Date(s * 1000).toISOString();

function withCfg(cfg) {
  const start = PULL.indexOf('const CFG = {'), end = PULL.indexOf('};', start) + 2;
  assert.ok(start > 0 && end > start, 'CFG block not found');
  const full = { mode: 'account', id: null, since: null, listOnly: false, fetchUnchanged: false, fetchTextdocs: false, gapMs: 600,
                 partBytes: 100000000, maxThreads: null, maxMinutes: null, jitterMs: 0, onlyIds: null, resumeOf: null, ...cfg };
  return PULL.slice(0, start) + 'const CFG = ' + JSON.stringify(full) + ';' + PULL.slice(end);
}
const withDownload = (edits = {}) => {
  let s = DOWNLOAD;
  if (edits.errorOk) s = s.replace('const ERROR_PART_OK = false;', 'const ERROR_PART_OK = true;');
  if (edits.name) s = s.replace("const NAME = 'chatgpt-project-YYYY-MM-DD.json';", `const NAME = '${edits.name}';`);
  return s;
};

function conv(id, pad = 0, extra = {}) {
  return {
    conversation_id: id, title: 'T ' + id.slice(-4), create_time: 1760000000, update_time: 1760000100, current_node: 'b',
    mapping: { a: { id: 'a', parent: null, children: ['b'], message: null },
               b: { id: 'b', parent: 'a', children: [], message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['x'.repeat(pad) || 'hi'] }, create_time: 1760000100, metadata: {} } } },
    ...extra,
  };
}

// ---- fake backend
function server(o = {}) {
  const main = o.main || [], archived = o.archived || [], projects = o.projects || {};
  const log = [], counts = {};
  let inflight = 0, maxInflight = 0;
  const resp = (status, body) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text, headers: { get: (n) => (status === 429 && o.retryAfter !== undefined && String(n).toLowerCase() === 'retry-after' ? o.retryAfter : null) } };
  };
  const fetch = async (url, init) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setImmediate(r));
    inflight--;
    const u = new URL(url, 'https://chatgpt.com');
    log.push(u.pathname + u.search);
    if (u.pathname === '/api/auth/session') return resp(200, { accessToken: TOKEN, user: { id: 'u' } });
    if ((init && init.headers && init.headers.Authorization) !== 'Bearer ' + TOKEN) return resp(403, { detail: 'no auth' });
    if (o.hook) { const h = await o.hook(u, counts); if (h) return h; }
    if (u.pathname === '/backend-api/conversations') {
      const list = u.searchParams.get('is_archived') === 'true' ? archived : main;
      const off = o.ignoreOffset ? 0 : Number(u.searchParams.get('offset'));
      if (o.infiniteMain && list === main) return resp(200, { items: Array.from({ length: 100 }, (_, i) => ({ id: uuid(1e6 + off + i), title: 'x', update_time: iso(1760000000) })), total: 101, limit: 100 });
      return resp(200, { items: list.slice(off, off + 100), total: 101, limit: 100, offset: off });
    }
    if (u.pathname === '/backend-api/gizmos/snorlax/sidebar') {
      if (o.sidebar) return resp(200, o.sidebar(u.searchParams.get('cursor')));
      return resp(200, { items: Object.entries(projects).map(([id, p]) => ({ gizmo: { gizmo: { id, display: { name: p.name } } } })), cursor: null });
    }
    const gm = u.pathname.match(/^\/backend-api\/gizmos\/(g-p-[A-Za-z0-9-]+)\/conversations$/);
    if (gm) {
      const p = projects[gm[1]]; if (!p) return resp(404, {});
      const c = Number(u.searchParams.get('cursor'));
      const next = c + 2 < p.rows.length ? String(c + 2) : null;
      return resp(200, { items: p.rows.slice(c, c + 2), cursor: next });
    }
    const cm = u.pathname.match(/^\/backend-api\/conversation\/([0-9a-f-]{36})$/);
    if (cm) {
      const id = cm[1]; counts[id] = (counts[id] || 0) + 1;
      if (o.conv) { const r = o.conv(id, counts[id]); if (typeof r === 'number') return resp(r, { detail: 'x' }); if (r) return resp(200, r); }
      return resp(200, conv(id, o.pad || 0));
    }
    return resp(404, {});
  };
  return { fetch, log, counts, get maxInflight() { return maxInflight; } };
}

// ---- fake page. After the last test the fake timers stop firing, so a job a failed test left paused cannot hang the run.
let closed = false;
after(() => { closed = true; });
function page(srv) {
  const sleeps = [], downloads = [], logs = [], blobs = new Map();
  let n = 0;
  // controllable clock for maxMinutes: the job reads Date.now(); fake sleeps advance it by the requested delay,
  // and a test can add more with pg.clock.t += ms (the real Date constructor is left alone)
  const clock = { t: Date.now() };
  class FakeDate extends Date { static now() { return clock.t; } }
  const ctx = {
    location: { origin: 'https://chatgpt.com' }, fetch: srv.fetch, crypto: globalThis.crypto, Blob, Date: FakeDate,
    setTimeout: (fn, ms) => { sleeps.push(ms); clock.t += ms; return closed ? null : setImmediate(fn); },
    console: { log: (...a) => logs.push(a), error: (...a) => logs.push(a), warn: (...a) => logs.push(a) },
    URL: { createObjectURL: (b) => { const id = 'blob:' + ++n; blobs.set(id, b); return id; }, revokeObjectURL: () => {} },
    document: { body: { appendChild: () => {} }, createElement: () => ({ style: {}, remove() {}, click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }); } }) },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return { ctx, sleeps, downloads, logs, clock, run: (src) => vm.runInContext(src, ctx) };
}

async function until(cond, label) {
  for (let i = 0; i < 400000; i++) { if (cond()) return; await new Promise((r) => setImmediate(r)); }
  throw new Error('timed out waiting for ' + label);
}
const status = (pg) => pg.ctx.window.__pull && pg.ctx.window.__pull.status;
const settled = (pg) => () => ['ready', 'listed', 'part_ready'].includes(status(pg)) || String(status(pg)).startsWith('error');
async function text(d) { return JSON.parse(await d.blob.text()); }

function fixture() {
  const main = Array.from({ length: 137 }, (_, i) => ({ id: uuid(i + 1), title: 'Main ' + (i + 1), create_time: iso(1700000000 + i), update_time: iso(1750000000 - i) }));
  main[4].gizmo_id = P1;              // a project thread the main list also carries
  main[5].gizmo_id = 'g-abcdef1234';  // a custom GPT: never a project
  return {
    main,
    archived: [{ id: uuid(200), title: 'Arch A', create_time: iso(1700000000), update_time: iso(1700000000) },
               { id: uuid(201), title: 'Arch B', create_time: iso(1700000000), update_time: iso(1700000000) }],
    projects: {
      [P1]: { name: 'Proj One', rows: [main[4], { id: uuid(300), title: 'Only in P1', create_time: iso(1700000000), update_time: iso(1760000000) },
                                       { id: uuid(301), title: 'Only in P1 too', create_time: iso(1700000000), update_time: iso(1700000000) }] },
      [P2]: { name: 'Proj Two', rows: [{ id: uuid(302), title: 'P2 thread', create_time: iso(1700000000), update_time: iso(1700000000) }] },
    },
  };
}

test('account listing: union of main, archived and projects, de-duplicated, short-page stop, total not trusted', async () => {
  const srv = server(fixture());
  const pg = page(srv);
  pg.run(withCfg({ listOnly: true }));
  await until(settled(pg), 'listed');
  assert.equal(status(pg), 'listed');
  const b = pg.ctx.window.__bundle;
  assert.equal(b.schema, 3); assert.equal(b.kind, 'account'); assert.equal(pg.ctx.window.__part, null);
  assert.equal(b.listing.length, 137 + 2 + 2 + 1);
  assert.equal(new Set(b.listing.map((r) => r.id)).size, b.listing.length);
  const row = (n) => b.listing.find((r) => r.id === uuid(n));
  deq(row(5).sources, ['main', 'project']);
  assert.equal(row(5).project, P1); assert.equal(row(5).project_name, 'Proj One');
  assert.equal(row(6).project, null); assert.equal(row(6).gizmo_id, 'g-abcdef1234');
  deq(row(300).sources, ['project']); assert.equal(row(300).project, P1);
  deq(row(200).sources, ['archived']);
  assert.equal(row(302).project_name, 'Proj Two');
  assert.equal(b.sources.main.stop_reason, 'complete'); assert.equal(b.sources.main.pages, 2);
  assert.equal(b.sources.main.count, 137); assert.equal(b.sources.main.total_reported, 101);
  assert.equal(b.sources.archived.stop_reason, 'complete'); assert.equal(b.sources.archived.new, 2);
  assert.equal(b.sources.projects.count, 2);
  assert.equal(b.sources.project_threads[P1].stop_reason, 'complete'); assert.equal(b.sources.project_threads[P1].pages, 2);
  assert.equal(b.listing_complete, true); assert.equal(b.stop_reason, 'complete'); assert.equal(b.partial, false);
  assert.equal(srv.log.filter((l) => l.startsWith('/backend-api/conversation/')).length, 0, 'list-only fetches no bodies');
  assert.equal(srv.maxInflight, 1, 'requests are sequential');
  assert.ok(pg.sleeps.filter((s) => s === 600).length >= srv.log.length - 2, 'gapMs between requests');
});

test('sidebar shapes: nested, single-level and flat items; custom GPTs skipped; cursor followed; stuck cursor reported', async () => {
  const f = fixture();
  const pages = { null: { items: [{ gizmo: { gizmo: { id: P1, display: { name: 'Proj One' } } } }, { gizmo: { gizmo: { id: 'g-123456abc', display: { name: 'A GPT' } } } }], cursor: 'c1' },
                  c1: { items: [{ gizmo: { id: P2, name: 'Proj Two' } }], cursor: 'c2' }, c2: { items: [{ id: 'g-p-' + 'd'.repeat(32), name: 'Flat' }], cursor: null } };
  let pg = page(server({ ...f, sidebar: (c) => pages[c] }));
  pg.run(withCfg({ listOnly: true }));
  await until(settled(pg), 'listed');
  let s = pg.ctx.window.__bundle.sources.projects;
  assert.equal(s.stop_reason, 'complete'); assert.equal(s.count, 3); assert.equal(s.other_gizmos, 1); assert.equal(s.pages, 3);
  pg = page(server({ ...f, sidebar: () => ({ items: [], cursor: 'same' }) }));
  pg.run(withCfg({ listOnly: true }));
  await until(settled(pg), 'listed');
  const b = pg.ctx.window.__bundle;
  assert.equal(b.sources.projects.stop_reason, 'stuck_cursor');
  assert.equal(b.partial, true); assert.equal(b.stop_reason, 'projects:stuck_cursor');
});

test('page ceiling and a list that ignores offset are reported as stop reasons, never as complete', async () => {
  let pg = page(server({ ...fixture(), infiniteMain: true }));
  pg.run(withCfg({ listOnly: true }));
  await until(settled(pg), 'listed');
  let b = pg.ctx.window.__bundle;
  assert.equal(b.sources.main.stop_reason, 'ceiling'); assert.equal(b.sources.main.pages, 500);
  assert.equal(b.listing_complete, false); assert.equal(b.partial, true); assert.equal(b.stop_reason, 'main:ceiling');
  assert.equal(pg.ctx.window.__pull.partial, true);
  pg = page(server({ ...fixture(), ignoreOffset: true }));
  pg.run(withCfg({ listOnly: true }));
  await until(settled(pg), 'listed');
  b = pg.ctx.window.__bundle;
  assert.equal(b.sources.main.stop_reason, 'no_progress'); assert.equal(b.partial, true);
});

test('since: new / grown / unchanged triage, early since_cutoff stop on main after one safety page', async () => {
  const since = 1750000000;
  const main = Array.from({ length: 400 }, (_, i) => {
    const r = { id: uuid(i + 1), title: 'm' + i };
    if (i < 50) { r.create_time = iso(since + 1000 - i); r.update_time = iso(since + 2000 - i); }          // new
    else if (i < 80) { r.create_time = iso(since - 5000); r.update_time = iso(since + 500 - i); }          // grown
    else { r.create_time = iso(since - 9000); r.update_time = iso(since - 100 - i); }                     // unchanged
    return r;
  });
  const srv = server({ main, archived: [], projects: {} });
  const pg = page(srv);
  pg.run(withCfg({ listOnly: true, since: iso(since) }));
  await until(settled(pg), 'listed');
  const b = pg.ctx.window.__bundle, P = pg.ctx.window.__pull;
  assert.equal(b.sources.main.stop_reason, 'since_cutoff'); assert.equal(b.sources.main.pages, 3);
  assert.equal(b.listing.length, 300);
  assert.equal(b.listing_complete, true); assert.equal(b.stop_reason, 'complete');
  deq([P.new, P.grown, P.unchanged], [50, 30, 220]);
  assert.equal(P.total, 80, 'only new and grown are to fetch');
  // without since the same list is read to its short last page
  const pg2 = page(server({ main, archived: [], projects: {} }));
  pg2.run(withCfg({ listOnly: true }));
  await until(settled(pg2), 'listed');
  assert.equal(pg2.ctx.window.__bundle.sources.main.stop_reason, 'complete');
  assert.equal(pg2.ctx.window.__bundle.listing.length, 400);
});

test('parts: flush at the byte budget, pause until download.js takes the part, resume, final part', async () => {
  const main = Array.from({ length: 7 }, (_, i) => ({ id: uuid(i + 1), title: 'c' + i, create_time: iso(1700000000), update_time: iso(1700000000) }));
  const srv = server({ main, archived: [], projects: {}, pad: 400000 });
  const pg = page(srv);
  pg.run(withCfg({ partBytes: 1000000 }));
  const parts = [];
  for (let k = 0; k < 3; k++) {
    await until(() => (pg.ctx.window.__part && pg.ctx.window.__part.part === k) || String(status(pg)).startsWith('error'), 'part ' + k);
    const expectFinal = k === 2;
    assert.equal(status(pg), expectFinal ? 'ready' : 'part_ready');
    if (!expectFinal) {
      const before = srv.log.length;
      for (let i = 0; i < 2000; i++) await new Promise((r) => setImmediate(r));
      assert.equal(srv.log.length, before, 'no fetching while a part waits');
      assert.equal(JSON.parse(pg.run(withCfg({ partBytes: 1000000 }))).status, 'part_ready', 're-run returns the live job');
    }
    const info = JSON.parse(pg.run(withDownload()));
    if (!expectFinal) assert.equal(status(pg), 'running', 'download.js marks the job running at once');
    assert.match(info.name, PART_RE);
    assert.equal(info.part, k); assert.equal(info.final, expectFinal);
    assert.equal(pg.ctx.window.__part, null, 'buffer freed');
    parts.push(await text(pg.downloads[k]));
    assert.equal(pg.downloads[k].name, info.name);
  }
  deq(parts.map((p) => p.conversations.length), [3, 3, 1]);
  deq(parts.map((p) => p.part), [0, 1, 2]);
  deq(parts.map((p) => p.final), [false, false, true]);
  assert.equal(new Set(parts.map((p) => p.run_id)).size, 1);
  assert.match(parts[0].run_id, /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/);
  assert.equal(new Set(parts.map((p) => p.started_at)).size, 1);
  for (const p of parts) {
    assert.equal(p.schema, 3); assert.equal(p.listing.length, 7); assert.equal(p.partial, false);
    deq(p.ids, p.conversations.map((c) => c.conversation_id));
  }
  deq(parts.flatMap((p) => p.ids), main.map((r) => r.id));
  assert.equal(pg.downloads[0].name, `chatgpt-account-${parts[0].run_id}-part-000.json`);
  assert.match(pg.run(withDownload()), /^no part waiting/);
});

test('onlyIds restricts fetching; resumeOf skips listing; bad ids and misuse are refused', async () => {
  const f = fixture();
  let srv = server(f), pg = page(srv);
  pg.run(withCfg({ onlyIds: [uuid(2), uuid(300)] }));
  await until(settled(pg), 'ready');
  deq(srv.log.filter((l) => l.startsWith('/backend-api/conversation/')), [`/backend-api/conversation/${uuid(2)}`, `/backend-api/conversation/${uuid(300)}`]);
  let part = pg.ctx.window.__part;
  deq(part.ids, [uuid(2), uuid(300)]); deq(part.only_ids, [uuid(2), uuid(300)]);
  assert.equal(part.listing.length, 142, 'a plain onlyIds run still lists');

  srv = server(f); pg = page(srv);
  pg.run(withCfg({ onlyIds: [uuid(7)], resumeOf: '20261110T120000Z-abc123' }));
  await until(settled(pg), 'ready');
  deq(srv.log.slice(1), [`/backend-api/conversation/${uuid(7)}`], 'a resume run fetches only its ids');
  part = pg.ctx.window.__part;
  assert.equal(part.resume_of, '20261110T120000Z-abc123'); assert.equal(part.listing_skipped, true);
  assert.equal(part.listing.length, 0); assert.equal(part.partial, false); assert.equal(part.sources, null);

  for (const [cfg, msg] of [[{ onlyIds: ['not-a-uuid'] }, /onlyIds/], [{ onlyIds: [] }, /onlyIds/], [{ onlyIds: uuid(1) }, /onlyIds/],
                            [{ resumeOf: '20261110T120000Z-abc123' }, /resumeOf needs onlyIds/], [{ onlyIds: [uuid(1)], resumeOf: '../x' }, /resumeOf/],
                            [{ partBytes: 10 }, /partBytes/], [{ maxThreads: 0 }, /maxThreads/], [{ maxMinutes: 0 }, /maxMinutes/], [{ id: 'g-p-' + 'a'.repeat(32) }, /mode\/id/],
                            [{ mode: 'project', id: P1, onlyIds: [uuid(1)] }, /account-mode only/], [{ gapMs: 100 }, /gapMs/]]) {
    const p2 = page(server(f));
    assert.match(String(p2.run(withCfg(cfg))), msg, JSON.stringify(cfg));
    assert.equal(p2.ctx.window.__pull, undefined, 'no job started');
  }
  const wrong = page(server(f)); wrong.ctx.location.origin = 'https://evil.example';
  assert.match(wrong.run(withCfg({})), /wrong origin/);
});

test('a thread that 404s between listing and fetch is an error row, not a crash; maxThreads caps cleanly', async () => {
  const main = Array.from({ length: 5 }, (_, i) => ({ id: uuid(i + 1), title: 'c' + i, create_time: iso(1700000000), update_time: iso(1700000000) }));
  let pg = page(server({ main, archived: [], projects: {}, conv: (id) => (id === uuid(3) ? 404 : null) }));
  pg.run(withCfg({}));
  await until(settled(pg), 'ready');
  assert.equal(status(pg), 'ready');
  let part = pg.ctx.window.__part;
  deq(part.errors, [{ id: uuid(3), status: 404 }]);
  assert.equal(part.conversations.length, 4); assert.equal(pg.ctx.window.__pull.errors, 1);

  const srv = server({ main, archived: [], projects: {} });
  pg = page(srv);
  pg.run(withCfg({ maxThreads: 2 }));
  await until(settled(pg), 'ready');
  part = pg.ctx.window.__part;
  assert.equal(status(pg), 'ready'); assert.equal(pg.ctx.window.__pull.capped, true);
  assert.equal(part.capped, true); assert.equal(part.remaining, 3); assert.equal(part.partial, false);
  assert.equal(part.to_fetch_count, 5); assert.equal(part.conversations.length, 2);
  assert.equal(srv.log.filter((l) => l.startsWith('/backend-api/conversation/')).length, 2);
});

const mainRows = (n) => Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), title: 'c' + i, create_time: iso(1700000000), update_time: iso(1700000000) }));
const fetched = (srv) => srv.log.filter((l) => l.startsWith('/backend-api/conversation/')).length;

test('maxMinutes: a time cap mid-fetch ends ready + capped_by time, remaining counts the rest, to_fetch_count is the true total', async () => {
  let pg;
  const srv = server({ main: mainRows(5), archived: [], projects: {}, conv: () => { pg.clock.t += 20000; return null; } }); // each fetch "takes" 20 s
  pg = page(srv);
  pg.run(withCfg({ maxMinutes: 1 }));
  await until(settled(pg), 'ready');
  const part = pg.ctx.window.__part, P = pg.ctx.window.__pull;
  assert.equal(status(pg), 'ready');
  assert.equal(part.final, true); assert.equal(part.partial, false); assert.equal(part.listing_complete, true); assert.equal(part.error, null);
  assert.equal(part.capped, true); assert.equal(part.capped_by, 'time'); assert.equal(part.remaining, 2);
  assert.equal(part.conversations.length, 3); assert.equal(fetched(srv), 3);
  assert.equal(part.to_fetch_count, 5, 'to_fetch_count stays the pre-cap total');
  assert.equal(part.max_minutes, 1); assert.equal(part.max_threads, null);
  assert.equal(P.capped, true); assert.equal(P.remaining, 2); assert.equal(P.capped_by, 'time');
  deq(part.ids, [uuid(1), uuid(2), uuid(3)]);

  // a deadline that is never reached leaves the run uncapped
  pg = page(server({ main: mainRows(5), archived: [], projects: {} }));
  pg.run(withCfg({ maxMinutes: 600 }));
  await until(settled(pg), 'ready');
  const p2 = pg.ctx.window.__part;
  assert.equal(p2.capped, false); assert.equal(p2.capped_by, null); assert.equal(p2.remaining, 0); assert.equal(p2.conversations.length, 5);
  assert.equal(p2.to_fetch_count, 5); assert.equal(p2.max_minutes, 600);
  assert.equal(pg.ctx.window.__pull.capped, undefined);
});

test('maxMinutes with maxThreads: remaining covers both caps and the time cap wins capped_by; maxThreads alone says threads', async () => {
  let pg;
  const srv = server({ main: mainRows(6), archived: [], projects: {}, conv: () => { pg.clock.t += 20000; return null; } });
  pg = page(srv);
  pg.run(withCfg({ maxThreads: 4, maxMinutes: 1 }));
  await until(settled(pg), 'ready');
  let part = pg.ctx.window.__part;
  assert.equal(part.capped, true); assert.equal(part.capped_by, 'time');
  assert.equal(part.conversations.length, 3); assert.equal(part.remaining, 3, '2 cut by maxThreads + 1 cut by the clock');
  assert.equal(part.to_fetch_count, 6); assert.equal(pg.ctx.window.__pull.remaining, 3); assert.equal(pg.ctx.window.__pull.capped_by, 'time');

  // maxThreads reached first (deadline far away): capped_by is threads
  pg = page(server({ main: mainRows(6), archived: [], projects: {} }));
  pg.run(withCfg({ maxThreads: 4, maxMinutes: 600 }));
  await until(settled(pg), 'ready');
  part = pg.ctx.window.__part;
  assert.equal(part.capped, true); assert.equal(part.capped_by, 'threads'); assert.equal(part.remaining, 2);
  assert.equal(part.to_fetch_count, 6); assert.equal(pg.ctx.window.__pull.capped_by, 'threads');

  // the clock runs out exactly after the last allowed thread: nothing is left to cut, so maxThreads stays the reason
  pg = page(server({ main: mainRows(6), archived: [], projects: {}, conv: () => { pg.clock.t += 600000; return null; } }));
  pg.run(withCfg({ maxThreads: 1, maxMinutes: 1 }));
  await until(settled(pg), 'ready');
  part = pg.ctx.window.__part;
  assert.equal(part.capped_by, 'threads'); assert.equal(part.remaining, 5); assert.equal(part.conversations.length, 1);
});

test('maxMinutes: a deadline already passed when fetching begins ends capped with zero conversations; the listing is never cut', async () => {
  const f = fixture();
  let pg;
  // every listing request jumps the clock 10 minutes: the deadline is long gone before the first fetch
  const srv = server({ ...f, hook: async (u) => { if (!u.pathname.startsWith('/backend-api/conversation/')) pg.clock.t += 600000; return null; } });
  pg = page(srv);
  pg.run(withCfg({ maxMinutes: 1 }));
  await until(settled(pg), 'ready');
  const part = pg.ctx.window.__part;
  assert.equal(status(pg), 'ready');
  assert.equal(part.listing_complete, true); assert.equal(part.partial, false); assert.equal(part.stop_reason, 'complete');
  assert.equal(part.listing.length, 142, 'the whole listing was read');
  assert.equal(part.sources.main.stop_reason, 'complete'); assert.equal(part.sources.project_threads[P1].stop_reason, 'complete');
  assert.equal(part.capped, true); assert.equal(part.capped_by, 'time');
  assert.equal(part.conversations.length, 0); assert.equal(fetched(srv), 0);
  assert.equal(part.remaining, 142); assert.equal(part.to_fetch_count, 142);
  assert.equal(pg.ctx.window.__pull.remaining, 142); assert.equal(pg.ctx.window.__pull.capped, true);
});

test('maxMinutes: a resume run (resumeOf + onlyIds) honours it too', async () => {
  let pg;
  const ids = [1, 2, 3, 4].map(uuid);
  const srv = server({ main: mainRows(5), archived: [], projects: {}, conv: () => { pg.clock.t += 20000; return null; } });
  pg = page(srv);
  pg.run(withCfg({ onlyIds: ids, resumeOf: '20261110T120000Z-abc123', maxMinutes: 1 }));
  await until(settled(pg), 'ready');
  const part = pg.ctx.window.__part;
  assert.equal(part.listing_skipped, true); assert.equal(part.listing.length, 0);
  assert.equal(part.capped, true); assert.equal(part.capped_by, 'time'); assert.equal(part.remaining, 1);
  assert.equal(part.conversations.length, 3); assert.equal(part.to_fetch_count, 4);
  assert.equal(part.partial, false);
});

test('maxMinutes validation: null or a number from 1 to 600, account mode only', async () => {
  const f = { main: mainRows(2), archived: [], projects: {} };
  for (const bad of [0, 0.5, 601, -1, '5', true, [5], {}]) {
    const p = page(server(f));
    assert.equal(p.run(withCfg({ maxMinutes: bad })), 'bad CFG: maxMinutes', JSON.stringify(bad));
    assert.equal(p.ctx.window.__pull, undefined, 'no job started');
  }
  for (const cfg of [{ mode: 'project', id: P1, maxMinutes: 5 }, { mode: 'thread', id: uuid(1), maxMinutes: 5 }]) {
    const p = page(server(f));
    assert.match(String(p.run(withCfg(cfg))), /account-mode only/, JSON.stringify(cfg));
    assert.equal(p.ctx.window.__pull, undefined);
  }
  for (const ok of [1, 1.5, 600]) {
    const p = page(server(f));
    const r = p.run(withCfg({ maxMinutes: ok }));
    assert.equal(JSON.parse(r).status, 'running', String(ok));
    await until(settled(p), 'ready');
    assert.equal(p.ctx.window.__part.max_minutes, ok);
  }
});

const isConvReq = (l) => l.startsWith('/backend-api/conversation/');
const ERR_RE = /^error: rate limited \(429\), not retried/;

test('429 in account mode: the first one stops the run at once, no retry, error part keeps what was buffered (download opt-in)', async () => {
  const srv = server({ main: mainRows(3), archived: [], projects: {}, conv: (id) => (id === uuid(2) ? 429 : null) });
  let pg = page(srv);
  pg.run(withCfg({}));
  await until(settled(pg), 'error');
  assert.match(status(pg), ERR_RE);
  assert.equal(srv.counts[uuid(2)], 1, 'exactly one request for the thread that got the 429: no retry');
  assert.equal(fetched(srv), 2, 'nothing is fetched after the 429');
  assert.ok(!pg.sleeps.includes(5000), 'no backoff sleep');
  const part = pg.ctx.window.__part;
  assert.equal(part.final, true); assert.equal(part.partial, true); assert.match(part.error, /rate limited/);
  deq(part.ids, [uuid(1)]);
  assert.equal(part.rate_limit.phase, 'fetching'); assert.equal(part.rate_limit.done, 1); assert.equal(part.rate_limit.retry_after_s, null);
  assert.ok(!Number.isNaN(Date.parse(part.rate_limit.at)));
  deq(pg.ctx.window.__pull.rate_limit, part.rate_limit);
  assert.match(pg.run(withDownload()), /^part not ready: error/);
  assert.match(pg.run(withCfg({})), /a part is still waiting/, 'a re-run cannot drop an undownloaded part');
  const info = JSON.parse(pg.run(withDownload({ errorOk: true })));
  assert.equal(info.final, true); assert.match(info.error, /rate limited/);
  assert.equal(pg.ctx.window.__part, null);
});

test('429 Retry-After: seconds, an HTTP date, a junk value and no header', async () => {
  const cases = [['120', 120], ['Fri, 01 Jan 2100 00:00:00 GMT', 'date'], ['soon', null], [undefined, null]];
  for (const [hdr, want] of cases) {
    const pg = page(server({ main: mainRows(2), archived: [], projects: {}, conv: (id) => (id === uuid(1) ? 429 : null), retryAfter: hdr }));
    pg.run(withCfg({}));
    await until(settled(pg), 'error');
    const rl = pg.ctx.window.__part.rate_limit;
    if (want === 'date') assert.ok(Number.isInteger(rl.retry_after_s) && rl.retry_after_s > 1e8, 'seconds until the date');
    else assert.equal(rl.retry_after_s, want, String(hdr));
    if (want === null) assert.doesNotMatch(status(pg), /retry-after/);
    else assert.match(status(pg), /; retry-after \d+s$/);
    assert.equal(rl.done, 0);
  }
  // a date in the past clamps to 0
  const pg = page(server({ main: mainRows(1), archived: [], projects: {}, conv: () => 429, retryAfter: 'Thu, 01 Jan 2004 00:00:00 GMT' }));
  pg.run(withCfg({}));
  await until(settled(pg), 'error');
  assert.equal(pg.ctx.window.__part.rate_limit.retry_after_s, 0);
});

test('429 during the listing (main, project listing) ends the run with phase listing and no retry', async () => {
  let pg, srv = server({ ...fixture(), hook: (u) => (u.pathname === '/backend-api/conversations' && !u.searchParams.get('is_archived') ? { ok: false, status: 429, json: async () => ({}), text: async () => '', headers: { get: () => '7' } } : null) });
  pg = page(srv);
  pg.run(withCfg({}));
  await until(settled(pg), 'error');
  assert.match(status(pg), ERR_RE);
  assert.equal(srv.log.filter((l) => l.startsWith('/backend-api/conversations')).length, 1, 'one listing request, no retry');
  const part = pg.ctx.window.__part;
  assert.equal(part.rate_limit.phase, 'listing'); assert.equal(part.rate_limit.done, 0); assert.equal(part.rate_limit.retry_after_s, 7);
  assert.equal(part.listing_complete, false); assert.equal(part.remaining, null, 'the to-fetch set is unknown before the listing ends');
  assert.equal(fetched(srv), 0);

  srv = server({ ...fixture(), hook: (u) => (/^\/backend-api\/gizmos\/g-p-/.test(u.pathname) ? { ok: false, status: 429, json: async () => ({}), text: async () => '', headers: { get: () => null } } : null) });
  pg = page(srv);
  pg.run(withCfg({}));
  await until(settled(pg), 'error');
  assert.equal(pg.ctx.window.__part.rate_limit.phase, 'listing');
  assert.equal(srv.log.filter((l) => l.startsWith('/backend-api/gizmos/g-p-')).length, 1);
});

test('remaining on a final part is always the to-fetch threads this run did not fetch (error, with and without maxThreads); rate_limit null on a clean run', async () => {
  let pg = page(server({ main: mainRows(10), archived: [], projects: {}, conv: (id) => (id === uuid(4) ? 429 : null) }));
  pg.run(withCfg({}));
  await until(settled(pg), 'error');
  let part = pg.ctx.window.__part;
  assert.equal(part.conversations.length, 3); assert.equal(part.remaining, 7); assert.equal(part.to_fetch_count, 10);
  assert.equal(part.capped, false);

  pg = page(server({ main: mainRows(10), archived: [], projects: {}, conv: (id) => (id === uuid(4) ? 429 : null) }));
  pg.run(withCfg({ maxThreads: 6 }));
  await until(settled(pg), 'error');
  part = pg.ctx.window.__part;
  assert.equal(part.conversations.length, 3); assert.equal(part.remaining, 7, 'not just the 4 cut by maxThreads'); assert.equal(part.to_fetch_count, 10);

  pg = page(server({ main: mainRows(4), archived: [], projects: {} }));
  pg.run(withCfg({}));
  await until(settled(pg), 'ready');
  part = pg.ctx.window.__part;
  assert.equal(part.rate_limit, null); assert.equal(part.remaining, 0); assert.equal(pg.ctx.window.__pull.rate_limit, null);

  pg = page(server({ main: mainRows(10), archived: [], projects: {} }));
  pg.run(withCfg({ maxThreads: 6 }));
  await until(settled(pg), 'ready');
  part = pg.ctx.window.__part;
  assert.equal(part.remaining, 4); assert.equal(part.rate_limit, null);
});

test('jitterMs: each gap is gapMs + random(0..jitterMs); default 0 adds nothing; validated; account mode only', async () => {
  const withRandom = (v) => { const pg = page(server({ main: mainRows(2), archived: [], projects: {} })); pg.ctx.Math = Object.assign(Object.create(Math), { random: () => v }); return pg; };
  let pg = withRandom(0);
  pg.run(withCfg({ jitterMs: 250 }));
  await until(settled(pg), 'ready');
  assert.ok(pg.sleeps.length > 0 && pg.sleeps.every((s) => s === 600), 'random 0 -> exactly gapMs');
  pg = withRandom(0.9999999);
  pg.run(withCfg({ jitterMs: 250 }));
  await until(settled(pg), 'ready');
  assert.ok(pg.sleeps.length > 0 && pg.sleeps.every((s) => s === 850), 'random just under 1 -> gapMs + jitterMs');
  pg = withRandom(0.5);
  pg.run(withCfg({ jitterMs: 250 }));
  await until(settled(pg), 'ready');
  assert.ok(pg.sleeps.every((s) => s === 725));
  pg = page(server({ main: mainRows(2), archived: [], projects: {} }));
  pg.run(withCfg({}));
  await until(settled(pg), 'ready');
  assert.ok(pg.sleeps.every((s) => s === 600), 'default jitter 0');
  for (const bad of [-1, 5001, 1.5, '10', null]) assert.match(page(server({})).run(withCfg({ jitterMs: bad })), /bad CFG: jitterMs/, String(bad));
  assert.doesNotMatch(page(server({})).run(withCfg({ jitterMs: 5000, listOnly: true })), /bad CFG/);
  assert.match(page(server({})).run(withCfg({ mode: 'thread', id: uuid(1), jitterMs: 100 })), /account-mode only/);
});

test('project mode keeps the four-step backoff (5, 10, 20, 40 s) on a persistent 429', async () => {
  const srv = server({ main: [], archived: [], projects: { [P1]: { name: 'P', rows: [{ id: uuid(1), title: 'a', create_time: iso(1700000000), update_time: iso(1700000000) }] } }, conv: () => 429 });
  const pg = page(srv);
  pg.run(withCfg({ mode: 'project', id: P1 }));
  await until(settled(pg), 'ready');
  assert.equal(srv.counts[uuid(1)], 4, 'four attempts');
  deq(pg.sleeps.filter((s) => s >= 5000), [5000, 10000, 20000, 40000]);
  assert.equal(pg.ctx.window.__bundle.errors[0].status, 429);
  assert.equal(pg.ctx.window.__pull.rate_limit, undefined);
});

test('the access token never reaches window, a part, a download, a log or an error string', async () => {
  const f = fixture();
  const scan = (pg) => {
    for (const k of Object.keys(pg.ctx)) {
      if (['fetch', 'crypto', 'console', 'URL', 'document', 'Blob', 'Date', 'setTimeout', 'location', 'window'].includes(k)) continue;
      assert.ok(!JSON.stringify(pg.ctx[k] ?? null).includes(TOKEN.slice(20)), 'token on window.' + k);
    }
    assert.ok(!JSON.stringify(pg.logs).includes(TOKEN.slice(20)));
  };
  let pg = page(server({ ...f, pad: 1000 }));
  pg.run(withCfg({ fetchTextdocs: true }));
  await until(settled(pg), 'ready');
  scan(pg);
  pg.run(withDownload());
  assert.ok(!(await pg.downloads[0].blob.text()).includes(TOKEN.slice(20)));
  assert.ok(!JSON.stringify(pg.ctx.window.__pull).includes('Bearer'));

  // a foreign error that carries the token (and another JWT) is scrubbed before it is shown or stored
  pg = page(server({ ...f, hook: (u) => { if (u.pathname.startsWith('/backend-api/conversation/')) throw new Error('network down ' + TOKEN + ' Bearer ' + TOKEN); } }));
  pg.run(withCfg({}));
  await until(settled(pg), 'error');
  assert.match(status(pg), /^error: Error: network down \[redacted\]/);
  scan(pg);
  assert.ok(!JSON.stringify(pg.ctx.window.__part).includes(TOKEN.slice(20)));
  assert.equal(Object.keys(pg.ctx).filter((k) => /token|auth|^H$/i.test(k)).length, 0);
});

test('401 ends the run with an actionable message; project mode is unchanged (schema 2, NAME download)', async () => {
  const f = fixture();
  let pg = page(server({ ...f, hook: (u) => (u.pathname === '/backend-api/conversations' ? { ok: false, status: 401, json: async () => ({}), text: async () => '' } : null) }));
  pg.run(withCfg({}));
  await until(settled(pg), 'error');
  assert.match(status(pg), /^error: auth expired \(401\)/);

  const srv = server(f);
  pg = page(srv);
  pg.run(withCfg({ mode: 'project', id: P1, partBytes: 100000000 }));
  await until(settled(pg), 'ready');
  const b = pg.ctx.window.__bundle;
  assert.equal(b.schema, 2); assert.equal(b.kind, 'project'); assert.equal(b.project, P1);
  assert.equal(b.stop_reason, 'complete'); assert.equal(b.listing_pages, 2); assert.equal(b.listing.length, 3);
  deq(Object.keys(b.listing[0]).sort(), ['create_time', 'id', 'title', 'triage', 'update_time']);
  assert.equal(b.conversations.length, 3); assert.equal(pg.ctx.window.__part, undefined);
  assert.ok(!srv.log.some((l) => l.startsWith('/backend-api/conversations') || l.includes('snorlax')), 'no account listing calls');
  const info = JSON.parse(pg.run(withDownload({ name: 'chatgpt-project-2026-11-10.json' })));
  assert.equal(info.name, 'chatgpt-project-2026-11-10.json'); assert.equal(info.conversations, 3);
  assert.match(pg.run(withDownload({ name: '../x.json' })), /bad NAME/);

  pg = page(server({ ...f, projects: {} }));
  pg.run(withCfg({ mode: 'project', id: P1 }));
  await until(settled(pg), 'error');
  assert.equal(status(pg), 'error: listing failed: 404');
});

test('end to end: capped run -> verify.py missing -> resume run -> verify.py check and convert.py pass on the parts', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-export-e2e-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const save = async (pg) => { for (const d of pg.downloads.splice(0)) fs.writeFileSync(path.join(data, d.name), await d.blob.text()); };
  const drain = async (pg) => {
    for (;;) {
      await until(() => pg.ctx.window.__part || String(status(pg)).startsWith('error'), 'a part');
      const info = JSON.parse(pg.run(withDownload()));
      await save(pg);
      if (info.final) return info;
    }
  };
  const f = fixture();
  // session 1: capped at 60 threads, parts of about 1 MB
  let pg = page(server({ ...f, pad: 300000 }));
  pg.run(withCfg({ maxThreads: 60, partBytes: 1000000 }));
  let info = await drain(pg);
  assert.equal(info.capped, true); assert.equal(info.remaining, 142 - 60);
  const py = (args) => spawnSync('python3', ['-I', ...args], { encoding: 'utf8' });
  let r = py([path.join(HERE, 'verify.py'), 'missing', '--input', data]);
  assert.equal(r.status, 0, r.stderr);
  const missing = JSON.parse(r.stdout);
  assert.equal(missing.length, 82);
  const run = /resumeOf = '([^']+)'/.exec(r.stderr)[1];
  // session 2 (a fresh tab): resume with exactly those ids
  pg = page(server({ ...f, pad: 300000 }));
  pg.run(withCfg({ onlyIds: missing, resumeOf: run, partBytes: 1000000 }));
  info = await drain(pg);
  assert.equal(info.capped, false);
  r = py([path.join(HERE, 'verify.py'), 'missing', '--input', data]);
  assert.deepEqual(JSON.parse(r.stdout), []);
  r = py([path.join(HERE, 'verify.py'), 'check', '--input', data, '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 0, JSON.stringify(out.findings.filter((x) => x.level === 'FAIL')));
  assert.equal(out.bundle.fetched, 142); assert.equal(out.bundle.run, run);
  const notes = path.join(dir, 'out');
  const summary = JSON.parse(execFileSync('python3', ['-I', path.join(HERE, 'convert.py'), '--input', data, '--out-dir', notes, '--date', '2026-11-10'], { encoding: 'utf8' }));
  assert.equal(summary.notes, 142); assert.equal(summary.missing, 0);
  r = py([path.join(HERE, 'verify.py'), 'check', '--input', data, '--notes-dir', notes, '--json']);
  assert.equal(r.status, 0, r.stdout.slice(0, 2000));
  const idx = fs.readFileSync(path.join(notes, summary.index), 'utf8');
  assert.match(idx, /\| Next --since cutoff \| `/);
  for (const name of fs.readdirSync(data)) assert.ok(!fs.readFileSync(path.join(data, name), 'utf8').includes(TOKEN.slice(20)));
  fs.rmSync(dir, { recursive: true, force: true });
});
