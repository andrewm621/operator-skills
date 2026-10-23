#!/usr/bin/env node
/* In-browser checks for a walkthrough (headless; run lint.mjs first).

     node audit.mjs <dir> [--driver agent-browser|chrome] [--session name]

   For BOTH the wide and the narrow layout (real viewports, 1280x800 and 390x844):
     moves     every cursor target exists, is laid out and is visible when the move settles
               (a hidden target silently sends the cursor to its parking spot)
     clicks    the cursor is inside the clicked selector at click time, and it is visible
     owners    no element/property is written by two owners (sampled across the timeline)
     canvas    no visible element sticks out past the canvas edge at a resting frame
     errors    no uncaught errors or rejections
   Plus: no horizontal scroll at 390 and 820 wide, the theme follows the OS when ?theme is
   absent, and reduced motion steps caption by caption.

   Pages load from a local server over wrap.mjs's standards-mode test page. The browser is
   headless with its own session: never the user's browser. */

import path from 'node:path';
import { resolveTarget, serveDir, flag, positional, reporter, isMain } from './_lib.mjs';
import { launchBrowser, waitFor } from './_browser.mjs';
import { wrap } from './wrap.mjs';

/* Runs inside the page. Returns a JSON string. Kept as a real function so it is syntax-checked. */
function pageAudit() {
  var W = window.__walk, cv = document.getElementById('cv');
  var out = { mode: W.mode, moves: [], clicks: [], conflicts: [], overflow: [], clipped: [], errors: W.errors.slice() };
  var cvr0 = cv.getBoundingClientRect();
  var scale = cvr0.width / cv.offsetWidth || 1;
  function desc(el) {
    if (el.id) return '#' + el.id;
    var c = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return el.tagName.toLowerCase() + (c ? '.' + c : '');
  }
  function eff(el) {
    var o = 1, n = el;
    while (n && n !== document.body) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
      o *= parseFloat(cs.opacity);
      n = n.parentElement;
    }
    return o;
  }
  var CW = cv.offsetWidth, CH = cv.offsetHeight;

  W.moves.forEach(function (m) {
    var t = m.at + m.dur;
    W.seek(t);
    var el = cv.querySelector(m.sel), why = null;
    if (!el) why = 'missing from the page';
    else if (el.offsetParent === null) why = 'not laid out in the ' + out.mode + ' layout (display:none or detached), so the cursor parks instead';
    else if (eff(el) < 0.1) why = 'laid out but invisible when the move settles (t=' + t + ')';
    else {
      var p = W.resolve(m.sel, m.fx, m.fy);
      if (!p || p.x < 0 || p.y < 0 || p.x > CW || p.y > CH) why = 'resolves outside the canvas';
    }
    if (why) out.moves.push({ scene: m.scene, sel: m.sel, t: t, why: why });
  });

  W.clicks.forEach(function (c) {
    W.seek(c.at);
    var el = cv.querySelector(c.sel), why = null;
    if (!el) why = 'missing from the page';
    else if (el.offsetParent === null) why = 'not laid out in the ' + out.mode + ' layout';
    else if (eff(el) < 0.1) why = 'invisible at click time';
    else {
      var p = W.cursorAt(c.at), o = W.off(el), tol = 6;
      var dx = p.x < o.x ? o.x - p.x : p.x > o.x + el.offsetWidth ? p.x - (o.x + el.offsetWidth) : 0;
      var dy = p.y < o.y ? o.y - p.y : p.y > o.y + el.offsetHeight ? p.y - (o.y + el.offsetHeight) : 0;
      if (dx > tol || dy > tol) why = 'cursor is ' + Math.round(Math.max(dx, dy)) + 'px outside it at click time (cursor ' + Math.round(p.x) + ',' + Math.round(p.y) + '; target ' + Math.round(o.x) + ',' + Math.round(o.y) + ' ' + el.offsetWidth + 'x' + el.offsetHeight + ')';
    }
    if (why) out.clicks.push({ scene: c.scene, sel: c.sel, t: c.at, why: why });
  });

  /* two owners writing one thing: sample the whole timeline with recording on */
  W.recording(true);
  var N = 70;
  for (var i = 0; i <= N; i++) W.seek(Math.round(W.duration * i / N));
  W.beats.forEach(function (b) { W.seek(b + 1); W.seek(b + 400); });
  var seen = {};
  W.conflicts().forEach(function (c) {
    var key = desc(c.el) + '|' + c.prop;
    if (!seen[key]) { seen[key] = 1; out.conflicts.push({ el: desc(c.el), prop: c.prop, owners: c.owners }); }
  });
  W.recording(false);

  /* resting frames: nothing visible may stick out past the canvas */
  var all = cv.querySelectorAll('*');
  var tol2 = 2 * scale, shown = {};
  W.beats.forEach(function (b, bi) {
    var next = bi + 1 < W.beats.length ? W.beats[bi + 1] : W.duration;
    W.seek(next - 40);
    var cvr = cv.getBoundingClientRect();
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.closest('.wt-cur,.wt-rip,svg')) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left >= cvr.left - tol2 && r.right <= cvr.right + tol2 && r.top >= cvr.top - tol2 && r.bottom <= cvr.bottom + tol2) {
        /* text that is cut off by its own overflow:hidden box */
        if (el.scrollWidth > el.clientWidth + 2 && el.children.length === 0 && el.textContent.trim() && eff(el) > 0.5) {
          var cs0 = getComputedStyle(el);
          if (cs0.overflowX !== 'visible' && !shown['c' + desc(el)]) { shown['c' + desc(el)] = 1; out.clipped.push({ el: desc(el), t: next - 40, text: el.textContent.trim().slice(0, 40) }); }
        }
        continue;
      }
      if (eff(el) < 0.2) continue;
      var clippedByParent = false;
      for (var n = el.parentElement; n && n !== cv; n = n.parentElement) {
        var cs = getComputedStyle(n);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { clippedByParent = true; break; }
      }
      if (clippedByParent) continue;
      var k = desc(el);
      if (!shown[k]) { shown[k] = 1; out.overflow.push({ el: k, t: next - 40, by: Math.round(Math.max(cvr.left - r.left, r.right - cvr.right, cvr.top - r.top, r.bottom - cvr.bottom) / scale) }); }
    }
  });
  W.seek(0);
  out.errors = W.errors.slice();
  return JSON.stringify(out);
}

const PAGE_AUDIT = `(${pageAudit.toString()})()`;
const PAGE_SCROLL = `JSON.stringify({sw:document.documentElement.scrollWidth,iw:window.innerWidth,bad:Array.prototype.slice.call(document.querySelectorAll('.wt-pbar,.wt-stage,.wt-tour,.wt-cv,.wt-dots,.wt-ctl')).filter(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.right>window.innerWidth+1}).map(function(e){return e.className.split(' ')[0]})})`;

export async function audit(arg, opts = {}) {
  const target = resolveTarget(arg);
  wrap(target);
  const r = reporter('audit');
  const server = await serveDir(target.scratch);
  const b = await launchBrowser({ driver: opts.driver, session: opts.session || 'wt-audit-' + process.pid });
  console.log(`audit ${path.basename(target.dir)}  (${b.name})`);
  const url = (q) => `${server.origin}/test.html?autoplay=0&theme=light${q || ''}`;
  const ready = async () => {
    await waitFor(b, 'window.__walk ? true : false');
    try { await waitFor(b, 'document.fonts.status === "loaded"', { timeout: 6000 }); } catch { r.warn('fonts', 'fonts did not finish loading; measured with the fallback stack'); }
  };
  try {
    for (const [mode, vp] of [['wide', { width: 1280, height: 800 }], ['narrow', { width: 390, height: 844 }]]) {
      await b.open(url(), { ...vp, scheme: 'light' });
      await ready();
      const res = JSON.parse(await b.eval(PAGE_AUDIT));
      if (res.mode !== mode) r.fail('mode', `expected the ${mode} layout at ${vp.width}px but the page chose ${res.mode}`);
      const issues = [...res.moves.map((m) => ['moves', m]), ...res.clicks.map((m) => ['clicks', m])];
      for (const [rule, m] of issues) r.fail(`${rule}/${mode}`, `scene '${m.scene}' ${m.sel} at t=${m.t}: ${m.why}`);
      for (const c of res.conflicts) r.fail(`owners/${mode}`, `${c.el} ${c.prop} is written by ${c.owners.join(' and ')}; one owner per property`);
      for (const o of res.overflow) r.fail(`canvas/${mode}`, `${o.el} sticks out past the canvas by ${o.by}px at t=${o.t}`);
      for (const c of res.clipped) r.warn(`clipped/${mode}`, `${c.el} cuts off its text at t=${c.t}: "${c.text}"`);
      for (const e of res.errors) r.fail(`errors/${mode}`, e);
      if (!issues.length && !res.conflicts.length && !res.overflow.length && !res.errors.length) r.pass(`${mode}: ${await b.eval('__walk.moves.length')} moves and ${await b.eval('__walk.clicks.length')} clicks land, no double writers, nothing past the canvas, no errors`);
    }

    for (const w of [390, 820]) {
      await b.open(url(), { width: w, height: w === 390 ? 844 : 1100, scheme: 'light' });
      await ready();
      const s = JSON.parse(await b.eval(PAGE_SCROLL));
      if (s.sw > s.iw + 1 || s.bad.length) r.fail('scroll', `horizontal overflow at ${w}px (scrollWidth ${s.sw}${s.bad.length ? '; ' + s.bad.join(', ') + ' past the edge' : ''})`);
      else r.pass(`no horizontal scroll at ${w}px`);
    }

    for (const scheme of ['dark', 'light']) {
      await b.open(`${server.origin}/test.html?autoplay=0`, { width: 1280, height: 800, scheme });
      await ready();
      const got = await b.eval('document.documentElement.getAttribute("data-theme")');
      if (got !== scheme) r.fail('theme', `prefers-color-scheme ${scheme} produced data-theme="${got}"`);
    }
    r.pass('data-theme follows the OS when ?theme is absent');

    await b.open(url('&reduced=1'), { width: 1280, height: 800, scheme: 'light' });
    await ready();
    const rm = JSON.parse(await b.eval(`(function(){var W=__walk;var t0=W.t;document.getElementById('wtNext').click();var t1=W.t;var rip=getComputedStyle(document.getElementById('wtRip')).opacity;
      return JSON.stringify({reduced:W.reduced,t0:t0,t1:t1,beats:W.beats,scenes:W.scenes,rip:rip});})()`));
    const rest = (i) => (i + 1 < rm.beats.length ? rm.beats[i + 1] : 1e9) - 40;
    const firstOf1 = rm.beats.findIndex((x) => x >= rm.scenes[1]);
    if (!rm.reduced) r.fail('reduced', '?reduced=1 did not switch on reduced motion');
    else if (rm.t0 !== rest(0) || rm.t1 !== rest(firstOf1)) r.fail('reduced', `reduced motion should rest on each caption's last frame (expected ${rest(0)} then ${rest(firstOf1)}, got ${rm.t0} then ${rm.t1})`);
    else r.pass('reduced motion: steps caption by caption on resting frames');
  } finally {
    await b.close();
    await server.close();
  }
  return r;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const arg = positional(argv, ['driver', 'session'])[0];
    const r = await audit(arg, { driver: flag(argv, 'driver', 'auto'), session: flag(argv, 'session') });
    process.exitCode = r.done();
  } catch (e) {
    console.error('audit: ' + e.message);
    process.exit(1);
  }
}
