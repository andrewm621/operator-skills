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
"""
import argparse
import collections
import datetime
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
MAX_BRANCH_MESSAGES = 500     # rendered per off-path branch
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

    created = safe_ts(iso(conv.get("create_time") or row.get("create_time")))
    updated = safe_ts(iso(conv.get("update_time") or row.get("update_time")))
    return {
        "title": title, "conv_id": conv_id, "created": created, "updated": updated,
        "model": (safe_model(models.most_common(1)[0][0]) or "") if models else "", "triage": triage,
        "messages": msgs, "branches": branch_count, "blocks": blocks, "branches_md": branches_md,
        "off_path": max(0, len(mapping) - len(path)),
    }


def note_text(c, args, bundle, index_link):
    kind = bundle.get("kind") if bundle.get("kind") in ("project", "thread") else "project"
    project = bundle.get("project")
    url = ""
    if c["conv_id"]:
        if kind == "project" and isinstance(project, str) and PROJECT_RE.fullmatch(project):
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


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="Convert an ai-export ChatGPT bundle to markdown notes.")
    ap.add_argument("--input", required=True, help="bundle JSON (untrusted)")
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

    in_path = os.path.realpath(args.input)
    if not os.path.isfile(in_path):
        die("input is not a file: " + args.input)
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
