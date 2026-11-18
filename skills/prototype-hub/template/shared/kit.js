/* Small shared helpers for every prototype page. Classic script, no dependencies.
   Load after data.js. Everything lives on window.Kit. Client-specific helpers go in
   shared/domain.js, not here. */
(function () {
  "use strict";

  var D = window.PROTO_DATA || { meta: {} };
  var META = D.meta || {};
  var PREFIX = "proto:" + (META.slug || "demo") + ":";
  var memory = {}; /* stands in when localStorage is blocked */
  var resetHandler = null;
  var labelMounted = false;

  /* ---------- DOM ---------- */
  /* el("button", { class: "btn", onclick: fn, dataset: { id: 1 }, disabled: true }, "Text", childNode, [more]) */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) { return; }
      if (k === "class" || k === "className") { node.className = v; }
      else if (k === "html") { node.innerHTML = v; }
      else if (k === "style" && typeof v === "object") { Object.assign(node.style, v); }
      else if (k === "dataset") { Object.assign(node.dataset, v); }
      else if (k.indexOf("on") === 0 && typeof v === "function") { node.addEventListener(k.slice(2).toLowerCase(), v); }
      else if (k === "value" || k === "checked") { node[k] = v; }
      else if (v === true) { node.setAttribute(k, ""); }
      else { node.setAttribute(k, v); }
    });
    for (var i = 2; i < arguments.length; i++) { append(node, arguments[i]); }
    return node;
  }

  function append(node, child) {
    if (child === null || child === undefined || child === false) { return; }
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }

  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
    return node;
  }

  /* ---------- Storage: nothing here throws, even in a locked-down iframe ---------- */
  function pageId() {
    var name = "";
    try { name = (location.pathname.split("/").pop() || "").replace(/\.html?$/i, ""); } catch (e) { name = ""; }
    return Kit.pageName || name || "page";
  }

  /* Short keys are kept per page. A key starting with the shared prefix is used as written,
     which is how one page hands something to the next. */
  function fullKey(key) { return key.indexOf(PREFIX) === 0 ? key : PREFIX + pageId() + ":" + key; }
  function sharedKey(key) { return PREFIX + "shared:" + key; }

  function safeGet(key, fallback) {
    var k = fullKey(key);
    var text = null;
    try { text = window.localStorage.getItem(k); } catch (e) { text = null; }
    if (text === null && Object.prototype.hasOwnProperty.call(memory, k)) { text = memory[k]; }
    if (text === null) { return fallback === undefined ? null : fallback; }
    try { return JSON.parse(text); } catch (e) { return fallback === undefined ? null : fallback; }
  }

  function safeSet(key, value) {
    var k = fullKey(key);
    var text = JSON.stringify(value);
    memory[k] = text;
    try { window.localStorage.setItem(k, text); return true; } catch (e) { return false; }
  }

  function safeRemove(key) {
    var k = fullKey(key);
    delete memory[k];
    try { window.localStorage.removeItem(k); } catch (e) { /* blocked store: memory is already clear */ }
  }

  /* Clears this page's keys and nothing else */
  function clearPage() {
    var start = PREFIX + pageId() + ":";
    Object.keys(memory).forEach(function (k) { if (k.indexOf(start) === 0) { delete memory[k]; } });
    try {
      var doomed = [];
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf(start) === 0) { doomed.push(k); }
      }
      doomed.forEach(function (k) { window.localStorage.removeItem(k); });
    } catch (e) { /* blocked store: memory is already clear */ }
  }

  /* ---------- The persistent label and Reset demo ---------- */
  /* mountProtoLabel("Option A: Three buttons", { page: "option-a", onReset: render }) */
  function mountProtoLabel(optionName, opts) {
    var o = opts || {};
    if (o.page) { Kit.pageName = o.page; }
    if (o.onReset) { resetHandler = o.onReset; }
    var old = document.querySelector(".proto-label");
    if (old) { old.parentNode.removeChild(old); }
    var label = el("div", { class: "proto-label", role: "note", "data-proto-label": "1" },
      el("span", null, META.prototypeLabel || "Prototype. Made-up data. Not connected to anything."),
      optionName ? el("span", { class: "proto-option" }, optionName) : null,
      el("button", { class: "proto-reset", type: "button", onclick: resetDemo }, "Reset demo")
    );
    document.body.appendChild(label);
    labelMounted = true;
    return label;
  }

  function onReset(fn) { resetHandler = fn; }

  function resetDemo() {
    clearPage();
    if (resetHandler) {
      resetHandler();
      toast("Demo reset");
    } else {
      window.location.reload();
    }
  }

  /* A page that forgets the label still gets it */
  function autoMount() { if (!labelMounted) { mountProtoLabel(); } }
  if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", autoMount); }
  else { setTimeout(autoMount, 0); }

  var toastTimer = null;
  function toast(text, ms) {
    var node = document.querySelector(".toast");
    if (!node) {
      node = el("div", { class: "toast", role: "status" });
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.add("hidden"); }, ms || 2600);
    return node;
  }

  /* Clipboard is often blocked on file:// and in iframes, so fall back to a hidden textarea */
  function copyText(text, doneMessage) {
    var message = doneMessage || "Copied. Nothing was sent.";
    function fallback() {
      var area = el("textarea", { style: { position: "fixed", left: "-9999px" } });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(area);
      toast(ok ? message : "Copy is blocked here. Select the text and copy it.");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(message); }, fallback);
    } else {
      fallback();
    }
  }

  /* ---------- Role switcher: one set of records, many views ---------- */
  /* Kit.roleSwitcher({ roles: [{ id: "pm", label: "PM" }] or ["PM"], label: "View as", key: "role", onChange: fn })
     Remembers the choice. Read it back with Kit.currentRole(roles). */
  function normalizeRoles(roles) {
    return roles.map(function (r) { return typeof r === "string" ? { id: r, label: r } : r; });
  }

  function currentRole(roles, key) {
    var list = normalizeRoles(roles);
    var saved = safeGet(key || "role");
    var hit = list.filter(function (r) { return r.id === saved; })[0];
    return hit ? hit.id : list[0].id;
  }

  function roleSwitcher(opts) {
    var roles = normalizeRoles(opts.roles);
    var key = opts.key || "role";
    var active = opts.value || currentRole(roles, key);
    var wrap = el("div", { class: "seg", role: "group", "aria-label": opts.label || "View as" });
    if (opts.label !== "") { wrap.appendChild(el("span", { class: "seg-label" }, opts.label || "View as")); }
    roles.forEach(function (r) {
      wrap.appendChild(el("button", {
        class: "chip", type: "button", "aria-pressed": r.id === active ? "true" : "false", dataset: { role: r.id },
        onclick: function () {
          active = r.id;
          safeSet(key, r.id);
          Array.prototype.forEach.call(wrap.querySelectorAll(".chip"), function (b) {
            b.setAttribute("aria-pressed", b.dataset.role === active ? "true" : "false");
          });
          if (opts.onChange) { opts.onChange(r.id); }
        }
      }, r.label));
    });
    return wrap;
  }

  /* ---------- Badges and honest labels ---------- */
  var TONES = ["neutral", "under", "over", "pin", "manual", "unknown", "late"];
  function badge(text, tone) {
    return el("span", { class: "badge badge-" + (TONES.indexOf(tone) === -1 ? "neutral" : tone) }, text);
  }
  function source(text) { return el("span", { class: "source" }, text || META.sourceLabel || "Made-up source"); }
  function ideaLabel() { return el("span", { class: "label-idea" }, META.ideaLabel || "Idea, not agreed"); }
  function onlyIfLabel() { return el("span", { class: "label-onlyif" }, META.onlyIfLabel || "Needs approval"); }
  function aiSample(text) {
    return el("div", { class: "sample-output" },
      el("span", { class: "sample-label" }, META.aiOffLabel || "Sample output. No AI is running."),
      text);
  }

  /* ---------- Small helpers ---------- */
  function byId(list, id) {
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
    return null;
  }
  function formatDate(iso) {
    if (!iso) { return ""; }
    var parts = iso.split("-");
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10);
  }

  var Kit = {
    pageName: null,
    data: D,
    el: el, clear: clear,
    store: { get: safeGet, set: safeSet, remove: safeRemove, clearPage: clearPage },
    safeGet: safeGet, safeSet: safeSet, safeRemove: safeRemove, sharedKey: sharedKey,
    mountProtoLabel: mountProtoLabel, onReset: onReset, resetDemo: resetDemo,
    toast: toast, copyText: copyText,
    roleSwitcher: roleSwitcher, currentRole: currentRole,
    badge: badge, source: source, ideaLabel: ideaLabel, onlyIfLabel: onlyIfLabel, aiSample: aiSample,
    byId: byId, formatDate: formatDate
  };

  window.Kit = Kit;
})();
