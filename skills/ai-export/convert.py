#!/usr/bin/env python3
"""convert.py -- turn an ai-export ChatGPT bundle into one markdown note per conversation plus an index note.

Run it isolated, with every path passed as an argument:

    python3 -I convert.py --input data/bundle.json --out-dir out/ --date 2026-10-16

The bundle is UNTRUSTED data from a chat export. This script only parses JSON and writes text: no eval/exec, no
subprocess, no network, no imports beyond the standard library. Filenames come from a strict slug whitelist
(never a raw title), files are created exclusively (never overwritten) and must resolve inside --out-dir.

Only the ChatGPT `mapping` / `current_node` shape is supported (verified 2026-10-13). Claude.ai and Grok shapes are
unverified, so this refuses them rather than guessing.

Frontmatter is deliberately minimal and vault-agnostic. Vault-specific keys are opt-in: `--id-key NAME` adds a fresh
uuid4 under that key, and `--fm KEY=VALUE` (repeatable) adds fixed keys such as a vault's default `type`. Keys that start
with `_` are reserved for vault tooling and are refused (never written, so `_organized` can't be stamped).

Account pulls (schema 3) arrive as several part files. Pass them all, or their directory, as one pull:

    python3 -I convert.py --input data/ --out-dir out/ --date 2026-11-10      # every chatgpt-account-*-part-NNN.json[.gz]
    python3 -I convert.py --input data/a.json --input data/b.json --out-dir out/

Parts are read one at a time (twice: once for the headers, once to render), so memory holds one part, not the pull.
`account_plan` groups them into runs (the pull plus any resume runs) and is shared with verify.py, so "complete"
has one definition.
"""
import argparse
import collections
import datetime
import gzip
import hashlib
import json
import os
import re
import sys
import unicodedata
import uuid

MAX_INPUT_MB = 256            # refuse bigger bundles outright
MAX_CONVERSATIONS = 5000
MAX_NODES_PER_CONV = 100000   # mapping nodes walked per conversation
MAX_MESSAGE_CHARS = 1000000   # per message, longer is cut with a marker
MAX_FILE_CHARS = 20000000     # per output note, longer is cut with a marker
MAX_BRANCH_MESSAGES = 5000    # rendered per off-path branch; 500 cut a real 595-message branch, MAX_BRANCH_CHARS is the real bound
MAX_BRANCHES = 200            # per conversation
TOOL_CALL_CHARS = 400         # compact tool rendering, matches the existing vault output
TOOL_RESULT_CHARS = 500

# Always used with .fullmatch(): `$` would also accept a trailing newline.
PROJECT_RE = re.compile(r"g-p-[A-Za-z0-9-]{8,64}")
CONV_ID_RE = re.compile(r"[0-9a-fA-F-]{36}")
MODEL_RE = re.compile(r"[A-Za-z0-9._:/-]{1,64}")
TS_RE = re.compile(r"[0-9T:Z-]*")
JWT_VALUE_RE = re.compile(r"eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*")
TOKEN_KEYS = ("accesstoken", "access_token")
MAX_BRANCH_CHARS = 4000000    # total rendered across ALL off-path branches of one conversation
SLUG_MAX = 80
MAX_ACCOUNT_CONVERSATIONS = 100000   # across all parts of one account pull
MAX_PARTS = 1000
RUN_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}")
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
PART_NAME_RE = re.compile(r"chatgpt-account-([0-9]{8}T[0-9]{6}Z-[0-9a-f]{6})-part-([0-9]{3})\.json(?:\.gz)?")
REQUIRED_SOURCES = ("main", "archived", "projects")
PRIVATE_USE_SPAN = re.compile("\ue200.*?\ue201", re.S)   # ChatGPT citation / entity markers
PRIVATE_USE_CHARS = re.compile("[\ue000-\uf8ff]")
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def token_scan(root):
    """Structural check: an accessToken/access_token key anywhere outside message content. Returns
    (key_hits, jwt_values). Message `content` is skipped, so a thread that merely talks about tokens never matches."""
    key_hits = jwt_values = visited = 0
    stack = [root]
    while stack and visited < 3000000:
        node = stack.pop()
        visited += 1
        if isinstance(node, dict):
            is_message = "author" in node and "content" in node
            for k, v in node.items():
                if is_message and k == "content":
                    continue
                if isinstance(k, str) and k.lower() in TOKEN_KEYS:
                    key_hits += 1
                    if isinstance(v, str) and JWT_VALUE_RE.fullmatch(v.strip()):
                        jwt_values += 1
                stack.append(v)
        elif isinstance(node, list):
            stack.extend(node)
    return key_hits, jwt_values


def die(msg, code=2):
    print("convert.py: " + msg, file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------- small helpers

def clean_title(raw, fallback):
    """One line, no control characters, trimmed (titles can end in a newline)."""
    t = CONTROL_CHARS.sub("", str(raw if raw is not None else ""))
    t = " ".join(t.split())
    return t or fallback


def slugify(title):
    """ASCII [a-z0-9-] only, so '../' or any separator can never survive."""
    t = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:SLUG_MAX].strip("-")
    return t


def yq(s):
    """Double-quoted YAML scalar. JSON string escapes are valid YAML escapes."""
    return json.dumps(str(s), ensure_ascii=False)


FM_KEY_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,39}")
BUILTIN_KEYS = {"type", "created", "source", "conversation_id", "title", "conv_created", "conv_updated", "model",
                "triage", "url", "related_to", "tags", "belongs_to"}


def parse_extra_fm(items, id_key):
    """Validate --id-key / --fm into ordered (key, value) pairs; value None means 'fresh uuid4'. Dies on a bad key."""
    pairs, seen = [], set()
    if id_key:
        pairs.append((id_key, None))
    for item in items:
        key, sep, value = item.partition("=")
        if not sep:
            die("--fm expects KEY=VALUE, got %r" % item)
        pairs.append((key, value))
    for key, _ in pairs:
        if not FM_KEY_RE.fullmatch(key):
            die("frontmatter key %r must match [A-Za-z][A-Za-z0-9_-]* (keys starting with '_' are reserved for vault tooling)" % key)
        if key in BUILTIN_KEYS or key in seen:
            die("frontmatter key %r is already written by this script or repeated" % key)
        seen.add(key)
    return pairs


def extra_fm_lines(args):
    """Frontmatter lines for the opt-in keys. Values are always double-quoted scalars, so they can't inject keys."""
    return ["%s: %s" % (k, str(uuid.uuid4()) if v is None else yq(v)) for k, v in args.extra_fm]


def to_epoch(t):
    """epoch seconds / epoch ms / ISO string -> float seconds, or None."""
    if t is None or isinstance(t, bool):
        return None
    try:
        if isinstance(t, (int, float)):
            v = float(t)
            return v / 1000.0 if v > 1e11 else v
        if isinstance(t, str):
            s = t.strip()
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
                s += "T00:00:00+00:00"
            s = re.sub(r"Z$", "+00:00", s)
            d = datetime.datetime.fromisoformat(s)
            if d.tzinfo is None:
                d = d.replace(tzinfo=datetime.timezone.utc)
            return d.timestamp()
    except (ValueError, OverflowError, OSError):
        return None
    return None


def safe_model(v):
    """Model slug if it is a plain token, else None. Used for headings AND frontmatter."""
    return v if isinstance(v, str) and MODEL_RE.fullmatch(v) else None


def safe_ts(v):
    """Timestamps are written unquoted into frontmatter, so only digits and T : Z - may pass."""
    return v if isinstance(v, str) and TS_RE.fullmatch(v) else ""


def iso(t, minute=False):
    e = to_epoch(t)
    if e is None:
        return ""
    try:
        d = datetime.datetime.fromtimestamp(e, datetime.timezone.utc)
    except (ValueError, OverflowError, OSError):
        return ""
    return d.strftime("%Y-%m-%dT%H:%M" if minute else "%Y-%m-%dT%H:%M:%SZ")


def cap(text, limit):
    if len(text) <= limit:
        return text
    return text[:limit] + "\n[... truncated %d chars]" % (len(text) - limit)


def fence(text, lang=""):
    """Code fence longer than any backtick run inside, so content can't close it early."""
    longest = max([len(m) for m in re.findall(r"`+", text)] or [0])
    f = "`" * max(3, longest + 1)
    lang = re.sub(r"[^A-Za-z0-9_+.-]", "", lang or "")[:20]
    return "%s%s\n%s\n%s" % (f, lang, text.rstrip("\n"), f)


def quote(text):
    return "\n".join(("> " + line).rstrip() for line in text.splitlines()) or ">"


def as_dict(x):
    return x if isinstance(x, dict) else {}


def as_list(x):
    return x if isinstance(x, list) else []


# ---------------------------------------------------------------- message rendering

def apply_citations(text, meta):
    """Best effort: turn web citation markers into ([site](url)) and drop the rest of the private-use markers."""
    for ref in as_list(meta.get("content_references")):
        ref = as_dict(ref)
        matched = ref.get("matched_text")
        if not isinstance(matched, str) or not matched or len(matched) > 500:
            continue
        links = []
        for item in as_list(ref.get("items"))[:3]:
            item = as_dict(item)
            url = item.get("url")
            if isinstance(url, str) and re.match(r"https?://", url):
                site = clean_title(item.get("attribution") or re.sub(r"^https?://([^/]+).*$", r"\1", url), "source")
                site = re.sub(r"[\[\]()]", "", site)
                links.append("[%s](%s)" % (site, url.replace(")", "%29").replace(" ", "%20")))
        text = text.replace(matched, (" (" + ", ".join(links) + ")") if links else "", 1)
    text = PRIVATE_USE_SPAN.sub("", text)
    return PRIVATE_USE_CHARS.sub("", text)


def content_text(content):
    """Return (kind, text) for a message content dict, or (None, '') when it should not be rendered."""
    content = as_dict(content)
    ct = content.get("content_type")
    parts = as_list(content.get("parts"))
    if ct in ("thoughts", "reasoning_recap", "user_editable_context", "model_editable_context", "system_error"):
        return None, ""
    if ct in ("text", "multimodal_text") or (ct is None and parts):
        out = []
        for p in parts:
            if isinstance(p, str):
                out.append(p)
            elif isinstance(p, dict) and p.get("content_type") == "image_asset_pointer":
                out.append("[image attachment]")
            elif isinstance(p, dict) and p.get("content_type") == "audio_transcription" and isinstance(p.get("text"), str):
                out.append(p["text"])   # voice mode: the spoken text; audio pointers stay outside the JSON
        return "text", "\n\n".join(s for s in out if s.strip())
    if ct == "code":
        text = content.get("text")
        if isinstance(text, str):
            return "code", text
        return None, ""
    if ct == "execution_output":
        text = content.get("text")
        return ("result", text) if isinstance(text, str) else (None, "")
    if ct in ("tether_browsing_display", "tether_quote", "sonic_webpage"):
        text = content.get("result") or content.get("text")
        return ("result", text) if isinstance(text, str) else (None, "")
    text = content.get("text")
    if isinstance(text, str):
        return "text", text
    strs = [p for p in parts if isinstance(p, str)]
    return ("text", "\n\n".join(strs)) if strs else (None, "")


def is_voice(content):
    return any(isinstance(p, dict) and p.get("content_type") == "audio_transcription" for p in as_list(as_dict(content).get("parts")))


def render_message(msg, heading_level):
    """Markdown for one mapping message, or '' when it is hidden/system/empty. Returns (markdown, role, model)."""
    msg = as_dict(msg)
    author = as_dict(msg.get("author"))
    role = author.get("role")
    meta = as_dict(msg.get("metadata"))
    if role not in ("user", "assistant", "tool"):
        return "", role, None
    if meta.get("is_visually_hidden_from_conversation") or meta.get("is_user_system_message"):
        return "", role, None
    kind, text = content_text(msg.get("content"))
    if kind is None:
        return "", role, None
    text = cap(text, MAX_MESSAGE_CHARS)
    lang = as_dict(msg.get("content")).get("language")
    stamp = iso(msg.get("create_time"), minute=True)
    model = safe_model(meta.get("model_slug"))
    hashes = "#" * heading_level

    if role == "tool" or kind == "result":
        if not text.strip():
            return "", role, None
        name = clean_title(author.get("name"), "tool")
        body = cap(apply_citations(text, meta), TOOL_RESULT_CHARS)
        return "> **tool result** (%s, %s), %d chars:\n%s\n" % (name, stamp[-5:], len(text), quote(body)), role, None
    if role == "assistant" and msg.get("recipient") not in (None, "all"):
        if not text.strip():
            return "", role, None
        body = cap(text, TOOL_CALL_CHARS)
        return "> **tool call** (%s, %s), %d chars:\n%s\n" % (
            clean_title(msg.get("recipient"), "tool"), stamp[-5:], len(text), quote(body)), role, None

    text = apply_citations(text, meta)
    if not text.strip():
        return "", role, None
    if kind == "code":
        text = fence(text, lang if isinstance(lang, str) and lang != "unknown" else "")
    who = "User" if role == "user" else "Assistant"
    head = "%s %s · %s" % (hashes, who, stamp)
    if role == "assistant":
        if model:
            head += " · " + model
        if msg.get("channel") == "commentary":
            head += " · commentary"
    if is_voice(msg.get("content")):
        head += " · voice"
    return "%s\n\n%s\n" % (head, text), role, model


# ---------------------------------------------------------------- tree walking

def main_path(mapping, current):
    """current_node -> root via parents (cycle-safe), returned root first."""
    path, seen = [], set()
    node_id = current
    while isinstance(node_id, str) and node_id in mapping and node_id not in seen and len(seen) < MAX_NODES_PER_CONV:
        seen.add(node_id)
        path.append(node_id)
        node_id = as_dict(mapping[node_id]).get("parent")
    path.reverse()
    return path


def node_time(mapping, nid):
    return to_epoch(as_dict(as_dict(mapping.get(nid)).get("message")).get("create_time")) or 0.0


def subtree(mapping, root, seen):
    """DFS order, children sorted by create_time. `seen` is shared and mutated: it starts as the main path and
    accumulates every node already rendered in any branch, so a node reachable from several forks is output once."""
    out, stack = [], [root]
    while stack and len(out) < MAX_NODES_PER_CONV:
        nid = stack.pop()
        if nid in seen or nid not in mapping:
            continue
        seen.add(nid)
        out.append(nid)
        kids = [k for k in as_list(as_dict(mapping[nid]).get("children")) if isinstance(k, str)]
        stack.extend(sorted(kids, key=lambda k: node_time(mapping, k), reverse=True))
    return out


def branch_label(i):
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return letters[i] if i < 26 else str(i + 1)


def fork_context(mapping, path, idx):
    """Describe the nearest visible message at or above path[idx]."""
    for j in range(idx, -1, -1):
        msg = as_dict(as_dict(mapping.get(path[j])).get("message"))
        md, role, _ = render_message(msg, 2)
        if md:
            kind, text = content_text(msg.get("content"))
            snippet = clean_title(text, "")[:100]
            return "after %s message at %s: \"%s\"" % (role, iso(msg.get("create_time"), True), snippet)
    return "at the start of the conversation"


def render_branches(mapping, path):
    seen = set(path)               # shared across ALL branches: each node is rendered at most once
    budget = MAX_BRANCH_CHARS
    sections, count = [], 0
    for idx, nid in enumerate(path):
        kids = [k for k in as_list(as_dict(mapping[nid]).get("children")) if isinstance(k, str) and k in mapping]
        for kid in kids:
            if kid in seen:
                continue
            if count >= MAX_BRANCHES:
                sections.append("*[more branches omitted: limit of %d reached]*\n" % MAX_BRANCHES)
                return "\n".join(sections), count
            if budget <= 0:
                sections.append("*[remaining branches omitted: output budget of %d chars reached]*\n" % MAX_BRANCH_CHARS)
                return "\n".join(sections), count
            rendered = []
            for sid in subtree(mapping, kid, seen):
                md, _, _ = render_message(as_dict(mapping[sid]).get("message"), 4)
                if md:
                    budget -= len(md)
                    rendered.append(md)
                if len(rendered) >= MAX_BRANCH_MESSAGES:
                    rendered.append("*[branch truncated at %d messages]*\n" % MAX_BRANCH_MESSAGES)
                    break
                if budget <= 0:
                    rendered.append("*[branch truncated: output budget reached]*\n")
                    break
            if not rendered:
                continue
            sections.append("### Branch %s (forks %s)\n\n%s" % (branch_label(count), fork_context(mapping, path, idx), "\n".join(rendered)))
            count += 1
    return "\n".join(sections), count


# ---------------------------------------------------------------- conversation -> note

def convert_conversation(conv, row, bundle, args):
    """Return dict(title, body, frontmatter fields) for one conversation."""
    conv = as_dict(conv)
    row = as_dict(row)
    mapping = as_dict(conv.get("mapping"))
    conv_id = conv.get("conversation_id") or conv.get("id") or row.get("id") or ""
    conv_id = conv_id if isinstance(conv_id, str) and CONV_ID_RE.fullmatch(conv_id) else ""
    title = clean_title(conv.get("title") or row.get("title"), "Untitled conversation")
    path = main_path(mapping, conv.get("current_node"))
    cutoff = to_epoch(bundle.get("since")) if bundle.get("since") else None
    triage = row.get("triage")
    triage = triage.upper() if isinstance(triage, str) and triage in ("new", "grown", "unchanged") else ""

    blocks, models, msgs, marker_done = [], collections.Counter(), 0, False
    for nid in path:
        msg = as_dict(as_dict(mapping.get(nid)).get("message"))
        md, role, model = render_message(msg, 2)
        if not md:
            continue
        msgs += 1
        if role == "assistant" and model:
            models[model] += 1
        t = to_epoch(msg.get("create_time"))
        if triage == "GROWN" and cutoff and not marker_done and t and t > cutoff:
            blocks.append("> **Messages below were added after the previous pull (%s).**\n" % iso(cutoff))
            marker_done = True
        blocks.append(md)
    branches_md, branch_count = render_branches(mapping, path)

    canvas_ids = []
    for n in mapping.values():
        td = as_dict(as_dict(as_dict(as_dict(n).get("message")).get("metadata")).get("canvas")).get("textdoc_id")
        if isinstance(td, str) and td not in canvas_ids:
            canvas_ids.append(td)

    created = safe_ts(iso(conv.get("create_time") or row.get("create_time")))
    updated = safe_ts(iso(conv.get("update_time") or row.get("update_time")))
    project = row.get("project") if isinstance(row.get("project"), str) and PROJECT_RE.fullmatch(row["project"]) else ""
    return {
        "title": title, "conv_id": conv_id, "created": created, "updated": updated,
        "model": (safe_model(models.most_common(1)[0][0]) or "") if models else "", "triage": triage,
        "messages": msgs, "branches": branch_count, "blocks": blocks, "branches_md": branches_md,
        "off_path": max(0, len(mapping) - len(path)), "canvas_ids": canvas_ids,
        "project": project, "project_name": clean_title(row.get("project_name"), "")[:200] if project else "",
    }


def note_text(c, args, bundle, index_link):
    kind = bundle.get("kind") if bundle.get("kind") in ("project", "thread", "account") else "project"
    project = c["project"] if kind == "account" else bundle.get("project")
    url = ""
    if c["conv_id"]:
        if kind in ("project", "account") and isinstance(project, str) and PROJECT_RE.fullmatch(project):
            url = "https://chatgpt.com/g/%s/c/%s" % (project, c["conv_id"])
        else:
            url = "https://chatgpt.com/c/%s" % c["conv_id"]
    tags = ["src-chatgpt-thread"] + [t for t in args.tag if re.fullmatch(r"[A-Za-z0-9_-]{1,40}", t)]
    fm = ["---"] + extra_fm_lines(args)[:1 if args.id_key else 0] + [
          "type: source",
          "created: " + args.date,
          "source: chatgpt-" + kind,
          "conversation_id: " + yq(c["conv_id"]),
          "title: " + yq(c["title"]),
          "conv_created: " + safe_ts(c["created"]),
          "conv_updated: " + safe_ts(c["updated"]),
          "model: " + yq(c["model"])]
    if c["triage"]:
        fm.append("triage: " + c["triage"])
    if url:
        fm.append("url: " + yq(url))
    if kind == "account":   # every account note says which project it is in ("" = none)
        fm += ["project: " + yq(c["project"]), "project_name: " + yq(c["project_name"])]
    if args.related_to:
        fm.append("related_to: " + yq(args.related_to))
    fm += extra_fm_lines(args)[1 if args.id_key else 0:]
    fm.append("tags:")
    fm += ["  - " + t for t in tags]
    fm += ["belongs_to:", "  - " + yq(index_link), "---"]

    intro = ("> Rendered from the %s pull (current branch path from root to `current_node`; hidden reasoning, system "
             "and spinner messages omitted; tool calls and results shown compactly and truncated)." % args.date)
    if c["triage"]:
        intro += " Triage: **%s**." % c["triage"]
    parts = ["\n".join(fm), "# " + c["title"], intro, "---"] + c["blocks"]
    if c["branches_md"]:
        parts += ["---", "## Other branches", c["branches_md"]]
    docs = getattr(args, "textdocs", None) or {}
    if c["canvas_ids"]:
        section = ["---", "## Canvas documents"]
        for td in c["canvas_ids"]:
            d = as_dict(docs.get(td))
            title = clean_title(d.get("title"), td)
            if isinstance(d.get("content"), str):
                kind = d.get("textdoc_type") if isinstance(d.get("textdoc_type"), str) else ""
                lang = kind.split("/", 1)[1] if kind.startswith("code/") else "markdown"
                section.append("### %s\n\n`%s`, version %s\n\n%s" % (title, td, clean_title(d.get("version"), "?")[:12],
                                                                        fence(cap(d["content"], MAX_MESSAGE_CHARS), lang)))
            else:
                section.append("### %s\n\n`%s`: not in this bundle (pull with `fetchTextdocs: true` to include it)" % (title, td))
        parts += section
    text = "\n\n".join(p.rstrip("\n") for p in parts if p) + "\n"
    if len(text) > MAX_FILE_CHARS:
        text = text[:MAX_FILE_CHARS] + "\n\n[... note truncated at %d chars]\n" % MAX_FILE_CHARS
    return text


def write_exclusive(out_dir, name, text):
    path = os.path.join(out_dir, name)
    if os.path.dirname(os.path.realpath(path)) != out_dir:
        die("refusing to write outside the output dir: " + name)
    try:
        with open(path, "x", encoding="utf-8", newline="\n") as f:   # 'x' = never overwrite or follow an existing link
            f.write(text)
    except FileExistsError:
        die("%s already exists in the output dir; use a fresh, empty --out-dir" % name)
    return path


def unique_slug(slug, conv_id, used):
    slug = slug or "untitled"
    if slug in used or slug == "index":
        slug = "%s-%s" % (slug, conv_id[:8] if conv_id else "dup")
    n, candidate = 2, slug
    while candidate in used:
        candidate = "%s-%d" % (slug, n)
        n += 1
    used.add(candidate)
    return candidate


# ---------------------------------------------------------------- account pulls (schema 3, several part files)

class PartError(ValueError):
    """A part file that can't be read; callers turn it into their own error message."""


def is_account_part(b):
    return isinstance(b, dict) and b.get("schema") == 3 and b.get("kind") == "account"


def expand_inputs(paths):
    """Files as given (order kept); a directory contributes its chatgpt-account-…-part-NNN.json[.gz] files, sorted.
    Duplicates are kept on purpose so account_plan can report a part given twice."""
    out = []
    for p in paths:
        real = os.path.realpath(p)
        if os.path.isdir(real):
            names = sorted(n for n in os.listdir(real) if PART_NAME_RE.fullmatch(n))
            if not names:
                raise PartError("no chatgpt-account-<run>-part-NNN.json files in %s" % p)
            out += [os.path.join(real, n) for n in names]
        elif os.path.isfile(real):
            out.append(real)
        else:
            raise PartError("input is not a file or directory: %s" % p)
    return out


def read_json_file(path, max_mb):
    """(object, sha256 of the uncompressed bytes, uncompressed size, text_hit). gzip is detected by its magic bytes."""
    with open(path, "rb") as f:
        head = f.read(2)
    opener = gzip.open if head == b"\x1f\x8b" else open
    with opener(path, "rb") as f:
        raw = f.read(max_mb * 1024 * 1024 + 1)
    if len(raw) > max_mb * 1024 * 1024:
        raise PartError("%s is over the %d MB guard (uncompressed)" % (os.path.basename(path), max_mb))
    sha = hashlib.sha256(raw).hexdigest()
    text_hit = b"accessToken" in raw or bool(re.search(rb"eyJ[A-Za-z0-9_-]{20,}\.eyJ", raw))
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        raise PartError("%s is not valid JSON: %s" % (os.path.basename(path), type(e).__name__))
    return obj, sha, len(raw), text_hit


def conv_key(conv):
    cid = conv.get("conversation_id") or conv.get("id")
    return cid if isinstance(cid, str) else None


def part_header(b, path, sha="", size=0):
    """The small facts about one part that grouping needs. Conversation bodies are not kept, only their ids."""
    name = os.path.basename(path)
    h = {"path": path, "name": name, "sha256": sha, "size": size, "invalid": None}
    run, part, final = b.get("run_id"), b.get("part"), b.get("final")
    if not is_account_part(b):
        h["invalid"] = "not a schema-3 account part"
    elif not (isinstance(run, str) and RUN_ID_RE.fullmatch(run)):
        h["invalid"] = "run_id"
    elif not (isinstance(part, int) and not isinstance(part, bool) and 0 <= part < MAX_PARTS):
        h["invalid"] = "part index"
    elif not isinstance(final, bool):
        h["invalid"] = "final flag"
    elif b.get("resume_of") is not None and not (isinstance(b.get("resume_of"), str) and RUN_ID_RE.fullmatch(b["resume_of"])):
        h["invalid"] = "resume_of"
    m = PART_NAME_RE.fullmatch(name)
    convs = [c for c in as_list(b.get("conversations")) if isinstance(c, dict)]
    only = b.get("only_ids")
    h.update({
        "run_id": run, "part": part, "final": final, "resume_of": b.get("resume_of"),
        "name_run": m.group(1) if m else None, "name_part": int(m.group(2)) if m else None,
        "started_at": b.get("started_at") if isinstance(b.get("started_at"), str) else None,
        "pulled_at": b.get("pulled_at") if isinstance(b.get("pulled_at"), str) else None,
        "since": b.get("since"), "list_only": b.get("list_only") is True, "fetch_unchanged": b.get("fetch_unchanged") is True,
        "listing_skipped": b.get("listing_skipped") is True, "listing_complete": b.get("listing_complete") is True,
        "stop_reason": b.get("stop_reason"), "error": b.get("error") if isinstance(b.get("error"), str) else None,
        "rate_limit": b.get("rate_limit") if isinstance(b.get("rate_limit"), dict) else None,
        "capped": b.get("capped") is True, "capped_by": b.get("capped_by"), "remaining": b.get("remaining") if isinstance(b.get("remaining"), int) else None,
        "sources": b.get("sources") if isinstance(b.get("sources"), dict) else None,
        "only_ids": [i for i in only if isinstance(i, str)] if isinstance(only, list) else None,
        "listing": [r for r in as_list(b.get("listing")) if isinstance(r, dict)],
        "ids": [i for i in as_list(b.get("ids")) if isinstance(i, str)],
        "conv_ids": [conv_key(c) for c in convs], "no_id": sum(1 for c in convs if conv_key(c) is None),
        "errors": [as_dict(e) for e in as_list(b.get("errors"))],
        "textdoc_errors": [as_dict(e) for e in as_list(b.get("textdoc_errors"))],
        "attachments": [as_dict(a) for a in as_list(b.get("attachments"))[:200]],
        "attachment_count": len(as_list(b.get("attachments"))),
        "textdoc_count": len(as_dict(b.get("textdocs"))), "has_textdocs": "textdocs" in b,
    })
    h["conv_ids"] = [c for c in h["conv_ids"] if c is not None]
    return h


def account_plan(headers, part_only=False):
    """Group part headers into one logical pull: the primary run plus the resume runs that name it in resume_of.
    Returns problems as (level, scope, msg); 'fatal' lists the ones that make the input ambiguous (convert.py refuses
    those). With part_only, run-level completeness (missing parts, final part, coverage) is reported as INFO."""
    probs, fatal = [], []

    def add(level, scope, msg, run_level=False, is_fatal=False):
        if part_only and run_level and level == "FAIL":
            level = "INFO"
        probs.append((level, scope, msg))
        if is_fatal:
            fatal.append(msg)

    valid = []
    for h in headers:
        if h["invalid"]:
            add("FAIL", "parts", "%s: not a valid account part (%s)" % (h["name"], h["invalid"]), is_fatal=True)
            continue
        if h["name_run"] is None:
            add("WARN", "parts", "%s: not a canonical part file name; checked by its header" % h["name"])
        elif (h["name_run"], h["name_part"]) != (h["run_id"], h["part"]):
            add("FAIL", "parts", "%s: file name says run %s part %d, its header says run %s part %d" % (
                h["name"], h["name_run"], h["name_part"], h["run_id"], h["part"]), is_fatal=True)
        valid.append(h)
    plan = {"problems": probs, "fatal": fatal, "primary": None, "order": [], "listing": [], "rows": {}, "to_fetch": [],
            "missing": [], "winner": {}, "errors_unresolved": [], "sources": None, "since": None, "started_at": None,
            "pulled_at": None, "fetch_unchanged": False, "capped": False, "complete": False}
    runs = collections.OrderedDict()
    for h in valid:
        runs.setdefault(h["run_id"], []).append(h)
    if not runs:
        add("FAIL", "parts", "no account parts to check", is_fatal=True)
        return plan

    def run_key(rid):
        return (runs[rid][0]["started_at"] or "", rid)

    primaries = sorted((rid for rid, hs in runs.items() if hs[0]["resume_of"] is None), key=run_key)
    if not primaries:
        add("FAIL", "runs", "no primary run: every part is a resume run (resume_of set); add the parts of the pull it resumes",
            is_fatal=True)
        return plan
    if len(primaries) > 1:
        add("FAIL", "runs", "mismatched run ids: parts from %d separate pulls (%s); check one pull and its resume runs at a time"
            % (len(primaries), ", ".join(primaries)), is_fatal=True)
    primary = primaries[0]
    resumes = []
    for rid in sorted(runs, key=run_key):
        if rid == primary:
            continue
        ro = runs[rid][0]["resume_of"]
        if ro is None:
            continue   # a second primary, reported above
        if ro != primary:
            add("FAIL", "runs", "mismatched run ids: run %s resumes %s, not the pull being checked (%s)" % (rid, ro, primary),
                is_fatal=True)
            continue
        resumes.append(rid)
    order = [primary] + resumes
    latest = order[-1]

    for rid in order:
        hs = sorted(runs[rid], key=lambda x: x["part"])
        scope = "run %s" % rid
        counts = collections.Counter(h["part"] for h in hs)
        for idx, n in sorted(counts.items()):
            if n > 1:
                add("FAIL", scope, "part %d given %d times" % (idx, n), is_fatal=True)
        uniq, seen_idx = [], set()
        for h in hs:
            if h["part"] not in seen_idx:
                seen_idx.add(h["part"])
                uniq.append(h)
        plan["order"].append((rid, uniq))
        lvl = "FAIL" if rid == latest else "WARN"
        later = "" if rid == latest else " (a later resume run follows; coverage below decides)"
        top = uniq[-1]["part"]
        gaps = sorted(set(range(top + 1)) - seen_idx)
        if gaps:
            add(lvl, scope, "part(s) %s missing%s" % (", ".join(str(g) for g in gaps[:20]), later), run_level=True)
        finals = [h for h in uniq if h["final"]]
        if not finals:
            add(lvl, scope, "no final part: the run ended early or its last part was not downloaded%s" % later, run_level=True)
        elif len(finals) > 1:
            add("FAIL", scope, "%d parts are marked final" % len(finals))
        elif finals[0]["part"] != top:
            add("FAIL", scope, "part(s) after the final part %d" % finals[0]["part"])
        for key in ("started_at", "since", "list_only", "fetch_unchanged", "only_ids", "resume_of", "listing_skipped"):
            if len({json.dumps(h[key], sort_keys=True) for h in uniq}) > 1:
                add("FAIL", scope, "parts disagree on %s" % key)
        if len({tuple(r.get("id") for r in h["listing"]) for h in uniq}) > 1:
            add("FAIL", scope, "parts carry different listings")
        for h in finals[:1]:
            if h["error"]:
                add(lvl, scope, "run ended in error: %s%s" % (h["error"][:200], later))
            rl = h["rate_limit"]
            if rl:
                ra = rl.get("retry_after_s")
                add("INFO", scope, "rate limited (429) during %s after %s fetch(es); retry-after %s" % (
                    rl.get("phase") if rl.get("phase") in ("listing", "fetching") else "?",
                    rl.get("done") if isinstance(rl.get("done"), int) else "?",
                    "%s s" % ra if isinstance(ra, (int, float)) and not isinstance(ra, bool) else "not given"))
            if h["capped"]:
                add("INFO", scope, "run capped (by %s); %s thread(s) left for the next run" % (
                    h["capped_by"] if h["capped_by"] in ("threads", "time") else "a limit", h["remaining"]))
                plan["capped"] = True

    # ---- the primary run's listing is the pull's listing
    first = plan["order"][0][1][0]
    listing = first["listing"]
    plan.update(listing=listing, since=first["since"], started_at=first["started_at"], fetch_unchanged=first["fetch_unchanged"],
                sources=first["sources"], primary=primary)
    pulled = [h["pulled_at"] for _, hs in plan["order"] for h in hs if h["pulled_at"]]
    plan["pulled_at"] = max(pulled) if pulled else None
    if first["list_only"]:
        add("FAIL", "listing", "list-only preview: no conversation bodies were fetched")
    ids = [r.get("id") for r in listing]
    dup = [k for k, v in collections.Counter(ids).items() if v > 1]
    if dup:
        add("FAIL", "listing", "%d id(s) listed more than once" % len(dup))
    bad = [i for i in ids if not (isinstance(i, str) and UUID_RE.fullmatch(i))]
    if bad:
        add("FAIL", "listing", "%d listing row(s) without a valid conversation id" % len(bad))
    src = first["sources"]
    if not isinstance(src, dict):
        add("FAIL", "listing", "the primary run has no per-source listing record")
    else:
        for key in REQUIRED_SOURCES:
            st = as_dict(src.get(key))
            stop = st.get("stop_reason")
            if stop == "complete":
                continue
            if stop == "since_cutoff" and key == "main" and first["since"]:
                add("INFO", "listing", "main list stopped at the since cutoff (incremental pull; older threads not relisted)")
            else:
                add("FAIL", "listing", "listing source %s stopped: %r" % (key, stop))
        arch = as_dict(src.get("archived"))
        if isinstance(arch.get("count"), int) and arch["count"] > 0 and arch.get("new") == 0:
            add("WARN", "listing", "archived listing returned only threads already in the main list (is_archived may be ignored)")
        pt = as_dict(src.get("project_threads"))
        bad_pt = sorted((gid, as_dict(st).get("stop_reason")) for gid, st in pt.items() if as_dict(st).get("stop_reason") != "complete")
        if bad_pt:
            add("FAIL", "listing", "%d project listing(s) did not end normally: %s" % (
                len(bad_pt), ", ".join("%s %r" % kv for kv in bad_pt[:5])))
        sidebar = as_dict(src.get("projects")).get("count")
        if isinstance(sidebar, int) and sidebar != len(pt):
            add("FAIL", "listing", "the sidebar listed %d projects but %d project listings were recorded" % (sidebar, len(pt)))

    # ---- coverage: every to-fetch thread of the primary in some part, each part's ids header true
    rows = collections.OrderedDict((r.get("id"), r) for r in listing if isinstance(r.get("id"), str))
    for rid in order[1:]:
        for r in plan["order"][order.index(rid)][1][0]["listing"]:
            if isinstance(r.get("id"), str) and r["id"] not in rows:
                rows[r["id"]] = r
    plan["rows"] = rows
    if first["only_ids"] is not None:
        to_fetch = list(first["only_ids"])
    else:
        to_fetch = [r.get("id") for r in listing if first["fetch_unchanged"] or r.get("triage") != "unchanged"]
    allowed = set(rows) | set(to_fetch)
    for rid in order[1:]:
        allowed |= set(plan["order"][order.index(rid)][1][0]["only_ids"] or [])
    winner, cross_dups = {}, 0
    for rid, hs in plan["order"]:
        in_run = set()
        for h in hs:
            if h["ids"] != h["conv_ids"]:
                add("FAIL", "parts", "%s: its ids header does not match the conversations it holds" % h["name"])
            if h["no_id"]:
                add("FAIL", "parts", "%s: %d conversation(s) without an id" % (h["name"], h["no_id"]))
            for cid in h["conv_ids"]:
                if cid in in_run:
                    add("FAIL", "fetch", "conversation %s appears twice in run %s" % (cid, rid))
                elif cid in winner:
                    cross_dups += 1
                in_run.add(cid)
                winner[cid] = (rid, h["part"])   # the latest copy wins
    if cross_dups:
        add("INFO", "fetch", "%d thread(s) fetched again by a resume run; the latest copy is used" % cross_dups)
    plan["winner"], plan["to_fetch"] = winner, to_fetch
    missing = [i for i in to_fetch if i not in winner]
    plan["missing"] = missing
    if missing:
        add("FAIL", "fetch", "%d listed thread(s) are in no part%s: %s (run `verify.py missing` for the full list)" % (
            len(missing), " (expected while a capped backfill is in progress)" if plan["capped"] else "",
            ", ".join(missing[:10])), run_level=True)
    extra = [cid for cid in winner if cid not in allowed]
    if extra:
        add("FAIL", "fetch", "%d conversation(s) not in the listing: %s" % (len(extra), ", ".join(extra[:10])))
    errs = [e for _, hs in plan["order"] for h in hs for e in h["errors"]]
    unresolved = [e for e in errs if e.get("id") not in winner]
    plan["errors_unresolved"] = unresolved
    if unresolved:
        add("FAIL", "fetch", "%d fetch error(s) for threads still in no part: %s" % (len(unresolved), ", ".join(
            "%s → %s" % (str(e.get("id"))[:40], str(e.get("status"))[:20]) for e in unresolved[:10])))
    if len(errs) > len(unresolved):
        add("INFO", "fetch", "%d earlier fetch error(s) resolved by a later copy" % (len(errs) - len(unresolved)))
    for _, hs in plan["order"]:
        for h in hs:
            for e in h["textdoc_errors"]:
                add("FAIL", "canvas", "canvas fetch failed: %s → %s" % (str(e.get("id"))[:40], str(e.get("status"))[:20]))
    plan["complete"] = not any(level == "FAIL" for level, _, _ in probs)
    return plan


def account_slugs(rows, prefix):
    """id -> filename slug, decided from the whole listing so it does not depend on part order: a title slug shared
    by more than one listed thread gets a short id suffix on every one of them (the whole id if even that collides)."""
    bases = {cid: slugify(clean_title(r.get("title"), "")) or "untitled" for cid, r in rows.items()}
    counts = collections.Counter(bases.values())
    short = {cid: base if counts[base] == 1 and base != "index" else "%s-%s" % (base, slugify(cid)[:8])
             for cid, base in bases.items()}
    counts = collections.Counter(short.values())
    out = {}
    for cid, slug in short.items():
        if counts[slug] > 1:
            slug = "%s-%s" % (bases[cid], slugify(cid).replace("-", ""))
        out[cid] = "-".join(p for p in (prefix, slug) if p)
    return out


def convert_account(args, paths, prefix):
    if any(k in ("project", "project_name") for k, _ in args.extra_fm):
        die("frontmatter keys project / project_name are written by account mode")
    warnings, headers = [], []
    for p in paths:
        try:
            b, sha, size, text_hit = read_json_file(p, args.max_input_mb)
        except PartError as e:
            die(str(e))
        if not is_account_part(b):
            die("%s is not an account part (schema 3); convert project and thread bundles one at a time" % os.path.basename(p))
        if len(as_list(b.get("conversations"))) > MAX_CONVERSATIONS:
            die("%s holds over %d conversations" % (os.path.basename(p), MAX_CONVERSATIONS))
        key_hits, jwt_values = token_scan(b)
        if key_hits:
            warnings.append("TOKEN WARNING: %s has %d accessToken/access_token key(s) outside message text%s. This looks like a "
                            "real session token. Do not archive or file this pull until the owner decides what to do with it."
                            % (os.path.basename(p), key_hits, " (%d JWT-shaped value(s))" % jwt_values if jwt_values else ""))
        elif text_hit:
            warnings.append("note: message text in %s mentions accessToken or contains a JWT-shaped string. No token key was "
                            "found outside message text, so this is probably harmless thread content." % os.path.basename(p))
        headers.append(part_header(b, p, sha, size))
        del b
    plan = account_plan(headers)
    if plan["fatal"]:
        die("these parts are not one pull: " + "; ".join(plan["fatal"][:5]))
    if len(plan["winner"]) > MAX_ACCOUNT_CONVERSATIONS:
        die("%d conversations, over the %d guard" % (len(plan["winner"]), MAX_ACCOUNT_CONVERSATIONS))
    warnings += ["%s [%s] %s" % (lvl, scope, msg) for lvl, scope, msg in plan["problems"] if lvl in ("FAIL", "WARN")]

    out_dir = os.path.realpath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    index_slug = "-".join(p for p in (prefix, "chatgpt-account-pull", args.date, "index") if p)
    index_link = "[[%s]]" % index_slug
    rows = plan["rows"]
    names = account_slugs(rows, prefix)
    used, written, entries, rendered = {index_slug}, [], [], set()
    for rid, hs in plan["order"]:
        for h in hs:
            if not any(plan["winner"].get(cid) == (rid, h["part"]) for cid in h["conv_ids"]):
                continue
            try:
                b, _, _, _ = read_json_file(h["path"], args.max_input_mb)
            except PartError as e:
                die(str(e))
            args.textdocs = {k: v for k, v in as_dict(b.get("textdocs")).items() if isinstance(k, str) and isinstance(v, dict)}
            for conv in as_list(b.get("conversations")):
                cid = conv_key(conv) if isinstance(conv, dict) else None
                if cid is None or plan["winner"].get(cid) != (rid, h["part"]) or cid in rendered:
                    continue
                rendered.add(cid)
                c = convert_conversation(conv, rows.get(cid, {}), b, args)
                slug = names.get(cid)
                if slug is None or slug in used:
                    base = slugify(c["title"]) or ("untitled-" + (c["conv_id"][:8] if c["conv_id"] else "x"))
                    slug = unique_slug("-".join(p for p in (prefix, base) if p), c["conv_id"], used)
                else:
                    used.add(slug)
                write_exclusive(out_dir, slug + ".md", note_text(c, args, b, index_link))
                written.append(slug + ".md")
                entries.append((slug, c))
            del b
    write_exclusive(out_dir, index_slug + ".md", account_index(args, plan, headers, entries, warnings))
    written.append(index_slug + ".md")
    print(json.dumps({
        "out_dir": out_dir, "notes": len(written) - 1, "index": index_slug + ".md", "written": written,
        "branches": sum(c["branches"] for _, c in entries), "parts": len(headers), "run": plan["primary"],
        "missing": len(plan["missing"]), "errors_in_bundle": len(plan["errors_unresolved"]),
        "attachment_refs": sum(h["attachment_count"] for h in headers),
        "bundle_sha256": {h["name"]: h["sha256"] for h in headers}, "warnings": warnings,
    }, indent=2))


def account_index(args, plan, headers, entries, warnings):
    counts = collections.Counter((c["triage"] or "ALL") for _, c in entries)
    idx = ["---"] + extra_fm_lines(args)[:1 if args.id_key else 0] + ["type: source", "created: " + args.date,
           "source: chatgpt-account"]
    if args.related_to:
        idx += ["related_to: " + yq(args.related_to)]
    idx += extra_fm_lines(args)[1 if args.id_key else 0:]
    idx += ["tags:", "  - src-chatgpt-thread", "  - chatgpt-pull"]
    idx += ["  - " + t for t in args.tag if re.fullmatch(r"[A-Za-z0-9_-]{1,40}", t)]
    idx += ["---", "", "# ChatGPT account pull, %s" % args.date, ""]
    idx.append("Pulled %s from the ChatGPT web app via its own JSON API (in-page fetch). %d conversations rendered%s."
               % (clean_title(plan["pulled_at"], "at an unknown time"), len(entries),
                  "; " + ", ".join("%d %s" % (n, k.lower()) for k, n in sorted(counts.items())) if counts and "ALL" not in counts else ""))
    if plan["since"]:
        idx.append("Incremental pull: cutoff `%s`." % clean_title(plan["since"], ""))
    idx.append("Listing: %d threads. Verdict of the part checks: %s." % (
        len(plan["listing"]), "complete" if plan["complete"] else "NOT complete (see Warnings)"))
    runs = [rid for rid, _ in plan["order"]]
    idx += ["", "## Provenance", "", "| Item | Value |", "|---|---|",
            "| Pull (run id) | `%s` |" % runs[0],
            "| Resume runs | %s |" % (", ".join("`%s`" % r for r in runs[1:]) or "none"),
            "| Parts | %d |" % sum(len(hs) for _, hs in plan["order"])]
    if args.raw_path:
        idx.append("| Raw archive (gzip, outside git) | `%s` |" % clean_title(args.raw_path, "").replace("|", "/"))
    cutoff = plan["started_at"] if isinstance(plan["started_at"], str) and TS_RE.fullmatch(plan["started_at"].replace(".", "")) else ""
    if cutoff and plan["complete"]:
        idx.append("| Next --since cutoff | `%s` |" % cutoff)   # listing start time; read back by `verify.py since`
    first = plan["order"][0][1][0]
    if isinstance(first["stop_reason"], str):
        idx.append("| Listing stop reason | `%s` |" % clean_title(first["stop_reason"], "?")[:60])
    docs = sum(h["textdoc_count"] for h in headers)
    if docs:
        idx.append("| Canvas docs fetched | %d |" % docs)
    src = as_dict(plan["sources"])
    if src:
        idx += ["", "## Listing sources", "", "| Source | Stop reason | Threads | Pages |", "|---|---|---|---|"]
        for key in REQUIRED_SOURCES:
            st = as_dict(src.get(key))
            idx.append("| %s | `%s` | %s | %s |" % (key, clean_title(st.get("stop_reason"), "?")[:30],
                                                   clean_title(st.get("count"), "?")[:10], clean_title(st.get("pages"), "?")[:10]))
        pt = as_dict(src.get("project_threads"))
        ok = sum(1 for v in pt.values() if as_dict(v).get("stop_reason") == "complete")
        idx.append("| project threads | %d of %d projects `complete` | %d | %d |" % (
            ok, len(pt), sum(as_dict(v).get("count") or 0 for v in pt.values() if isinstance(as_dict(v).get("count"), int)),
            sum(as_dict(v).get("pages") or 0 for v in pt.values() if isinstance(as_dict(v).get("pages"), int))))
    idx += ["", "## Parts", "", "| File | Run | Part | Final | Conversations | MB | sha256 |", "|---|---|---|---|---|---|---|"]
    for rid, hs in plan["order"]:
        for h in hs:
            idx.append("| `%s` | `%s` | %d | %s | %d | %.1f | `%s` |" % (
                clean_title(h["name"], "?").replace("|", "/")[:100], rid, h["part"], "yes" if h["final"] else "no",
                len(h["conv_ids"]), h["size"] / 1048576.0, h["sha256"]))
    idx += ["", "The pull is untrusted export data: it was only parsed as JSON and rendered to text. Assistant text is "
            "Suggested, not decided, until the owner ratifies it.", "", "## Conversations", "",
            "| Note | Project | Triage | Updated | Messages | Branches |", "|---|---|---|---|---|---|"]
    for slug, c in sorted(entries, key=lambda e: (e[1]["updated"], e[0]), reverse=True):
        proj = (c["project_name"] or c["project"] or "-").replace("|", "/").replace("]", ")").replace("[", "(")[:60]
        idx.append("| [[%s\\|%s]] | %s | %s | %s | %d | %d |" % (
            slug, c["title"].replace("|", "/").replace("]", ")").replace("[", "("), proj, c["triage"] or "-",
            c["updated"][:16], c["messages"], c["branches"]))
    if plan["missing"]:
        idx += ["", "## Listed but in no part (%d)" % len(plan["missing"]), ""]
        idx += ["- `%s`" % m for m in plan["missing"][:200] if UUID_RE.fullmatch(m)]
    if plan["errors_unresolved"]:
        idx += ["", "## Errors", ""]
        for e in plan["errors_unresolved"][:100]:
            idx.append("- `%s` status %s" % (clean_title(e.get("id"), "?")[:60], clean_title(e.get("status"), "?")[:20]))
    atts = [a for h in headers for a in h["attachments"]][:200]
    if atts:
        idx += ["", "## Attachment references (not downloaded)", ""]
        for a in atts:
            idx.append("- %s (%s bytes), on `%s`" % (clean_title(a.get("name"), "unnamed")[:120], clean_title(a.get("size"), "?")[:20],
                                                   clean_title(a.get("title") or a.get("conv"), "?")[:80]))
    if warnings:
        idx += ["", "## Warnings", ""] + ["- " + clean_title(w, "")[:600] for w in warnings[:300]]
    return "\n".join(idx) + "\n"


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Convert an ai-export ChatGPT bundle to markdown notes.")
    ap.add_argument("--input", required=True, action="append",
                    help="bundle JSON (untrusted); for an account pull repeat it per part, or pass the parts' directory")
    ap.add_argument("--out-dir", required=True, help="fresh output directory (created if missing)")
    ap.add_argument("--date", default=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
                    help="pull date for `created` and the index name (YYYY-MM-DD)")
    ap.add_argument("--platform", default="chatgpt", help="chatgpt only; claude/grok shapes are unverified")
    ap.add_argument("--slug-prefix", default="", help="prefix for every note filename, e.g. a date, to keep wikilinks unique")
    ap.add_argument("--related-to", default="", help='wikilink for related_to, e.g. "[[some-project]]"')
    ap.add_argument("--id-key", default="", help="optional: also write a fresh uuid4 under this frontmatter key (e.g. a vault's id field)")
    ap.add_argument("--fm", action="append", default=[], metavar="KEY=VALUE",
                    help="optional: extra fixed frontmatter key (repeatable); keys starting with '_' are refused")
    ap.add_argument("--tag", action="append", default=[], help="extra tag (repeatable)")
    ap.add_argument("--raw-path", default="", help="where the gzipped raw bundle was archived (recorded in the index)")
    ap.add_argument("--max-input-mb", type=int, default=MAX_INPUT_MB)
    args = ap.parse_args()
    args.extra_fm = parse_extra_fm(args.fm, args.id_key)

    if args.platform != "chatgpt":
        die("platform %r is not supported: its export shape is unverified, so no converter was written" % args.platform)
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        die("--date must be YYYY-MM-DD")
    prefix = slugify(args.slug_prefix)

    first = os.path.realpath(args.input[0])
    gz = False
    if os.path.isfile(first):
        with open(first, "rb") as f:
            gz = f.read(2) == b"\x1f\x8b"   # gzip input is read for account parts only
    if len(args.input) > 1 or os.path.isdir(first) or gz:
        try:
            paths = expand_inputs(args.input)
        except PartError as e:
            die(str(e))
        return convert_account(args, paths, prefix)
    in_path = os.path.realpath(args.input[0])
    if not os.path.isfile(in_path):
        die("input is not a file: " + args.input[0])
    size = os.path.getsize(in_path)
    if size > args.max_input_mb * 1024 * 1024:
        die("input is %.1f MB, over the %d MB guard" % (size / 1048576.0, args.max_input_mb))

    with open(in_path, "rb") as f:
        raw = f.read()
    sha = hashlib.sha256(raw).hexdigest()
    try:
        bundle = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        die("input is not valid JSON: %s" % type(e).__name__)
    warnings = []
    text_hit = b"accessToken" in raw or bool(re.search(rb"eyJ[A-Za-z0-9_-]{20,}\.eyJ", raw))
    del raw
    if not isinstance(bundle, dict):
        die("bundle must be a JSON object")
    if is_account_part(bundle):   # a single account part: same path as several
        del bundle
        return convert_account(args, [in_path], prefix)
    key_hits, jwt_values = token_scan(bundle)
    if key_hits:
        warnings.append("TOKEN WARNING: %d accessToken/access_token key(s) outside message text%s. This looks like a real "
                        "session token. Do not archive or file this bundle until the owner decides what to do with it."
                        % (key_hits, " (%d JWT-shaped value(s))" % jwt_values if jwt_values else ""))
    elif text_hit:
        warnings.append("note: message text mentions accessToken or contains a JWT-shaped string. No token key was found "
                        "outside message text, so this is probably harmless thread content. The owner decides; nothing was changed.")
    if bundle.get("platform", "chatgpt") != "chatgpt":
        die("bundle platform %r is not supported" % bundle.get("platform"))
    if bundle.get("partial"):
        warnings.append("bundle is marked partial (the pull ended early); counts are incomplete")

    convs = as_list(bundle.get("conversations"))
    if len(convs) > MAX_CONVERSATIONS:
        die("%d conversations, over the %d guard" % (len(convs), MAX_CONVERSATIONS))
    rows = {r.get("id"): r for r in as_list(bundle.get("listing")) if isinstance(r, dict) and isinstance(r.get("id"), str)}
    textdocs = {k: v for k, v in as_dict(bundle.get("textdocs")).items() if isinstance(k, str) and isinstance(v, dict)}
    args.textdocs = textdocs

    out_dir = os.path.realpath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    kind0 = bundle.get("kind") if bundle.get("kind") in ("project", "thread") else "project"
    short = ""
    if kind0 == "project" and isinstance(bundle.get("project"), str) and PROJECT_RE.fullmatch(bundle["project"]):
        short = bundle["project"][4:12]
    elif convs and isinstance(convs[0], dict):
        first = convs[0].get("conversation_id") or convs[0].get("id")
        short = first[:8] if isinstance(first, str) and CONV_ID_RE.fullmatch(first) else ""
    index_slug = "-".join(p for p in (prefix, "chatgpt", slugify(short), "pull", args.date, "index") if p)
    index_link = "[[%s]]" % index_slug

    used, written, entries = {index_slug}, [], []
    for conv in convs:
        if not isinstance(conv, dict):
            warnings.append("skipped a non-object conversation entry")
            continue
        cid = conv.get("conversation_id") or conv.get("id") or ""
        cid = cid if isinstance(cid, str) else ""
        alt = conv.get("id") if isinstance(conv.get("id"), str) else ""
        row = rows.get(cid) or rows.get(alt) or {}
        c = convert_conversation(conv, row, bundle, args)
        base = slugify(c["title"]) or ("untitled-" + (c["conv_id"][:8] if c["conv_id"] else "x"))
        slug = unique_slug("-".join(p for p in (prefix, base) if p), c["conv_id"], used)
        text = note_text(c, args, bundle, index_link)
        write_exclusive(out_dir, slug + ".md", text)
        written.append(slug + ".md")
        entries.append((slug, c))

    # ---- index note
    errors = as_list(bundle.get("errors"))
    atts = as_list(bundle.get("attachments"))
    kind = bundle.get("kind") if bundle.get("kind") in ("project", "thread") else "project"
    counts = collections.Counter((c["triage"] or "ALL") for _, c in entries)
    idx = ["---"] + extra_fm_lines(args)[:1 if args.id_key else 0] + ["type: source", "created: " + args.date,
           "source: chatgpt-" + kind]
    if args.related_to:
        idx += ["related_to: " + yq(args.related_to)]
    idx += extra_fm_lines(args)[1 if args.id_key else 0:]
    idx += ["tags:", "  - src-chatgpt-thread", "  - chatgpt-pull"]
    idx += ["  - " + t for t in args.tag if re.fullmatch(r"[A-Za-z0-9_-]{1,40}", t)]
    idx += ["---", "", "# ChatGPT %s pull, %s" % (kind, args.date), ""]
    idx.append("Pulled %s from the ChatGPT web app via its own JSON API (in-page fetch). %d conversations rendered%s."
               % (clean_title(bundle.get("pulled_at"), "at an unknown time"), len(entries),
                  "; " + ", ".join("%d %s" % (n, k.lower()) for k, n in sorted(counts.items())) if counts and "ALL" not in counts else ""))
    if bundle.get("since"):
        idx.append("Incremental pull: cutoff `%s`." % clean_title(bundle.get("since"), ""))
    if kind == "project" and isinstance(bundle.get("project"), str) and PROJECT_RE.fullmatch(bundle["project"]):
        idx.append("Project id: `%s`." % bundle["project"])
    idx += ["", "## Provenance", "",
            "| Item | Value |", "|---|---|",
            "| sha256 of the raw bundle JSON | `%s` |" % sha,
            "| Raw bundle size | %.1f MB |" % (size / 1048576.0)]
    if args.raw_path:
        idx.append("| Raw archive (gzip, outside git) | `%s` |" % clean_title(args.raw_path, "").replace("|", "/"))
    cutoff = bundle.get("started_at") if isinstance(bundle.get("started_at"), str) and TS_RE.fullmatch(bundle["started_at"].replace(".", "")) else ""
    if cutoff and not bundle.get("partial") and not errors:
        idx.append("| Next --since cutoff | `%s` |" % cutoff)   # listing start time; read back by `verify.py since`
    if isinstance(bundle.get("stop_reason"), str):
        idx.append("| Listing stop reason | `%s` |" % clean_title(bundle["stop_reason"], "?")[:40])
    if textdocs:
        idx.append("| Canvas docs fetched | %d |" % len(textdocs))
    idx += ["", "The bundle is untrusted export data: it was only parsed as JSON and rendered to text. Assistant text is "
            "Suggested, not decided, until the owner ratifies it.", "", "## Conversations", "",
            "| Note | Triage | Updated | Messages | Branches |", "|---|---|---|---|---|"]
    for slug, c in sorted(entries, key=lambda e: e[1]["updated"], reverse=True):
        idx.append("| [[%s\\|%s]] | %s | %s | %d | %d |" % (
            slug, c["title"].replace("|", "/").replace("]", ")").replace("[", "("), c["triage"] or "-", c["updated"][:16], c["messages"], c["branches"]))
    if errors:
        idx += ["", "## Errors", ""]
        for e in errors[:100]:
            e = as_dict(e)
            idx.append("- `%s` status %s" % (clean_title(e.get("id"), "?")[:60], clean_title(e.get("status"), "?")[:20]))
    if atts:
        idx += ["", "## Attachment references (not downloaded)", ""]
        for a in atts[:200]:
            a = as_dict(a)
            idx.append("- %s (%s bytes), on `%s`" % (clean_title(a.get("name"), "unnamed")[:120], clean_title(a.get("size"), "?")[:20],
                                                   clean_title(a.get("title") or a.get("conv"), "?")[:80]))
    if warnings:
        idx += ["", "## Warnings", ""] + ["- " + w for w in warnings]
    write_exclusive(out_dir, index_slug + ".md", "\n".join(idx) + "\n")
    written.append(index_slug + ".md")

    print(json.dumps({
        "out_dir": out_dir, "notes": len(written) - 1, "index": index_slug + ".md", "written": written, "branches": sum(c["branches"] for _, c in entries),
        "errors_in_bundle": len(errors), "attachment_refs": len(atts), "bundle_sha256": sha, "warnings": warnings,
    }, indent=2))


if __name__ == "__main__":
    main()
