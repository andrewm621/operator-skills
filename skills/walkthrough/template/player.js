/* Walkthrough runtime (WT)
   Player, narration, cursor and hooks for an auto-playing guided walkthrough.

   Built on motion-artifact's Motion runtime: wrap.mjs inlines scenes/motion.js
   ahead of this file, and every owner runs inside one Motion cue,
   S.cue(0, END, ...). WT never calls S.mount(); it sets window.__motion itself,
   so motion-artifact's purity.mjs and render.mjs run on a walkthrough unchanged.

   The rule is the same one motion.js states: every visual state is a pure
   function of time. seek(t) paints identical DOM whether the viewer played to
   t, scrubbed back to it, or jumped there cold.

   Authoring surface (two inline blocks in the walkthrough page):

     <script type="application/json" id="wt-spec">   the spec as JSON: scenes, beats, moves, clicks,
                                                     marks. Parsed with JSON.parse, never executed.
     WT.own("name", fn(t, k))    behaviour: the ONLY writer of what it touches
     WT.start()                  last line; reads #wt-spec

   Times in a scene (beats, moves, clicks, marks) are scene-relative
   milliseconds. k.at("scene", "mark") and k.local(t, "scene") convert. */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";
  var Mo = global.Motion;
  if (!Mo || !Mo.scene) throw new Error("WT: the Motion runtime is missing. Run wrap.mjs; it inlines motion.js before this file.");

  var doc = global.document;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var clamp = Mo.clamp, lerp = Mo.lerp;
  var EASE = { lin: Mo.ease.linear, out: Mo.ease.out, "in": Mo.ease["in"], inOut: Mo.ease.inOut, back: Mo.ease.outBack };

  var Q = new URLSearchParams(global.location ? global.location.search : "");
  var EXPORT = !!global.__motionExport;
  var AUDIT = Q.get("audit") === "1";
  var REDUCED = !EXPORT && (Q.get("reduced") === "1" || !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches));
  var FORCED_MODE = Q.get("mode") === "narrow" || Q.get("mode") === "wide" ? Q.get("mode") : (global.__WT_MODE === "narrow" || global.__WT_MODE === "wide" ? global.__WT_MODE : "");

  /* ---------------------------------------------------------------------
     Audit recording. While on, every helper write notes which owner wrote
     which property of which element, so audit.mjs can find two owners fighting
     over the same thing (the usual cause of a walkthrough that plays fine and
     jumps wrong).
     --------------------------------------------------------------------- */
  var REC = null;      // Map(el -> { prop -> { owner: 1 } })
  var OWNER = "";
  function note(el, prop) {
    if (!REC || !OWNER) return;
    var m = REC.get(el);
    if (!m) { m = {}; REC.set(el, m); }
    (m[prop] || (m[prop] = {}))[OWNER] = 1;
  }

  /* ---------------------------------------------------------------------
     Helpers. Writes are cached on the element so a seek that changes nothing
     touches nothing, and so a hidden/visible flip is one write.
     --------------------------------------------------------------------- */
  function rp(t, a, d, e) { if (d <= 0) return t >= a ? 1 : 0; return (EASE[e] || EASE.out)(clamp((t - a) / d, 0, 1)); }   // eased progress of the window [a, a+d]
  function win(t, a, b, fi, fo) {                                                                                         // 0..1 for something shown from a to b, with fades (b null = stays)
    var i = fi === undefined ? 300 : fi, o = fo === undefined ? 300 : fo;
    var v = rp(t, a, i, "lin");
    if (b != null) v = Math.min(v, 1 - rp(t, b - o, o, "lin"));
    return v;
  }
  function pick(t, list) { var v = list[0][1]; for (var i = 0; i < list.length; i++) { if (t >= list[i][0]) v = list[i][1]; } return v; }  // last [at, value] whose time has passed
  function css(el, k, v) { note(el, "css:" + k); var key = "_c_" + k; if (el[key] !== v) { el.style[k] = v; el[key] = v; } }
  function txt(el, s) { note(el, "text"); if (el._txt !== s) { el.textContent = s; el._txt = s; } }
  function cls(el, c, on) {
    note(el, "class:" + c); on = !!on; var key = "_k_" + c;
    if (el[key] !== on) {
      el.classList.toggle(c, on); el[key] = on;
      if (!el.classList.length) el.removeAttribute("class");   // toggling the last class off leaves class="", which would make a played DOM differ from a jumped one
    }
  }
  function op(el, v) { v = Math.round(clamp(v, 0, 1) * 1000) / 1000; css(el, "opacity", String(v)); css(el, "visibility", v <= 0 ? "hidden" : "visible"); }
  function tr(el, x, y, extra) { el._tx = x; el._ty = y; css(el, "transform", "translate(" + x.toFixed(2) + "px," + y.toFixed(2) + "px)" + (extra || "")); }
  function rev(el, t, at, dur, dy) { var p = rp(t, at, dur || 420, "out"); op(el, p); tr(el, 0, (1 - p) * (dy === undefined ? 8 : dy)); }   // fade up into place
  function num(el, t, at, dur, to, dec) { var v = to * rp(t, at, dur, "out"); txt(el, dec ? v.toFixed(dec) : String(Math.round(v))); }  // count up
  function spin(el, t, a, b) { css(el, "display", t >= a && t < b ? "inline-block" : "none"); css(el, "transform", "rotate(" + Math.round((t * 0.42) % 360) + "deg)"); }

  /* ---------------------------------------------------------------------
     Spec, resolved to absolute times
     --------------------------------------------------------------------- */
  var SPEC = null, SC = [], START = {}, IDX = {}, END = 0;
  var BEATS = [], MOVES = [], CLICKS = [];
  var OWNERS = [], OWNER_NAMES = {};
  var MODE = "wide", T = 0, S = null;
  var CV, SHELL, WRAP, SIZER;
  var started = false;

  function startOf(id) { if (!(id in START)) throw new Error("WT: unknown scene '" + id + "'"); return START[id]; }
  var K = {
    local: function (t, id) { return t - startOf(id); },
    at: function (id, m) {
      var base = startOf(id);
      if (typeof m === "number") return base + m;
      var marks = SC[IDX[id]].marks || {};
      if (!(m in marks)) throw new Error("WT: scene '" + id + "' has no mark '" + m + "'");
      return base + marks[m];
    },
    start: function (id) { return startOf(id); },
    end: function (id) { return startOf(id) + SC[IDX[id]].len; },
    scene: function (t) { return SC[sceneAt(t)].id; },
    mode: function () { return MODE; },
    reduced: REDUCED,
    END: 0
  };

  function define(spec) {
    if (SPEC) throw new Error("WT: the spec was defined twice");
    if (!spec || !spec.scenes || !spec.scenes.length) throw new Error("WT: define() needs scenes");
    SPEC = spec;
    var at = 0;
    spec.scenes.forEach(function (sc, i) {
      if (!sc.id || IDX[sc.id] !== undefined) throw new Error("WT: scene " + i + " needs a unique id");
      SC.push(sc); IDX[sc.id] = i; START[sc.id] = at; at += sc.len;
    });
    END = at; K.END = END;
    SC.forEach(function (sc, i) {
      var s0 = START[sc.id];
      (sc.beats || []).forEach(function (b) { BEATS.push({ at: s0 + b[0], text: b[1], scene: i }); });
      (sc.moves || []).forEach(function (m) {
        var o = m[5] || {};
        MOVES.push({ at: s0 + m[0], dur: m[1], sel: m[2], fx: m[3], fy: m[4], follow: !!o.follow, scene: i });
      });
      (sc.clicks || []).forEach(function (c) { CLICKS.push({ at: s0 + c[0], sel: c[1], scene: i }); });
    });
    BEATS.sort(function (a, b) { return a.at - b.at; });
    MOVES.sort(function (a, b) { return a.at - b.at; });
    CLICKS.sort(function (a, b) { return a.at - b.at; });
  }

  function own(name, fn) {
    if (typeof name !== "string" || typeof fn !== "function") throw new Error("WT.own(name, fn): a name and a function");
    if (OWNER_NAMES[name]) throw new Error("WT: owner '" + name + "' registered twice");
    OWNER_NAMES[name] = 1;
    OWNERS.push({ name: name, fn: fn });
  }

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function sceneAt(t) { var k = 0; for (var i = 0; i < SC.length; i++) if (t >= START[SC[i].id]) k = i; return k; }
  function beatAt(t) { var k = 0; for (var i = 0; i < BEATS.length; i++) if (t >= BEATS[i].at) k = i; return k; }
  function sceneEnd(k) { return k < SC.length - 1 ? START[SC[k + 1].id] : END; }

  /* ---------------------------------------------------------------------
     Layout-derived cursor. Targets are resolved against live layout, so the
     cursor follows a CSS change; audit.mjs proves each target is laid out.
     --------------------------------------------------------------------- */
  function off(el) {
    var x = 0, y = 0, n = el;
    while (n && n !== CV) { x += n.offsetLeft + (n._tx || 0); y += n.offsetTop + (n._ty || 0); n = n.offsetParent; }
    return { x: x, y: y };
  }
  var CACHE = {};
  function E(sel) { var c = CACHE[sel]; if (!c || !c.isConnected) c = CACHE[sel] = $(sel, CV); return c; }
  function resolve(sel, fx, fy) {
    var el = E(sel);
    if (!el || el.offsetParent === null) return null;
    var o = off(el);
    return { x: o.x + el.offsetWidth * (fx == null ? 0.5 : fx), y: o.y + el.offsetHeight * (fy == null ? 0.55 : fy) };
  }
  function park() {
    var p = (SPEC.park || {})[MODE] || (MODE === "wide" ? [760, 560] : [300, 640]);
    return { x: p[0], y: p[1] };
  }
  function cursorAt(t) {
    var p = park(), from = p, cur = p;
    for (var i = 0; i < MOVES.length; i++) {
      var m = MOVES[i];
      if (t < m.at) break;
      var target = resolve(m.sel, m.fx, m.fy) || park();
      if (m.follow) { cur = target; from = target; continue; }   // ride a moving element until the next move
      var k = rp(t, m.at, m.dur, "inOut");
      cur = { x: lerp(from.x, target.x, k), y: lerp(from.y, target.y, k) };
      from = target;
    }
    return cur;
  }

  /* ---------------------------------------------------------------------
     Framework owners: narration and cursor. Registered by start(), after the
     author's owners, so the cursor reads the layout they just set.
     --------------------------------------------------------------------- */
  function installNarration() {
    var nEy = $("#wtEy"), nTitle = $("#wtTitle"), nLede = $("#wtLede"), capEy = $("#wtCapEy"), capTx = $("#wtCapTx"), prog = $("#wtProg");
    var steps = $$("#wtSteps li"), dots = $$("#wtDots .wt-dot");
    own("wt:narration", function (t) {
      var k = sceneAt(t), b = BEATS[beatAt(t)], sc = SC[k];
      var n = SC.length;
      txt(nEy, (sc.tag ? sc.tag + " · " : "") + "Step " + (k + 1) + " of " + n);
      txt(nTitle, sc.title || sc.name); txt(nLede, sc.lede || "");
      txt(capEy, "Step " + (k + 1) + " of " + n + " · " + sc.name);
      txt(capTx, b ? b.text : "");
      steps.forEach(function (li, i) { cls(li, "on", i === k); cls(li, "done", i < k); });
      var s0 = START[sc.id], s1 = sceneEnd(k);
      dots.forEach(function (d, i) {
        cls(d, "on", i === k); cls(d, "done", i < k);
        css(d.firstChild, "width", (i === k ? 100 * clamp((t - s0) / (s1 - s0), 0, 1) : 0) + "%");
        if (i === k) d.setAttribute("aria-current", "step"); else d.removeAttribute("aria-current");
      });
      css(prog, "width", (100 * clamp(t / END, 0, 1)).toFixed(2) + "%");
    });
  }
  function installCursor() {
    var cur = $("#wtCur"), rip = $("#wtRip");
    var closing = SPEC.closing ? START[SPEC.closing] : END;
    own("wt:cursor", function (t) {
      var c = cursorAt(t), press = 0, i, last = null;
      for (i = 0; i < CLICKS.length; i++) { if (t >= CLICKS[i].at && t < CLICKS[i].at + 180) press = 1; }
      var vis = 1 - rp(t, closing - 100, 300, "lin");
      if (REDUCED) vis = t >= closing ? 0 : 1;
      op(cur, vis);
      tr(cur, c.x - 4, c.y - 2, press ? " scale(.86)" : "");
      for (i = 0; i < CLICKS.length; i++) if (t >= CLICKS[i].at && t < CLICKS[i].at + 520) last = CLICKS[i].at;
      if (last === null || REDUCED) { op(rip, 0); css(rip, "transform", "none"); return; }
      var q = rp(t, last, 520, "out"), at = cursorAt(last);
      op(rip, 0.9 * (1 - q));
      css(rip, "transform", "translate(" + at.x.toFixed(1) + "px," + at.y.toFixed(1) + "px) scale(" + (0.35 + 1.4 * q).toFixed(3) + ")");
    });
  }

  /* ---------------------------------------------------------------------
     seek and layout
     --------------------------------------------------------------------- */
  function seek(t) {
    T = clamp(t, 0, END);
    S.seek(T);
    return T;
  }
  function runOwners(t) {
    for (var i = 0; i < OWNERS.length; i++) { OWNER = OWNERS[i].name; OWNERS[i].fn(t, K); }
    OWNER = "";
  }

  function dims() {
    var c = SPEC.canvas || {};
    return MODE === "narrow" ? (c.narrow || [390, 720]) : (c.wide || [1000, 620]);
  }
  function layout() {
    var narrowBelow = (SPEC.canvas && SPEC.canvas.narrowBelow) || 760;
    var narrow = FORCED_MODE ? FORCED_MODE === "narrow" : (!EXPORT && global.innerWidth < narrowBelow);
    MODE = narrow ? "narrow" : "wide";
    SHELL.setAttribute("data-mode", MODE);
    cls(CV, "is-narrow", narrow);
    var d = dims(), W = d[0], H = d[1];
    CV.style.width = W + "px"; CV.style.height = H + "px";
    if (EXPORT) {
      CV.style.transform = "none";
    } else {
      var s = Math.max(0.3, Math.min(WRAP.clientWidth / W, WRAP.clientHeight / H, narrow ? 1.15 : 1.3));
      SIZER.style.width = (W * s) + "px"; SIZER.style.height = (H * s) + "px";
      CV.style.transform = "scale(" + s + ")";
    }
    if (global.__motion) { global.__motion.width = W; global.__motion.height = H; }
    seek(T);
  }

  /* ---------------------------------------------------------------------
     Player: continuous playback, or caption-by-caption resting frames when the
     viewer prefers reduced motion.
     --------------------------------------------------------------------- */
  var playing = false, last = 0, raf = 0, holdTimer = 0, autoTimer = 0, ended = false;
  var bPlay;
  var ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
  var ICON_AGAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
  function setPlayBtn() {
    bPlay.innerHTML = ended ? ICON_AGAIN : playing ? ICON_PAUSE : ICON_PLAY;
    bPlay.setAttribute("aria-label", ended ? "Watch again" : playing ? "Pause" : "Play");
  }
  function restOf(i) { var next = i + 1 < BEATS.length ? BEATS[i + 1].at : END; return next - 40; }   // a beat's resting frame: just before the next beat
  function frame(now) {
    if (!playing) { raf = 0; return; }
    var dt = last ? now - last : 0; last = now;
    var t = T + Math.min(dt, 100);
    if (t >= END) { seek(END); playing = false; ended = true; setPlayBtn(); raf = 0; return; }
    seek(t);
    raf = global.requestAnimationFrame(frame);
  }
  function scheduleHold() {
    clearTimeout(holdTimer);
    if (!playing) return;
    holdTimer = setTimeout(function () {
      var i = beatAt(T);
      if (i + 1 >= BEATS.length) { playing = false; ended = true; setPlayBtn(); return; }
      seek(restOf(i + 1)); scheduleHold();
    }, SPEC.holdMs || 5200);
  }
  function play() {
    clearTimeout(autoTimer);
    if (ended) { ended = false; seek(REDUCED ? restOf(0) : 0); }
    playing = true; setPlayBtn();
    if (REDUCED) { scheduleHold(); return; }
    last = 0; if (!raf) raf = global.requestAnimationFrame(frame);
  }
  function pause() { clearTimeout(autoTimer); playing = false; clearTimeout(holdTimer); setPlayBtn(); }
  function goScene(k) {
    k = clamp(k, 0, SC.length - 1); ended = false;
    if (REDUCED) { var i = 0; while (i < BEATS.length && BEATS[i].scene !== k) i++; seek(restOf(i)); scheduleHold(); }
    else { seek(START[SC[k].id]); last = 0; }
    setPlayBtn();
  }
  function restart() { ended = false; seek(REDUCED ? restOf(0) : 0); last = 0; play(); }

  function wireControls() {
    bPlay = $("#wtPlay");
    bPlay.addEventListener("click", function () { if (ended) { restart(); return; } playing ? pause() : play(); });
    $("#wtRestart").addEventListener("click", restart);
    $("#wtPrev").addEventListener("click", function () {
      var k = sceneAt(T);
      if (!REDUCED && T - START[SC[k].id] > 1500) goScene(k); else goScene(k - 1);
    });
    $("#wtNext").addEventListener("click", function () { goScene(sceneAt(T) + 1); });
    $$("#wtDots .wt-dot, #wtSteps button").forEach(function (b) {
      b.addEventListener("click", function () { goScene(+b.getAttribute("data-k")); if (!playing) play(); });
    });
    doc.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var onButton = e.target && e.target.tagName === "BUTTON";
      if (e.key === " " && !onButton) { e.preventDefault(); if (ended) restart(); else playing ? pause() : play(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goScene(sceneAt(T) + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goScene(sceneAt(T) - 1); }
      else if (e.key === "r" || e.key === "R") { e.preventDefault(); restart(); }
    });
  }

  /* ---------------------------------------------------------------------
     start(): build the shell from the spec, expose the hooks, begin.
     --------------------------------------------------------------------- */
  function start() {
    if (started) throw new Error("WT: start() called twice");
    if (!SPEC) {
      var specEl = doc.getElementById("wt-spec");
      if (!specEl) throw new Error('WT: no <script type="application/json" id="wt-spec"> found');
      define(JSON.parse(specEl.textContent));
    }
    started = true;
    CV = $("#cv"); SHELL = $("#wtShell"); WRAP = $("#wtWrap"); SIZER = $("#wtSizer");
    if (!CV || !SHELL) throw new Error("WT: the page is missing #cv or #wtShell (copy template/player.html)");

    var b = SPEC.brand || {};
    txt($("#wtBrandEy"), b.eyebrow || ""); txt($("#wtBrandName"), b.name || "");
    txt($("#wtBadge"), SPEC.badge || "Walkthrough · sample data");
    txt($("#wtMeta"), SPEC.meta || (SC.length + " steps · about " + Math.round(END / 1000) + " seconds"));
    txt($("#wtFoot"), SPEC.foot || "Sample data only.");
    $("#wtSteps").innerHTML = SC.map(function (sc, i) { return '<li><button type="button" data-k="' + i + '"><span class="wt-k">0' + (i + 1) + '</span><span>' + esc(sc.name) + '</span></button></li>'; }).join("");
    $("#wtDots").innerHTML = SC.map(function (sc, i) { return '<button type="button" class="wt-dot" data-k="' + i + '" aria-label="Step ' + (i + 1) + ': ' + esc(sc.name) + '"><i></i></button>'; }).join("");

    installNarration();
    installCursor();

    S = Mo.scene({ width: dims()[0], height: dims()[1], tail: 0 });
    S.cue(0, END, function (p, t) { runOwners(t); }, "linear");

    wireControls();
    if (EXPORT) doc.body.classList.add("wt-export");
    T = REDUCED ? restOf(0) : 0;
    layout();
    setPlayBtn();

    if (global.ResizeObserver) new global.ResizeObserver(function () { layout(); }).observe(WRAP);
    global.addEventListener("resize", layout);

    /* Hooks. __motion is what motion-artifact's purity.mjs and render.mjs key on.
       In export mode it appears only once fonts have settled, so frames never
       race a late font swap. */
    function expose() {
      global.__motion = { ready: true, seek: function (t) { seek(t); }, duration: END, fps: S.fps, width: dims()[0], height: dims()[1] };
    }
    var errors = [];
    global.addEventListener("error", function (e) { errors.push(String(e.message || e)); });
    global.addEventListener("unhandledrejection", function (e) { errors.push("unhandledrejection: " + String(e.reason)); });
    global.__walk = {
      version: VERSION,
      seek: function (t) { pause(); ended = false; setPlayBtn(); seek(t); },
      play: play, pause: pause,
      duration: END,
      ids: SC.map(function (s) { return s.id; }),
      scenes: SC.map(function (s) { return START[s.id]; }),
      lens: SC.map(function (s) { return s.len; }),
      beats: BEATS.map(function (x) { return x.at; }),
      closing: SPEC.closing || null,
      moves: MOVES.map(function (m) { return { at: m.at, dur: m.dur, sel: m.sel, fx: m.fx, fy: m.fy, follow: m.follow, scene: SC[m.scene].id }; }),
      clicks: CLICKS.map(function (c) { return { at: c.at, sel: c.sel, scene: SC[c.scene].id }; }),
      get mode() { return MODE; },
      get t() { return T; },
      get reduced() { return REDUCED; },
      errors: errors,
      /* audit support */
      resolve: resolve,
      cursorAt: cursorAt,
      off: off,
      recording: function (on) { REC = on ? new Map() : null; },
      conflicts: function () {
        var out = [];
        if (!REC) return out;
        REC.forEach(function (props, el) {
          Object.keys(props).forEach(function (p) {
            var owners = Object.keys(props[p]);
            if (owners.length > 1) out.push({ el: el, prop: p, owners: owners });
          });
        });
        return out;
      }
    };
    if (AUDIT) global.__walk.audit = true;

    if (EXPORT) {
      var fontsReady = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
      Promise.race([fontsReady, new Promise(function (r) { setTimeout(r, 2500); })]).then(function () { layout(); expose(); });
      return;
    }
    expose();
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(function () { seek(T); });
    if (Q.get("autoplay") !== "0") autoTimer = setTimeout(play, REDUCED ? 0 : 700);
  }

  global.WT = {
    version: VERSION,
    define: define,
    own: own,
    start: start,
    $: $, $$: $$, off: off,
    h: { rp: rp, win: win, pick: pick, op: op, css: css, txt: txt, cls: cls, tr: tr, rev: rev, num: num, spin: spin, clamp: clamp, lerp: lerp }
  };
})(window);
