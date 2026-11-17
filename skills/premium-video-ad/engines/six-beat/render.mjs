// Usage:
//   node render.mjs frames <config> <out-dir> t1 t2 ...      -> JPEG stills at those seconds
//   node render.mjs video  <config> <out.mp4> [sceneId ...]  -> per-scene MP4s, then concat (all scenes)
//   append :v to the config (example:v) for the 1080x1920 vertical layout
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const FPS = 30;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2', '.css': 'text/css' };

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rsp);
    }).listen(0, () => res(srv));
  });
}

const [mode, cfgArg, out, ...rest] = process.argv.slice(2);
const [cfg, fmt] = cfgArg.split(':');           // e.g. example:v for 9:16
const VERT = fmt === 'v', VW = VERT ? 1080 : 1920, VH = VERT ? 1920 : 1080;
const srv = await serve();
const browser = await chromium.launch({ executablePath: CHROME, args: ['--hide-scrollbars', '--force-color-profile=srgb'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('pageerror', e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/index.html?c=${cfg}${VERT ? '&f=v' : ''}`);
await page.evaluate(() => window.ready);
const shot = async t => { await page.evaluate(t => window.seek(t), t); return page.screenshot({ type: 'jpeg', quality: 92 }); };

if (mode === 'frames') {
  fs.mkdirSync(out, { recursive: true });
  for (const t of rest.map(Number)) fs.writeFileSync(path.join(out, `f_${t.toFixed(2)}.jpg`), await shot(t));
} else {
  const scenes = await page.evaluate(() => window.SCENES);
  const want = rest.length ? rest : scenes.map(s => s.id);
  const dir = path.join(path.dirname(path.resolve(out)), 'parts-' + cfg + (VERT ? '-v' : '')); fs.mkdirSync(dir, { recursive: true });
  for (const s of scenes.filter(s => want.includes(s.id))) {
    const n = Math.round((s.end - s.start) * FPS), tmp = path.join(dir, s.id + '.tmp.mp4');
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-crf', '16', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-r', String(FPS), tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise(r => ff.on('close', r));
    for (let i = 0; i < n; i++) { const buf = await shot(s.start + i / FPS); if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r)); }
    ff.stdin.end();
    if ((await done) === 0) fs.renameSync(tmp, path.join(dir, s.id + '.mp4')); else throw new Error('ffmpeg failed on ' + s.id);
    console.log('scene', s.id, n, 'frames');
  }
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, scenes.map(s => `file '${path.join(dir, s.id + '.mp4')}'`).join('\n'));
  await new Promise((r, j) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { stdio: 'inherit' }).on('close', c => c ? j(c) : r()));
  console.log('wrote', out);
}
await browser.close(); srv.close();
