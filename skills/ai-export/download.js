// download.js -- one-Blob download of window.__bundle (VERIFIED 2026-10-13), or of the account part waiting on
// window.__part (UNVERIFIED live). Run in the SAME tab after pull-chatgpt.js reports status 'ready' (or
// 'part_ready' in account mode). Edit ONLY NAME (project / thread) or ERROR_PART_OK (account). The file lands in the
// browser's download folder (check the browser's actual download folder; it may not be ~/Downloads). If a call
// times out the download may still have fired: check that folder before running this again.
(() => {
  const NAME = 'chatgpt-project-YYYY-MM-DD.json'; // project / thread only: account parts name themselves
  const ERROR_PART_OK = false; // account only: true = also take the last part of a run that ended in 'error: …'
  if (!/^[A-Za-z0-9._-]{1,100}\.json$/.test(NAME)) return 'bad NAME';
  const P = window.__pull;
  const save = (name, obj) => {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return blob.size;
  };
  if (P && P.mode === 'account') {
    const part = window.__part, st = String(P.status);
    if (!part) return 'no part waiting: ' + st;
    if (!(st === 'part_ready' || st === 'ready' || (ERROR_PART_OK && st.startsWith('error')))) return 'part not ready: ' + st;
    if (!Number.isInteger(part.part) || part.part < 0 || part.part > 999 || !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$/.test(String(part.run_id))) return 'bad part header';
    const name = `chatgpt-account-${part.run_id}-part-${String(part.part).padStart(3, '0')}.json`;
    if (!/^chatgpt-account-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}-part-[0-9]{3}\.json$/.test(name) || name.length > 100) return 'bad part name';
    const bytes = save(name, part);
    const info = { name, bytes, part: part.part, final: part.final, conversations: part.conversations.length,
                   errors: part.errors.length, capped: part.capped, remaining: part.remaining, error: part.error };
    window.__part = null; P.taken = part.part; // frees the buffer; a paused job resumes fetching
    if (!part.final) P.status = 'running';
    return JSON.stringify(info);
  }
  if (!window.__bundle || !P || P.status !== 'ready') return 'bundle not ready: ' + (P && P.status);
  const bytes = save(NAME, window.__bundle);
  return JSON.stringify({ name: NAME, bytes, conversations: window.__bundle.conversations.length });
})()
