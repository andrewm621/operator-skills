// download.js -- one-Blob download of window.__bundle (VERIFIED 2026-10-13). Run in the SAME tab after
// pull-chatgpt.js reports status 'ready'. Edit ONLY NAME. The file lands in the browser's download folder
// (check the browser's actual download folder; it may not be ~/Downloads). If a call times out the
// download may still have fired: check that folder before running this again.
(() => {
  const NAME = 'chatgpt-project-YYYY-MM-DD.json';
  if (!/^[A-Za-z0-9._-]{1,100}\.json$/.test(NAME)) return 'bad NAME';
  const P = window.__pull;
  if (!window.__bundle || !P || P.status !== 'ready') return 'bundle not ready: ' + (P && P.status);
  const blob = new Blob([JSON.stringify(window.__bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = NAME; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return JSON.stringify({ name: NAME, bytes: blob.size, conversations: window.__bundle.conversations.length });
})()
