#!/usr/bin/env node
/* Sets up an output folder for a prototype run.

     node new.mjs <out dir> --config <config.json>

   Copies the hub, the prototype helpers (shared/kit.js, shared/proto.css) and the skill's vendored
   Theme Core kit (kit/), writes shared/theme.css for config.theme, and puts the config where
   check.mjs finds it. Refuses to touch a folder that already has files in it, so it can never
   overwrite a client's work.

   config.theme: a theme slug vendored in kit/ (see kit/themes.json; default "house"), or a path
   to a client <slug>.vars.css built and gated with rebel-theme resolve (copied into shared/). */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'template');
const KIT = path.join(HERE, '..', 'kit');
const DEFAULT_THEME = 'house';
const REQUIRED = ['client', 'title', 'slug', 'sources', 'tracks', 'rules', 'denyTerms'];

const argv = process.argv.slice(2);
const out = argv[0];
const at = argv.indexOf('--config');
if (!out || out.startsWith('--') || at === -1 || !argv[at + 1]) {
  console.error('usage: node new.mjs <out dir> --config <config.json>');
  process.exit(2);
}

const config = JSON.parse(readFileSync(argv[at + 1], 'utf8'));
const missing = REQUIRED.filter((k) => config[k] === undefined);
if (missing.length) {
  console.error(`The config is missing: ${missing.join(', ')}. See template/config.example.json.`);
  process.exit(2);
}
const kitThemes = Object.keys(JSON.parse(readFileSync(path.join(KIT, 'themes.json'), 'utf8')).themes);
const theme = config.theme || DEFAULT_THEME;
let themeFile = null;
if (theme.endsWith('.vars.css')) {
  themeFile = path.resolve(path.dirname(path.resolve(argv[at + 1])), theme);
  if (!existsSync(themeFile)) {
    console.error(`config.theme: ${themeFile} doesn't exist. Build it with rebel-theme resolve, or use one of: ${kitThemes.join(', ')}.`);
    process.exit(2);
  }
} else if (!kitThemes.includes(theme)) {
  console.error(`config.theme "${theme}" isn't vendored here. Use one of: ${kitThemes.join(', ')}, or a path to a client <slug>.vars.css.`);
  process.exit(2);
}
if (existsSync(out) && readdirSync(out).length) {
  console.error(`${out} already has files in it. Pick a new folder; this won't overwrite anything.`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
cpSync(path.join(TEMPLATE, 'shared'), path.join(out, 'shared'), { recursive: true });
cpSync(KIT, path.join(out, 'kit'), { recursive: true });
let themeHref = `../kit/themes/${theme}.vars.css`;
if (themeFile) {
  cpSync(themeFile, path.join(out, 'shared', path.basename(themeFile)));
  themeHref = path.basename(themeFile);
}
writeFileSync(path.join(out, 'shared', 'theme.css'), `/* The run's theme, written by new.mjs (config.theme: ${theme}). Every page and the hub load this
   file first, then ../kit/kit.css and proto.css. To change the look, point the import at another
   ../kit/themes/<slug>.vars.css, or at a client <slug>.vars.css (built and gated with
   rebel-theme resolve) next to this file. Nothing else goes here: no tokens, no colours. */
@import url("${themeHref}");
`);
cpSync(path.join(TEMPLATE, 'index.html'), path.join(out, 'index.html'));
writeFileSync(path.join(out, 'prototype-hub.config.json'), JSON.stringify(config, null, 2) + '\n');
writeFileSync(path.join(out, 'gate-result.js'), `/* Written by check.mjs. Don't edit: run the check again. */\nwindow.PROTO_GATE = null;\n`);
console.log(`Ready: ${path.resolve(out)}`);
