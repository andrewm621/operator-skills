/* GENERATED from ../SKILL.md — do not edit here.
   Edit the Scene runtime in SKILL.md, then run: node scenes/sync.mjs */
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
