#!/usr/bin/env node
/* Screenshots of one page at each device, for an agent to read.

     node shot.mjs <page.html> <out prefix> [desktop ipadL ipadP phone]

   Writes <out prefix>-<device>.png and prints each path. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './_cdp.mjs';
import { DEVICES } from './check.mjs';

const [target, prefix, ...which] = process.argv.slice(2);
if (!target || !prefix) {
  console.error('usage: node shot.mjs <page.html> <out prefix> [desktop ipadL ipadP phone]');
  process.exit(2);
}
mkdirSync(path.dirname(path.resolve(prefix)), { recursive: true });
const browser = await launch();
try {
  for (const key of which.length ? which : Object.keys(DEVICES)) {
    if (!DEVICES[key]) { console.error(`unknown device: ${key}`); continue; }
    const page = await browser.page(DEVICES[key]);
    await page.goto(pathToFileURL(path.resolve(target)).href);
    const file = `${prefix}-${key}.png`;
    await page.screenshot(file);
    console.log(file);
    await page.close();
  }
} finally {
  await browser.close();
}
