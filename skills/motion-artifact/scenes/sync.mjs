#!/usr/bin/env node
/* Extract the runtime + renderer code fences out of ../SKILL.md into real files
   next to the scenes, so a scene can `<script src="motion.js">` instead of
   carrying 400 inlined lines.

   SKILL.md is the source of truth (it has to be — claude.ai web users only ever
   get the Markdown). These files are generated from it.

     node sync.mjs           # write motion.js + render.mjs
     node sync.mjs --check   # exit 1 if they have drifted, write nothing

   Run --check after editing SKILL.md. Drift here is the exact trap CONTRIBUTING
   describes for docs/claude-ai-skill-reference.md, one directory over. */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, '..', 'SKILL.md');

const src = readFileSync(SKILL, 'utf8');
const blocks = [...src.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length < 2) {
  console.error('SKILL.md: expected at least 2 ```js fences (runtime, renderer)');
  process.exit(1);
}

const banner = (what) =>
  `/* GENERATED from ../SKILL.md — do not edit here.\n` +
  `   Edit the ${what} in SKILL.md, then run: node scenes/sync.mjs */\n`;

const targets = [
  ['motion.js', banner('Scene runtime') + blocks[0]],
  ['render.mjs', blocks[1].replace(/^#!.*\n/, (m) => m + banner('renderer'))]
];

const check = process.argv.includes('--check');
let drifted = 0;

for (const [name, content] of targets) {
  const path = join(HERE, name);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === content) continue;
  if (check) {
    console.error(`DRIFT: scenes/${name} does not match SKILL.md`);
    drifted++;
  } else {
    writeFileSync(path, content);
    console.log(`wrote scenes/${name}`);
  }
}

if (check) {
  if (drifted) { console.error('\nRun: node scenes/sync.mjs'); process.exit(1); }
  console.log('scenes/ matches SKILL.md');
}
