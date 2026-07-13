#!/usr/bin/env node
// verify-adapters.mjs
//
// Complements the manual "Verify before committing" checks in CONTRIBUTING.md
// (folder count, stale skill counts, /help mirror diff) with a check for the
// generated adapter outputs: regenerate the portable/claude-only ×
// Codex/Cursor tree plus AGENTS.md into a throwaway temp dir and diff it
// against the committed generated/ dir. Non-zero exit on any drift — the
// same discipline CONTRIBUTING.md already asks for on the other five
// surfaces. Walks the tree recursively, so it doesn't need to know about the
// generated/portable/ vs generated/claude-only/ split explicitly.
//
// Usage: node verify-adapters.mjs

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { generate, REPO_ROOT } from "./generate-adapters.mjs";

const COMMITTED_DIR = join(REPO_ROOT, "generated");

// Static, hand-written files that live alongside the generated output but
// aren't produced by generate-adapters.mjs — not part of the drift check.
const STATIC_FILES = new Set(["README.md"]);

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

function main() {
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

  if (drift.length > 0) {
    console.error(`✗ generated/ is out of sync with skills/*/SKILL.md (${drift.length} issue${drift.length === 1 ? "" : "s"}):\n`);
    for (const line of drift) console.error(`  - ${line}`);
    console.error(`\nRun: node ${relative(process.cwd(), join(REPO_ROOT, "generate-adapters.mjs"))} to regenerate, then re-verify.`);
    process.exit(1);
  }

  console.log("✓ generated/ matches skills/*/SKILL.md — no drift.");
}

main();
