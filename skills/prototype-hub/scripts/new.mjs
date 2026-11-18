#!/usr/bin/env node
/* Sets up an output folder for a prototype run.

     node new.mjs <out dir> --config <config.json>

   Copies the hub and the shared kit, and puts the config where check.mjs finds it. Refuses to
   touch a folder that already has files in it, so it can never overwrite a client's work. */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'template');
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
if (existsSync(out) && readdirSync(out).length) {
  console.error(`${out} already has files in it. Pick a new folder; this won't overwrite anything.`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
cpSync(path.join(TEMPLATE, 'shared'), path.join(out, 'shared'), { recursive: true });
cpSync(path.join(TEMPLATE, 'index.html'), path.join(out, 'index.html'));
writeFileSync(path.join(out, 'prototype-hub.config.json'), JSON.stringify(config, null, 2) + '\n');
writeFileSync(path.join(out, 'gate-result.js'), `/* Written by check.mjs. Don't edit: run the check again. */\nwindow.PROTO_GATE = null;\n`);
console.log(`Ready: ${path.resolve(out)}`);
