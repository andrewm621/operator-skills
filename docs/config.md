# Per-user config

Skills that need to know something about *your* setup read it from one file outside the repo, so nothing personal is ever committed and a fresh install works with sensible defaults.

- **Location:** `~/.config/operator-skills/config.yaml`, or `$XDG_CONFIG_HOME/operator-skills/config.yaml` if `XDG_CONFIG_HOME` is set.
- **Starting point:** copy [`config.example.yaml`](../config.example.yaml) and edit the paths.
- **Every key is optional.** A skill falls back to the default listed below when a key, a section, or the whole file is missing.
- **Skills read only the sections they need** and never rewrite sections that aren't theirs. (`/note` is the only skill that offers to *create* the file, and only its own `knowledge:` section.)

```bash
mkdir -p ~/.config/operator-skills
cp ~/operator-skills/config.example.yaml ~/.config/operator-skills/config.yaml
```

## Keys

### `owner`

Who you are — used where a skill drafts in your voice or assigns work to you.

| Key | Default | Meaning | Read by |
|-----|---------|---------|---------|
| `owner.handle` | `$USER` | Handle used as task/board assignee | `/maestro` |
| `owner.voice_guide` | none — drafts use a plain neutral voice | Path to your writing-style guide | `/slack-reply` |

### `paths`

Where things live. `~` is expanded.

| Key | Default | Meaning | Read by |
|-----|---------|---------|---------|
| `paths.projects` | `~/Projects` | Workspace root that holds your projects (one subfolder per project) | `/switch`, `/search-all`, `/deps`, `/scaffold`, `/map`, `/roadmap`, `/parallel`, `/subagent`, `/research`, `/port-check`, `/ai-export`, `/maestro`, `/test-desktop-app` |
| `paths.notes` | `~/.claude/dev-notes` | Dev-notes root. Skills create these subfolders on first use: `decisions/`, `learnings/`, `sessions/`, `freezes/`, `roadmaps/`, plus `INDEX.md` | `/log`, `/learn`, `/document`, `/freeze`, `/roadmap`, `/phases`, `/todo`, `/parallel`, `/invert`, `/pre-mortem` |
| `paths.memory` | none | Workspace memory directory (for example Claude Code auto-memory). **When unset, steps that write memory are skipped.** | `/map`, `/log`, `/document`, `/email-triage` |

`/roadmap`, `/todo` and `/phases` share one data directory, `<notes>/roadmaps/` (`INDEX.md`, one `<slug>/roadmap.md` per roadmap, and `standalone/` for freestanding todo lists), so they always see each other's data.

### `browser`

How browser-driving skills reach a browser.

| Key | Default | Meaning | Read by |
|-----|---------|---------|---------|
| `browser.mode` | `headless` | `headless`: `agent-browser` launches its own isolated browser. `cdp`: attach to your running browser over the DevTools Protocol | `/verify-app`, `/perf` |
| `browser.cdp_port` | `9222` | DevTools Protocol port, used when `mode: cdp` | `/verify-app`, `/perf`, `/port-check` |
| `browser.launch_cmd` | none | Command that starts your CDP browser | `/verify-app`, `/perf` |
| `browser.agent_browser_config` | none | `agent-browser --config` file to use in `cdp` mode | `/verify-app`, `/perf` |

### `knowledge`

Your knowledge base: a local Markdown vault (Obsidian, Tolaria, Logseq, or a plain folder). Read by `/note` and `/ai-export`; `/email-triage` and `/slack-ctx` / `/slack-reply` also use the default vault to locate their output folders.

| Key | Default | Meaning |
|-----|---------|---------|
| `knowledge.default` | the only vault, if exactly one | Vault used when `--vault` isn't given |
| `knowledge.vaults.<name>.path` | **required** | The vault's root folder |
| `knowledge.vaults.<name>.inbox` | the vault root | Where new notes land unless routed (relative to `path`) |
| `knowledge.vaults.<name>.conventions` | `AGENTS.md` / `CLAUDE.md` at the vault root, if present | Vault file to read before writing (rules, frontmatter types) |
| `knowledge.vaults.<name>.frontmatter` | none | Defaults merged into every note |
| `knowledge.vaults.<name>.commit` | `false` | `true`: `git add` + `git commit` the note after writing (never pushes) |
| `knowledge.vaults.<name>.routes` | none | Map of note kind to folder (relative to `path`) |

### `email_triage`

Read by `/email-triage`.

| Key | Default | Meaning |
|-----|---------|---------|
| `email_triage.context` | `[<paths.memory>/MEMORY.md]` if `paths.memory` is set, else none | Files listing your clients/contacts, used to judge context |
| `email_triage.report_dir` | the default vault's inbox, else the current directory | Where the triage report is written |
| `email_triage.known_noise` | `[]` | Senders/domains to always treat as noise |
| `email_triage.always_surface` | `[]` | Senders/domains to always surface |

### `slack`

Read by `/slack-ctx` and `/slack-reply`.

| Key | Default | Meaning |
|-----|---------|---------|
| `slack.registry` | `~/.config/operator-skills/slack/registry.yaml` | The local Slack directory (people, channels, threads) |
| `slack.mirror_dir` | the default vault's `routes.reference` folder, else the vault root; no vault → skipped | Where the directory mirror and reply log are written |

### `ai_export`

Read by `/ai-export`.

| Key | Default | Meaning |
|-----|---------|---------|
| `ai_export.downloads` | `$AI_EXPORT_DOWNLOADS`, else ask | Where raw JSON exports are saved |
| `ai_export.archive` | `$AI_EXPORT_ARCHIVE`, else ask | Where converted archives are kept |

### Environment overrides

`/maestro`'s CLI also honors `MAESTRO_HANDLE` (overrides `owner.handle`) and `MAESTRO_PROJECTS` (overrides `paths.projects`).

**Upgrading:** maestro's human handle used to be hardcoded; set `owner.handle` to your previous handle (or export `MAESTRO_HANDLE`) so existing `@`-asks still reach you. Handle matching is case-insensitive.

## No config file

Everything still works; skills use the defaults:

| Without config | What happens |
|----------------|--------------|
| `paths.projects` | `~/Projects` is used. If it doesn't exist, the skill says so and asks for the folder instead of guessing another path. |
| `paths.notes` | `~/.claude/dev-notes` is used and created on first write. |
| `paths.memory` | Memory-writing steps are skipped. Nothing is written outside `paths.notes` or the project itself. |
| `owner.*` | `/maestro` assigns work to `$USER`; `/slack-reply` drafts in a plain neutral voice. |
| `browser.*` | Headless `agent-browser`; no browser of yours is touched. |
| `knowledge.*` | `/note` does **not** guess a vault path. It shows the example block, asks for your vault's folder, and offers to create the config file after you confirm its contents. |

A skill never invents a path that isn't in the config or in this table of defaults.

## Adding a key (contributors)

Skills must not hardcode personal paths, names, or machine setups. If a new skill needs a location or preference:

1. Reuse an existing key above if it fits. Don't add top-level sections without strong reason.
2. Otherwise add the key to [`config.example.yaml`](../config.example.yaml) with a default and a one-line comment, and document it in this file (default, meaning, which skills read it).
3. In the skill, add one **Config** line near the top and refer to a placeholder (`<notes>`, `<projects>`) in paths and snippets:

   > **Config:** `paths.notes` from `~/.config/operator-skills/config.yaml` (default `~/.claude/dev-notes`) — see `docs/config.md`.

`node verify-adapters.mjs` fails if any shipped text file (`skills/`, `docs/`, `README.md`, `config.example.yaml`, `.claude/CLAUDE.md`) contains an absolute home-directory path (`/Users/<name>`, `-Users-<name>`, `/home/<name>/...`).
