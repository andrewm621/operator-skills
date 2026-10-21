---
name: port-check
description: >
  Show what's running on common development ports. Identifies projects and offers to kill stale processes.
---

Show what's running on common development ports. Identifies projects and offers to kill stale processes.

**Config:** `paths.projects` (default `~/Projects`) and `browser.cdp_port` (default `9222`) from `~/.config/operator-skills/config.yaml` — see `docs/config.md`. `<projects>` below is the projects directory; a missing file or key means the default.

## Steps

1. **Scan ports** — Run `lsof -iTCP -sTCP:LISTEN -P -n` to get all listening TCP ports. Filter to common dev ports:
   - 3000-3010 (Next.js, Vite, React dev servers)
   - 4000-4001 (GraphQL, custom APIs)
   - 5173-5174 (Vite default)
   - 5432 (PostgreSQL)
   - 54321-54322 (Supabase local)
   - 8080, 8787, 8788 (Express, Wrangler/CF Workers)
   - `browser.cdp_port`, default 9222 (Chrome DevTools Protocol for a browser-automation session)
   - Also show any other ports with node/next/vite/python/ruby/postgres processes

2. **Identify projects** — For each process:
   - Get the PID and process name
   - Run `lsof -p <PID> | grep cwd` or `ps -p <PID> -o args=` to determine the working directory
   - Match working directory to a `<projects>/*` subdirectory
   - Calculate uptime from process start time: `ps -p <PID> -o etime=`

3. **Detect conflicts** — Check if multiple dev servers are trying to use the same port range, or if a port is occupied by a zombie process.

4. **Report** — Present a clean summary:

   ```
   ## Active Ports

   | Port | Process | PID | Project | Uptime |
   |------|---------|-----|---------|--------|
   | 3000 | next-server | 12345 | dashboard | 2h 15m |
   | 3001 | next-server | 12346 | web-app | 45m |
   | 5432 | postgres | 789 | (system) | 3d |
   | 9222 | Chrome | 456 | (browser) | 1h 10m |

   2 dev servers running. No conflicts.
   ```

5. **Offer cleanup** — If there are processes running, ask if the user wants to:
   - Kill a specific process by port number
   - Kill all dev servers (keeping databases and browsers)
   - **Always confirm before killing any process**

## Notes
- Read-only scan by default — only kills processes with explicit user confirmation
- Useful before starting a new dev server to avoid EADDRINUSE errors
- Works on macOS (uses lsof)
