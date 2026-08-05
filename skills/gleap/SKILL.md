---
name: gleap
description: >
  Work with Gleap (in-app feedback, support inbox, surveys, product tours) — install
  the widget, query the server REST API, or debug an existing integration. Covers the
  two-key auth model, the inconsistent response envelopes, and the query syntax.
argument-hint: "[install | api <what to fetch> | audit | docs <topic>]"
---

Integrate, query, or audit a [Gleap](https://gleap.io) setup.

Task: $ARGUMENTS

## The one thing to get right first

Gleap has **two separate interfaces with two different keys**. Mixing them up is the
most common failure.

| | Web SDK (browser) | Server REST API |
|---|---|---|
| Key | Frontend API key — **public** | Secret API key (a JWT) — **never in the browser** |
| Found in | Project Settings → Widget | Project Settings → Security → API Key |
| Auth | `Gleap.initialize(key)` | `Authorization: Bearer <jwt>` **and** `Project: <projectId>` |
| Base | `sdk.gleap.io/latest/index.js` | `https://api.gleap.io/v3` |

The server API requires **both** headers. Sending only `Authorization` returns
`400 Project header is required` as **plain text, not JSON**.

## Steps

1. **Figure out which half the request is about.** Widget/SDK work → step 2.
   Server/REST work → step 3. Debugging an existing setup → step 5.

2. **Widget install.** Check whether the project already has a Gleap setup skill or
   provider before writing one. Otherwise:
   - `npm install gleap`
   - Call `Gleap.initialize(key)` **exactly once**. In React/Next.js put it at
     **module scope** behind `typeof window !== "undefined"`, not in a `useEffect` —
     an effect double-fires under Strict Mode.
   - Read the key from an env var (`NEXT_PUBLIC_GLEAP_API_KEY`, `VITE_…`, `PUBLIC_…`).
     Never hardcode it — staging needs to point at a different project.
   - `Gleap.identify(userId, {...})` on sign-in; `Gleap.updateContact()` for later
     changes; `Gleap.clearIdentity()` on sign-out.
   - `Gleap.setEnvironment(process.env.NODE_ENV === "production" ? "prod" : "dev")`
     so local noise stays out of the inbox.

3. **Server API.** Confirm `GLEAP_API_KEY` and `GLEAP_PROJECT_ID` are set, then
   verify auth with the cheapest call:
   ```bash
   curl -s https://api.gleap.io/v3/users/me \
     -H "Authorization: Bearer $GLEAP_API_KEY" -H "Project: $GLEAP_PROJECT_ID"
   ```
   The key is a JWT — decode it to check which project it belongs to before assuming
   the key is bad:
   ```bash
   echo "$GLEAP_API_KEY" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool
   ```

4. **Build the query.** Every `GET` list endpoint filters on **any field present on
   the stored document** — there's no fixed allowlist. Fetch one record and read its
   keys to discover filters.

   | Pattern | Example |
   |---|---|
   | Exact | `?status=OPEN` |
   | OR | `?status=OPEN,DONE,INPROGRESS` |
   | Comparison | `?createdAt>=2026-01-01T00:00:00.000Z` (`>=` `<=` `>` `<`) |
   | AND | `?status=OPEN&priority=HIGH` |
   | Paging | `?limit=50&skip=100` |

   Dates are ISO 8601. Prefer `GET /tickets/export` or `/tickets/csv-export` over
   paging for bulk pulls.

   ⚠️ **Comparison filters break `URLSearchParams`.** In `createdAt>=2026-01-01…` the
   operator *is* the separator — there's no `=` after it. `params.append("createdAt>=",
   v)` emits `createdAt%3E%3D=v`, and the server then reads the value as `=2026-01-01…`
   and fails with `Cast to date failed`. Build those fragments by hand:
   ```ts
   const OPERATOR_RE = /(>=|<=|>|<)$/;
   const m = key.match(OPERATOR_RE);
   const part = m
     ? `${encodeURIComponent(key.slice(0, -m[1].length))}${m[1]}${encodeURIComponent(value)}`
     : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
   ```
   `curl -G --data-urlencode "createdAt>=$VALUE"` is fine — curl splits on the first
   `=` and adds no extra separator.

5. **Apply the known traps** when writing or debugging client code:
   - **Envelopes are inconsistent.** `GET /tickets` returns
     `{ tickets, count, totalCount }`. Every other list endpoint — `/sessions`,
     `/companies`, `/messages`, `/teams`, `/helpcenter/collections` — returns a
     **bare array**. Normalize once at the boundary.
   - **Errors come in four shapes:** `{error:{message}}` (401),
     `{fields:{…}}` (validation 400), `{codeName:"MaxTimeMSExpired"}` (backend 409),
     and **plain text** (missing `Project` header). Never call `res.json()`
     unconditionally — read text, then try to parse.
   - **`409` is retryable**, not a client error — it's a backend query timeout
     leaking a raw database error. A blanket `if (status >= 400) throw` mishandles it.
   - **No rate-limit headers.** Only `Retry-After` is exposed, and only on a `429`.
     You can't pace proactively — react and back off. Documented limits: 1000 req/60s
     for most endpoints, 200 req/60s for ticket endpoints.

6. **Audit an existing integration** (`/gleap audit`) — check each:
   - Is the secret API key ever bundled client-side? (grep for it outside server code)
   - Is the widget key hardcoded, or duplicated across files that can drift?
   - Does `Gleap.identify()` pass a **user hash** (third argument)? Without it anyone
     can impersonate any user from the browser console. Generate it server-side:
     `crypto.createHmac("sha256", SECRET).update(String(userId)).digest("hex")` —
     note `String(...)`, Gleap treats userId as a string and a numeric hash silently
     fails to verify.
   - Do PII-rendering pages mask inputs for replays? Add `rr-mask` (value) or
     `rr-block` (subtree); `Gleap.setReplayOptions({maskAllInputs:true})` must run
     **before** `initialize()`.
   - If a strict CSP is in place, are `sdk.gleap.io` and `*.gleap.io` allowed? (Only
     needed when loading the SDK via `<script>` — npm-bundled installs don't fetch it.)
   - Is `Gleap.setEnvironment()` wired, so dev traffic isn't in the production inbox?

7. **Report** what you changed or found. For an audit, lead with anything
   security-relevant (missing user hash, leaked secret key), then correctness, then
   hygiene.

## Fetching current docs

Gleap's docs are Mintlify, so they're machine-readable — don't scrape the HTML:

```bash
curl -s https://api.gleap.io/api-docs.json      # full OpenAPI 3.0 spec (258 operations)
curl -s https://docs.gleap.io/llms-full.txt     # entire docs corpus as markdown
curl -s https://docs.gleap.io/llms.txt          # page index
```

Any single page also serves clean markdown by appending `.md`:
`https://docs.gleap.io/documentation/javascript/user-identity.md`

## Notes

- **Resource groups in the API:** `/tickets` (44 ops — the support inbox),
  `/sessions` (24 — identified contacts), `/engagement/*` (~80 — surveys, tours,
  banners, emails, checklists), `/helpcenter/*` (29), `/companies`, `/teams`,
  `/statistics`, `/messages`. Full schemas live in the OpenAPI spec above.
- **Don't double-instrument.** If the project also runs Sentry and PostHog, keep the
  split clean: Sentry owns errors, PostHog owns behavioural analytics, Gleap owns
  human-reported feedback. Routing one signal to two tools makes both less trustworthy.
- The SDK's nested `company: { id, name }` object needs **≥ 16.3.0**. On older
  versions use the flat `companyId` / `companyName` properties.
- Custom data is capped at **35 keys** per identify call, and values must be string,
  number, or boolean — nested objects won't work in segment filters.
- Un-identified visitors become guest sessions; identifying later **merges** their
  existing feedback into the user session, so a late `identify()` doesn't lose reports.
- Enable identity-verification enforcement in the dashboard only **after** every
  client passes a user hash — enforcement rejects un-hashed calls immediately.
- Use `/env-check` to confirm the Gleap env vars are present before debugging auth,
  and `/search-all` to find every project that already depends on `gleap`.
