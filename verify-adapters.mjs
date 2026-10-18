#!/usr/bin/env node
// verify-adapters.mjs
//
// The repo's drift check (CONTRIBUTING.md: a skill lives on several surfaces and
// nothing errors when they diverge). Run it before every commit that touches
// skills/ or docs/; CI runs it on every push and PR. Non-zero exit on any drift.
// All counts are derived from the skills/ folder, never hardcoded.
//
// Checks:
//   1. generated/ (Codex, Cursor, AGENTS.md) matches a fresh regeneration from
//      skills/*/SKILL.md (regenerated into a temp dir and diffed).
//   2. docs/claude-ai-skill-reference.md mirrors every SKILL.md body verbatim,
//      one `## /name` section per skill, with no missing or orphan sections.
//   3. Skill-count claims ("N skills", "N custom skills", "all N operator skills")
//      in README.md and the three docs/ files equal the number of skills/*/ folders.
//   4. Every skill has a row in the README `## Skill Catalog` and in
//      docs/claude-ai-project-instructions.md `## Skill Catalog` (and no row
//      names a skill that doesn't exist).
//   5. The /help cheat-sheet block (from " SKILL CATALOG" through the
//      "Cross-project" line) is byte-identical in skills/help/SKILL.md and the
//      reference doc, its stated count equals the commands it lists, and every
//      listed command is a real skill.
//   6. The ~/.agents/skills install surface (Delta, Zed): every skills/<name>
//      must have a resolving <agents dir>/<name>/SKILL.md that lands inside this
//      repo. Override the dir with AGENTS_SKILLS_DIR (default ~/.agents/skills).
//      Fix with ./install-global.sh. Skipped with --skip-install or when CI is
//      truthy (set and not "0"/"false"), since a CI runner has no
//      home-directory install.
//
//   7. Portability guard: no shipped text file (skills/, docs/, README.md,
//      CONTRIBUTING.md, config.example.yaml, .claude/CLAUDE.md) may contain an
//      absolute home-directory path (/Users/<name>, -Users-<name> as in Claude
//      Code's project-slug dirs, or /home/<name>/...). Personal paths belong in
//      the per-user config (docs/config.md), not in shipped files. Bare
//      placeholders such as "/Users/..." or "/home/<name>/" are fine.
//
// Frontmatter `name` must equal the folder name; generate-adapters.mjs throws on
// a mismatch and this script reports it as a failure.
//
// Usage: node verify-adapters.mjs [--skip-install]

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { generate, loadSkills, REPO_ROOT } from "./generate-adapters.mjs";

const COMMITTED_DIR = join(REPO_ROOT, "generated");
const REFERENCE_PATH = "docs/claude-ai-skill-reference.md";

// Static, hand-written files that live alongside the generated output but
// aren't produced by generate-adapters.mjs — not part of the drift check.
const STATIC_FILES = new Set(["README.md"]);

// Files that state "N skills" somewhere; each claim must equal the folder count.
const COUNT_FILES = [
  "README.md",
  REFERENCE_PATH,
  "docs/claude-ai-project-instructions.md",
  "docs/cowork-setup-guide.md",
];

/** Recursively list all file paths under `dir`, relative to `dir`, sorted. */
function listFilesRecursive(dir) {
  let results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results = results.concat(listFilesRecursive(full).map((p) => join(entry, p)));
    } else {
      results.push(entry);
    }
  }
  return results.sort();
}

/** Read a repo-relative file as LF-normalized text. */
function readText(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
}

/** Return the lines of the `## <heading>` section (up to the next `## `), or null if absent. */
function sectionLines(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

/** Check 1: generated/ matches a fresh regeneration. Returns problem lines. */
function checkGenerated() {
  const tmpDir = mkdtempSync(join(tmpdir(), "operator-skills-verify-"));
  const drift = [];
  try {
    generate(tmpDir);

    const expected = new Set(listFilesRecursive(tmpDir));
    const actual = new Set(listFilesRecursive(COMMITTED_DIR).filter((p) => !STATIC_FILES.has(p)));

    for (const relPath of expected) {
      if (!actual.has(relPath)) {
        drift.push(`missing in generated/: ${relPath}`);
        continue;
      }
      const expectedContent = readFileSync(join(tmpDir, relPath), "utf8");
      const actualContent = readFileSync(join(COMMITTED_DIR, relPath), "utf8");
      if (expectedContent !== actualContent) {
        drift.push(`stale in generated/: ${relPath}`);
      }
    }

    for (const relPath of actual) {
      if (!expected.has(relPath)) {
        drift.push(`extra in generated/ (no longer produced by a skill): ${relPath}`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  if (drift.length > 0) drift.push("Run: node generate-adapters.mjs to regenerate, then re-verify.");
  return drift;
}

/**
 * Split the reference doc into name -> { body, line } by its `## /name` headings.
 * A heading only starts a section when the previous non-blank line is a `---`
 * separator (bodies contain their own `## ` headings and `---` rules). Each
 * body ends at the `---` that precedes the next section.
 */
function parseReference(text) {
  const lines = text.split("\n");
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## \/([a-z0-9-]+)\s*$/);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === "") j--;
    if (j >= 0 && lines[j].trim() === "---") starts.push({ name: m[1], line: i });
  }
  const sections = new Map();
  const duplicates = [];
  starts.forEach((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
    const chunk = lines.slice(s.line + 1, end);
    while (chunk.length && chunk[chunk.length - 1].trim() === "") chunk.pop();
    if (chunk.length && chunk[chunk.length - 1].trim() === "---") chunk.pop();
    if (sections.has(s.name)) duplicates.push(s.name);
    sections.set(s.name, { body: chunk.join("\n").trim(), line: s.line + 1 });
  });
  return { sections, duplicates };
}

/** Describe the first line where two texts differ. */
function firstDifference(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    if (al[i] !== bl[i]) return `first difference at body line ${i + 1}`;
  }
  return "bodies differ";
}

/** Check 2: reference doc mirrors every SKILL.md body. */
function checkMirror(skills) {
  const problems = [];
  const { sections, duplicates } = parseReference(readText(REFERENCE_PATH));
  for (const name of duplicates) problems.push(`${REFERENCE_PATH}: duplicate section ## /${name}`);
  const names = new Set(skills.map((s) => s.name));
  for (const skill of skills) {
    const section = sections.get(skill.name);
    if (!section) {
      problems.push(`${REFERENCE_PATH}: missing section ## /${skill.name}`);
      continue;
    }
    const expected = skill.body.trim();
    if (section.body !== expected) {
      problems.push(
        `${REFERENCE_PATH}: ## /${skill.name} (line ${section.line}) differs from skills/${skill.name}/SKILL.md — ${firstDifference(expected, section.body)}`,
      );
    }
  }
  for (const [name, section] of sections) {
    if (!names.has(name)) problems.push(`${REFERENCE_PATH}: orphan section ## /${name} (line ${section.line}) has no skills/${name}/`);
  }
  return problems;
}

/** Check 3: every "N skills" claim equals the skills/ folder count. */
function checkCounts(total) {
  const problems = [];
  for (const rel of COUNT_FILES) {
    let claims = 0;
    readText(rel)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(/\b(\d+)\s+(?:custom\s+|operator\s+)?skills\b/gi)) {
          claims++;
          if (Number(m[1]) !== total) problems.push(`${rel}:${i + 1}: says "${m[0]}" but skills/ has ${total}`);
        }
      });
    if (claims === 0) problems.push(`${rel}: no skill-count claim found (expected "N skills"); update the checker if the wording changed`);
  }
  return problems;
}

/** Check 4: every skill appears in a doc's `## Skill Catalog` table. */
function checkCatalog(rel, skills) {
  const section = sectionLines(readText(rel), "Skill Catalog");
  if (!section) return [`${rel}: no "## Skill Catalog" section`];
  const problems = [];
  const listed = new Set();
  for (const line of section) {
    const row = line.match(/^\|\s*`\/([a-z0-9-]+)`\s*\|/);
    if (row) listed.add(row[1]);
  }
  const names = new Set(skills.map((s) => s.name));
  for (const skill of skills) {
    if (!listed.has(skill.name)) problems.push(`${rel}: skill catalog is missing /${skill.name}`);
  }
  for (const name of listed) {
    if (!names.has(name)) problems.push(`${rel}: skill catalog lists /${name} but skills/${name}/ does not exist`);
  }
  return problems;
}

/**
 * Extract the /help cheat-sheet block: from the " SKILL CATALOG" line through the
 * "Cross-project" line (the awk range CONTRIBUTING.md used to describe).
 */
function extractCheatSheet(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(" SKILL CATALOG"));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i >= start && l.includes("Cross-project"));
  if (end === -1) return null;
  return lines.slice(start, end + 1);
}

/** Check 5: /help cheat sheet is mirrored, self-consistent, and names real skills. */
function checkHelp(skills) {
  const problems = [];
  const skillBlock = extractCheatSheet(readText("skills/help/SKILL.md"));
  const refBlock = extractCheatSheet(readText(REFERENCE_PATH));
  if (!skillBlock) problems.push('skills/help/SKILL.md: no cheat sheet found (" SKILL CATALOG" … "Cross-project")');
  if (!refBlock) problems.push(`${REFERENCE_PATH}: no /help cheat sheet found (" SKILL CATALOG" … "Cross-project")`);
  if (!skillBlock) return problems;

  if (refBlock && skillBlock.join("\n") !== refBlock.join("\n")) {
    const n = Math.max(skillBlock.length, refBlock.length);
    let at = 0;
    for (let i = 0; i < n; i++) {
      if (skillBlock[i] !== refBlock[i]) {
        at = i;
        break;
      }
    }
    problems.push(`/help cheat sheet differs between skills/help/SKILL.md and ${REFERENCE_PATH} (first difference at block line ${at + 1})`);
  }

  const stated = skillBlock[0].match(/SKILL CATALOG\s+(\d+)/);
  const combos = skillBlock.findIndex((l) => l.includes("QUICK COMBOS"));
  const listed = [];
  const external = new Set(); // @REBEL/UI commands ship with the design system, not in skills/
  let section = "";
  for (const line of skillBlock.slice(0, combos === -1 ? skillBlock.length : combos)) {
    if (/^ [A-Z@][A-Z0-9 &@/.-]+(\s+\(.*\))?$/.test(line)) section = line.trim();
    const m = line.match(/^ \/([a-z0-9-]+)/);
    if (!m) continue;
    listed.push(m[1]);
    if (section.startsWith("@REBEL/UI")) external.add(m[1]);
  }
  if (!stated) {
    problems.push('skills/help/SKILL.md: cheat sheet header has no count (expected " SKILL CATALOG  N custom commands")');
  } else if (Number(stated[1]) !== listed.length) {
    problems.push(`skills/help/SKILL.md: cheat sheet says ${stated[1]} commands but lists ${listed.length}`);
  }
  const names = new Set(skills.map((s) => s.name));
  const seen = new Set();
  for (const name of listed) {
    if (!names.has(name) && !external.has(name)) problems.push(`skills/help/SKILL.md: cheat sheet lists /${name} but skills/${name}/ does not exist`);
    if (seen.has(name)) problems.push(`skills/help/SKILL.md: cheat sheet lists /${name} more than once`);
    seen.add(name);
  }
  return problems;
}

/** Check 6: ~/.agents/skills/<name>/SKILL.md resolves into this repo for every skill. */
function checkAgentsSkills() {
  const agentsDir = process.env.AGENTS_SKILLS_DIR || join(homedir(), ".agents", "skills");
  const repoSkills = realpathSync(join(REPO_ROOT, "skills"));
  const problems = [];
  const names = readdirSync(join(REPO_ROOT, "skills"))
    .filter((n) => existsSync(join(REPO_ROOT, "skills", n, "SKILL.md")))
    .sort();
  for (const name of names) {
    let resolved;
    try {
      resolved = realpathSync(join(agentsDir, name, "SKILL.md"));
    } catch {
      problems.push(`missing in ${agentsDir}: ${name}`);
      continue;
    }
    if (!resolved.startsWith(repoSkills + sep)) {
      problems.push(`foreign in ${agentsDir}: ${name} -> ${resolved}`);
    }
  }
  if (problems.length > 0) problems.push("Run: ./install-global.sh to link them, then re-verify.");
  return { agentsDir, total: names.length, problems };
}

// Files outside skills/ and docs/ that ship with the repo and are scanned for home paths too.
const PORTABILITY_EXTRA_FILES = ["README.md", "CONTRIBUTING.md", "config.example.yaml", ".claude/CLAUDE.md"];

/** Check 7: no absolute home-directory paths in shipped text (skills/, docs/, top-level docs). */
function checkPortability() {
  const problems = [];
  // A placeholder like "/Users/..." or "/home/<name>/" is documentation, not a leak:
  // the first character after the prefix must be a real name character.
  const patterns = [
    { label: "/Users/ path", re: /\/Users\/[A-Za-z0-9_][^\s`"')]*/ },
    { label: "-Users- project-slug path", re: /-Users-[A-Za-z0-9_][A-Za-z0-9_.-]*/ },
    { label: "/home/<name> path", re: /\/home\/[a-z_][a-z0-9_-]*\/[^\s`"')]*/ },
  ];
  const targets = [];
  for (const dir of ["skills", "docs"]) {
    for (const rel of listFilesRecursive(join(REPO_ROOT, dir))) targets.push(join(dir, rel));
  }
  for (const rel of PORTABILITY_EXTRA_FILES) if (existsSync(join(REPO_ROOT, rel))) targets.push(rel);
  for (const rel of targets) {
    if (rel.split(sep).some((part) => part === "__pycache__" || part === "node_modules")) continue;
    const buf = readFileSync(join(REPO_ROOT, rel));
    if (buf.includes(0)) continue; // binary (e.g. .pyc) — not text
    buf
      .toString("utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .forEach((line, i) => {
        for (const { label, re } of patterns) {
          const m = line.match(re);
          if (m) problems.push(`${rel}:${i + 1}: ${label} "${m[0]}" — read it from the per-user config instead (docs/config.md)`);
        }
      });
  }
  return problems;
}

function main() {
  // CI is "truthy" when set to anything but empty/"0"/"false" (so CI=0 / CI=false still run the install check).
  const ciTruthy = !["", "0", "false"].includes((process.env.CI ?? "").trim().toLowerCase());
  const skipInstall = process.argv.includes("--skip-install") || ciTruthy;
  let failed = false;

  /** Print one check's result; `problems` is a list of lines, empty = pass. */
  function report(title, okMessage, problems) {
    if (problems.length === 0) {
      console.log(`✓ ${okMessage}`);
      return;
    }
    failed = true;
    console.error(`✗ ${title}:\n`);
    for (const line of problems) console.error(`  - ${line}`);
    console.error("");
  }

  let skills;
  try {
    skills = loadSkills();
  } catch (err) {
    // Includes frontmatter `name` != folder, thrown by generate-adapters.mjs.
    console.error(`✗ cannot load skills/: ${err.message}`);
    process.exit(1);
  }
  const total = skills.length;

  report("generated/ is out of sync with skills/*/SKILL.md", "generated/ matches skills/*/SKILL.md — no drift.", checkGenerated());
  report(`${REFERENCE_PATH} does not mirror skills/*/SKILL.md`, `${REFERENCE_PATH} mirrors all ${total} skill bodies.`, checkMirror(skills));
  report(`skill counts do not match the ${total} folders in skills/`, `skill-count claims match skills/ (${total}) in ${COUNT_FILES.length} files.`, checkCounts(total));
  report(
    "skill catalogs are out of sync with skills/",
    "README.md and docs/claude-ai-project-instructions.md catalogs list every skill.",
    [...checkCatalog("README.md", skills), ...checkCatalog("docs/claude-ai-project-instructions.md", skills)],
  );
  report("/help cheat sheet is inconsistent", "/help cheat sheet matches its mirror and its stated count.", checkHelp(skills));
  report("shipped files contain hardcoded personal paths", "skills/, docs/ and top-level docs have no absolute home-directory paths.", checkPortability());

  if (skipInstall) {
    console.log("- skipped ~/.agents/skills install check (--skip-install or CI).");
  } else {
    const agents = checkAgentsSkills();
    report(`${agents.agentsDir} is out of sync with skills/`, `${agents.agentsDir} links all ${agents.total} skills into this repo.`, agents.problems);
  }

  if (failed) process.exit(1);
}

main();
