// pull-chatgpt.js -- in-page background job for chatgpt.com (VERIFIED 2026-10-13 against a 34-thread project;
// 2026-11-08 against a 60-thread project). Bundle schema 2 adds started_at, stop_reason, listing_pages,
// list_only, fetch_unchanged and, with fetchTextdocs, textdocs / textdoc_errors. verify.py checks all of them.
// Account mode (mode: 'account') writes schema-3 PARTS instead of one bundle. Its listing endpoints were exercised
// list-only on 2026-11-10; this script's account listing, parts, pause/resume, cap and resume are UNVERIFIED live.
//
// Run it with the Claude in Chrome javascript_tool inside a logged-in chatgpt.com tab. Edit ONLY the values in
// CFG below before pasting. It starts a background job and returns immediately; progress lives on window.__pull,
// the result on window.__bundle (project, thread, account list-only) or window.__part (each account part).
// Poll with short calls (see SKILL.md).
//
// Hard rules baked in:
//   - The access token lives only in the local variable H inside the async job. Never assign it to window, never
//     log it, never return it, never put it in an error string. Do not "debug" by printing H.
//   - Requests are sequential, CFG.gapMs apart (600 ms verified). Do not parallelize.
//   - Account mode stops at the FIRST 429 (no retry): 172 fetches at 600 ms tripped the limit on 2026-11-10 and the
//     limit itself is unknown. The event is recorded as rate_limit on the final part and on window.__pull.
//   - Everything is wrapped in an IIFE so re-running in the same tab does not hit "already declared" errors.
//   - Account mode never downloads by itself: it pauses at each part until download.js takes it.
(() => {
  const CFG = {
    mode: 'project',          // 'project' | 'thread' | 'account'
    id: 'g-p-REPLACE_ME',     // project: g-p-<hex> (from /g/g-p-.../project) | thread: conversation uuid (from /c/<uuid>) | account: null
    since: null,              // null (pull everything) | ISO 8601 string, e.g. '2026-10-13T00:50:00Z'
    listOnly: false,          // true = list + classify only, fetch no conversation bodies
    fetchUnchanged: false,    // with `since`: also fetch threads classified 'unchanged' (default skips them)
    fetchTextdocs: false,     // true = also fetch each canvas doc a thread references (GET /backend-api/textdoc/<id>)
    gapMs: 600,
    // ---- account mode only; leave these defaults for project / thread ----
    partBytes: 100000000,     // pause with a part ready once buffered conversation JSON passes this many characters
    maxThreads: null,         // null | integer: fetch at most this many threads this run, then end 'capped'
    jitterMs: 0,              // integer 0..5000: each gap becomes gapMs + a random 0..jitterMs (spreads requests so they look less mechanical)
    maxMinutes: null,         // null | number 1..600: stop STARTING fetches this many minutes after the job began (listing included), then end 'capped'
    onlyIds: null,            // null | array of conversation uuids to fetch (paste the array from `verify.py missing`)
    resumeOf: null,           // null | run id being continued (printed by `verify.py missing`); a resume run skips listing
  };

  // ---- validate CFG (it is derived from a URL, so treat it as untrusted) ----
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const RUN_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/;
  const PROJ_RE = /^g-p-[A-Za-z0-9-]{8,64}$/;
  const ACCOUNT = CFG.mode === 'account';
  if (!['project', 'thread', 'account'].includes(CFG.mode)) return 'bad CFG: mode/id';
  if (ACCOUNT ? CFG.id !== null
      : (typeof CFG.id !== 'string' || !(CFG.mode === 'project' ? PROJ_RE : /^[0-9a-fA-F-]{36}$/).test(CFG.id))) return 'bad CFG: mode/id';
  if (location.origin !== 'https://chatgpt.com') return 'wrong origin: ' + location.origin;
  const sinceMs = CFG.since ? Date.parse(CFG.since) : null;
  if (CFG.since && (typeof CFG.since !== 'string' || Number.isNaN(sinceMs))) return 'bad CFG: since';
  if (!(CFG.gapMs >= 400)) return 'bad CFG: gapMs must be >= 400';
  let onlyIds = null;
  if (!ACCOUNT) {
    if (CFG.onlyIds !== null || CFG.resumeOf !== null || CFG.maxThreads !== null || CFG.maxMinutes !== null || CFG.jitterMs !== 0) return 'bad CFG: onlyIds / resumeOf / maxThreads / maxMinutes / jitterMs are account-mode only';
  } else {
    if (!Number.isInteger(CFG.partBytes) || CFG.partBytes < 1000000 || CFG.partBytes > 200000000) return 'bad CFG: partBytes must be an integer from 1e6 to 2e8';
    if (CFG.maxThreads !== null && !(Number.isInteger(CFG.maxThreads) && CFG.maxThreads >= 1 && CFG.maxThreads <= 100000)) return 'bad CFG: maxThreads';
    if (CFG.maxMinutes !== null && !(typeof CFG.maxMinutes === 'number' && Number.isFinite(CFG.maxMinutes) && CFG.maxMinutes >= 1 && CFG.maxMinutes <= 600)) return 'bad CFG: maxMinutes';
    if (!Number.isInteger(CFG.jitterMs) || CFG.jitterMs < 0 || CFG.jitterMs > 5000) return 'bad CFG: jitterMs must be an integer from 0 to 5000';
    if (CFG.onlyIds !== null) {
      if (!Array.isArray(CFG.onlyIds) || CFG.onlyIds.length < 1 || CFG.onlyIds.length > 20000) return 'bad CFG: onlyIds must be null or 1..20000 ids';
      if (!CFG.onlyIds.every((x) => typeof x === 'string' && UUID_RE.test(x))) return 'bad CFG: onlyIds must all be conversation uuids';
      onlyIds = [...new Set(CFG.onlyIds)];
    }
    if (CFG.resumeOf !== null && (typeof CFG.resumeOf !== 'string' || !RUN_RE.test(CFG.resumeOf))) return 'bad CFG: resumeOf';
    if (CFG.resumeOf !== null && onlyIds === null) return 'bad CFG: resumeOf needs onlyIds (from verify.py missing)';
  }
  if (window.__pull && ['running', 'part_ready'].includes(window.__pull.status)) return JSON.stringify(window.__pull);
  if (window.__part) return 'a part is still waiting for download.js: download it, or set window.__part = null to drop it';

  window.__pull = { status: 'running', phase: 'start', mode: CFG.mode, done: 0, total: 0, new: 0, grown: 0, unchanged: 0, errors: 0 };
  window.__bundle = null;

  const sleep = (t) => new Promise((r) => setTimeout(r, t));
  // listing times are ISO strings; conversation times are epoch seconds. Normalize both to ms.
  const ms = (t) => (t == null ? null : typeof t === 'number' ? (t < 1e11 ? t * 1000 : t) : Date.parse(t));
  const triageOf = (it) => {
    if (sinceMs == null) return null;
    const c = ms(it.create_time), u = ms(it.update_time);
    if (c != null && c > sinceMs) return 'new';
    if (u != null && u > sinceMs) return 'grown';
    return 'unchanged';
  };
  // every inter-request gap: gapMs, plus a random 0..jitterMs in account mode (jitterMs is 0 elsewhere)
  const gap = () => CFG.gapMs + (CFG.jitterMs > 0 ? Math.floor(Math.random() * (CFG.jitterMs + 1)) : 0);
  const own = (m) => Object.assign(new Error(m), { own: true }); // our fixed messages; anything else gets scrubbed
  // started_at is taken BEFORE the listing: it is the safe --since cutoff for the next pull, because a thread
  // updated while this pull ran has update_time > started_at even if it is < pulled_at.
  const startedAt = new Date().toISOString();
  // the maxMinutes clock starts here too, so it includes the listing. It is only ever checked in the fetch loop:
  // a listing cut short by a deadline would be a partial run, which is worse than running over.
  const deadlineMs = ACCOUNT && CFG.maxMinutes !== null ? Date.now() + CFG.maxMinutes * 60000 : null;
  const rnd = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('')
    : Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
  const runId = startedAt.replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '') + '-' + rnd;
  if (ACCOUNT) { window.__part = null; window.__pull.run = runId; window.__pull.parts = 0; window.__pull.rate_limit = null; }

  (async () => {
    const P = window.__pull;
    let listing = [], convs = [], errors = [], attachments = [], stopReason = null, pages = 0, H = null;
    const textdocs = {}, textdocErrors = [];
    const build = (partial) => ({
      platform: 'chatgpt', schema: 2, kind: CFG.mode, project: CFG.mode === 'project' ? CFG.id : null,
      started_at: startedAt, pulled_at: new Date().toISOString(), since: CFG.since,
      partial: !!partial || (stopReason !== null && stopReason !== 'complete'), stop_reason: stopReason,
      listing_pages: pages, list_only: !!CFG.listOnly, fetch_unchanged: !!CFG.fetchUnchanged,
      listing, conversations: convs, attachments, errors,
      ...(CFG.fetchTextdocs ? { textdocs, textdoc_errors: textdocErrors } : {}),
    });

    // ---- account mode: one run, flushed as parts. Every part carries the run header and the full listing. ----
    const rows = new Map();
    const sources = { main: null, archived: null, projects: null, project_threads: {} };
    let listingComplete = false, toFetch = [], partIdx = 0, capped = false, cappedBy = null, toFetchTotal = 0, toFetchKnown = false;
    let rateLimit = null;
    let buf = [], bufIds = [], bufErrors = [], bufAtts = [], bufDocs = {}, bufDocErrors = [], bufBytes = 0;
    const buildPart = (final, error) => ({
      platform: 'chatgpt', schema: 3, kind: 'account', project: null,
      run_id: runId, resume_of: CFG.resumeOf, part: partIdx, final: !!final,
      started_at: startedAt, pulled_at: new Date().toISOString(), since: CFG.since,
      partial: !listingComplete || !!error, listing_complete: listingComplete, stop_reason: stopReason,
      error: error || null, capped: !!final && capped, capped_by: final && capped ? cappedBy : null, remaining: final && toFetchKnown ? Math.max(0, toFetchTotal - P.done) : null, // to-fetch threads this run did not fetch, whatever ended it
      rate_limit: rateLimit,
      sources: CFG.resumeOf ? null : sources, listing_skipped: !!CFG.resumeOf, listing_pages: pages,
      list_only: !!CFG.listOnly, fetch_unchanged: !!CFG.fetchUnchanged, fetch_textdocs: !!CFG.fetchTextdocs,
      only_ids: onlyIds, max_threads: CFG.maxThreads, max_minutes: CFG.maxMinutes, part_bytes: CFG.partBytes,
      listing_count: listing.length, to_fetch_count: toFetchTotal, ids: bufIds,
      listing, conversations: buf, attachments: bufAtts, errors: bufErrors,
      ...(CFG.fetchTextdocs ? { textdocs: bufDocs, textdoc_errors: bufDocErrors } : {}),
    });
    const resetBuf = () => { buf = []; bufIds = []; bufErrors = []; bufAtts = []; bufDocs = {}; bufDocErrors = []; bufBytes = 0; P.buffered = 0; };
    // Hand a part to download.js, drop our references to it, and wait (fetching nothing) until it has been taken.
    const flush = async (final, error) => {
      if (partIdx > 999) throw own('more than 1000 parts: raise partBytes');
      window.__part = buildPart(final, error);
      resetBuf();
      P.part_ready = partIdx;
      if (final) return;
      P.status = 'part_ready';
      while (P.taken !== partIdx) await sleep(1000);
      partIdx++; P.parts = partIdx; P.status = 'running';
    };

    try {
      // token stays in this closure only
      const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
      if (!s || !s.accessToken) throw own('not logged in (no session)');
      H = { Authorization: 'Bearer ' + s.accessToken };

      const get = async (path) => {
        let r;
        for (let a = 0; a < 4; a++) {
          r = await fetch(path, { headers: H });
          if (r.status === 401) throw own(ACCOUNT ? 'auth expired (401); download this part (ERROR_PART_OK), reload, resume with verify.py missing'
                                                  : 'auth expired (401); reload the tab and re-run');
          if (r.status !== 429) return r;
          if (ACCOUNT) { // account mode backs off the moment the server says so: no retry, record it, end the run
            let ra = null;
            try {
              const h = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
              if (typeof h === 'string' && /^\s*\d+\s*$/.test(h)) ra = Number(h);
              else if (typeof h === 'string' && !Number.isNaN(Date.parse(h))) ra = Math.max(0, Math.ceil((Date.parse(h) - Date.now()) / 1000));
            } catch (e) { ra = null; }
            rateLimit = { at: new Date().toISOString(), phase: String(P.phase).startsWith('listing') ? 'listing' : 'fetching', done: P.done, retry_after_s: ra };
            P.rate_limit = rateLimit;
            throw own('rate limited (429), not retried: wait, then resume with verify.py missing' + (ra !== null ? '; retry-after ' + ra + 's' : ''));
          }
          await sleep(5000 * 2 ** a); // gentle backoff on rate limit (not exercised in the verified run)
        }
        return r;
      };

      // One g-p- project's threads, following its cursor. Shared by project mode and account mode.
      const listGizmo = async (gid, onItem) => {
        const st = { stop_reason: null, pages: 0, count: 0, status: null };
        let cursor = '0';
        const seenCursors = new Set([cursor]), seenIds = new Set();
        while (st.stop_reason === null) {
          if (st.pages >= 200) { st.stop_reason = 'ceiling'; break; } // the listing is incomplete: reported, never swallowed
          st.pages++;
          const r = await get(`/backend-api/gizmos/${gid}/conversations?cursor=${encodeURIComponent(cursor)}`);
          if (!r.ok) { st.stop_reason = r.status === 429 ? 'rate_limited' : 'http_' + r.status; st.status = r.status; break; }
          const j = await r.json();
          for (const i of (j && j.items) || []) {
            if (!i || typeof i.id !== 'string' || seenIds.has(i.id)) continue;
            seenIds.add(i.id);
            if (onItem(i) !== false) st.count++;
          }
          const next = (j && j.cursor) ?? null;
          if (next === null || next === '') st.stop_reason = 'complete';
          else if (seenCursors.has(String(next))) st.stop_reason = 'stuck_cursor'; // repeated or cycling cursor: NOT the end
          else { seenCursors.add(String(next)); cursor = String(next); }
          await sleep(gap());
        }
        return st;
      };

      // ---- 1. listing ----
      P.phase = 'listing';
      if (CFG.mode === 'project') {
        const st = await listGizmo(CFG.id, (i) => { listing.push({ id: i.id, title: i.title, create_time: i.create_time, update_time: i.update_time }); });
        pages = st.pages; stopReason = st.stop_reason;
        if (st.status !== null) throw own('listing failed: ' + st.status);
        if (stopReason !== 'complete') P.partial = true;
        P.stop = stopReason;
        for (const it of listing) { it.triage = triageOf(it); if (it.triage) P[it.triage]++; }
      } else if (CFG.mode === 'thread') {
        listing = [{ id: CFG.id, title: null, create_time: null, update_time: null }];
        stopReason = 'complete';
      } else if (CFG.resumeOf) {
        // a resume run fetches exactly onlyIds; the continued run's listing (already on disk) stays authoritative
        listingComplete = true; stopReason = 'skipped';
      } else {
        // Account listing: the union, by id, of main, archived, and every sidebar project's threads (240 of 1,304
        // project threads were not in the main list on 2026-11-10, so the per-project listing is required).
        const addRow = (i, src, proj) => {
          if (!i || typeof i.id !== 'string' || !UUID_RE.test(i.id)) return false;
          let row = rows.get(i.id);
          if (!row) {
            row = { id: i.id, title: i.title ?? null, create_time: i.create_time ?? null, update_time: i.update_time ?? null,
                    sources: [], project: null, project_name: null };
            rows.set(i.id, row);
          } else {
            if (row.title == null && i.title != null) row.title = i.title;
            if (row.create_time == null && i.create_time != null) row.create_time = i.create_time;
            if ((ms(i.update_time) ?? -Infinity) > (ms(row.update_time) ?? -Infinity)) row.update_time = i.update_time;
          }
          if (!row.sources.includes(src)) row.sources.push(src);
          const gz = typeof i.gizmo_id === 'string' && i.gizmo_id.length <= 100 ? i.gizmo_id : null;
          if (proj && !row.project) row.project = proj;
          else if (gz && PROJ_RE.test(gz) && !row.project) row.project = gz;      // a project, named on the row itself
          if (gz && !PROJ_RE.test(gz) && row.gizmo_id === undefined) row.gizmo_id = gz; // a custom GPT: never a project
          if (typeof i.conversation_template_id === 'string' && i.conversation_template_id.length <= 100 && row.conversation_template_id === undefined) {
            row.conversation_template_id = i.conversation_template_id;
          }
          if (typeof i.is_archived === 'boolean' && row.is_archived === undefined) row.is_archived = i.is_archived;
          return true;
        };
        const isOld = (t) => { const v = ms(t); return v != null && !Number.isNaN(v) && v <= sinceMs; };
        // main and archived: offset pages, newest-updated first. `total` is recorded but never trusted (101 on 5,063).
        const listOffset = async (src, extra, allowSinceStop) => {
          const st = { stop_reason: null, pages: 0, count: 0, new: 0, skipped: 0, total_reported: null, limit_reported: null };
          sources[src] = st;
          const seen = new Set();
          let offset = 0, oldPages = 0;
          while (st.stop_reason === null) {
            if (st.pages >= 500) { st.stop_reason = 'ceiling'; break; }
            st.pages++; pages++;
            const r = await get(`/backend-api/conversations?offset=${offset}&limit=100&order=updated${extra}`);
            if (!r.ok) { st.stop_reason = r.status === 429 ? 'rate_limited' : 'http_' + r.status; break; }
            const j = await r.json();
            const items = j && Array.isArray(j.items) ? j.items : null;
            if (!items) { st.stop_reason = 'bad_shape'; break; }
            if (st.total_reported === null && typeof j.total === 'number') st.total_reported = j.total;
            if (st.limit_reported === null && typeof j.limit === 'number') st.limit_reported = j.limit;
            const pageSize = typeof j.limit === 'number' && j.limit > 0 && j.limit < 100 ? j.limit : 100;
            let fresh = 0, newer = 0;
            for (const i of items) {
              if (!i || typeof i.id !== 'string' || !UUID_RE.test(i.id)) { st.skipped++; continue; }
              if (sinceMs != null && !(isOld(i.update_time) && (i.create_time == null || isOld(i.create_time)))) newer++;
              if (seen.has(i.id)) continue;
              seen.add(i.id); fresh++; st.count++;
              if (!rows.has(i.id)) st.new++;
              addRow(i, src, null);
            }
            P.listed = rows.size;
            if (items.length < pageSize) st.stop_reason = 'complete';
            else if (fresh === 0) st.stop_reason = 'no_progress'; // offset ignored or the list is cycling: NOT the end
            else if (allowSinceStop && newer === 0 && ++oldPages >= 2) st.stop_reason = 'since_cutoff'; // a full old page + one safety page
            else { if (newer > 0) oldPages = 0; offset += items.length; }
            await sleep(gap());
          }
        };
        await listOffset('main', '', sinceMs != null);
        await listOffset('archived', '&is_archived=true', false); // order not established: always read in full

        // project sidebar: every g-p- project (custom GPTs are counted and skipped), following a cursor if any
        const projects = [];
        {
          const st = { stop_reason: null, pages: 0, count: 0, other_gizmos: 0 };
          sources.projects = st;
          const seenP = new Set(), seenCursors = new Set();
          let cursor = null;
          while (st.stop_reason === null) {
            if (st.pages >= 50) { st.stop_reason = 'ceiling'; break; }
            st.pages++; pages++;
            const r = await get('/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
            if (!r.ok) { st.stop_reason = r.status === 429 ? 'rate_limited' : 'http_' + r.status; break; }
            const j = await r.json();
            const items = j && Array.isArray(j.items) ? j.items : null;
            if (!items) { st.stop_reason = 'bad_shape'; break; }
            for (const it of items) {
              // live shape 2026-11-07: items[].gizmo.gizmo.{id, display.name}; items[].gizmo.{…} and flat are tolerated
              const outer = it && typeof it.gizmo === 'object' && it.gizmo ? it.gizmo : it;
              const g = outer && typeof outer.gizmo === 'object' && outer.gizmo ? outer.gizmo : outer;
              const gid = g && g.id;
              if (typeof gid !== 'string' || !PROJ_RE.test(gid)) { st.other_gizmos++; continue; }
              if (seenP.has(gid)) continue;
              seenP.add(gid);
              const name = g.display && typeof g.display.name === 'string' ? g.display.name : typeof g.name === 'string' ? g.name : null;
              projects.push({ id: gid, name }); st.count++;
            }
            const next = (j && j.cursor) ?? null;
            if (next === null || next === '') st.stop_reason = 'complete';
            else if (seenCursors.has(String(next))) st.stop_reason = 'stuck_cursor';
            else { seenCursors.add(String(next)); cursor = String(next); }
            await sleep(gap());
          }
        }
        const names = new Map(projects.map((p) => [p.id, p.name]));
        for (const p of projects) {
          P.phase = 'listing project ' + (projects.indexOf(p) + 1) + '/' + projects.length;
          const st = await listGizmo(p.id, (i) => addRow(i, 'project', p.id));
          pages += st.pages;
          sources.project_threads[p.id] = { name: p.name, stop_reason: st.stop_reason, pages: st.pages, count: st.count };
          P.listed = rows.size;
        }
        listing = [...rows.values()];
        for (const row of listing) if (row.project && row.project_name == null) row.project_name = names.get(row.project) ?? null;

        // every source is required; since_cutoff is a normal end only for an incremental (since) pull
        const req = [['main', sources.main], ['archived', sources.archived], ['projects', sources.projects],
                     ...Object.entries(sources.project_threads).map(([k, v]) => ['project ' + k, v])];
        const okStop = (r) => r === 'complete' || (r === 'since_cutoff' && sinceMs != null);
        const bad = req.find(([, v]) => !v || !okStop(v.stop_reason));
        listingComplete = !bad;
        stopReason = bad ? bad[0] + ':' + (bad[1] ? bad[1].stop_reason : 'missing') : 'complete';
        P.stop = stopReason;
        if (!listingComplete) P.partial = true;
        P.sources = {};
        for (const [k, v] of req.slice(0, 3)) P.sources[k] = v.stop_reason + ' ' + v.count;
        P.sources.project_threads = Object.values(sources.project_threads).filter((v) => v.stop_reason === 'complete').length
          + ' of ' + projects.length + ' complete';
        for (const it of listing) { it.triage = triageOf(it); if (it.triage) P[it.triage]++; }
      }

      if (ACCOUNT) {
        const byId = new Map(listing.map((r) => [r.id, r]));
        toFetch = onlyIds ? onlyIds.map((id) => byId.get(id) || { id, title: null })
                          : listing.filter((it) => CFG.fetchUnchanged || it.triage !== 'unchanged');
        toFetchTotal = toFetch.length; toFetchKnown = true; // the true total before any cap; a time cap below must not change it
        if (CFG.maxThreads !== null && toFetch.length > CFG.maxThreads) {
          const remaining = toFetch.length - CFG.maxThreads; capped = true; cappedBy = 'threads'; toFetch = toFetch.slice(0, CFG.maxThreads);
          P.capped = true; P.remaining = remaining; P.capped_by = cappedBy;
        }
      } else {
        toFetch = listing.filter((it) => CFG.fetchUnchanged || it.triage !== 'unchanged');
      }
      P.total = toFetch.length;
      if (CFG.listOnly) {
        window.__bundle = ACCOUNT ? buildPart(true) : build(false);
        P.phase = 'done'; P.status = 'listed'; return;
      }

      // ---- 2. conversations, one at a time ----
      P.phase = 'fetching';
      for (let ti = 0; ti < toFetch.length; ti++) {
        const it = toFetch[ti];
        if (deadlineMs !== null && Date.now() >= deadlineMs) { // time cap: same clean end as maxThreads; checked only here, never in the listing
          capped = true; cappedBy = 'time';
          P.capped = true; P.remaining = toFetchTotal - P.done; P.capped_by = cappedBy;
          break;
        }
        await sleep(gap());
        const r = await get(`/backend-api/conversation/${it.id}`);
        if (!r.ok) { (ACCOUNT ? bufErrors : errors).push({ id: it.id, status: r.status }); P.errors++; }
        else {
          let c;
          if (ACCOUNT) {
            let txt = await r.text();
            try { c = JSON.parse(txt); } catch (e) { c = null; }
            if (!c || typeof c !== 'object' || Array.isArray(c)) { bufErrors.push({ id: it.id, status: 'bad_json' }); P.errors++; P.done++; continue; }
            buf.push(c); bufIds.push(it.id); bufBytes += txt.length; txt = null;
          } else {
            c = await r.json();
            convs.push(c);
          }
          if (CFG.mode === 'thread') { // single thread: fill the listing row from the conversation itself
            it.title = c.title; it.create_time = c.create_time; it.update_time = c.update_time; it.triage = triageOf(it);
            if (it.triage) P[it.triage]++;
          }
          const docIds = new Set();
          for (const n of Object.values(c.mapping || {})) {
            const meta = (n && n.message && n.message.metadata) || {};
            for (const a of meta.attachments || []) {
              (ACCOUNT ? bufAtts : attachments).push({ conv: it.id, title: it.title, id: a.id, name: a.name, size: a.size });
            }
            const td = meta.canvas && meta.canvas.textdoc_id;
            if (typeof td === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(td)) docIds.add(td);
          }
          if (CFG.fetchTextdocs) {
            // account mode dedupes per part, so every part carries the canvas docs its own threads cite
            const docs = ACCOUNT ? bufDocs : textdocs, docErrors = ACCOUNT ? bufDocErrors : textdocErrors;
            for (const td of docIds) {
              if (docs[td]) continue;
              await sleep(gap());
              const tr = await get(`/backend-api/textdoc/${td}`);
              if (!tr.ok) { docErrors.push({ id: td, conv: it.id, status: tr.status }); continue; }
              const d = await tr.json();
              docs[td] = { id: td, conv: it.id, title: d.title ?? null, textdoc_type: d.textdoc_type ?? null,
                           version: d.version ?? null, content: typeof d.content === 'string' ? d.content : null };
              if (ACCOUNT) { bufBytes += (docs[td].content || '').length; P.textdocs = (P.textdocs || 0) + 1; }
            }
            if (!ACCOUNT) P.textdocs = Object.keys(textdocs).length;
          }
        }
        P.done++;
        if (ACCOUNT) { P.buffered = bufBytes; if (bufBytes >= CFG.partBytes) await flush(false); }
      }
      if (ACCOUNT) { await flush(true); P.phase = 'done'; P.status = 'ready'; return; }
      window.__bundle = build(false);
      P.phase = 'done'; P.status = 'ready';
    } catch (e) {
      // Our own messages are fixed strings; anything else is scrubbed of the token and of JWT-shaped strings.
      let m = e && e.own ? e.message : String((e && e.name) || 'Error') + ': ' + String((e && e.message) || e);
      const tok = H && H.Authorization.slice(7);
      if (tok) m = m.split(tok).join('[redacted]');
      m = m.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g, '[redacted]').slice(0, 200);
      if (ACCOUNT) {
        if (!listing.length && rows.size) listing = [...rows.values()];
        window.__part = buildPart(true, m); // keeps what was buffered; download.js takes it only with ERROR_PART_OK
        resetBuf();
      } else {
        window.__bundle = build(true); // keep whatever was pulled; download.js refuses unless status is 'ready'
      }
      P.status = 'error: ' + m;
    }
  })();

  return JSON.stringify(window.__pull);
})()
