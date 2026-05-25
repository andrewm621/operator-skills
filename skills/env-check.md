Compare expected vs actual environment variables and flag mismatches. Never displays secret values.

Target directory: $ARGUMENTS (default: current working directory)

## Steps

1. **Find env template** — Look for the source of truth in order:
   - `.env.example`
   - `.env.sample`
   - `.env.template`
   - If none found, check `README.md` for documented env vars
   - If still nothing, report "No env template found — consider creating .env.example"

2. **Read actual env files** — Read these if they exist (in parallel):
   - `.env.local`
   - `.env`
   - `.env.development.local`

3. **Compare** — For each variable in the template:
   - Is it present in `.env.local`?
   - Is the value a placeholder? (check for: `your-`, `changeme`, `xxx`, `TODO`, `REPLACE`, `sk_test_xxx`, empty string)
   - Is it a `NEXT_PUBLIC_` var that should be in the template but isn't?

4. **Check Vercel sync** (optional) — If the project has `.vercel/project.json` (is Vercel-linked):
   - Run `vercel env ls 2>/dev/null` to see what's configured on Vercel
   - Flag vars that exist locally but not on Vercel (and vice versa)
   - Note: skip this step if `vercel` CLI is not installed or not linked

5. **Common issue detection** — Flag these patterns:
   - `DATABASE_URL` missing or placeholder
   - Stripe keys mixing test/live modes
   - `NEXT_PUBLIC_` prefix missing on client-side vars
   - Supabase URL without matching anon/service key
   - Neon connection string without `?sslmode=require`

6. **Report** — Present findings:

   ```
   ## Environment Check: <project-name>
   Template: .env.example (15 variables)

   | Variable | Template | Local | Vercel | Status |
   |----------|----------|-------|--------|--------|
   | DATABASE_URL | required | set | set | OK |
   | STRIPE_SECRET_KEY | required | MISSING | set | Pull from Vercel |
   | NEXT_PUBLIC_APP_URL | required | set | not set | Push to Vercel |
   | RESEND_API_KEY | required | placeholder | set | Update local |

   ### Issues
   - 1 missing variable (STRIPE_SECRET_KEY) — run `vercel env pull` to sync
   - 1 placeholder value — update RESEND_API_KEY in .env.local

   ### Suggestions
   - Run `vercel env pull` to sync from Vercel
   ```

7. **Offer fixes** — If issues found, offer to:
   - Run `vercel env pull` to sync from Vercel (if linked)
   - Create missing `.env.local` from template
   - **Never write actual secret values** — only scaffold the file structure

## Notes
- NEVER display actual values of secrets in output — only show key names and status (set/missing/placeholder)
- Safe to run anytime — purely read-only analysis
- Works with any framework (Next.js, Vite, Express, etc.)
