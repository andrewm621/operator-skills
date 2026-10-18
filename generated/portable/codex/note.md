Add a note to your personal knowledge base (second brain) — a local Markdown vault such as Obsidian, Tolaria, Logseq, or a plain folder. Reads the vault location from a per-user config outside the repo, follows the vault's own conventions, routes the note to the right folder, avoids duplicates, and never overwrites.

Task: $ARGUMENTS

## Config

The vault location lives in a per-user file **outside this repo**, so the skill itself carries no personal paths:

- Path: `$XDG_CONFIG_HOME/operator-skills/config.yaml` if `XDG_CONFIG_HOME` is set, else `~/.config/operator-skills/config.yaml`.
- Vault settings sit under a top-level `knowledge:` section. Other skills may add their own sections to the same file — read and write only `knowledge:`, and leave every other section untouched.
- The repo ships `config.example.yaml` as a starting point.

```yaml
knowledge:
  default: personal            # vault used when --vault is not given
  vaults:
    personal:
      path: ~/notes            # required; ~ is expanded
      inbox: 00-Inbox          # where new notes land unless routed (relative to path)
      conventions: AGENTS.md   # optional: vault file to read before writing (rules, frontmatter types)
      frontmatter:             # optional: defaults merged into every note
        type: Note
      commit: false            # true = git add + commit the note after writing (never push)
      routes:                  # optional: kind -> folder (relative to path)
        project: 01-Projects
        reference: 03-Resources
```

Only `path` is required. Missing `inbox` means the vault root. Multiple vaults are allowed.

## Steps

1. **Load config** — Read the config file above. Parse `--vault <name>` out of `$ARGUMENTS` (strip it from the text to capture); otherwise use `knowledge.default`; if there is no default and exactly one vault, use that one. If the named vault doesn't exist, list the configured vault names and stop.
   - **Config or `knowledge:` section missing** — do **not** guess a path. Show the example block above, ask the user for their vault's folder, and offer to create the config file with it. Confirm the exact file contents before writing. If the file already exists with other sections, add only a `knowledge:` section and preserve the rest. Then continue.
   - Expand `~`. If the vault `path` doesn't exist or isn't a directory, stop and say so — never create a vault directory.
2. **Validate input** — If the text to capture is empty, ask what to capture, or offer to summarize the current conversation into a note (show the draft and wait for a yes before saving). Never write an empty or placeholder note.
3. **Read vault conventions** — If `conventions` is set and the file exists in the vault, read it before writing and follow its rules for frontmatter fields, note types, wikilink style, and naming over the defaults in this skill. If it's set but missing, say so and continue with the defaults. If unset, still check the vault root for `AGENTS.md` or `CLAUDE.md` and use it if present. Don't touch properties the conventions mark as tool-managed (e.g. keys starting with `_`).
4. **Classify and route** — Pick one kind and honor an explicit prefix over your own judgment:

   | Kind | Prefix | Use for | Route key |
   |------|--------|---------|-----------|
   | note | `note:` (default) | General thought, idea, meeting takeaway, anything unclassified | — (inbox) |
   | reference | `ref:` | Durable facts, how-tos, links, snippets worth looking up later | `reference` |
   | project-update | `project:` | Status, decision, or progress on a named project | `project` |
   | quick | `quick:` | One-liner capture; keep it as short as the input | — (inbox) |

   Destination folder: `routes.<route key>` if that route is configured, else `inbox`, else the vault root. For `project:`, if the routed folder has a subfolder whose name matches the project mentioned, use that subfolder. Create the destination folder only if it is a configured route or inbox and its parent exists; never invent new top-level folders.
5. **Title and filename** — Derive a specific H1 title (not "Note" or "Untitled") and a kebab-case slug from it. Filename is `YYYY-MM-DD-<slug>.md` (today's date) in the inbox, and `<slug>.md` in any other folder. **Never overwrite**: if the target file exists, offer to append to it or to save under a new suffix (`-2`) — and wait for the answer.
6. **Dedupe** — Grep the vault (skip `.git`, attachments, and hidden folders) for 2–3 distinctive phrases from the note, and check filenames and H1s for the slug's keywords. If a close match exists, show it and offer to append to it as a new dated section instead of creating a new note. Skip this for `quick:` notes.
7. **Write the note** — Compose the file:
   - Frontmatter: the vault's `frontmatter` defaults, plus `created` (ISO 8601 timestamp, local time with offset) and `tags` (2–5 lowercase keywords). If `conventions` specify different field names or types, use those instead.
   - `# Title` H1, then the body in clean Markdown. Keep the user's meaning and voice; tighten, don't embellish. Never invent facts or add content they didn't give you.
   - `[[wikilinks]]` only to notes that actually exist — verify each target by filename or H1 in the vault first. Use the link style the conventions require. No links is fine.
   - When appending to an existing note, add a dated `##` section at the end and leave the rest of the file unchanged.
8. **Commit (optional)** — Only if `commit: true` **and** the vault is a git repo. Pass the message on stdin through a quoted heredoc, so a title containing quotes, backticks or `$` can't break the shell:
   ```bash
   git -C <vault> add -- <file>
   git -C <vault> commit -F - -- <file> <<'EOF'
   note: <title>
   EOF
   ```
   Scope strictly to that one file; never stage other changes, never push, never use `--no-verify`. If the vault isn't a git repo or the commit fails, report that and leave the file written.
9. **Report** — Print the full path of the note and a one-line summary (kind, vault, title, and whether it was new, appended, or committed).

## Notes

- This is the generic base for capturing to a markdown vault. For expanded idea capture or project-specific stores, you may have your own skills that build on or replace it.
- It writes into the vault only — one note per run, plus the config file when you approve creating it. It never edits other notes except to append when you choose that.
- Related skills: `/learn` is for engineering gotchas and lessons, `/log` for the daily work log, `/document` for dev-notes decisions and project docs, `/log wrap` for end-of-session snapshots, `/ai-export` to file exported AI chats into a vault.
- Vault-specific rules (required frontmatter, folder meaning, link style) belong in the vault's own conventions file, not in this skill — point `conventions` at it.
