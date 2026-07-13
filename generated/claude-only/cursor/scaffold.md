# scaffold

Create a new project from templates tuned to your stack conventions. Scaffolds full project structure with framework, database, auth, and design system pre-wired.

Arguments: {the text you type after the command} (project name + optional template: "next", "vite", "api", "monorepo", or a description)

## Steps

1. **Parse the request** — From `{the text you type after the command}`, determine:

   **a) Project name:** First word or quoted string (e.g., `my-app`, `"cool project"`)
   - Slugify for directory name: lowercase, hyphens, no spaces
   - Target directory: `~/Projects/<slug>/`
   - If directory already exists, warn and stop

   **b) Template:** Infer from remaining arguments or ask:

   | Keyword | Template |
   |---------|----------|
   | `next` | Next.js 16 + App Router full-stack |
   | `vite` | Vite + React 19 SPA |
   | `api` | Hono API server (deployable to Vercel or CF Workers) |
   | `monorepo` | Turborepo with app + packages |
   | _(description)_ | Infer best template from description |
   | _(empty)_ | Ask with AskUserQuestion |

2. **Gather preferences** — Use AskUserQuestion with 3-4 questions:

   **Question 1 — Database:**
   - Neon Postgres + Drizzle (recommended — matches most projects)
   - Supabase (if project needs realtime or Supabase Auth)
   - None (static site or client-only)

   **Question 2 — Auth:**
   - Neon Auth (if Neon selected, zero-config)
   - Clerk (marketplace integration, rich UI components)
   - Supabase Auth (if Supabase selected)
   - None

   **Question 3 — UI:**
   - @rebel/ui (shared design system — auto-wires with `/setup-rebel-ui` patterns)
   - shadcn/ui (standalone, `npx shadcn@latest init`)
   - Tailwind only (minimal)

   **Question 4 — Extras (multi-select feel — list as options):**
   - Stripe (payments/billing)
   - AI features (AI SDK + AI Gateway)
   - Cron jobs
   - None of the above

   **CRITICAL:** Wait for answers before proceeding.

3. **Create the project** — Based on template + preferences:

   **For `next` template:**
   ```bash
   cd ~/Projects
   npx create-next-app@latest <slug> --typescript --tailwind --app --src-dir --import-alias "@/*" --turbopack
   cd <slug>
   ```

   **For `vite` template:**
   ```bash
   cd ~/Projects
   npm create vite@latest <slug> -- --template react-ts
   cd <slug>
   npm install
   npm install -D tailwindcss @tailwindcss/postcss
   ```

   **For `api` template:**
   ```bash
   cd ~/Projects
   mkdir <slug> && cd <slug>
   npm init -y
   npm install hono
   npm install -D typescript @types/node tsx
   ```
   Create `src/index.ts` with Hono app, `tsconfig.json`, and Vercel adapter config.

   **For `monorepo` template:**
   ```bash
   cd ~/Projects
   npx create-turbo@latest <slug> --package-manager pnpm
   cd <slug>
   ```

4. **Wire up database** (if selected):

   **Neon + Drizzle:**
   ```bash
   npm install drizzle-orm @neondatabase/serverless
   npm install -D drizzle-kit
   ```
   - Create `db/schema.ts` with a starter `users` table
   - Create `db/index.ts` with connection setup (reads `DATABASE_URL`)
   - Create `drizzle.config.ts`
   - Create `.env.example` with `DATABASE_URL=postgresql://...`

   **Supabase:**
   ```bash
   npm install @supabase/supabase-js @supabase/ssr
   ```
   - Create `lib/supabase/client.ts` (browser client)
   - Create `lib/supabase/server.ts` (server client)
   - Create `.env.example` with `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

5. **Wire up auth** (if selected):

   **Clerk:**
   - Add to `.env.example`: `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`
   ```bash
   npm install @clerk/nextjs
   ```
   - Create `proxy.ts` (or `src/proxy.ts`) with `clerkMiddleware()`
   - Wrap root layout with `<ClerkProvider>`
   - Create `app/sign-in/[[...sign-in]]/page.tsx` and `app/sign-up/[[...sign-up]]/page.tsx`
   - Note: user must run `vercel integration add clerk` manually (requires terminal interaction)

   **Neon Auth:**
   - Add auth schema to `db/schema.ts` (users table with auth fields)
   - Create `lib/auth.ts` with session helpers

6. **Wire up UI** (if selected):

   **@rebel/ui:**
   - Follow the exact same steps as `/setup-rebel-ui` — add link dependency, configure globals.css with theme bridge block, set up layout.tsx with providers
   - Read the template files from `~/Projects/design-system/template/`

   **shadcn/ui:**
   ```bash
   npx shadcn@latest init -d
   ```

7. **Wire up extras:**

   **Stripe:**
   ```bash
   npm install stripe
   ```
   - Create `lib/stripe.ts` with Stripe client
   - Create `app/api/webhooks/stripe/route.ts` with signature verification skeleton
   - Add to `.env.example`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

   **AI features:**
   ```bash
   npm install ai @ai-sdk/react
   ```
   - Create `app/api/chat/route.ts` with `streamText` + `toUIMessageStreamResponse()`
   - Add to `.env.example`: note about `vercel env pull` for OIDC
   - Remind user: `vercel link` → enable AI Gateway → `vercel env pull`

   **Cron jobs:**
   - Create `app/api/cron/route.ts` with `CRON_SECRET` verification
   - Add cron config to `vercel.json`
   - Add `CRON_SECRET` to `.env.example`

8. **Create project scaffolding files:**

   **a) `.env.example`** — All required env vars collected from above steps

   **b) `.gitignore`** — Standard for the framework, plus:
   ```
   .env*.local
   .vercel
   .next
   node_modules
   dist
   ```

   **c) `CLAUDE.md`** — Project-specific instructions:
   ```markdown
   # <Project Name>

   ## Overview
   <one-line description>

   ## Stack
   - Framework: <framework>
   - Database: <db choice>
   - Auth: <auth choice>
   - UI: <ui choice>

   ## Setup
   1. `npm install`
   2. Copy `.env.example` to `.env.local` and fill in values
   3. `npm run dev`

   ## Conventions
   <inherit from ~/Projects/CLAUDE.md>
   ```

   **d) Initialize git:**
   ```bash
   git init
   git add -A
   git commit -m "feat: scaffold <project-name>"
   ```

9. **Report** — Show what was created:

   ```
    SCAFFOLD  <project-name> created at ~/Projects/<slug>/

    Stack: Next.js 16 + Neon/Drizzle + Clerk + @rebel/ui + Stripe

    Structure:
    <slug>/
    ├── app/
    │   ├── api/webhooks/stripe/route.ts
    │   ├── sign-in/[[...sign-in]]/page.tsx
    │   ├── layout.tsx (with ClerkProvider, ThemeProvider)
    │   └── page.tsx
    ├── db/
    │   ├── schema.ts (users table)
    │   └── index.ts (Neon connection)
    ├── lib/
    │   └── stripe.ts
    ├── proxy.ts (Clerk middleware)
    ├── CLAUDE.md
    ├── .env.example (7 variables)
    └── drizzle.config.ts

    Next steps:
    1. vercel link (connect to Vercel project)
    2. vercel integration add clerk (set up auth)
    3. vercel env pull (sync env vars)
    4. Copy .env.example to .env.local and fill in remaining values
    5. npm run dev
   ```

## Notes
- This skill creates a project that matches the conventions in `~/Projects/CLAUDE.md`: async request APIs, function declarations, semantic tokens, `cn()` utility, etc.
- For @rebel/ui projects, reads templates from `~/Projects/design-system/template/` to get the canonical globals.css and layout.tsx
- After scaffolding, suggest `/switch <project>` to enter the new project context
- For monorepo template, suggest naming workspace packages with `@<project>/` prefix
- The scaffold includes a `CLAUDE.md` because every project should have one — it inherits cross-project conventions and adds project-specific details
- **Never hardcode secrets** in scaffolded files — always use `.env.example` placeholders
- If the user gives a description instead of a template name (e.g., "a SaaS dashboard for managing invoices"), infer the best template and preferences, then confirm before proceeding
