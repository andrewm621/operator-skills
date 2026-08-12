Animate a product feature or process as a self-contained HTML scene, then export it to GIF, MP4, WebM, or PNG frames.

What to animate: $ARGUMENTS

Use this when someone needs a short motion clip of software doing something — an onboarding flow, a search returning results, a pipeline advancing, a dashboard filling in — and hand-animating in After Effects or Figma is overkill. You author the scene in HTML/CSS, and a renderer steps it frame by frame into a video or GIF.

## The one idea that makes this work

**Every visual state is a pure function of time.** The scene declares cues; `seek(t)` applies all of them at their clamped progress. Nothing fires, nothing accumulates, nothing depends on how you got to `t`.

That buys three things at once:

- **Scrubbing** — jump to any moment, forward or backward, and the frame is correct.
- **Deterministic export** — the renderer drives a *virtual* clock, so output is byte-identical on a fast desktop and a throttled laptop. It is not a screen recording.
- **Render beyond real-time** — export 60fps from a machine that could never play it at 60fps.

Break purity and the export silently smears. The [Hard rules](#hard-rules) exist to keep it.

## Steps

1. **Pin the brief** — From `$ARGUMENTS`, settle these before writing code. Ask only if a wrong guess would waste the whole scene; otherwise pick a sane default and say what you picked.

   | | Default |
   |---|---|
   | The beats, in order | derive from the request |
   | Canvas | `desktop` — see the preset table below |
   | Duration | 5–8s — long enough to read, short enough to loop |
   | Output | GIF for chat/docs, MP4 for slides/social |

   Keep it to **3–5 beats**. A clip that tries to show a whole product shows nothing.

   **Pick the canvas from the subject, not the default.** A phone scene on a 16:9
   canvas wastes ~70% of the frame and lands with type at the edge of legible:

   | Preset | Canvas | Use |
   |---|---|---|
   | `desktop` | 1200×675 | app window, dashboard, browser flow |
   | `phone` | 420×660 | a single mobile screen |
   | `phone-wide` | 900×560 | phone beside a caption or callout |
   | `square` | 800×800 | LinkedIn / IG feed |
   | `story` | 540×960 | IG / TikTok story, 9:16 |

2. **Start from a scene, not a blank page** — Check `scenes/` next to this skill first.
   Each one is a complete, rendered, self-contained clip; copying the closest and
   editing its copy is faster and more reliable than writing cues from nothing.

   | Scene | Canvas | Shows |
   |---|---|---|
   | `onboarding-flow.html` | desktop | cursor → type → click → step advance |
   | `search-results.html` | desktop | query typed, results stagger in |
   | `pipeline-run.html` | desktop | stages advancing through `states()` |
   | `dashboard-fill.html` | desktop | counters, progress bars, a chart drawing in |
   | `phone-concierge.html` | phone | mobile screen, typed question, result cards |
   | `checklist-complete.html` | square | `sequence()` ticking a list, for social |
   | `feature-story.html` | story | 9:16 vertical, big type, one idea |

   If nothing fits, write one: a self-contained `.html` file with the runtime from
   [Scene runtime](#scene-runtime) inlined verbatim in a `<script>` tag; no CDN, no
   build step, no network. Follow the [Scene skeleton](#scene-skeleton).

   Build **all** DOM up front and let cues reveal it. Fake the product's chrome (browser bar, sidebar, panel) rather than screenshotting the real app — it stays legible when scaled down to a GIF, and it never leaks real customer data.

3. **Write the renderer** — Drop [render.mjs](#renderer) next to the scene. Zero dependencies: it drives Chrome over CDP with Node's built-in `WebSocket` (Node 22+) and shells out to `ffmpeg`. Nothing to install if the user has Chrome and ffmpeg.

4. **Preview before rendering** — Open the scene in a browser and watch it. `Space` play/pause, `R` replay, `←`/`→` scrub 250ms, `1`/`2`/`3` speed. Rendering a scene you have not watched wastes a minute per attempt.

5. **Render** —

   ```bash
   node render.mjs scene.html --format gif --scale 900     # chat, docs, Slack
   node render.mjs scene.html --format mp4 --scale 1200    # slides, social
   node render.mjs scene.html --format frames              # PNG sequence for an editor
   ```

   Useful flags: `--fps`, `--width`/`--height`, `--dpr` (capture scale, default 2), `--from`/`--to` (render a sub-range while iterating), `--out`, `--keep-frames`, `--chrome <path>`.

6. **Verify the output, not the exit code** — Extract a few frames and *look* at them:

   ```bash
   ffmpeg -v error -y -i out.gif -vf "select='eq(n\,20)+eq(n\,110)+eq(n\,200)'" -vsync 0 chk_%d.png
   ```

   Check the frames mid-transition, not just the last one — most bugs are states stomping each other partway through. If you suspect a purity break, prove it — **two checks, and they catch different bugs**:

   ```bash
   # 1. wall-clock leak: the same render twice must be byte-identical
   node render.mjs scene.html --format frames --out fa
   node render.mjs scene.html --format frames --out fb
   for f in fa/*.png; do cmp -s "$f" "fb/$(basename $f)" || echo "NONDETERMINISTIC $(basename $f)"; done

   # 2. cold-seek leak: a sub-range must match the full render at the same t
   node render.mjs scene.html --format frames --from 3000 --out fc
   # at 30fps, --from 3000 means fc frame N is fa frame N+90
   cmp fa/f_00092.png fc/f_00002.png && echo "COLD SEEK OK"
   ```

   Output from check 1 means something is running on wall-clock time — convert the frame number to a timestamp (`frame / fps * 1000`) to find the offending cue. A mismatch in check 2 means a cue depends on *how you got to `t`* rather than on `t`: it will look right when you play from the start and wrong whenever you scrub or render a sub-range. **Check 1 cannot catch that** — both full renders walk forward identically and agree with each other.

7. **Report** — Give the output path, dimensions, duration, and **file size**. Size is the thing that decides whether it can be pasted into Slack or a README. If a GIF lands over ~2MB, cut `--scale`, drop `--fps` to 20, or shorten the clip — in that order.

## Hard rules

These are the failure modes that actually bite. Each one has cost a debugging session.

1. **Never put `transition:` or `animation:` on anything a cue touches.** This is the big one. CSS transitions run on wall-clock time and desync from `seek()`, so exported frames smear unpredictably — and it does not reproduce in the browser, where it looks fine. Tween through `reveal()`/`tween()` instead.
2. **Build all DOM up front.** A cue that creates nodes cannot be scrubbed backward. Pre-render every state and toggle classes.
3. **Every `apply()` must define state at `p=0` *and* `p=1`.** Anything that only paints on the way up breaks reverse scrubbing.
4. **Two cues that write the same CSS property on the same element fight — the later one wins, at every `t`.** So use `states()` for anything that changes more than once: two `set()` cues on one element each re-assert their own "before" value at `p=0`, and the later cue wins at `t=0`, showing a future state early. The one exception is `transform`, which `tween()` composes per element — `reveal()` then a later `tween({x})` keeps both channels. Everything else (`opacity`, `filter`, `width`, text) still needs one owner per element.
5. **System fonts, or base64 the font.** A webfont that loads over the network races the first frames.
6. **`html, body` must be exactly the scene size with `overflow:hidden`.** The renderer captures the viewport.
7. **`scroll()` needs an explicit `from`.** Reading `scrollTop` at seek time makes the cue depend on history.
8. **Keep clips 4–10s.** GIF size scales with how many pixels change, not duration alone — a full-frame fade costs more than a long quiet hold.

<h2 id="scene-runtime">Scene runtime</h2>

Write this verbatim into the scene's `<script>` tag (or alongside as `motion.js` while iterating).

```js
/* Motion Scene Runtime
   Deterministic, seekable animation for short product-demo scenes.

   The one rule that makes export work: every visual state is a pure function of
   time. Cues never "fire" and never accumulate state - seek(t) applies every cue
   at its clamped progress, so seek(4200) paints the same pixels whether you got
   there by playing forward, scrubbing backward, or jumping cold. That is what
   lets a renderer step frames on a virtual clock instead of screen-recording.

   Corollary: build all DOM up front and animate by toggling classes and styles.
   A cue that creates nodes is a cue that cannot be scrubbed. */
(function (global) {
  'use strict';

  var EASE = {
    linear: function (p) { return p; },
    out: function (p) { return 1 - Math.pow(1 - p, 3); },
    in: function (p) { return p * p * p; },
    inOut: function (p) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; },
    outBack: function (p) { var c = 1.70158, c3 = c + 1; return 1 + c3 * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); },
    step: function (p) { return p < 1 ? 0 : 1; }
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function el(target, root) {
    if (!target) return null;
    if (typeof target === 'string') return (root || document).querySelector(target);
    return target;
  }
  function els(target, root) {
    if (!target) return [];
    if (typeof target === 'string') return Array.prototype.slice.call((root || document).querySelectorAll(target));
    if (target.length !== undefined && !target.nodeType) return Array.prototype.slice.call(target);
    return [target];
  }

  function Scene(opts) {
    opts = opts || {};
    this.fps = opts.fps || 30;
    this.width = opts.width || 1280;
    this.height = opts.height || 720;
    this.tail = opts.tail === undefined ? 600 : opts.tail;
    this.loop = !!opts.loop;
    this.cues = [];
    this._t = 0;
    this._playing = false;
    this._speed = 1;
    this._raf = null;
    this._last = 0;
  }

  /* ---- low level ------------------------------------------------------- */

  /* A cue is {start, dur, ease, apply(p, t)}. apply must set state for BOTH
     p=0 and p=1 - anything that only paints on the way up breaks scrubbing. */
  Scene.prototype.cue = function (start, dur, apply, ease) {
    this.cues.push({
      start: start || 0,
      dur: dur || 0,
      ease: typeof ease === 'function' ? ease : (EASE[ease] || EASE.out),
      apply: apply
    });
    return this;
  };

  Scene.prototype.duration = function () {
    var end = 0;
    for (var i = 0; i < this.cues.length; i++) {
      var c = this.cues[i];
      if (c.start + c.dur > end) end = c.start + c.dur;
    }
    return end + this.tail;
  };

  Scene.prototype.seek = function (t) {
    this._t = t;
    for (var i = 0; i < this.cues.length; i++) {
      var c = this.cues[i];
      var p;
      if (c.dur <= 0) p = t >= c.start ? 1 : 0;
      else p = clamp((t - c.start) / c.dur, 0, 1);
      c.apply(c.ease(p), t, p);
    }
    return this;
  };

  /* ---- primitives ------------------------------------------------------ */

  /* Tween any combination of opacity / translate / scale / rotate / blur / size.
     Values are [from, to] pairs. This is the workhorse - reveal() and progress()
     are thin wrappers over it. */
  /* Transform channels are composed per NODE, not per cue. Two tweens on one
     element each own the channels they were given; the element's transform is
     rebuilt from the union every seek. Without this, the later cue's transform
     string overwrites the earlier one's whole-cloth - including at p=0 - so an
     earlier reveal()'s rise silently disappears and the clip just looks flatter
     than you wrote it. Channel order is fixed (not authoring order) so the
     composed string stays a pure function of t. */
  var TR_ORDER = ['x', 'y', 'scale', 'rotate'];
  var TR_FMT = {
    x: function (v) { return 'translateX(' + v + 'px)'; },
    y: function (v) { return 'translateY(' + v + 'px)'; },
    scale: function (v) { return 'scale(' + v + ')'; },
    rotate: function (v) { return 'rotate(' + v + 'deg)'; }
  };
  function trState(node) {
    if (!node.__motionTr) node.__motionTr = {};
    return node.__motionTr;
  }
  function writeTr(node) {
    var st = trState(node), out = [];
    for (var i = 0; i < TR_ORDER.length; i++) {
      var k = TR_ORDER[i];
      if (st[k] !== undefined) out.push(TR_FMT[k](st[k]));
    }
    if (out.length) node.style.transform = out.join(' ');
  }

  Scene.prototype.tween = function (target, o) {
    o = o || {};
    var nodes = els(target);
    var stagger = o.stagger || 0;
    var self = this;
    nodes.forEach(function (node, i) {
      self.cue((o.start || 0) + i * stagger, o.dur === undefined ? 500 : o.dur, function (p) {
        if (o.opacity) node.style.opacity = lerp(o.opacity[0], o.opacity[1], p);
        var st = trState(node), touched = false;
        for (var j = 0; j < TR_ORDER.length; j++) {
          var k = TR_ORDER[j];
          if (o[k]) { st[k] = lerp(o[k][0], o[k][1], p); touched = true; }
        }
        if (touched) writeTr(node);
        if (o.blur) node.style.filter = 'blur(' + lerp(o.blur[0], o.blur[1], p) + 'px)';
        if (o.width) node.style.width = lerp(o.width[0], o.width[1], p) + (o.unit || '%');
        if (o.height) node.style.height = lerp(o.height[0], o.height[1], p) + (o.unit || '%');
      }, o.ease);
    });
    return this;
  };

  Scene.prototype.reveal = function (target, o) {
    o = o || {};
    return this.tween(target, {
      start: o.start, dur: o.dur === undefined ? 520 : o.dur, ease: o.ease || 'out',
      stagger: o.stagger, opacity: [0, 1], y: o.y === null ? null : [o.y === undefined ? 14 : o.y, 0]
    });
  };

  /* Typewriter. Renders text as a pure slice of the string, so any frame is
     reproducible. The caret blink is derived from t rather than a CSS animation,
     because CSS animations run on wall-clock time and would smear on export. */
  Scene.prototype.type = function (target, text, o) {
    o = o || {};
    var node = el(target);
    if (!node) return this;
    var dur = o.dur === undefined ? Math.max(400, text.length * 32) : o.dur;
    var caret = o.caret !== false;
    var hold = o.caretHold === undefined ? 900 : o.caretHold;
    var start = o.start || 0;
    return this.cue(start, dur, function (p, t) {
      node.textContent = text.slice(0, Math.round(p * text.length));
      if (caret) {
        var show = t >= start && t < start + dur + hold && Math.floor((t - start) / 500) % 2 === 0;
        node.setAttribute('data-caret', show ? '1' : '0');
      }
    }, o.ease || 'linear');
  };

  /* Reveal pre-existing children one at a time by toggling a class. The children
     must already be in the DOM (hidden by CSS) - building them during playback
     would make seek() impure. This is the code-streaming / checklist primitive. */
  Scene.prototype.sequence = function (target, o) {
    o = o || {};
    var nodes = els(target);
    var cls = o.cls || 'on';
    var n = nodes.length;
    if (!n) return this;
    return this.cue(o.start || 0, o.dur === undefined ? n * 260 : o.dur, function (p) {
      var k = Math.round(p * n);
      for (var i = 0; i < n; i++) nodes[i].classList.toggle(cls, i < k);
    }, o.ease || 'linear');
  };

  /* Eased auto-scroll of a container - the "someone is scrolling the page" move.
     `from` is explicit because reading scrollTop at seek time would make the cue
     depend on history. `toEl` resolves against layout, which is stable. */
  Scene.prototype.scroll = function (target, o) {
    o = o || {};
    var node = el(target);
    if (!node) return this;
    var pad = o.pad === undefined ? 24 : o.pad;
    return this.cue(o.start || 0, o.dur === undefined ? 800 : o.dur, function (p) {
      var to = o.to;
      if (to === undefined && o.toEl) {
        var t = el(o.toEl);
        to = t ? Math.max(0, t.offsetTop - pad) : 0;
      }
      var max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = clamp(lerp(o.from || 0, to || 0, p), 0, max);
    }, o.ease || 'inOut');
  };

  Scene.prototype.counter = function (target, o) {
    o = o || {};
    var node = el(target);
    if (!node) return this;
    var fmt = o.format || function (v) { return Math.round(v).toLocaleString(); };
    return this.cue(o.start || 0, o.dur === undefined ? 900 : o.dur, function (p) {
      node.textContent = fmt(lerp(o.from || 0, o.to || 0, p));
    }, o.ease || 'out');
  };

  Scene.prototype.progress = function (target, o) {
    o = o || {};
    return this.tween(target, {
      start: o.start, dur: o.dur === undefined ? 1200 : o.dur, ease: o.ease || 'inOut',
      width: [o.from === undefined ? 0 : o.from, o.to === undefined ? 100 : o.to]
    });
  };

  /* Hold a class between two times - status pills, "live" badges, focus rings. */
  Scene.prototype.classFor = function (target, cls, o) {
    o = o || {};
    var nodes = els(target);
    var end = o.end === undefined ? Infinity : o.end;
    var start = o.start || 0;
    return this.cue(0, 0, function (p, t) {
      var on = t >= start && t < end;
      for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle(cls, on);
    }, 'linear');
  };

  /* A labelled state machine on one element: the last entry whose `at` has passed
     wins. Use this - not chained set() calls - whenever an element changes more
     than once. Two set() cues on the same node stomp each other, because each one
     re-asserts its own "before" text at p=0 regardless of what the other wants.
     states() has no before/after, only "which entry is current at t", so it stays
     pure and composes to any number of transitions.

       S.states('#cta', [
         { at: 0,    text: 'Connect' },
         { at: 3600, text: 'Connecting...', cls: 'busy' },
         { at: 5200, text: 'Connected',     cls: 'done' }
       ]);

     Each key resolves independently, so an entry may set only `cls` and leave
     the previous entry's text in place. Before the first entry that defines
     `text`, the element's markup text stands. */
  Scene.prototype.states = function (target, list, o) {
    o = o || {};
    var nodes = els(target);
    if (!nodes.length || !list || !list.length) return this;
    /* The markup-authored text is the implicit value for any t before the first
       entry that defines `text`. Captured once at build time so it is a
       constant, not a read of live DOM at seek time. */
    var initialText = nodes.map(function (n) { return n.textContent; });
    /* Only manage textContent if the list actually sets text somewhere. A
       class-only list (status pills, focus rings) must not touch textContent at
       all - writing it would flatten the element's child markup into a string. */
    var usesText = false;
    for (var u = 0; u < list.length; u++) if (list[u].text !== undefined) usesText = true;
    return this.cue(0, 0, function (p, t) {
      /* Resolve each key INDEPENDENTLY from the last entry at-or-before t that
         defines it. Reading only the active entry's keys meant an entry that
         omitted `text` left whatever text was written last - making the frame a
         function of scrub history rather than of t, which corrupts --from/--to
         sub-range renders because those seek cold into the middle. */
      var active = null, text, attrK, attrV;
      for (var i = 0; i < list.length; i++) {
        if (t < (list[i].at || 0)) break;
        active = list[i];
        if (list[i].text !== undefined) text = list[i].text;
        if (list[i].attr) { attrK = list[i].attr; attrV = list[i].value; }
      }
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (usesText) node.textContent = text !== undefined ? text : initialText[n];
        if (attrK) node.setAttribute(attrK, attrV);
        for (var j = 0; j < list.length; j++) {
          if (list[j].cls) node.classList.toggle(list[j].cls, active === list[j]);
        }
      }
    }, 'linear');
  };

  /* Swap text or toggle a class at a single instant. Text-only by design: to
     change markup, pre-render both states in the DOM and cross-fade them with
     classFor. If the element changes more than once, use states() instead. */
  Scene.prototype.set = function (target, o) {
    o = o || {};
    var nodes = els(target);
    var at = o.at || 0;
    return this.cue(at, 0, function (p) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (o.text !== undefined && p) n.textContent = o.text;
        if (o.textBefore !== undefined && !p) n.textContent = o.textBefore;
        if (o.cls) n.classList.toggle(o.cls, !!p);
        if (o.attr) n.setAttribute(o.attr, p ? o.value : (o.valueBefore || ''));
      }
    }, 'step');
  };

  /* Synthetic pointer. Moves along a polyline of [x,y] waypoints in scene
     coordinates; segments are evenly timed. This is the primitive the slide deck
     never had, and it is the one most product-feature clips need. */
  Scene.prototype.cursor = function (target, o) {
    o = o || {};
    var node = el(target);
    var path = o.path || [];
    if (!node || path.length < 2) return this;
    return this.cue(o.start || 0, o.dur === undefined ? 900 : o.dur, function (p) {
      var segs = path.length - 1;
      var f = clamp(p * segs, 0, segs);
      var i = Math.min(Math.floor(f), segs - 1);
      var lp = f - i;
      node.style.transform = 'translate(' +
        lerp(path[i][0], path[i + 1][0], lp) + 'px,' +
        lerp(path[i][1], path[i + 1][1], lp) + 'px)';
    }, o.ease || 'inOut');
  };

  /* A click ripple at an instant - pair with cursor() so the pulse lands where
     the pointer is. */
  Scene.prototype.click = function (target, o) {
    o = o || {};
    var node = el(target);
    if (!node) return this;
    var at = o.at || 0;
    var dur = o.dur === undefined ? 520 : o.dur;
    return this.cue(at, dur, function (p, t) {
      var live = t >= at && p < 1;
      node.style.opacity = live ? String(1 - p) : '0';
      node.style.transform = 'translate(' + (o.x || 0) + 'px,' + (o.y || 0) + 'px) scale(' + lerp(0.2, 1.9, p) + ')';
    }, o.ease || 'out');
  };

  /* ---- player ---------------------------------------------------------- */

  Scene.prototype.mount = function (o) {
    o = o || {};
    var self = this;
    var dur = this.duration();

    /* Export hook. The renderer sets window.__motionExport before the document
       loads, which keeps the rAF player from fighting the frame stepper. */
    global.__motion = {
      ready: true,
      seek: function (t) { self.seek(t); },
      duration: dur,
      fps: this.fps,
      width: this.width,
      height: this.height
    };

    if (global.__motionExport) { this.seek(0); return this; }

    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { this.seek(dur); return this; }

    function frame(now) {
      if (!self._playing) { self._raf = null; return; }
      var dt = self._last ? now - self._last : 0;
      self._last = now;
      self._t += dt * self._speed;
      if (self._t >= dur) {
        if (self.loop) self._t = 0;
        else { self._t = dur; self._playing = false; }
      }
      self.seek(self._t);
      self._raf = self._playing ? requestAnimationFrame(frame) : null;
    }
    function play() { if (self._playing) return; self._playing = true; self._last = 0; self._raf = requestAnimationFrame(frame); }
    function pause() { self._playing = false; self._last = 0; }
    function replay() { self._t = 0; self.seek(0); pause(); play(); }
    function scrub(d) { pause(); self._t = clamp(self._t + d, 0, dur); self.seek(self._t); }

    this.play = play; this.pause = pause; this.replay = replay;

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); self._playing ? pause() : play(); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); replay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); scrub(250); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); scrub(-250); }
      else if (e.key === '1') self._speed = 0.5;
      else if (e.key === '2') self._speed = 1;
      else if (e.key === '3') self._speed = 2;
    });

    this.seek(0);
    if (o.autoplay !== false) setTimeout(play, o.delay === undefined ? 400 : o.delay);
    return this;
  };

  global.Motion = {
    /* Bump when a change to this runtime would alter an existing scene's frames.
       Scenes are committed as source and re-rendered later, so a silent runtime
       change is a silent asset change. */
    version: '2.0.0',
    scene: function (opts) { return new Scene(opts); },
    ease: EASE,
    lerp: lerp,
    clamp: clamp
  };
})(typeof window !== 'undefined' ? window : this);
```

### Primitives

All take `{start, dur, ease}`; `ease` is `linear | out | in | inOut | outBack | step` (default `out`). Targets are a CSS selector, an element, or a NodeList.

| Call | Does |
|---|---|
| `S.type(el, text, {start, dur, caret})` | Typewriter. Renders a pure slice of the string; caret blink derives from `t`. |
| `S.reveal(el, {start, dur, stagger, y})` | Fade + rise. Pass a NodeList with `stagger` for a staged list. |
| `S.tween(el, {opacity, x, y, scale, rotate, blur, width, height})` | The workhorse. Values are `[from, to]` pairs. |
| `S.sequence(el, {start, dur, cls})` | Toggle a class onto children one at a time. For instant appears — no CSS transition. |
| `S.scroll(el, {from, to \| toEl, pad, dur})` | Eased auto-scroll of a container. The "someone is scrolling" move. |
| `S.states(el, [{at, text, cls, attr, value}])` | State machine — last entry whose `at` has passed wins. Use for any element that changes twice or more. |
| `S.set(el, {at, text, textBefore, cls, attr})` | One instantaneous change. If it changes again later, use `states()`. |
| `S.classFor(el, cls, {start, end})` | Hold a class between two times. |
| `S.counter(el, {from, to, format})` | Tween a number. |
| `S.progress(el, {from, to})` | Width % — progress bars. |
| `S.cursor(el, {path: [[x,y],...], dur})` | Synthetic pointer along a polyline, evenly timed segments. |
| `S.click(el, {at, x, y})` | Click ripple. Pair with `cursor()` so the pulse lands under the pointer. |
| `S.cue(start, dur, apply, ease)` | Escape hatch. `apply(p, t)` — must be pure. |

`Motion.scene({width, height, fps, tail, loop})` creates the scene; `S.mount()` wires the player and exposes `window.__motion` for the renderer. `S.duration()` is computed from the cues plus `tail`.

A pointer that moves, clicks, types, and moves again is what makes a clip read as *someone using the product* rather than a diagram animating itself. Reach for `cursor()` + `click()` early.

<h2 id="renderer">Renderer</h2>

Write this verbatim as `render.mjs` next to the scene.

```js
#!/usr/bin/env node
/* Motion renderer - deterministic frame export for Motion scenes.
   Zero dependencies: drives Chrome over CDP using Node's built-in WebSocket
   (Node 22+) and shells out to ffmpeg.

   This does NOT screen-record. It steps a virtual clock: for each frame it calls
   window.__motion.seek(frameIndex * 1000 / fps), waits two rAFs for paint, and
   captures. Output is identical on a fast desktop and a throttled laptop, and
   you can render 60fps from a machine that could never play it at 60fps.

   Usage:
     node render.mjs scene.html [options]

   Options:
     --format gif|mp4|webm|frames   default gif
     --out <path>                   default <scene>.<ext>
     --fps <n>                      default: scene's fps
     --width / --height <px>        default: scene's declared size
     --dpr <n>                      capture scale factor, default 2 (retina)
     --scale <px>                   output width; height auto. default: --width
     --from / --to <ms>             render a sub-range
     --keep-frames                  don't delete the PNG frames
     --chrome <path>                override the browser binary
*/

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* ---- args ------------------------------------------------------------- */

const argv = process.argv.slice(2);
const scenePath = argv.find((a) => !a.startsWith('--'));
if (!scenePath) {
  console.error('usage: node render.mjs scene.html [--format gif|mp4|webm|frames] [--out file]');
  process.exit(1);
}
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : argv[i + 1];
}
function has(name) { return argv.includes('--' + name); }

const format = flag('format', 'gif');
const dpr = Number(flag('dpr', 2));
const absScene = path.resolve(scenePath);
if (!existsSync(absScene)) { console.error('no such scene: ' + absScene); process.exit(1); }

/* ---- locate a browser -------------------------------------------------- */

async function resolveBrowser() {
  const override = flag('chrome');
  if (override) return override;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const root = path.join(process.env.HOME || '', '.cache/puppeteer/chrome-headless-shell');
  if (existsSync(root)) {
    const builds = (await readdir(root)).sort().reverse();
    for (const b of builds) {
      for (const leaf of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64',
        'chrome-headless-shell-linux64', 'chrome-headless-shell-win64']) {
        const p = path.join(root, b, leaf, 'chrome-headless-shell');
        if (existsSync(p)) return p;
        if (existsSync(p + '.exe')) return p + '.exe';
      }
    }
  }
  // Playwright's cache is where a lot of dev boxes and CI images keep Chromium.
  // Same versioned-build-dir shape as the puppeteer cache above.
  const pw = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pw && existsSync(pw)) {
    const builds = (await readdir(pw)).filter((b) => b.startsWith('chromium')).sort().reverse();
    for (const b of builds) {
      for (const leaf of [
        'chrome-linux/chrome',
        'chrome-linux/headless_shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-win/chrome.exe'
      ]) {
        const p = path.join(pw, b, leaf);
        if (existsSync(p)) return p;
      }
    }
  }

  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]) if (existsSync(p)) return p;

  throw new Error('No Chrome found. Pass --chrome <path> or set CHROME_PATH.');
}

/* ---- minimal CDP client ------------------------------------------------ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    // Killing the browser closes the socket from under us; without a listener
    // that surfaces as an unhandled 'error' and a stack trace on a clean run.
    ws.addEventListener('error', () => {});
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        const h = this.handlers.get(msg.method);
        if (h) h(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  once(method) {
    return new Promise((resolve) => this.handlers.set(method, (p) => { this.handlers.delete(method); resolve(p); }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, why) {
  for (let i = 0; i < 100; i++) {
    // Chrome exiting immediately (bad flags, missing libs, sandbox refusal) is
    // the common failure. Bail out with what Chrome actually said rather than
    // spending 10s retrying a socket that is never going to open.
    if (why.exited) {
      throw new Error(
        'Chrome exited immediately (code ' + why.code + ').\n' +
        (why.stderr.trim() || '(no stderr)') +
        '\nHint: on a bare container also check for missing shared libraries.'
      );
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        return new CDP(ws);
      }
    } catch { /* browser not up yet */ }
    await sleep(100);
  }
  throw new Error('could not attach to Chrome');
}

/* ---- ffmpeg ------------------------------------------------------------ */

function ffmpeg(args, label) {
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) {
    console.error(String(r.stderr).split('\n').slice(-14).join('\n'));
    throw new Error(`ffmpeg failed (${label})`);
  }
}

/* ---- main -------------------------------------------------------------- */

const browser = await resolveBrowser();
const port = 9500 + Math.floor(Math.random() * 400);
const profile = await mkdtemp(path.join(tmpdir(), 'motion-profile-'));

const proc = spawn(browser, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--no-sandbox',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--force-color-profile=srgb',
  '--disable-lcd-text',
  '--allow-file-access-from-files',
  'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });

// Keep Chrome's stderr and exit status so a launch failure can be reported as
// what it actually was, not as a generic "could not attach".
const why = { exited: false, code: null, stderr: '' };
proc.stderr.on('data', (d) => { why.stderr += d; });
proc.on('exit', (code) => { why.exited = true; why.code = code; });

let cdp;
const framesDir = await mkdtemp(path.join(tmpdir(), 'motion-frames-'));

try {
  cdp = await connect(port, why);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Set the export flag before the document runs so the rAF player stays parked.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__motionExport = true;' });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: 'file://' + absScene });
  await loaded;

  // Wait for the scene to call mount()
  let meta = null;
  for (let i = 0; i < 100; i++) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'window.__motion ? JSON.stringify({d:__motion.duration,f:__motion.fps,w:__motion.width,h:__motion.height}) : ""',
      returnByValue: true
    });
    if (r.result.value) { meta = JSON.parse(r.result.value); break; }
    await sleep(50);
  }
  if (!meta) throw new Error('scene never exposed window.__motion - did you call scene.mount()?');

  const width = Number(flag('width', meta.w));
  const height = Number(flag('height', meta.h));
  const fps = Number(flag('fps', meta.f));
  const from = Number(flag('from', 0));
  const to = Number(flag('to', meta.d));
  const outWidth = Number(flag('scale', width));

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: false
  });

  const total = Math.max(1, Math.round(((to - from) / 1000) * fps));
  process.stderr.write(`motion: ${total} frames @ ${fps}fps  ${width}x${height} (dpr ${dpr})\n`);

  for (let f = 0; f < total; f++) {
    const t = from + (f * 1000) / fps;
    await cdp.send('Runtime.evaluate', {
      expression: `window.__motion.seek(${t}); new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
      awaitPromise: true
    });
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true
    });
    await writeFile(path.join(framesDir, `f_${String(f).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (f % 15 === 0 || f === total - 1) process.stderr.write(`\r  frame ${f + 1}/${total}`);
  }
  process.stderr.write('\n');

  const base = absScene.replace(/\.html?$/i, '');
  const pattern = path.join(framesDir, 'f_%05d.png');

  if (format === 'frames') {
    const dest = flag('out', base + '-frames');
    await mkdir(dest, { recursive: true });
    for (const f of await readdir(framesDir)) {
      await writeFile(path.join(dest, f), await (await import('node:fs/promises')).readFile(path.join(framesDir, f)));
    }
    console.log(dest);
  } else if (format === 'gif') {
    const out = flag('out', base + '.gif');
    const palette = path.join(framesDir, 'palette.png');
    const scaleF = `fps=${fps},scale=${outWidth}:-1:flags=lanczos`;
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-vf', `${scaleF},palettegen=stats_mode=diff`, palette], 'palettegen');
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-i', palette, '-lavfi',
      `${scaleF} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
      '-loop', '0', out], 'paletteuse');
    console.log(out);
  } else if (format === 'mp4') {
    const out = flag('out', base + '.mp4');
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-vf',
      `scale=${outWidth}:-2:flags=lanczos`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-crf', '18', '-movflags', '+faststart', out], 'x264');
    console.log(out);
  } else if (format === 'webm') {
    const out = flag('out', base + '.webm');
    ffmpeg(['-y', '-framerate', String(fps), '-i', pattern, '-vf',
      `scale=${outWidth}:-2:flags=lanczos`, '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', out], 'vp9');
    console.log(out);
  } else {
    throw new Error('unknown --format: ' + format);
  }
} finally {
  try { cdp?.ws.close(); } catch { /* already gone */ }
  proc.kill();
  // Chrome keeps flushing its profile for a moment after kill(); deleting it too
  // eagerly throws ENOTEMPTY on a render that already succeeded.
  await new Promise((r) => {
    if (proc.exitCode !== null) return r();
    proc.once('exit', r);
    setTimeout(r, 2000);
  });
  // Cleanup must never fail a render that already wrote its output.
  if (!has('keep-frames') && format !== 'frames') await rm(framesDir, { recursive: true, force: true }).catch(() => {});
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
```

<h2 id="scene-skeleton">Scene skeleton</h2>

Start here. Sized canvas, pre-built DOM, runtime inlined, cues declared, `mount()` last.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Scene</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0B0F14; --panel:#121821; --line:#1E2833; --text:#E8EDF2;
    --dim:#8B9AAB; --accent:#38BDF8; --ok:#34D399;
    --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
    --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  }
  /* exact canvas: the renderer captures the viewport */
  html,body{width:1200px;height:675px;overflow:hidden;background:var(--bg)}
  body{font-family:var(--ui);color:var(--text);display:flex;align-items:center;justify-content:center}

  .app{position:relative;width:1080px;height:580px;background:var(--panel);
       border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .chrome{display:flex;align-items:center;gap:10px;height:44px;padding:0 16px;
          border-bottom:1px solid var(--line)}
  .badge{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
         color:var(--dim);border:1px solid var(--line);border-radius:99px;padding:4px 10px}
  .badge.live{color:var(--ok);border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.08)}

  /* animated elements start hidden and carry NO transition - cues drive them */
  .row{opacity:0}

  .cursor{position:absolute;top:0;left:0;width:20px;height:20px;pointer-events:none;z-index:20}
  .ripple{position:absolute;top:0;left:0;width:26px;height:26px;margin:-13px 0 0 -13px;
          border-radius:50%;border:2px solid var(--accent);opacity:0;z-index:19}
</style>
</head>
<body>
  <div class="app">
    <div class="chrome"><span class="badge" id="badge">idle</span></div>

    <!-- every state pre-rendered; cues reveal it -->
    <div id="rows">
      <div class="row">first</div>
      <div class="row">second</div>
    </div>

    <div class="ripple" id="ripple"></div>
    <svg class="cursor" id="cursor" viewBox="0 0 20 20" fill="none">
      <path d="M4 2l11 8.5-5 .6-2.6 4.9L4 2z" fill="#fff" stroke="#0B0F14"
            stroke-width="1.2" stroke-linejoin="round"/>
    </svg>
  </div>

<script>
/* --- paste the Scene runtime here --- */
</script>
<script>
(function () {
  var S = Motion.scene({ width: 1200, height: 675, fps: 30, tail: 900 });

  S.cursor('#cursor', { start: 200, dur: 900, path: [[820, 520], [200, 268]] });
  S.click('#ripple', { at: 1080, x: 200, y: 274 });

  S.states('#badge', [
    { at: 0, text: 'idle' },
    { at: 2400, text: 'running' },
    { at: 4200, text: 'done', cls: 'live' }
  ]);

  S.reveal('#rows .row', { start: 4300, dur: 420, stagger: 190, y: 8 });

  S.mount();
})();
</script>
</body>
</html>
```

## Notes

- **Fake the UI, don't screenshot it.** Hand-built chrome stays readable at GIF scale, renders crisply at any size, and never leaks real data. Match the product's palette and type, not its pixels.
- **Iterate with `--from`/`--to`, and at `--dpr 1`.** Re-rendering the whole clip to check one transition is the slowest possible loop, and dpr 1 halves capture time (measured: 13.9s vs 27.1s for 151 frames). Render the final pass at the default dpr 2 — it is not just sharper, it also produces a *smaller* GIF, because supersampled text dithers more cleanly.
- **Output sizing.** GIF at `--scale 900` suits Slack and READMEs; MP4 at full width suits slides and social. MP4 is typically 2–5× smaller than the same clip as GIF — prefer it wherever autoplay video is allowed.
- **Render cost is capture, not encode.** ~180ms/frame at dpr 2, dominated by CDP screenshot round-trips. A 6s clip is a ~35s job, so anything automated around this is a queue, not a request/response.
- **`--format frames`** hands a PNG sequence to Descript, Premiere, or Resolve when the clip needs voiceover or to sit in a longer edit.
- **Determinism is a feature, not trivia.** Because renders are byte-identical, you can commit a scene and regenerate the exact asset later, and a diff on the output means the *scene* changed. The corollary: the runtime is versioned (`Motion.version`) because a change to it is a change to every committed scene's output.
- **The renderer runs headless anywhere.** It passes `--no-sandbox` (Chrome refuses to start as root otherwise) and finds Chromium in the Playwright and Puppeteer caches as well as the usual system paths. If Chrome dies on launch it reports Chrome's own stderr rather than a generic attach timeout.
- **Reduced motion is handled.** With `prefers-reduced-motion: reduce`, `mount()` jumps to the end state instead of animating. Keep the end state legible on its own.
- **Related:** `/verify-app` for checking a real running app in a browser; `/scaffold` for new projects. This skill deliberately renders a *fabricated* UI — if you need footage of the real product, record it instead.
