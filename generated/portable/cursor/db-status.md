# db-status

Database connection check and quick status. For full migration workflows, use `/migrate`.

Target directory: {the text you type after the command} (default: current working directory)

## Steps

1. **Delegate to `/migrate status`** — This skill is a focused alias. Run the same logic as `/migrate status` but with a read-only emphasis:

   **a) Detect ORM and database** — Check for these files (in parallel):
   - `drizzle.config.ts` or `drizzle.config.js` → Drizzle ORM
   - `prisma/schema.prisma` → Prisma
   - `supabase/config.toml` → Supabase local
   - Look in `package.json` dependencies for `drizzle-orm`, `@prisma/client`, `@supabase/supabase-js`
   - Check `.env.local` or `.env` for `DATABASE_URL`, `POSTGRES_URL`, `SUPABASE_URL`

   **b) Test connection:**
   - If DATABASE_URL is set, try a simple connection test:
     ```bash
     node -e "const { Client } = require('pg'); const c = new Client(process.env.DATABASE_URL); c.connect().then(() => { console.log('OK'); c.end(); }).catch(e => console.error(e.message))" 2>&1
     ```
   - Report: connected (with latency) or error message

   **c) Migration status** — Based on detected ORM, check for pending migrations and schema drift (same detection logic as `/migrate status`).

   **d) Table inventory** — If connected:
   ```sql
   SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
   ```

2. **Report** — Present findings:

   ```
   ## Database Status: <project-name>
   ORM: Drizzle | Provider: Neon Postgres
   Connection: OK (us-east-2, 52ms)

   | Check | Status | Details |
   |-------|--------|---------|
   | Connection | PASS | Connected (52ms) |
   | Migrations | WARN | 1 pending migration |
   | Schema drift | PASS | Schema matches migrations |
   | Tables | INFO | 24 tables in public schema |

   ### Recent Migrations
   | Date | Name | Status |
   |------|------|--------|
   | 2026-05-06 | add_event_capacity | Applied |
   | 2026-05-01 | create_announcements | Applied |
   | 2026-04-28 | add_member_tags | PENDING |
   ```

3. **Suggest next steps** — Based on findings, point to the right skill:
   - Pending migrations → "Run `/migrate push` to apply"
   - Schema drift → "Run `/migrate generate` to create a migration"
   - Connection failure → "Run `/env-check` to verify DATABASE_URL"
   - No ORM detected → "Run `/migrate` to set one up"

   **This skill is read-only.** It never applies migrations or modifies the database. For actions, use `/migrate`.

## Notes
- This is the quick diagnostic; `/migrate` is the full workflow with generate/push/rollback/seed
- Connection test requires DATABASE_URL in environment — run `/env-check` first if connection fails
- For Supabase projects, the local dev database (port 54321) is checked separately from production
