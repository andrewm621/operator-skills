#!/usr/bin/env node
// lint.mjs - checks an onboarding spec (spec.yaml) with no dependencies.
//
//   node lint.mjs [spec.yaml] [--schema onboarding-spec.schema.json] [--strict] [--json]
//
// Exit codes: 0 = clean (warnings allowed), 1 = errors (or warnings with
// --strict), 2 = the file could not be read or parsed.
//
// 1. Schema: the file is checked against onboarding-spec.schema.json by a small
//    built-in validator (type, enum, const, required, properties,
//    additionalProperties, items, minItems, minProperties, minimum, minLength,
//    pattern, anyOf, if/then, $ref into #/$defs). Not a full JSON Schema engine.
// 2. Cross-references (errors): every completes_on event, activation event and
//    email trigger/unless event is declared in events; exactly one default
//    segment; every non-default segment has a path; paths point at real
//    segments and steps; ids are unique; intake answers used by segments exist.
// 3. Softer checks (warnings): copy keys that do not exist, steps no path uses,
//    paths that never reach the activation event, emails with no unsubscribe
//    suppression, funnel stages that match nothing, and similar.
//
// The YAML reader below handles the subset a spec needs: block maps and lists,
// one-line flow maps and lists ({a: b}, [a, b]), plain and quoted scalars,
// comments, and | / > block text. No anchors, tags or multiple documents, no
// flow maps or lists that span lines, and no "__proto__" keys.
// A .json file is read as JSON.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Minimal YAML reader
// ---------------------------------------------------------------------------

class YamlError extends Error {}

// "__proto__" as a key would set the prototype of the plain object it lands on
// instead of becoming a property, so the entry would vanish without a trace.
function checkKey(key, where) {
  if (key === "__proto__") throw new YamlError(`${where}: the key '__proto__' is not allowed`);
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") i++;
        else quote = null;
      }
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(text[i - 1]))) {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function plainScalar(s) {
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?(0|[1-9]\d*)$/.test(s)) return Number(s);
  if (/^-?(0|[1-9]\d*)\.\d+$/.test(s)) return Number(s);
  return s;
}

function quotedScalar(s, where) {
  if (s[0] === '"') {
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`${where}: bad double-quoted string ${s}`);
    }
  }
  return s.slice(1, -1).replace(/''/g, "'");
}

// Length of the quoted string that starts at s[0], or -1 if it never closes.
function quotedLength(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") i++;
    else if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") i++;
      else return i + 1;
    }
  }
  return -1;
}

function checkUnsupported(s, where) {
  if (/^[&*!]/.test(s)) throw new YamlError(`${where}: anchors, aliases and tags are not supported (${s.split(/\s/)[0]})`);
}

// Flow collections: {a: 1, b: [x, y]} and [a, b]. Recursive descent over one string.
function parseFlow(src, where) {
  let i = 0;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };

  function value(terminators) {
    ws();
    if (src[i] === "{") return map();
    if (src[i] === "[") return list();
    if (src[i] === '"' || src[i] === "'") {
      const len = quotedLength(src.slice(i));
      if (len < 0) throw new YamlError(`${where}: unterminated quote in ${src}`);
      const out = quotedScalar(src.slice(i, i + len), where);
      i += len;
      return out;
    }
    const start = i;
    while (i < src.length && !terminators.includes(src[i])) {
      if (src[i] === ":" && (i + 1 >= src.length || /[\s,\]}]/.test(src[i + 1])) && terminators.includes(":")) break;
      i++;
    }
    checkUnsupported(src.slice(start, i).trim(), where);
    return plainScalar(src.slice(start, i).trim());
  }

  function map() {
    const out = {};
    i++; // {
    ws();
    if (src[i] === "}") { i++; return out; }
    for (;;) {
      const key = value([":", ",", "}"]);
      ws();
      if (src[i] !== ":") throw new YamlError(`${where}: expected ':' after key '${key}' in ${src}`);
      i++;
      const val = value([",", "}"]);
      checkKey(key, where);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new YamlError(`${where}: duplicate key '${key}'`);
      out[key] = val;
      ws();
      if (src[i] === ",") { i++; ws(); if (src[i] === "}") { i++; return out; } continue; }
      if (src[i] === "}") { i++; return out; }
      throw new YamlError(`${where}: expected ',' or '}' in ${src}`);
    }
  }

  function list() {
    const out = [];
    i++; // [
    ws();
    if (src[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value([",", "]"]));
      ws();
      if (src[i] === ",") { i++; ws(); if (src[i] === "]") { i++; return out; } continue; }
      if (src[i] === "]") { i++; return out; }
      throw new YamlError(`${where}: expected ',' or ']' in ${src}`);
    }
  }

  const result = value([]);
  ws();
  if (i < src.length) throw new YamlError(`${where}: unexpected text after value: ${src.slice(i)}`);
  return result;
}

function parseInline(text, where) {
  const s = text.trim();
  checkUnsupported(s, where);
  if (s[0] === "{" || s[0] === "[") return parseFlow(s, where);
  if (s[0] === '"' || s[0] === "'") {
    const len = quotedLength(s);
    if (len < 0) throw new YamlError(`${where}: unterminated quote (multi-line strings are not supported; use | or >)`);
    if (len !== s.length) throw new YamlError(`${where}: unexpected text after quoted string`);
    return quotedScalar(s, where);
  }
  return plainScalar(s);
}

// Splits "key: rest" for a block line. Returns null if the line is not a key line.
function splitKey(text, where) {
  if (text[0] === "{" || text[0] === "[") return null;
  if (text[0] === '"' || text[0] === "'") {
    const len = quotedLength(text);
    if (len < 0) return null;
    const after = text.slice(len);
    if (after[0] !== ":" || (after.length > 1 && !/\s/.test(after[1]))) return null;
    return { key: quotedScalar(text.slice(0, len), where), rest: after.slice(1).trim() };
  }
  const m = text.match(/^([^:]*?):(?:\s+(.*))?$/);
  if (!m || /^[-?]\s*$/.test(m[1])) return null;
  return { key: m[1].trim(), rest: (m[2] ?? "").trim() };
}

function parseYaml(source) {
  const raw = source.replace(/\r\n?/g, "\n").split("\n");
  if (raw.some((l) => /^\t|^ *\t/.test(l))) throw new YamlError("tabs are not allowed for indentation");
  const lines = [];
  raw.forEach((line, n) => {
    if (line === "---" && lines.length === 0) return;
    const text = stripComment(line.trim() === "" ? "" : line);
    if (text.trim() === "") return;
    lines.push({ n, indent: text.length - text.trimStart().length, text: text.trim() });
  });
  let pos = 0;
  const here = (l) => `line ${l.n + 1}`;

  function blockScalar(parent, header, line) {
    // Read raw lines after `line` that are blank or indented deeper than the parent.
    const style = header[0];
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const body = [];
    let n = line.n + 1;
    let blockIndent = null;
    for (; n < raw.length; n++) {
      const r = raw[n];
      if (r.trim() === "") { body.push(""); continue; }
      const ind = r.length - r.trimStart().length;
      if (ind <= parent) break;
      if (blockIndent === null) blockIndent = ind;
      body.push(r.slice(Math.min(blockIndent, ind)));
    }
    while (pos < lines.length && lines[pos].n < n) pos++;
    while (body.length && body[body.length - 1] === "") body.pop();
    let out = style === "|" ? body.join("\n") : body.join(" ").replace(/ {2,}/g, " ");
    if (chomp !== "strip") out += "\n";
    return out;
  }

  function node(indent) {
    const line = lines[pos];
    if (line.text === "-" || line.text.startsWith("- ")) return sequence(line.indent);
    if (splitKey(line.text, here(line))) return mapping(line.indent);
    pos++;
    return parseInline(line.text, here(line));
  }

  function sequence(indent) {
    const out = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text === "-" || lines[pos].text.startsWith("- "))) {
      const line = lines[pos];
      const rest = line.text.slice(1);
      const content = rest.trimStart();
      if (content === "") {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) out.push(node(lines[pos].indent));
        else out.push(null);
      } else {
        // Treat "- key: v" as a virtual line indented past the dash and re-read it.
        const offset = 1 + (rest.length - content.length);
        lines[pos] = { ...line, indent: indent + offset, text: content };
        out.push(node(indent + offset));
      }
    }
    return out;
  }

  function mapping(indent) {
    const out = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos];
      const kv = splitKey(line.text, here(line));
      if (!kv) {
        if (line.text === "-" || line.text.startsWith("- ")) throw new YamlError(`${here(line)}: list item where a key was expected`);
        throw new YamlError(`${here(line)}: expected "key: value", got "${line.text}"`);
      }
      checkKey(kv.key, here(line));
      if (Object.prototype.hasOwnProperty.call(out, kv.key)) throw new YamlError(`${here(line)}: duplicate key '${kv.key}'`);
      let value;
      if (/^[|>][+-]?$/.test(kv.rest)) {
        pos++;
        value = blockScalar(indent, kv.rest, line);
      } else if (kv.rest === "") {
        pos++;
        const next = lines[pos];
        if (next && next.indent > indent) value = node(next.indent);
        else if (next && next.indent === indent && (next.text === "-" || next.text.startsWith("- "))) value = sequence(indent);
        else value = null;
      } else {
        pos++;
        value = parseInline(kv.rest, here(line));
      }
      out[kv.key] = value;
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new YamlError(`${here(lines[pos])}: unexpected indentation`);
    }
    return out;
  }

  if (lines.length === 0) return null;
  const root = node(lines[0].indent);
  if (pos < lines.length) throw new YamlError(`${here(lines[pos])}: unexpected content "${lines[pos].text}"`);
  return root;
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator
// ---------------------------------------------------------------------------

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const matchesType = (v, t) => (t === "number" ? typeof v === "number" : typeOf(v) === t);
const show = (v) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

function validate(schema, data, root, path = "", errors = []) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    if (!target) throw new Error(`schema: cannot resolve ${schema.$ref}`);
    validate(target, data, root, path, errors);
    return errors;
  }
  const at = path || "(root)";
  const fail = (msg) => errors.push({ path: at, message: msg });

  if ("const" in schema && JSON.stringify(data) !== JSON.stringify(schema.const)) {
    fail(`must be ${show(schema.const)}, found ${show(data)}`);
    return errors;
  }
  if (schema.enum && !schema.enum.some((e) => e === data)) {
    fail(`must be one of ${schema.enum.map(show).join(", ")}; found ${show(data)}`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(data, t))) {
      fail(`must be ${types.join(" or ")}, found ${typeOf(data)}`);
      return errors;
    }
  }
  if (typeof data === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) fail("must not be empty");
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      fail(`${show(data)} is not valid here${schema.description ? ` (${schema.description})` : ""}`);
    }
  }
  if (typeof data === "number" && schema.minimum !== undefined && data < schema.minimum) {
    fail(`must be at least ${schema.minimum}, found ${data}`);
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) fail(`needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
    if (schema.items) data.forEach((item, i) => validate(schema.items, item, root, `${path}[${i}]`, errors));
  }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (schema.minProperties !== undefined && Object.keys(data).length < schema.minProperties) fail(`needs at least ${schema.minProperties} entr${schema.minProperties === 1 ? "y" : "ies"}`);
    for (const key of schema.required ?? []) {
      if (!(key in data)) fail(`missing required property '${key}'`);
    }
    const props = schema.properties ?? {};
    for (const [key, value] of Object.entries(data)) {
      const childPath = path ? `${path}.${key}` : key;
      if (props[key]) validate(props[key], value, root, childPath, errors);
      else if (schema.additionalProperties === false) errors.push({ path: childPath, message: `unknown property '${key}'` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") validate(schema.additionalProperties, value, root, childPath, errors);
    }
  }
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((s) => validate(s, data, root, path, []));
    if (!attempts.some((a) => a.length === 0)) {
      // A branch that declares the data's type has the useful errors; otherwise say so generically.
      const typed = schema.anyOf.findIndex((s) => s.type && [].concat(s.type).some((t) => matchesType(data, t)));
      if (schema.description && schema.anyOf.every((s) => s.required)) fail(schema.description);
      else if (typed >= 0 && attempts[typed].length) errors.push(...attempts[typed]);
      else fail(`is not valid here${schema.description ? ` (${schema.description})` : ""}; found ${show(data)}`);
    }
  }
  if (schema.if && validate(schema.if, data, root, path, []).length === 0 && schema.then) {
    validate(schema.then, data, root, path, errors);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Cross-reference checks
// ---------------------------------------------------------------------------

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function dupes(items, key) {
  const seen = new Set();
  const out = [];
  items.forEach((it) => {
    const id = isObj(it) ? it[key] : undefined;
    if (typeof id !== "string") return;
    if (seen.has(id)) out.push(id);
    seen.add(id);
  });
  return out;
}

function lookupCopy(copyKeys, key) {
  if (!isObj(copyKeys)) return false;
  const k = key.replace(/^copy\./, "");
  if (k in copyKeys) return true;
  let cur = copyKeys;
  for (const part of k.split(".")) {
    if (!isObj(cur) || !(part in cur)) return false;
    cur = cur[part];
  }
  return true;
}

function crossCheck(spec) {
  const errors = [];
  const warnings = [];
  const info = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  const events = arr(spec.events);
  const steps = arr(spec.steps);
  const segments = arr(spec.segments);
  const paths = arr(spec.paths);
  const emails = arr(spec.emails);
  const tours = arr(spec.tours);
  const questions = arr(spec.intake?.questions);

  for (const [label, list] of [["events", events], ["steps", steps], ["segments", segments], ["emails", emails], ["tours", tours], ["intake.questions", questions]]) {
    for (const id of dupes(list, label === "events" ? "name" : "id")) err(label, `duplicate ${label === "events" ? "name" : "id"} '${id}'`);
  }

  const eventNames = new Set(events.map((e) => e?.name).filter(Boolean));
  const stepIds = new Set(steps.map((s) => s?.id).filter(Boolean));
  const segmentIds = new Set(segments.map((s) => s?.id).filter(Boolean));
  const requireEvent = (path, name) => {
    if (typeof name === "string" && !eventNames.has(name)) err(path, `event '${name}' is not declared in events`);
  };

  // Events
  if (spec.activation) {
    requireEvent("activation.activation_event", spec.activation.activation_event);
    if (spec.activation.aha_event) requireEvent("activation.aha_event", spec.activation.aha_event);
  }
  steps.forEach((s, i) => {
    if (s?.completes_on?.event) requireEvent(`steps[${i}].completes_on`, s.completes_on.event);
  });
  emails.forEach((e, i) => {
    requireEvent(`emails[${i}].trigger.after`, e?.trigger?.after);
    for (const u of [].concat(e?.trigger?.unless ?? [])) requireEvent(`emails[${i}].trigger.unless`, u);
  });
  const missing = events.filter((e) => e?.exists === false).map((e) => e.name);
  if (missing.length) info.push(`${missing.length} event${missing.length === 1 ? "" : "s"} to instrument (exists: false): ${missing.join(", ")}`);

  // Segments and paths
  const defaults = segments.filter((s) => s?.match === "default");
  if (segments.length && defaults.length !== 1) {
    err("segments", defaults.length === 0 ? "no default segment (one segment needs match: default)" : `${defaults.length} default segments (${defaults.map((s) => s.id).join(", ")}); exactly one is allowed`);
  }
  const pathBySegment = new Map();
  paths.forEach((p, i) => {
    if (!p) return;
    if (p.segment && !segmentIds.has(p.segment)) err(`paths[${i}].segment`, `segment '${p.segment}' does not exist`);
    if (pathBySegment.has(p.segment)) err(`paths[${i}].segment`, `segment '${p.segment}' already has a path`);
    pathBySegment.set(p.segment, p);
    arr(p.steps).forEach((sid, j) => {
      if (!stepIds.has(sid)) err(`paths[${i}].steps[${j}]`, `step '${sid}' does not exist in steps`);
    });
  });
  segments.forEach((s, i) => {
    if (!s || !s.id || pathBySegment.has(s.id)) return;
    if (s.match === "default") warn(`segments[${i}]`, `default segment '${s.id}' has no path; users who match nothing else get no guidance`);
    else err(`segments[${i}]`, `segment '${s.id}' has no path`);
  });

  // Intake answers used by segment matching
  const questionById = new Map(questions.map((q) => [q?.id, q]));
  segments.forEach((s, i) => {
    if (!isObj(s?.match)) return;
    for (const [key, values] of Object.entries(s.match)) {
      const m = key.match(/^intake\.(.+)$/);
      if (!m) { err(`segments[${i}].match`, `'${key}' must start with intake. (for example intake.business_type)`); continue; }
      const q = questionById.get(m[1]);
      if (!q) { err(`segments[${i}].match`, `intake question '${m[1]}' does not exist`); continue; }
      if (arr(q.options).length) {
        for (const v of arr(values)) {
          if (!q.options.includes(v)) warn(`segments[${i}].match`, `value '${v}' is not one of the options for intake question '${m[1]}'`);
        }
      }
    }
  });

  // Emails point at real segments
  emails.forEach((e, i) => {
    if (e?.segment && e.segment !== "*" && !segmentIds.has(e.segment)) err(`emails[${i}].segment`, `segment '${e.segment}' does not exist (use * for everyone)`);
    if (e && !arr(e.suppress).includes("unsubscribed")) warn(`emails[${i}]`, `email '${e.id}' does not list 'unsubscribed' in suppress`);
  });

  // Tours: unique step ids within a tour
  tours.forEach((t, i) => {
    for (const id of dupes(arr(t?.steps), "id")) err(`tours[${i}].steps`, `duplicate tour step id '${id}'`);
  });

  // Steps that nothing uses, paths that never activate
  const used = new Set(paths.flatMap((p) => arr(p?.steps)));
  steps.forEach((s, i) => {
    if (s?.id && !used.has(s.id)) warn(`steps[${i}]`, `step '${s.id}' is not used by any path`);
  });
  const activation = spec.activation?.activation_event;
  if (activation) {
    paths.forEach((p, i) => {
      const reaches = arr(p?.steps).some((sid) => steps.find((s) => s?.id === sid)?.completes_on?.event === activation);
      if (p && !reaches) warn(`paths[${i}]`, `path for '${p.segment}' has no step that completes on '${activation}'; check it can reach activation`);
    });
  }

  // Funnel stages
  arr(spec.measurement?.funnel).forEach((stage, i) => {
    if (typeof stage === "string" && !eventNames.has(stage) && !stepIds.has(stage)) {
      warn(`measurement.funnel[${i}]`, `stage '${stage}' is neither a declared event nor a step id`);
    }
  });

  // Copy keys (warnings only)
  const copyKeys = spec.copy?.keys;
  const checkCopy = (path, key) => {
    if (typeof key === "string" && !lookupCopy(copyKeys, key)) warn(path, `copy key '${key}' is not defined in copy.keys`);
  };
  questions.forEach((q, i) => q?.copy && checkCopy(`intake.questions[${i}].copy`, q.copy));
  steps.forEach((s, i) => {
    if (s?.copy) checkCopy(`steps[${i}].copy`, s.copy);
    arr(s?.blocked_when).forEach((b, j) => checkCopy(`steps[${i}].blocked_when[${j}].show`, b?.show));
  });
  tours.forEach((t, i) => arr(t?.steps).forEach((ts, j) => checkCopy(`tours[${i}].steps[${j}].copy`, ts?.copy)));
  emails.forEach((e, i) => checkCopy(`emails[${i}].copy`, e?.copy));

  return { errors, warnings, info };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  let file = null;
  let schemaPath = join(here, "onboarding-spec.schema.json");
  let strict = false;
  let dump = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--schema") schemaPath = argv[++i];
    else if (argv[i] === "--strict") strict = true;
    else if (argv[i] === "--json") dump = true;
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("usage: node lint.mjs [spec.yaml] [--schema file.json] [--strict] [--json]\n  --json prints the parsed spec as JSON and exits (to see how the YAML was read)");
      return 0;
    } else if (argv[i].startsWith("--")) {
      console.error(`unknown option ${argv[i]}`);
      return 2;
    } else file = argv[i];
  }
  file ??= "spec.yaml";

  let spec;
  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch (e) {
    console.error(`cannot read schema ${schemaPath}: ${e.message}`);
    return 2;
  }
  try {
    const text = readFileSync(file, "utf8");
    spec = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    console.error(`${file}: cannot parse: ${e.message}`);
    return 2;
  }

  if (dump) {
    console.log(JSON.stringify(spec, null, 2));
    return 0;
  }

  const schemaErrors = validate(schema, spec, schema);
  // Cross-checks assume a roughly right shape; skip them if the root is not even a map.
  const cross = isObj(spec) ? crossCheck(spec) : { errors: [], warnings: [], info: [] };
  const errors = [...schemaErrors, ...cross.errors];
  const warnings = cross.warnings;

  for (const e of errors) console.log(`ERROR  ${e.path}: ${e.message}`);
  for (const w of warnings) console.log(`WARN   ${w.path}: ${w.message}`);
  for (const n of cross.info) console.log(`INFO   ${n}`);
  const failed = errors.length > 0 || (strict && warnings.length > 0);
  console.log(`${failed ? "FAIL" : "PASS"}  ${file}: ${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}${strict && warnings.length ? " (--strict)" : ""}`);
  return failed ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
