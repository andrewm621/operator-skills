// spot-check.js -- read ONE thread's live state for `verify.py spot --live`. Run it with the Claude in Chrome
// javascript_tool in a logged-in chatgpt.com tab (a new tab, as for the pull). Edit ONLY ID. It returns a small JSON
// object (times, node count, current_node; no message text). Save the returned string to a file and pass it to
// `python3 -I verify.py spot --input <bundle> --thread <ID> --live <file>`.
// Same rules as pull-chatgpt.js: the token stays in a local variable, one request, nothing on window.
(async () => {
  const ID = '00000000-0000-0000-0000-000000000000';
  if (!/^[0-9a-fA-F-]{36}$/.test(ID)) return 'bad ID';
  if (location.origin !== 'https://chatgpt.com') return 'wrong origin: ' + location.origin;
  const s = await fetch('/api/auth/session').then((r) => r.json());
  if (!s || !s.accessToken) return 'not logged in (no session)';
  const r = await fetch(`/backend-api/conversation/${ID}`, { headers: { Authorization: 'Bearer ' + s.accessToken } });
  if (!r.ok) return 'fetch failed: ' + r.status;
  const c = await r.json();
  const m = c.mapping || {};
  let last = null, node = c.current_node;
  const seen = new Set();
  while (node && m[node] && !seen.has(node)) {
    seen.add(node);
    const msg = m[node].message;
    const role = msg && msg.author && msg.author.role;
    const hidden = msg && msg.metadata && msg.metadata.is_visually_hidden_from_conversation;
    const parts = (msg && msg.content && msg.content.parts) || [];
    const hasText = parts.some((p) => typeof p === 'string' && p.trim()) || (msg && typeof msg.content.text === 'string' && msg.content.text.trim());
    if (!last && msg && msg.create_time && (role === 'user' || role === 'assistant') && !hidden && hasText) last = msg.create_time;
    node = m[node].parent;
  }
  return JSON.stringify({ id: ID, update_time: c.update_time, current_node: c.current_node, nodes: Object.keys(m).length, last_message_time: last });
})()
