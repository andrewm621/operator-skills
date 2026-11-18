Verify a running web app in a real browser via `agent-browser`. URL defaults to http://localhost:3000 unless specified.

Target URL: $ARGUMENTS (default: http://localhost:3000)

**Config:** `browser.mode` (default `headless`), `browser.cdp_port` (default `9222`), `browser.launch_cmd` and `browser.agent_browser_config` (both optional) from `~/.config/operator-skills/config.yaml` — see `docs/config.md`. A missing file or key means the default; never guess.

## Steps

1. **Pick the browser** — Read `browser.mode` from the config (default `headless`).
   - **`headless`** — `agent-browser` launches its own isolated browser. No connection check needed; go to step 2.
   - **`cdp`** — Attach to the user's running browser. Run `curl -s http://127.0.0.1:<cdp_port>/json/version` (`cdp_port` defaults to `9222`). If it fails, tell the user the browser isn't listening on that port, suggest `browser.launch_cmd` if one is set (otherwise say to start their browser with `--remote-debugging-port=<cdp_port>`), and stop. If it succeeds and `browser.agent_browser_config` is set, add `--config <agent_browser_config>` to every `agent-browser` command below.

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
- Uses the `agent-browser` CLI. In `headless` mode (the default) it starts its own browser and never touches your real browser or its tabs; in `cdp` mode it drives the browser you point it at, including its logged-in sessions.
- Subagents should stay in `headless` mode so they never open tabs in your real browser.
- For deeper debugging, use Chrome DevTools MCP tools: `mcp__chrome-devtools__lighthouse_audit`, `mcp__chrome-devtools__list_network_requests`, `mcp__chrome-devtools__performance_start_trace`
- Desktop apps (Tauri, Electron, native macOS) are not covered here; use `/test-desktop-app` instead.
