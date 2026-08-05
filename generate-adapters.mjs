#!/usr/bin/env node
// generate-adapters.mjs
//
// Reads the canonical skills/<name>/SKILL.md sources and transpiles them into
// native command formats for other agent CLIs, plus one passive digest doc.
// Zero deps — the frontmatter parse below is hand-rolled on purpose (see
// CONTRIBUTING.md: "flat, no build step, no dependencies").
//
// Every skill is classified as either "portable" (works in any agent) or
// "claude-only" (hard-depends on Claude Code/claude.ai-specific tooling —
// Agent/Task/Workflow tools, named subagent_types, mcp__claude_ai_*/
// mcp__chrome-devtools__* MCP tools, or the Dia Browser + agent-browser + CDP
// setup). See CLAUDE_ONLY below for the source of truth on that split.
//
// Outputs (relative to repo root):
//   generated/portable/codex/<name>.md      — Codex CLI prompt, portable skills
//   generated/portable/cursor/<name>.md     — Cursor command, portable skills
//   generated/claude-only/codex/<name>.md   — Codex CLI prompt, Claude-only skills
//   generated/claude-only/cursor/<name>.md  — Cursor command, Claude-only skills
//   generated/AGENTS.md                     — one passive digest of every skill,
//                                              split portable vs Claude-only,
//                                              grouped by README category within each
//
// Usage:
//   node generate-adapters.mjs                 # write into ./generated
//   node generate-adapters.mjs --out <dir>      # write into an arbitrary dir (used by verify-adapters.mjs)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = __dirname;
const SKILLS_DIR = join(REPO_ROOT, "skills");
const README_PATH = join(REPO_ROOT, "README.md");

const CURSOR_ARG_PLACEHOLDER = "{the text you type after the command}";

/**
 * Curated source of truth for which skills hard-depend on Claude Code/
 * claude.ai-specific tooling (Agent/Task/Workflow tools, named
 * subagent_types, mcp__claude_ai_* / mcp__chrome-devtools__* MCP tool names, or
 * the Dia Browser + agent-browser + CDP setup). A curated list is more
 * reliable than a fragile regex — but see CLAUDE_TOKEN_PATTERNS below for a
 * safety net that warns (never fails) when this list and the skill body
 * disagree, so the classification can't silently rot as skills change.
 *
 * Everything not in this set is "portable" — it ports as-is to Codex,
 * Cursor, and any other AGENTS.md-aware agent.
 */
const CLAUDE_ONLY = new Set([
  "orchestrate",
  "subagent",
  "parallel",
  "parallel-check",
  "research",
  "map",
  "invert",
  "roadmap",
  "scaffold",
  "freeze",
  "perf",
  "verify-app",
  "port-check",
  "notion",
  "notion-ctx",
  "slack-reply",
  "slack-ctx",
]);

/**
 * Tell-tale tokens that indicate a skill body hard-depends on Claude Code/
 * claude.ai-specific primitives. Used only as a warning safety net against
 * CLAUDE_ONLY drift — never to decide the actual bucket a skill lands in.
 */
const CLAUDE_TOKEN_PATTERNS = [
  { label: "AskUserQuestion", re: /AskUserQuestion/ },
  { label: "subagent_type", re: /subagent_type/ },
  { label: "mcp__claude_ai_", re: /mcp__claude_ai_/ },
  { label: "mcp__chrome-devtools__", re: /mcp__chrome-devtools__/ },
  { label: "Workflow tool", re: /Workflow tool/ },
  { label: "agent-browser", re: /agent-browser/ },
  { label: "Dia Browser", re: /Dia Browser/ },
  { label: "Explore agent", re: /\bExplore\b/ },
  { label: "general-purpose agent", re: /general-purpose/ },
  { label: "Task tool", re: /Task tool/ },
];

/** Which CLAUDE_TOKEN_PATTERNS labels appear in a skill body, if any. */
function scanClaudeOnlyTokens(body) {
  return CLAUDE_TOKEN_PATTERNS.filter((p) => p.re.test(body)).map((p) => p.label);
}

/**
 * Warn (stderr only, never throws) when CLAUDE_ONLY and the token scan
 * disagree about a skill, so a classification that's gone stale gets noticed
 * instead of silently rotting.
 */
function checkClassification(skill) {
  const tokens = scanClaudeOnlyTokens(skill.body);
  const curated = CLAUDE_ONLY.has(skill.name);

  if (tokens.length > 0 && !curated) {
    console.warn(
      `⚠ ${skill.name}: contains Claude-only token(s) [${tokens.join(", ")}] but is classified "portable" — verify CLAUDE_ONLY in generate-adapters.mjs`,
    );
  } else if (tokens.length === 0 && curated) {
    console.warn(
      `⚠ ${skill.name}: classified "claude-only" but its body shows none of the tell-tale tokens — verify CLAUDE_ONLY in generate-adapters.mjs`,
    );
  }
}

/**
 * Hand-rolled frontmatter parser scoped to this repo's exact SKILL.md shape:
 *
 *   ---
 *   name: my-skill
 *   description: >
 *     folded, possibly multi-line, block scalar
 *   argument-hint: "<...>"
 *   ---
 *   body...
 *
 * Not a general YAML parser — deliberately only handles what SKILL.md uses
 * (bare scalars, quoted scalars, and `>` folded blocks).
 */
function parseSkillFile(raw) {
  const lines = raw.split("\n");
  if (lines[0].trim() !== "---") {
    throw new Error("missing opening frontmatter fence (---)");
  }
  let fenceEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd === -1) {
    throw new Error("missing closing frontmatter fence (---)");
  }

  const fmLines = lines.slice(1, fenceEnd);
  const meta = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();

    if (value === ">") {
      // Folded block scalar: gather following indented, non-blank lines and
      // join with spaces (YAML "folded" behavior for a single paragraph).
      const parts = [];
      let j = i + 1;
      while (j < fmLines.length && /^\s+\S/.test(fmLines[j])) {
        parts.push(fmLines[j].trim());
        j++;
      }
      value = parts.join(" ");
      i = j - 1;
    } else {
      value = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
    meta[key] = value;
  }

  const body = lines
    .slice(fenceEnd + 1)
    .join("\n")
    .replace(/^\n+/, ""); // drop leading blank lines right after the fence

  return { meta, body };
}

/** Read every skills/<name>/SKILL.md, sorted by folder name for stable output. */
function loadSkills() {
  const folders = readdirSync(SKILLS_DIR)
    .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
    .sort();

  return folders.map((folder) => {
    const path = join(SKILLS_DIR, folder, "SKILL.md");
    const raw = readFileSync(path, "utf8");
    const { meta, body } = parseSkillFile(raw);
    if (!meta.name) {
      throw new Error(`${path}: missing "name" in frontmatter`);
    }
    if (meta.name !== folder) {
      throw new Error(`${path}: name "${meta.name}" does not match folder "${folder}"`);
    }
    const skill = {
      name: meta.name,
      description: meta.description || "",
      argumentHint: meta.argumentHint || meta["argument-hint"] || "",
      body: body.replace(/\s+$/, "") + "\n", // trim trailing whitespace, single trailing newline
    };
    skill.bucket = CLAUDE_ONLY.has(skill.name) ? "claude-only" : "portable";
    return skill;
  });
}

/** Ensure a trailing newline and normalize CRLF-free, single-trailing-newline output. */
function withTrailingNewline(text) {
  return text.replace(/\s+$/, "") + "\n";
}

function buildCodexFile(skill) {
  // Codex CLI prompts are the markdown body verbatim — no frontmatter, no
  // rewriting. Codex supports $ARGUMENTS and $1..$9 the same as Claude Code.
  return withTrailingNewline(skill.body);
}

function buildCursorFile(skill) {
  // Cursor commands have no argument-substitution token, so swap $ARGUMENTS
  // for a readable inline placeholder, and make sure the file has a heading
  // since Cursor's command list is driven by the file, not YAML frontmatter.
  let body = skill.body.replaceAll("$ARGUMENTS", CURSOR_ARG_PLACEHOLDER);
  const firstNonBlankLine = body.split("\n").find((l) => l.trim() !== "") || "";
  if (!firstNonBlankLine.trim().startsWith("#")) {
    body = `# ${skill.name}\n\n${body}`;
  }
  return withTrailingNewline(body);
}

/**
 * Parse the "## Skill Catalog" section of README.md into
 * { category -> [skillName, ...] } so the AGENTS.md digest can reuse the
 * same grouping. Falls back to null if the section can't be found/parsed —
 * callers should fall back to alphabetical grouping in that case.
 */
function parseReadmeCategories() {
  let readme;
  try {
    readme = readFileSync(README_PATH, "utf8");
  } catch {
    return null;
  }

  const lines = readme.split("\n");
  const catalogStart = lines.findIndex((l) => l.trim() === "## Skill Catalog");
  if (catalogStart === -1) return null;

  let catalogEnd = lines.length;
  for (let i = catalogStart + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      catalogEnd = i;
      break;
    }
  }

  const section = lines.slice(catalogStart + 1, catalogEnd);
  const categories = new Map(); // category -> [names]
  let currentCategory = null;

  for (const line of section) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      currentCategory = h3[1].trim();
      categories.set(currentCategory, []);
      continue;
    }
    if (!currentCategory) continue;
    // Table row: | `/name` | description | example |
    const row = line.match(/^\|\s*`\/([a-z0-9-]+)`\s*\|/);
    if (row) {
      categories.get(currentCategory).push(row[1]);
    }
  }

  if (categories.size === 0) return null;
  return categories;
}

/** Group skills by README category; skills absent from the README fall into "Other". */
function groupSkillsByCategory(skills) {
  const categories = parseReadmeCategories();
  const byName = new Map(skills.map((s) => [s.name, s]));
  const grouped = new Map(); // category -> [skill,...]
  const seen = new Set();

  if (categories) {
    for (const [category, names] of categories) {
      const list = [];
      for (const name of names) {
        const skill = byName.get(name);
        if (skill && !seen.has(name)) {
          list.push(skill);
          seen.add(name);
        }
      }
      if (list.length > 0) grouped.set(category, list);
    }
  }

  const leftover = skills.filter((s) => !seen.has(s.name));
  if (leftover.length > 0) {
    grouped.set(categories ? "Other" : "All Skills", [...leftover].sort((a, b) => a.name.localeCompare(b.name)));
  }

  return grouped;
}

/**
 * One-line description for the passive digest: collapse whitespace and swap
 * any literal $ARGUMENTS (a couple of descriptions echo it) for the same
 * readable placeholder used in the Cursor output — this doc has no
 * substitution context either.
 */
function oneLineDescription(description) {
  return description.replace(/\s+/g, " ").trim().replaceAll("$ARGUMENTS", CURSOR_ARG_PLACEHOLDER);
}

/** Render one bucket's categories as "### Category" + skill bullet list sections. */
function buildCategorySections(skills) {
  const grouped = groupSkillsByCategory(skills);
  const sections = [];
  for (const [category, list] of grouped) {
    const rows = list
      .map((skill) => `- **/${skill.name}** — ${oneLineDescription(skill.description)}`)
      .join("\n");
    sections.push(`### ${category}\n\n${rows}`);
  }
  return sections.join("\n\n");
}

function buildAgentsDigest(skills) {
  const portable = skills.filter((s) => s.bucket === "portable");
  const claudeOnly = skills.filter((s) => s.bucket === "claude-only");

  const header = `# AGENTS.md

Passive skill digest for **Codex, Cursor, and other AGENTS.md-aware coding
agents.** This is a reference doc, not an installable command set — Codex CLI
and Cursor pick up runnable commands from \`generated/portable/codex/\` (or
\`generated/claude-only/codex/\`) and \`generated/portable/cursor/\` (or
\`generated/claude-only/cursor/\`) respectively (see \`generated/README.md\`).
This file just tells an agent what capabilities exist, in one place, so it can
decide when to reach for one.

These are Andrew Miller's operator skills: real working prompts for running
50+ software projects (Next.js, Vite, Cloudflare Workers, Turborepo), not
demos. Source of truth is \`skills/<name>/SKILL.md\` in this repo — this file is
generated from there; edit the source, then regenerate (see
\`generated/README.md\`).

Skills below are split into two sections by how portable they are. See
\`generate-adapters.mjs\` (\`CLAUDE_ONLY\`) for the exact classification.
`;

  const portableSection = `## Portable (any agent)

These skills have no dependency on Claude Code or claude.ai-specific tooling
— the instruction text works as-is in Codex, Cursor, or any other agent that
reads this file.

${buildCategorySections(portable)}`;

  const claudeOnlySection = `## Claude Code-specific (needs Anthropic tooling/MCP)

These skills describe Claude Code tools (Agent/Task/Workflow, named
subagent_types), \`mcp__claude_ai_*\`/\`mcp__chrome-devtools__*\` MCP tools, or
the Dia Browser + \`agent-browser\` + CDP setup. The *instruction text* ports
to any agent that reads this file, but the skill only actually *works* where
that underlying Claude-specific tooling or MCP server is also present.

${buildCategorySections(claudeOnly)}`;

  return withTrailingNewline(`${header}\n${portableSection}\n\n${claudeOnlySection}\n`);
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function generate(outDir) {
  const skills = loadSkills();
  const written = [];

  for (const skill of skills) {
    checkClassification(skill);
    const codexPath = join(outDir, skill.bucket, "codex", `${skill.name}.md`);
    const cursorPath = join(outDir, skill.bucket, "cursor", `${skill.name}.md`);
    writeFile(codexPath, buildCodexFile(skill));
    writeFile(cursorPath, buildCursorFile(skill));
    written.push(codexPath, cursorPath);
  }

  const agentsPath = join(outDir, "AGENTS.md");
  writeFile(agentsPath, buildAgentsDigest(skills));
  written.push(agentsPath);

  return { skills, written };
}

function main() {
  const args = process.argv.slice(2);
  const outFlagIndex = args.indexOf("--out");
  const outDir = outFlagIndex !== -1 && args[outFlagIndex + 1] ? args[outFlagIndex + 1] : join(REPO_ROOT, "generated");

  const { skills, written } = generate(outDir);
  const portableCount = skills.filter((s) => s.bucket === "portable").length;
  const claudeOnlyCount = skills.filter((s) => s.bucket === "claude-only").length;
  console.log(
    `Generated ${written.length} files from ${skills.length} skills (${portableCount} portable, ${claudeOnlyCount} claude-only) into ${outDir}`,
  );
}

// Only run main() when invoked directly (so verify-adapters.mjs can import
// `generate` without triggering a second write pass).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { generate, loadSkills, REPO_ROOT };
