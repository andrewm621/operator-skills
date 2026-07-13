Verify a running web app in Dia Browser via CDP. URL defaults to http://localhost:3000 unless specified.

Target URL: $ARGUMENTS (default: http://localhost:3000)

## Steps

1. **Check CDP connection** — Run `curl -s http://127.0.0.1:9222/json/version` to confirm Dia is connected. If it fails, tell the user to run `dia-dev --restart` and stop.

2. **Navigate** — Run `agent-browser open <URL> && agent-browser wait --load networkidle` to load the page.

3. **Screenshot** — Run `agent-browser screenshot --annotate` to capture an annotated screenshot. Read the screenshot image to visually inspect the page.

4. **Check for error overlays** — Run `agent-browser snapshot -i` and look for:
   - Next.js error overlay (text containing "Unhandled Runtime Error", "Server Error", "Module not found")
   - Vite error overlay (text containing "Failed to fetch", "500", error stack traces)
   - Generic error boundaries or blank white pages

5. **Check console errors** — Run:
   ```
   agent-browser eval --stdin <<'EVALEOF'
   JSON.stringify(
     performance.getEntriesByType("resource")
       .filter(r => r.responseStatus >= 400)
       .map(r => ({ url: r.name.split("/").pop(), status: r.responseStatus }))
   )
   EVALEOF
   ```
   Also check for JS errors visible in the snapshot.

6. **Interactive elements audit** — From the snapshot output, verify key interactive elements are present and properly labeled.

7. **Report** — Summarize findings in a table:
   | Check | Status | Details |
   |-------|--------|---------|
   | Page loads | pass/fail | ... |
   | No error overlays | pass/fail | ... |
   | No console errors | pass/fail | ... |
   | Interactive elements | pass/fail | ... |
   | Visual appearance | pass/fail | ... |

8. **Auto-fix cycle** — If issues are found that can be fixed in code, fix them, wait for HMR/rebuild, then re-verify (max 2 cycles). For issues that need user input, list them clearly.

## Notes
- Uses `agent-browser` CLI (auto-connects to Dia via ~/.agent-browser/config.json)
- For deeper debugging, use Chrome DevTools MCP tools: `mcp__chrome-devtools__lighthouse_audit`, `mcp__chrome-devtools__list_network_requests`, `mcp__chrome-devtools__performance_start_trace`
