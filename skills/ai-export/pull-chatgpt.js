// pull-chatgpt.js -- in-page background job for chatgpt.com (VERIFIED 2026-10-13 against a 34-thread project).
//
// Run it with the Claude in Chrome javascript_tool inside a logged-in chatgpt.com tab. Edit ONLY the values in
// CFG below before pasting. It starts a background job and returns immediately; progress lives on window.__pull
// and the result on window.__bundle. Poll with short calls (see SKILL.md).
//
// Hard rules baked in:
//   - The access token lives only in the local variable H inside the async job. Never assign it to window, never
//     log it, never return it, never put it in an error string. Do not "debug" by printing H.
//   - Requests are sequential, CFG.gapMs apart (600 ms verified). Do not parallelize.
//   - Everything is wrapped in an IIFE so re-running in the same tab does not hit "already declared" errors.
(() => {
  const CFG = {
    mode: 'project',          // 'project' | 'thread'
    id: 'g-p-REPLACE_ME',     // project: g-p-<hex> (from /g/g-p-.../project) | thread: conversation uuid (from /c/<uuid>)
    since: null,              // null (pull everything) | ISO 8601 string, e.g. '2026-10-13T00:50:00Z'
    listOnly: false,          // true = list + classify only, fetch no conversation bodies
    fetchUnchanged: false,    // with `since`: also fetch threads classified 'unchanged' (default skips them)
    gapMs: 600,
  };

  // ---- validate CFG (it is derived from a URL, so treat it as untrusted) ----
  const ID_RE = CFG.mode === 'project' ? /^g-p-[A-Za-z0-9-]{8,64}$/ : /^[0-9a-fA-F-]{36}$/;
  if (!['project', 'thread'].includes(CFG.mode) || typeof CFG.id !== 'string' || !ID_RE.test(CFG.id)) return 'bad CFG: mode/id';
  if (location.origin !== 'https://chatgpt.com') return 'wrong origin: ' + location.origin;
  const sinceMs = CFG.since ? Date.parse(CFG.since) : null;
  if (CFG.since && Number.isNaN(sinceMs)) return 'bad CFG: since';
  if (!(CFG.gapMs >= 400)) return 'bad CFG: gapMs must be >= 400';
  if (window.__pull && window.__pull.status === 'running') return JSON.stringify(window.__pull);

  window.__pull = { status: 'running', phase: 'start', done: 0, total: 0, new: 0, grown: 0, unchanged: 0, errors: 0 };
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

  (async () => {
    const P = window.__pull;
    let listing = [], convs = [], errors = [], attachments = [], listingCapped = false;
    const build = (partial) => ({
      platform: 'chatgpt', kind: CFG.mode, project: CFG.mode === 'project' ? CFG.id : null,
      pulled_at: new Date().toISOString(), since: CFG.since, partial: !!partial || listingCapped,
      listing, conversations: convs, attachments, errors,
    });
    try {
      // token stays in this closure only
      const s = await fetch('/api/auth/session').then((r) => r.json());
      if (!s || !s.accessToken) throw new Error('not logged in (no session)');
      const H = { Authorization: 'Bearer ' + s.accessToken };

      const get = async (path) => {
        let r;
        for (let a = 0; a < 4; a++) {
          r = await fetch(path, { headers: H });
          if (r.status === 401) throw new Error('auth expired (401); reload the tab and re-run');
          if (r.status !== 429) return r;
          await sleep(5000 * 2 ** a); // gentle backoff on rate limit (not exercised in the verified run)
        }
        return r;
      };

      // ---- 1. listing ----
      P.phase = 'listing';
      if (CFG.mode === 'project') {
        let cursor = '0', pages = 0;
        while (cursor !== null && pages++ < 200) {
          const r = await get(`/backend-api/gizmos/${CFG.id}/conversations?cursor=${encodeURIComponent(cursor)}`);
          if (!r.ok) throw new Error('listing failed: ' + r.status);
          const j = await r.json();
          listing.push(...(j.items || []).map((i) => ({ id: i.id, title: i.title, create_time: i.create_time, update_time: i.update_time })));
          const next = j.cursor ?? null;
          cursor = next === cursor ? null : next; // stuck-cursor guard
          await sleep(CFG.gapMs);
        }
        if (cursor !== null) { listingCapped = true; P.partial = true; } // hit the 200-page cap: the listing is incomplete
        for (const it of listing) { it.triage = triageOf(it); if (it.triage) P[it.triage]++; }
      } else {
        listing = [{ id: CFG.id, title: null, create_time: null, update_time: null }];
      }

      const toFetch = listing.filter((it) => CFG.fetchUnchanged || it.triage !== 'unchanged');
      P.total = toFetch.length;
      if (CFG.listOnly) { window.__bundle = build(false); P.phase = 'done'; P.status = 'listed'; return; }

      // ---- 2. conversations, one at a time ----
      P.phase = 'fetching';
      for (const it of toFetch) {
        await sleep(CFG.gapMs);
        const r = await get(`/backend-api/conversation/${it.id}`);
        if (!r.ok) { errors.push({ id: it.id, status: r.status }); P.errors++; }
        else {
          const c = await r.json();
          convs.push(c);
          if (CFG.mode === 'thread') { // single thread: fill the listing row from the conversation itself
            it.title = c.title; it.create_time = c.create_time; it.update_time = c.update_time; it.triage = triageOf(it);
            if (it.triage) P[it.triage]++;
          }
          for (const n of Object.values(c.mapping || {})) {
            for (const a of (n && n.message && n.message.metadata && n.message.metadata.attachments) || []) {
              attachments.push({ conv: it.id, title: it.title, id: a.id, name: a.name, size: a.size });
            }
          }
        }
        P.done++;
      }
      window.__bundle = build(false);
      P.phase = 'done'; P.status = 'ready';
    } catch (e) {
      window.__bundle = build(true); // keep whatever was pulled; download.js refuses unless status is 'ready'
      P.status = 'error: ' + String((e && e.message) || e).slice(0, 200);
    }
  })();

  return JSON.stringify(window.__pull);
})()
