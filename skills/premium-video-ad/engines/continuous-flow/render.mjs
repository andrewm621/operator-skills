// Render the continuous-shot walkthrough.
//   node render.mjs frames 0 3.5 7.2 ... [--out frames] [--c example]
//   node render.mjs video [seg00 seg03 ...]   (5 s segments; omit ids for all, then joins + muxes)
//   node render.mjs join                      (concat segments + mux walkthrough.wav)
//   node render.mjs cues                      (write cues.json for soundtrack.py)
//   node render.mjs sheet                     (contact sheet of 12 in-between frames)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FPS = 30, SEG = 5;
const args = process.argv.slice(2);
const mode = args[0];
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const pos = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const CFG = opt("c", "example");
const OUTNAME = opt("name", "example-walkthrough");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.join(DIR, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!p.startsWith(DIR)) { rsp.writeHead(403); return rsp.end(); }
      fs.readFile(p, (e, buf) => { if (e) { rsp.writeHead(404); return rsp.end(); } rsp.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); rsp.end(buf); });
    }).listen(0, "127.0.0.1", () => res(srv));
  });
}

async function openPage(browser, port) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on("pageerror", e => console.error("pageerror:", e.message));
  await page.goto(`http://127.0.0.1:${port}/canvas.html?c=${CFG}`);
  await page.evaluate(() => window.ready);
  return page;
}
const shot = async (page, t) => { await page.evaluate(t => window.seek(t), t); return page.screenshot({ type: "jpeg", quality: 92 }); };

function run(cmd, a) { const r = spawnSync(cmd, a, { stdio: ["ignore", "inherit", "inherit"] }); if (r.status !== 0) throw new Error(cmd + " failed"); }

async function renderSegment(page, idx, total) {
  const t0 = idx * SEG, t1 = Math.min(total, t0 + SEG);
  const n = Math.round((t1 - t0) * FPS);
  fs.mkdirSync(path.join(DIR, "segments"), { recursive: true });
  const out = path.join(DIR, "segments", `seg${String(idx).padStart(2, "0")}.mp4`);
  const tmp = out.replace(/\.mp4$/, ".tmp.mp4");
  const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "-",
    "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(FPS), tmp], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => ff.on("exit", c => c === 0 ? res() : rej(new Error("ffmpeg exit " + c))));
  for (let f = 0; f < n; f++) {
    const buf = await shot(page, t0 + f / FPS);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once("drain", r));
  }
  ff.stdin.end(); await done;
  fs.renameSync(tmp, out);
  console.log(`seg${String(idx).padStart(2, "0")} ${t0}-${t1}s: ${n} frames`);
}

function join() {
  const segs = fs.readdirSync(path.join(DIR, "segments")).filter(f => /^seg\d+\.mp4$/.test(f)).sort();
  fs.writeFileSync(path.join(DIR, "segments", "list.txt"), segs.map(s => `file '${s}'`).join("\n"));
  run(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(DIR, "segments", "list.txt"), "-c", "copy", path.join(DIR, "video-only.mp4")]);
  const wav = path.join(DIR, "walkthrough.wav");
  if (fs.existsSync(wav)) {
    run(FFMPEG, ["-y", "-loglevel", "error", "-i", path.join(DIR, "video-only.mp4"), "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", path.join(DIR, OUTNAME + ".mp4")]);
    console.log("wrote", OUTNAME + ".mp4");
  } else console.log("no walkthrough.wav yet; wrote video-only.mp4");
}

const srv = await serve();
const port = srv.address().port;
let browser;
try {
  if (mode === "join") { join(); }
  else {
    browser = await chromium.launch({ executablePath: CHROME, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
    if (mode === "frames") {
      const out = path.join(DIR, opt("out", "frames")); fs.mkdirSync(out, { recursive: true });
      const page = await openPage(browser, port);
      for (const a of pos) { const t = parseFloat(a); fs.writeFileSync(path.join(out, `f_${t.toFixed(2).padStart(6, "0")}.jpg`), await shot(page, t)); }
      console.log("frames ->", out);
    } else if (mode === "cues") {
      const page = await openPage(browser, port);
      const data = await page.evaluate(() => ({ total: window.TOTAL, bpm: window.AD.bpm, timing: window.AD.timing, scenes: window.SCENES, cues: window.CUES }));
      fs.writeFileSync(path.join(DIR, "cues.json"), JSON.stringify(data, null, 1));
      console.log("cues.json:", data.cues.length, "cues");
    } else if (mode === "sheet") {
      const times = [1.5, 4.9, 7.4, 11.1, 13.9, 17.0, 19.6, 23.2, 25.4, 31.0, 32.4, 37.2];
      const out = path.join(DIR, "sheet-frames"); fs.mkdirSync(out, { recursive: true });
      // Pull frames from the finished MP4 when it exists (confirms the encoded motion), else from the page.
      const mp4 = path.join(DIR, OUTNAME + ".mp4");
      const page = fs.existsSync(mp4) ? null : await openPage(browser, port);
      const files = [];
      for (const t of times) {
        const f = path.join(out, `t${t.toFixed(1)}.jpg`);
        if (page) fs.writeFileSync(f, await shot(page, t));
        else run(FFMPEG, ["-y", "-loglevel", "error", "-ss", String(t), "-i", mp4, "-frames:v", "1", "-q:v", "2", f]);
        files.push(f);
      }
      const inputs = files.flatMap(f => ["-i", f]);
      const filt = files.map((_, i) => `[${i}:v]scale=640:360[v${i}]`).join(";") +
        ";" + files.map((_, i) => `[v${i}]`).join("") + `xstack=inputs=${files.length}:layout=` + files.map((_, i) => `${(i % 4) * 640}_${Math.floor(i / 4) * 360}`).join("|") + "[o]";
      run(FFMPEG, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filt, "-map", "[o]", "-q:v", "3", path.join(DIR, "contact-sheet.jpg")]);
      console.log("wrote contact-sheet.jpg");
    } else if (mode === "video") {
      const page0 = await openPage(browser, port);
      const total = await page0.evaluate(() => window.TOTAL);
      const nseg = Math.ceil(total / SEG);
      const ids = pos.length ? pos.map(s => parseInt(s.replace(/\D/g, ""), 10)) : [...Array(nseg).keys()];
      const conc = Math.min(parseInt(opt("jobs", "3"), 10), ids.length);
      const pages = [page0]; for (let i = 1; i < conc; i++) pages.push(await openPage(browser, port));
      const queue = [...ids];
      await Promise.all(pages.map(async pg => { while (queue.length) { const id = queue.shift(); await renderSegment(pg, id, total); } }));
      join();
    } else { console.log("usage: node render.mjs frames|video|join|cues|sheet"); }
  }
} finally { if (browser) await browser.close(); srv.close(); }
