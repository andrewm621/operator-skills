# migrate

Database migration workflow for Drizzle, Prisma, or Supabase projects. Guides through generating, reviewing, and applying migrations safely. `/migrate status` is the read-only health check — connection test, migration state, schema drift, table inventory.

Arguments: {the text you type after the command} (subcommand: "generate", "push", "status", "rollback", "seed", "diff", or a description of schema changes)

## Steps

1. **Detect ORM and config** — Check for these files (in parallel):
   - `drizzle.config.ts` → Drizzle ORM (read config for schema path, output dir, driver)
   - `prisma/schema.prisma` → Prisma
   - `supabase/config.toml` → Supabase
   - Read `package.json` for installed packages and scripts
   - Check `.env.local` and `.env` (and the shell environment) for `DATABASE_URL`, `POSTGRES_URL`, or `SUPABASE_URL` — never assume the variable is already in `process.env`; see the connection test under `status`

   If no ORM detected, offer to set one up: "No database ORM found. Want to add Drizzle + Neon? (recommended)"

2. **Parse the subcommand** — From `{the text you type after the command}`:

   | Input | Action |
   |-------|--------|
   | _(empty)_ or `status` | Read-only health check: connection test, migration status, schema drift, table inventory. Never changes anything |
   | `generate` or `gen` | Generate a new migration from schema changes |
   | `push` or `apply` | Apply pending migrations to the database |
   | `rollback` | Roll back the last migration (with safety checks) |
   | `seed` | Run or create seed script |
   | `diff` | Show schema diff without generating migration |
   | A description (e.g., "add events table with capacity field") | Make the schema change, then generate migration |

3. **Execute based on subcommand:**

   ### `status`
   Read-only. Never applies migrations or modifies the database; for actions use the other subcommands. Run the checks below (the file-based ones in parallel).

   **a) Connection test — load the env files explicitly.** A bare `new Client(process.env.DATABASE_URL)` silently falls back to `localhost` when the variable is unset (the shell does not read `.env.local`), which reports a false OK or a misleading error. Resolve the URL yourself, say where it came from, and fail loudly if there isn't one:

   ```bash
   node - <<'NODE'
   const fs = require('fs');
   const KEYS = ['DATABASE_URL', 'POSTGRES_URL'];
   function parseEnv(file) {
     const out = {};
     let text = '';
     try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
     for (const line of text.split(/\r?\n/)) {
       const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
       if (!m || m[1].startsWith('#')) continue;
       out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
     }
     return out;
   }
   // Precedence: shell environment, then .env.local, then .env (same as Next.js).
   const sources = [['shell environment', process.env], ['.env.local', parseEnv('.env.local')], ['.env', parseEnv('.env')]];
   let url, key, source;
   outer: for (const [name, env] of sources) for (const k of KEYS) if (env[k]) { url = env[k]; key = k; source = name; break outer; }
   if (!url) {
     console.error('FAIL: no ' + KEYS.join(' or ') + ' found in the shell environment, .env.local, or .env (cwd: ' + process.cwd() + ')');
     process.exit(2);
   }
   let u;
   try { u = new URL(url); } catch { console.error('FAIL: ' + key + ' from ' + source + ' is not a valid URL'); process.exit(2); }
   console.log('Using ' + key + ' from ' + source + ' -> ' + u.protocol + '//' + u.host + u.pathname + ' (credentials hidden)');
   if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) console.log('NOTE: this points at a local database');
   let Client;
   try { ({ Client } = require('pg')); } catch { console.error('FAIL: the "pg" package is not installed in this project. Test with: psql "$URL" -c "select 1"'); process.exit(3); }
   const t0 = Date.now();
   const c = new Client({ connectionString: url });
   c.connect()
     .then(() => c.query('select 1'))
     .then(() => { console.log('OK connected in ' + (Date.now() - t0) + 'ms'); return c.end(); })
     .catch(e => { console.error('FAIL: ' + (e.code ? e.code + ' ' : '') + e.message); process.exitCode = 1; });
   NODE
   ```

   Report the variable, the source (`shell environment`, `.env.local`, or `.env`), the host and database name (never the password), and either the connected latency or the error. If no URL was found, stop here and say so; do not try the other checks against a guessed database, and point to `/env-check`. If `.env.local` and `.env` define different URLs, mention which one won and that the other was ignored. For Supabase projects, the local dev database (port 54321) is separate from production; say which one the URL targets.

   **b) Migration status** — based on the detected ORM:

   **Drizzle:**
   ```bash
   npx drizzle-kit status 2>&1
   ```
   - List all migration files in the migrations directory with dates
   - Check if `drizzle-kit generate` would produce new output (schema drift)
   - Read the schema file to show current table inventory

   **Prisma:**
   ```bash
   npx prisma migrate status 2>&1
   ```

   **Supabase:**
   - List `supabase/migrations/` files
   - Run `supabase db diff` if CLI available

   **c) Table inventory** — if connected, using the same connection as (a):
   ```sql
   SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
   ```

   **d) Report:**
   ```
    MIGRATE STATUS  <project-name>
    ORM: Drizzle | Schema: db/schema.ts | Migrations: drizzle/
    Connection: OK (DATABASE_URL from .env.local, 52ms)

    Applied: 12 migrations (latest: 2026-05-10 — add_member_tags)
    Pending: 0
    Schema drift: none detected

    Tables (14): users, events, members, tags, ...
   ```

   **e) Suggest next steps** — point to the right subcommand:
   - Pending migrations → "Run `/migrate push` to apply"
   - Schema drift → "Run `/migrate generate` to create a migration"
   - Connection failure or no URL → "Run `/env-check` to verify DATABASE_URL"
   - No ORM detected → offer to set one up (see step 1)

   ### `generate` / `gen`
   **a) Check for schema changes:**

   **Drizzle:**
   ```bash
   npx drizzle-kit generate 2>&1
   ```
   - If "No schema changes detected", report that and stop
   - If a migration is generated, read and display the generated SQL

   **Prisma:**
   ```bash
   npx prisma migrate dev --name <auto-generated-name> --create-only 2>&1
   ```

   **b) Review the generated migration:**
   - Read the generated SQL file
   - Analyze for safety:
     - `DROP TABLE` or `DROP COLUMN` → flag as **DESTRUCTIVE** — data will be lost
     - `ALTER TABLE ... ALTER COLUMN ... TYPE` → flag as **RISKY** — may fail on existing data
     - `NOT NULL` without `DEFAULT` on existing column → flag as **RISKY** — will fail if rows exist
     - `CREATE INDEX` on large table → flag as **SLOW** — may lock table
     - Pure `CREATE TABLE`, `ADD COLUMN` with defaults → **SAFE**

   **c) Present the review:**
   ```
    MIGRATE GENERATE  Migration created

    File: drizzle/0013_add_event_capacity.sql

    ```sql
    ALTER TABLE "events" ADD COLUMN "capacity" integer DEFAULT 0;
    ALTER TABLE "events" ADD COLUMN "waitlist_enabled" boolean DEFAULT false;
    CREATE INDEX "events_capacity_idx" ON "events" ("capacity");
    ```

    Safety: SAFE (additive changes only)

    Next: Run `/migrate push` to apply, or edit the SQL file first.
   ```

   If destructive changes found:
   ```
    WARNING: DESTRUCTIVE CHANGES DETECTED

    - DROP COLUMN "events"."old_status" — data in this column will be lost
    - ALTER COLUMN "users"."email" TYPE varchar(100) — may truncate existing values

    Before applying:
    1. Verify no important data in "events"."old_status"
    2. Check max length of existing email values: SELECT max(length(email)) FROM users
    3. Consider a staged migration: add new column → backfill → drop old column

    Proceed with caution. Run `/migrate push` only after review.
   ```

   ### `push` / `apply`
   **a) Safety check before applying:**
   - Read the pending migration SQL
   - If any destructive operations, require explicit confirmation: "This migration contains DROP operations. Type 'confirm' to proceed."
   - Show what will be applied

   **b) Apply:**

   **Drizzle:**
   ```bash
   npx drizzle-kit migrate 2>&1
   ```

   **Prisma:**
   ```bash
   npx prisma migrate deploy 2>&1
   ```

   **Supabase:**
   ```bash
   supabase db push 2>&1
   ```

   **c) Verify:**
   - Check exit code
   - Run a quick table count query to confirm the migration took effect
   - If failed, show the error and suggest fixes

   Report:
   ```
    MIGRATE PUSH  Applied 1 migration

    Applied: 0013_add_event_capacity.sql
    Duration: 0.8s
    Tables: 14 → 14 (no new tables, 1 altered)
    Status: SUCCESS
   ```

   ### `rollback`
   **a) Determine what to roll back:**
   - Read the most recent migration file
   - Check if the ORM supports rollback:
     - Drizzle: No built-in rollback — must create a reverse migration manually
     - Prisma: `npx prisma migrate reset` (resets ALL migrations — destructive)
     - Supabase: Can drop the latest migration if not yet deployed

   **b) For Drizzle (most common in this workspace):**
   - Read the last migration SQL
   - Generate reverse SQL (CREATE → DROP, ADD COLUMN → DROP COLUMN, etc.)
   - Write it as a new migration file
   - Show the reverse SQL for review before applying
   - **Never apply rollback without explicit confirmation**

   **c) Warn about data loss:**
   ```
    WARNING: Rolling back will:
    - Drop column "events"."capacity" (data will be lost)
    - Drop column "events"."waitlist_enabled" (data will be lost)
    - Drop index "events_capacity_idx"

    This is irreversible in production. Confirm? (y/N)
   ```

   ### `seed`
   **a) Find or create seed script:**
   - Check for `db/seed.ts`, `prisma/seed.ts`, `scripts/seed.ts`
   - If none exists, offer to create one

   **b) If creating a new seed script:**
   - Read the schema to understand tables and relationships
   - Generate realistic seed data (not lorem ipsum) based on the project's domain
   - Use the project's ORM for inserts
   - Handle foreign key relationships in correct order

   **c) Run the seed:**
   ```bash
   npx tsx db/seed.ts 2>&1
   ```
   Report row counts per table after seeding.

   ### `diff`
   Show what would be generated without creating files:

   **Drizzle:**
   ```bash
   npx drizzle-kit generate --dry-run 2>&1
   ```
   If `--dry-run` isn't available, run generate and show the output without committing.

   ### Description-based (e.g., "add events table with capacity field")
   **a) Read the current schema** to understand existing tables and patterns
   **b) Make the schema change:**
   - Edit `db/schema.ts` (Drizzle) or `prisma/schema.prisma` (Prisma)
   - Follow existing patterns in the file (naming conventions, column types, relations)
   - Show the diff of what was changed

   **c) Then run the `generate` flow** from above to create the migration

4. **Roadmap integration** — If there's an active roadmap and the migration relates to a task:
   - Mention the task ID: "This may relate to task 2.3 (Invoice display + Stripe)"
   - Offer to mark schema-related tasks as done

## Notes
- `/migrate status` is the read-only diagnostic (it absorbed the former standalone database-status skill); the other subcommands are the actions
- **Never apply destructive migrations without explicit user confirmation**
- For production databases, always recommend: test locally first → apply to preview branch → then production
- If no database URL can be found (shell, `.env.local`, `.env`), say so plainly and suggest `/env-check`; never let a connection test default to localhost
- Drizzle is the primary ORM in this workspace — optimized for that flow
- When making schema changes from descriptions, always show the diff before generating the migration
- Seed scripts should be idempotent (safe to run multiple times) — use `INSERT ... ON CONFLICT DO NOTHING` or truncate+insert
- For Neon projects, mention branching: "Consider creating a Neon branch to test this migration: `neonctl branches create --name test-migration`"
