---
name: dark-mode
description: >
  Add a Light / Dark / System theme toggle to the current project, defaulting to the
  OS preference and persisting the user's explicit choice — flash-free, across Next.js,
  Vite/React, and plain HTML.
argument-hint: "[where to place the toggle]"
---

Add a production-grade Light / Dark / System theme toggle to the app in the current directory. $ARGUMENTS

The toggle is 3-way — **Light**, **Dark**, **System** — where **System** is the default on first visit (follows the OS `prefers-color-scheme` and live-updates if the OS theme changes), and an explicit Light/Dark click is remembered across reloads.

## The contract (must hold on every path)

Whatever the stack, the finished implementation must satisfy all of these:

1. **System default** — First-ever load (nothing saved) follows `prefers-color-scheme`. No saved value means "System".
2. **Sticky explicit choice** — Clicking Light or Dark writes to `localStorage` (key: `theme`). That choice survives reloads and overrides the OS.
3. **Live OS updates in System mode** — While in System mode, if the OS switches light↔dark, the app updates immediately (subscribe to the `matchMedia` `change` event). Once the user pins Light/Dark, OS changes are ignored.
4. **No flash (FOUC)** — On a dark load, the page must never paint light first. This requires a **blocking inline script in `<head>`** that sets the theme class *before* first paint — frameworks apply it too late on their own.
5. **`color-scheme` set** — Always set `document.documentElement.style.colorScheme` to `light`/`dark` so native controls, scrollbars, and form widgets match. Add `<meta name="color-scheme" content="light dark">` for static pages.
6. **Accessible toggle** — Use a `radiogroup`/`radio` pattern with `aria-label`s, keyboard-operable, with a visible active state.

Storage convention used everywhere: key `theme`, values `"light"` | `"dark"`, and **System = the key absent** (remove it). The no-flash script and the provider both follow this so they can never disagree — a mismatch produces a flash that only appears in System mode, which is maddening to debug.

## Steps

1. **Detect the stack** — Inspect before writing anything. Read `package.json` (and note the package manager: `pnpm-lock.yaml` = pnpm, `package-lock.json` = npm, `yarn.lock` = yarn). Then branch:
   - `next` present **and** (`next-themes` or a `next-themes`-based design system) → **Path A**. Do NOT hand-roll a provider — wire up / reuse next-themes.
   - `next` present without `next-themes` → install `next-themes`, use **Path A** (it's the right tool for SSR).
   - `vite` + `react`, no `next` → **Path B**.
   - Bundler-less static site (root `index.html`, no framework) → **Path C**.
   - No-build CMS (Webflow, Squarespace, WordPress — theme injected via a "custom code" embed, no `index.html` to edit directly) → **Path C**, and consider its **TTL-persisted / body-class alternate** below if the client wants a plain 2-way switch rather than a 3-way System option.
   - Anything else (Vue, Svelte, Astro, CRA) → adapt the principles above; reuse the no-flash script + storage convention, and ask if the framework idiom is unclear.
   - Also locate the **theme CSS**: confirm a `.dark` selector (or `[data-theme="dark"]`) defines dark tokens. Tailwind v4 uses `@custom-variant dark (&:is(.dark *))` + a `.dark { ... }` block. If no dark styles exist at all, scaffold a minimal token set (Path C's CSS) and tell the user it's a starter palette to refine.
   - State which path you detected before proceeding.

2. **Implement the detected path** — follow Path A, B, or C below.

3. **Verify** — Run the project's dev/build briefly to confirm no type/import errors. If a browser harness is available, use `/verify-app` to confirm: (a) no light flash on a dark reload, (b) all three options work, (c) the active state is visible.

4. **Report** — State which path was used, the files created/modified, where the toggle was placed, and the manual OS-flip test to try (set OS dark with nothing saved → loads dark; pick Light → reload stays light; pick System → flip OS theme → updates live).

---

## Path A — Next.js + next-themes

next-themes handles persistence, system detection, live updates, and the no-flash script. Configure it correctly and add the toggle UI.

1. **Install** `next-themes` if missing (detected package manager).

2. **Wrap the app** in `ThemeProvider` in `app/layout.tsx`. If a provider already exists, just verify/fix its props — don't duplicate it. Required props:

   ```tsx
   // app/layout.tsx
   import { ThemeProvider } from "next-themes"

   export default function RootLayout({ children }: { children: React.ReactNode }) {
     return (
       <html lang="en" suppressHydrationWarning>
         <body>
           <ThemeProvider
             attribute="class"
             defaultTheme="system"
             enableSystem
             disableTransitionOnChange
           >
             {children}
           </ThemeProvider>
         </body>
       </html>
     )
   }
   ```

   - `suppressHydrationWarning` on `<html>` is **required** — next-themes mutates the class before React hydrates; without it React warns on every load.
   - `defaultTheme="system"` + `enableSystem` is the "default to machine state" requirement. (If the project was set up with `defaultTheme="dark"`, switch to `"system"` unless the user wants dark-default.)
   - `attribute="class"` matches the `.dark` Tailwind variant.

3. **Add the toggle** at `components/theme-toggle.tsx`. Use the project's icon lib (e.g. `lucide-react`) and its `cn()` helper if present:

   ```tsx
   "use client"

   import { useTheme } from "next-themes"
   import { useEffect, useState } from "react"
   import { Sun, Moon, Monitor } from "lucide-react"
   import { cn } from "@/lib/utils"

   const OPTIONS = [
     { value: "light", icon: Sun, label: "Light" },
     { value: "dark", icon: Moon, label: "Dark" },
     { value: "system", icon: Monitor, label: "System" },
   ] as const

   export function ThemeToggle() {
     const { theme, setTheme } = useTheme()
     const [mounted, setMounted] = useState(false)
     // Avoid hydration mismatch: theme is unknown on the server.
     useEffect(() => setMounted(true), [])
     if (!mounted) return <div className="inline-flex h-9 w-[6.75rem]" aria-hidden />

     return (
       <div
         role="radiogroup"
         aria-label="Color theme"
         className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-background p-0.5"
       >
         {OPTIONS.map(({ value, icon: Icon, label }) => (
           <button
             key={value}
             type="button"
             role="radio"
             aria-checked={theme === value}
             aria-label={label}
             title={label}
             onClick={() => setTheme(value)}
             className={cn(
               "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
               theme === value
                 ? "bg-muted text-foreground"
                 : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
             )}
           >
             <Icon className="h-4 w-4" />
           </button>
         ))}
       </div>
     )
   }
   ```

   If the project ships a design system with `Button`/`ToggleGroup` primitives, prefer those over raw `<button>`s, keeping the same `radiogroup` semantics.

4. **Place the toggle** in the header/nav (ask if not obvious), and confirm `globals.css` has the `.dark` block + `@custom-variant dark`.

---

## Path B — Vite / React (no next-themes)

Hand-roll a small provider. next-themes is Next-specific — don't pull it in here.

1. **No-flash script** — add as the **first** thing in `<head>` of `index.html`, before the module script. It runs synchronously before paint:

   ```html
   <!-- index.html, inside <head>, before <script type="module"> -->
   <script>
     (function () {
       try {
         var saved = localStorage.getItem("theme"); // "light" | "dark" | null(=system)
         var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
         var dark = saved === "dark" || (!saved && prefersDark);
         var root = document.documentElement;
         root.classList.toggle("dark", dark);
         root.style.colorScheme = dark ? "dark" : "light";
       } catch (e) {}
     })();
   </script>
   ```

   Also add `<meta name="color-scheme" content="light dark" />` to `<head>`.

2. **Theme provider** at `src/theme-provider.tsx`:

   ```tsx
   import { createContext, useContext, useEffect, useState, type ReactNode } from "react"

   type Theme = "light" | "dark" | "system"
   type Resolved = "light" | "dark"
   const STORAGE_KEY = "theme"

   type ThemeContextValue = {
     theme: Theme // the user's selection (may be "system")
     resolvedTheme: Resolved // what is actually applied
     setTheme: (t: Theme) => void
   }

   const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

   function getSystemTheme(): Resolved {
     return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
   }

   function apply(resolved: Resolved) {
     const root = document.documentElement
     root.classList.toggle("dark", resolved === "dark")
     root.style.colorScheme = resolved
   }

   export function ThemeProvider({ children }: { children: ReactNode }) {
     const [theme, setThemeState] = useState<Theme>(
       () => (localStorage.getItem(STORAGE_KEY) as Theme) || "system",
     )
     const [systemTheme, setSystemTheme] = useState<Resolved>(getSystemTheme)

     // Always track the OS, so System mode can react live.
     useEffect(() => {
       const mq = window.matchMedia("(prefers-color-scheme: dark)")
       const onChange = () => setSystemTheme(mq.matches ? "dark" : "light")
       mq.addEventListener("change", onChange)
       return () => mq.removeEventListener("change", onChange)
     }, [])

     const resolvedTheme: Resolved = theme === "system" ? systemTheme : theme

     useEffect(() => {
       apply(resolvedTheme)
     }, [resolvedTheme])

     const setTheme = (t: Theme) => {
       setThemeState(t)
       // System = key absent, matching the no-flash script.
       if (t === "system") localStorage.removeItem(STORAGE_KEY)
       else localStorage.setItem(STORAGE_KEY, t)
     }

     return (
       <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
         {children}
       </ThemeContext.Provider>
     )
   }

   export function useTheme() {
     const ctx = useContext(ThemeContext)
     if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>")
     return ctx
   }
   ```

3. **Mount the provider** — wrap the app root in `src/main.tsx` with `<ThemeProvider>`.

4. **Toggle component** at `src/components/theme-toggle.tsx` — same 3-way `radiogroup` markup as Path A, but import `useTheme` from `../theme-provider` (no `mounted` guard needed — Vite is client-only). Use the project's icon lib, or text labels if none.

5. **Dark CSS** — ensure a `.dark { ... }` token block. Tailwind v4: add `@custom-variant dark (&:is(.dark *))`. Tailwind v3: `darkMode: "class"`. Plain CSS: use Path C's variable approach.

---

## Path C — Plain HTML / CSS (no framework)

1. **No-flash script** — first element in `<head>`, plus the meta tag (same script as Path B step 1).

2. **CSS variables** — tokens on `:root`, overridden under `.dark`:

   ```css
   :root {
     color-scheme: light dark;
     --bg: #ffffff;
     --fg: #111111;
     --muted: #f4f4f5;
     --border: #e4e4e7;
   }
   .dark {
     --bg: #0b0b0c;
     --fg: #f5f5f5;
     --muted: #1c1c1f;
     --border: #2a2a2e;
   }
   body { background: var(--bg); color: var(--fg); }
   ```

   (Starter palette — tell the user to refine the colors.)

3. **Toggle markup + logic** — a `radiogroup` with three buttons and a tiny script:

   ```html
   <div role="radiogroup" aria-label="Color theme" id="theme-toggle">
     <button type="button" role="radio" data-theme="light" aria-label="Light">☀</button>
     <button type="button" role="radio" data-theme="dark" aria-label="Dark">☾</button>
     <button type="button" role="radio" data-theme="system" aria-label="System">🖥</button>
   </div>

   <script>
     (function () {
       var KEY = "theme";
       var mq = window.matchMedia("(prefers-color-scheme: dark)");
       function current() { return localStorage.getItem(KEY) || "system"; }
       function resolved(sel) { return sel === "system" ? (mq.matches ? "dark" : "light") : sel; }
       function apply(sel) {
         var r = resolved(sel);
         document.documentElement.classList.toggle("dark", r === "dark");
         document.documentElement.style.colorScheme = r;
         document.querySelectorAll("#theme-toggle [role=radio]").forEach(function (b) {
           b.setAttribute("aria-checked", String(b.dataset.theme === sel));
         });
       }
       function set(sel) {
         if (sel === "system") localStorage.removeItem(KEY);
         else localStorage.setItem(KEY, sel);
         apply(sel);
       }
       document.querySelectorAll("#theme-toggle [role=radio]").forEach(function (b) {
         b.addEventListener("click", function () { set(b.dataset.theme); });
       });
       mq.addEventListener("change", function () { if (current() === "system") apply("system"); });
       apply(current());
     })();
   </script>
   ```

### Path C alternate — TTL-persisted, body-class toggle (Webflow / CMS reference pattern)

Reverse-engineered from a production Webflow site (wellscollins.com) with a well-regarded
toggle. Reach for this **instead of** the 3-way `radiogroup` above when:

- The site lives in a no-build CMS (Webflow, Squarespace, WordPress) where you're
  injecting a script via a "custom code" embed rather than authoring `index.html`
  directly — a single self-contained snippet is easier to paste into an embed block
  than a multi-file setup.
- The client wants a simple **2-way** Light/Dark switch, not a 3-way System option.
  "Follow the OS" is still the default behavior, just not a selectable third state.
- It's fine for an explicit override to **expire** rather than stick forever (see the
  tradeoff below) — true for most marketing/content sites, not for gated apps.

This is **not** a strict upgrade over the 3-way pattern above — it's a narrower, simpler
mechanism suited to sites where dark mode is a light UI touch, not a persistent setting
tied to an account. Don't reach for it on an authenticated app with a settings page;
sticky-forever (Path A/B/C's default) is correct there.

1. **Toggle mechanism** — a single class on `<body>` (the reference site used
   `black-theme`; `dark` reads more consistently with the rest of this skill) added or
   removed, not a `data-theme` attribute. All dark rules key off `body.dark { ... }` (or
   CSS variable overrides scoped under it) — same idea as `.dark` on `<html>` elsewhere
   in this skill, just one level lower in the DOM. Put it on `<html>` instead if the
   project's existing dark CSS already keys off `documentElement`; the toggle mechanic
   below is identical either way.

2. **TTL-wrapped `localStorage`** in place of a plain `getItem`/`setItem`:

   ```js
   function setItemWithExpiry(key, value, ttlMs) {
     const item = { value, expiry: Date.now() + ttlMs }
     localStorage.setItem(key, JSON.stringify(item))
   }

   function getItemWithExpiry(key) {
     const raw = localStorage.getItem(key)
     if (!raw) return null
     const item = JSON.parse(raw)
     if (Date.now() > item.expiry) {
       localStorage.removeItem(key)
       return null
     }
     return item.value
   }
   ```

   The reference site uses a 24-hour TTL. **This is a deliberate tradeoff, not a bug.**
   Once the TTL lapses, an explicit choice is forgotten and the toggle silently re-syncs
   to `prefers-color-scheme`. That's the right call when a visitor's theme intent can
   drift — they flipped to dark mode once, months later their OS preference has changed,
   and a stale override would otherwise fight it forever. It's the wrong call when "the
   user explicitly picked dark" should persist indefinitely regardless of later OS
   changes — pick the indefinite `setItem`/`getItem` (Path A/B/C's default) for apps with
   accounts or settings pages, and this TTL variant for marketing/content sites.

3. **Initial-state resolution order** — a TTL-valid stored preference wins; otherwise
   fall back to `window.matchMedia("(prefers-color-scheme: dark)").matches`. Still wire
   this as the **first thing in `<head>`** (Path C step 1's no-flash script, adapted to
   read the TTL-wrapped value and toggle `body` instead of `documentElement`) — the
   reference implementation's own snippet runs after the page starts rendering, which
   the contract's no-flash requirement (point 4 above) doesn't allow; don't drop that
   guard just because the source site did.

4. **Live OS-preference listener** — not just an initial read. Keep listening for OS
   theme changes for as long as the page is open, and only defer to them when there's no
   active (unexpired) override:

   ```js
   window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
     if (getItemWithExpiry("theme")) return // explicit user choice takes precedence
     document.body.classList.toggle("dark", !e.matches)
   })
   ```

   This is the same live-update requirement as contract point 3 above; the only
   difference is scope — because there's no separate "System" state to enter, *no
   active override* is what stands in for System mode.

5. **Toggle wiring** — a plain click handler, framework-agnostic (the reference site
   used jQuery since it's Webflow, but a vanilla listener works identically):

   ```js
   toggleEl.addEventListener("click", () => {
     document.body.classList.toggle("dark")
     const next = document.body.classList.contains("dark") ? "dark" : "light"
     setItemWithExpiry("theme", next, 24 * 60 * 60 * 1000)
   })
   ```

   Still give the toggle `role="radio"`/`aria-checked` (or at minimum a toggle-button
   `aria-pressed`) and a keyboard-reachable element — the reference site's raw
   click-only jQuery handler doesn't satisfy contract point 6 on its own.

   **UI reference (optional)**: the source toggle was a sliding pill with two SVG icons
   (sun/moon) in adjacent cells, position animated purely in CSS (`transform` +
   `transition`, no JS animation library) — worth reusing as a visual pattern if the ask
   includes "make it look like a nice sliding switch," independent of the JS above.

## Notes
- **System = key absent** is the linchpin. The no-flash `<script>` and the provider are two independent code paths that both decide the theme; pinning one rule (`theme` present → explicit, absent → follow OS) is what keeps them from disagreeing.
- The `mounted` guard is **Next-only** (Path A). The server can't know the user's stored theme, so rendering the active state on the server would mismatch hydration. Vite (Path B) is client-only — adding the guard there just causes a pointless flicker.
- Setting `color-scheme` (not just the `.dark` class) is what themes native scrollbars, form controls, and `<input>` widgets. A class-only toggle leaves those light.
- On a project with no dark styles at all, this wires the *mechanism* but can't invent your palette — it scaffolds starter tokens and flags them to refine.
- **TTL-persisted overrides (Path C alternate) are opt-in, not the default.** Default to the indefinite 3-way pattern (Path A/B/C) unless the site is a no-build CMS embed and the client explicitly wants a 2-way switch that forgets stale choices — see Path C's alternate section for the tradeoff.
- Related: `/setup-rebel-ui` already wires a `next-themes` provider for design-system projects (run it first, then this adds the toggle); `/scaffold` for new projects; `/verify-app` to confirm no-flash behavior in a browser.
