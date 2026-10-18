Performance audit for web apps. Runs Lighthouse, analyzes bundle size, checks Core Web Vitals, and suggests optimizations.

Arguments: $ARGUMENTS (optional: URL, "bundle", "vitals", or a specific area like "images", "fonts", "js")

**Config:** `browser.mode` (default `headless`), `browser.cdp_port` (default `9222`), `browser.launch_cmd` and `browser.agent_browser_config` (both optional) from `~/.config/operator-skills/config.yaml` — see `docs/config.md`. A missing file or key means the default; never guess.

## Steps

1. **Parse the request** — From `$ARGUMENTS`:

   | Input | Action |
   |-------|--------|
   | _(empty)_ | Full audit: Lighthouse + bundle analysis on localhost:3000 |
   | A URL | Lighthouse audit on that URL |
   | `bundle` | Bundle size analysis only (no browser needed) |
   | `vitals` | Core Web Vitals check only (requires running app) |
   | `images` | Image optimization audit |
   | `fonts` | Font loading audit |
   | `js` | JavaScript bundle analysis |

2. **Check prerequisites:**
   - If URL-based audit: read `browser.mode` (default `headless`).
     - **`headless`** — no connection check; the audit tools launch their own browser.
     - **`cdp`** — run `curl -s http://127.0.0.1:<cdp_port>/json/version` (`cdp_port` defaults to `9222`). If it fails, suggest `browser.launch_cmd` if set (otherwise a browser started with `--remote-debugging-port=<cdp_port>`) and stop. Pass `--config <agent_browser_config>` to any `agent-browser` command when that key is set.
   - If bundle analysis: verify this is a Next.js or Vite project (has build config)
   - Detect framework for framework-specific optimizations

3. **Run Lighthouse audit** (for URL-based audits):

   **a) Navigate and audit:**
   Use Chrome DevTools MCP for the full Lighthouse audit (it must be configured to launch its own browser, or to attach to `http://127.0.0.1:<cdp_port>` in `cdp` mode):
   ```
   mcp__chrome-devtools__navigate_page → target URL
   mcp__chrome-devtools__lighthouse_audit → run audit
   ```
   If those tools aren't available, fall back to the Lighthouse CLI, which needs no MCP server:
   ```bash
   # headless mode: Lighthouse launches its own headless Chrome
   npx lighthouse <URL> --output=json --output-path=./lighthouse.json --chrome-flags="--headless=new"
   # cdp mode: attach to the running browser instead
   npx lighthouse <URL> --output=json --output-path=./lighthouse.json --port=<cdp_port>
   ```
   Read the scores and metrics from the JSON (`categories.*.score`, `audits.*.numericValue`), then delete `lighthouse.json`.

   **b) Parse Lighthouse results** — Extract scores:
   - Performance (target: >90)
   - Accessibility (target: >90)
   - Best Practices (target: >90)
   - SEO (target: >90)

   **c) Extract specific metrics:**
   - LCP (Largest Contentful Paint) — target: <2.5s
   - FID/INP (Interaction to Next Paint) — target: <200ms
   - CLS (Cumulative Layout Shift) — target: <0.1
   - FCP (First Contentful Paint) — target: <1.8s
   - TTFB (Time to First Byte) — target: <800ms
   - TBT (Total Blocking Time) — target: <200ms
   - Speed Index — target: <3.4s

4. **Run bundle analysis** (for `bundle` or full audit):

   **For Next.js:**
   ```bash
   # Build with analysis
   ANALYZE=true npm run build 2>&1
   ```
   If `@next/bundle-analyzer` isn't installed:
   ```bash
   # Use Next.js build output directly
   npm run build 2>&1
   ```
   Parse the build output for:
   - Route sizes (First Load JS per route)
   - Shared chunks size
   - Total first-load JS
   - Pages with large bundles (>100KB)

   **For Vite:**
   `vite build` has no `--report` flag (it lists chunk sizes in its normal output, which is often enough). For a treemap, use the bundle visualizer, which needs no config change:
   ```bash
   npx vite build 2>&1                  # chunk sizes are in the build output
   npx vite-bundle-visualizer           # builds, then writes stats.html (open it for the treemap)
   ```
   Or, if the project wants it permanently, add `rollup-plugin-visualizer` to `vite.config.ts`. Delete generated `stats.html` when done unless the user wants it.

   Also check for common bundle issues:
   ```bash
   # Find large dependencies
   du -sh node_modules/* 2>/dev/null | sort -rh | head -20
   ```

5. **Run targeted audits** (for specific areas):

   ### Images
   - Find all image imports and `<img>` / `<Image>` usage:
     ```bash
     grep -rn "next/image\|<img\|\.png\|\.jpg\|\.webp\|\.svg" --include="*.tsx" --include="*.ts" app/ components/ 2>/dev/null | head -30
     ```
   - Check for:
     - Images not using `next/image` (missing optimization)
     - Missing `width`/`height` or `fill` prop (causes CLS)
     - Missing `priority` on above-the-fold images (delays LCP)
     - Large images served without size constraints
     - SVGs that should be inlined vs loaded as images
     - Missing `loading="lazy"` on below-the-fold images

   ### Fonts
   - Check for font loading strategy:
     - Using `next/font`? (optimal — auto-optimized)
     - External font stylesheets? (blocks rendering)
     - `@font-face` declarations without `font-display: swap`?
     - Multiple font families loaded? (each adds weight)
   - Grep for font usage:
     ```bash
     grep -rn "next/font\|@font-face\|font-family\|googleapis.com/css" --include="*.tsx" --include="*.ts" --include="*.css" app/ 2>/dev/null
     ```

   ### JavaScript
   - Identify large client components (`"use client"` files):
     ```bash
     grep -rl "\"use client\"" app/ components/ 2>/dev/null
     ```
     For each, check file size and import tree depth
   - Look for barrel imports that pull in too much (icon sets, UI kits, utility libraries imported from their package root):
     ```bash
     grep -rnE "import \{[^}]{80,}\} from '[^./]" --include="*.tsx" --include="*.ts" app/ components/ 2>/dev/null
     ```
   - Check for dynamic imports where they should be used (heavy components, modals, charts)

6. **Network analysis** (if the Chrome DevTools MCP is available):
   Use Chrome DevTools MCP:
   ```
   mcp__chrome-devtools__list_network_requests → get all requests
   ```
   Analyze:
   - Total page weight (transferred vs uncompressed)
   - Number of requests
   - Largest resources
   - Requests without caching headers
   - Third-party script impact
   - Waterfall bottlenecks (sequential loads that could be parallel)

7. **Report** — Present comprehensive findings:

   ```
    PERF AUDIT  <project-name> | http://localhost:3000

    ### Lighthouse Scores
    | Category | Score | Status |
    |----------|-------|--------|
    | Performance | 78 | NEEDS WORK |
    | Accessibility | 95 | GOOD |
    | Best Practices | 92 | GOOD |
    | SEO | 100 | GOOD |

    ### Core Web Vitals
    | Metric | Value | Target | Status |
    |--------|-------|--------|--------|
    | LCP | 3.1s | <2.5s | SLOW |
    | INP | 120ms | <200ms | GOOD |
    | CLS | 0.05 | <0.1 | GOOD |
    | FCP | 1.2s | <1.8s | GOOD |
    | TTFB | 620ms | <800ms | GOOD |
    | TBT | 340ms | <200ms | SLOW |

    ### Bundle Size
    | Route | First Load JS | Status |
    |-------|--------------|--------|
    | / (homepage) | 89KB | OK |
    | /dashboard | 156KB | LARGE |
    | /settings | 112KB | WARN |
    | Shared chunks | 78KB | OK |

    ### Issues Found (sorted by impact)

    1. **HIGH — LCP: Hero image not using `priority` prop**
       File: app/page.tsx:24
       Fix: Add `priority` to the above-the-fold `<Image>` component
       Impact: ~0.5s LCP improvement

    2. **HIGH — TBT: Large client bundle on /dashboard**
       File: app/dashboard/page.tsx
       Fix: Dynamic import the chart components: `const Charts = dynamic(() => import('./charts'))`
       Impact: ~150ms TBT reduction

    3. **MEDIUM — Missing font optimization**
       File: app/layout.tsx
       Fix: Switch from Google Fonts stylesheet to `next/font/google`
       Impact: Eliminates render-blocking CSS request

    4. **LOW — Images without explicit dimensions**
       Files: components/avatar.tsx:12, components/card-image.tsx:8
       Fix: Add `width`/`height` props to prevent CLS

    ### Summary
    Performance: 78/100 — 2 high-impact fixes available
    Estimated score after fixes: ~88-92

    Quick wins (tell me which to apply, e.g. "fix 1 and 3"):
    - Add `priority` to hero image (issue 1)
    - Dynamic import charts (issue 2)
    - Use next/font (issue 3)
   ```

8. **Offer fixes** — For each issue found:
   - If it's a simple code change (add a prop, wrap in dynamic()), offer to fix it
   - After fixing, offer to re-run the specific check to verify improvement
   - **Do not make changes without presenting them first**

## Notes
- In `headless` mode (default) the audit launches its own browser. In `cdp` mode it needs your browser listening on `browser.cdp_port`.
- Bundle analysis works without a browser — just needs a build
- For production URLs (not localhost), Lighthouse runs against the live site which may differ from local
- Next.js build output already shows per-route bundle sizes — parse this for free without extra tools
- The `@next/bundle-analyzer` package provides detailed treemaps but isn't required — the built-in build output is usually sufficient
- Common quick wins: `next/font` instead of external stylesheets, `priority` on hero images, dynamic imports for charts/heavy components, avoiding barrel re-exports
- This skill pairs with `/verify-app` (functional check) — `/perf` focuses on performance specifically
- For Vercel-deployed apps, also check Vercel Speed Insights dashboard for real user metrics (not just lab data)
- If the project uses a shared design-system package, check that its CSS isn't being duplicated or loaded twice
