#!/usr/bin/env python3
"""
One-shot migration: laya-wiki -> onesystem wiki.

The 35 use-case and pattern notes are substantively engine-agnostic -- they are about
decision points in a workflow, not about a model. What is not agnostic is their
frontmatter, which names laya-only tools, and their payloads, which are all object-shaped
because laya requires an object.

This does the mechanical part so the hand-written part can stay readable:

  * tools          -> the real registered names, and which engines have them
  * surface        -> the surfaces onesystem actually has
  * laya_version   -> dropped; version facts move into prose where they are argued
  * projects       -> dropped; they named private repos and belong to no public vault
  * cost_ms        -> dropped from frontmatter; it was one engine's latency and a
                      frontmatter field is the wrong place for a per-engine number

It deliberately does NOT rewrite prose. Where a note makes a claim that is only true of
laya, a human has to notice and fix it -- see the audit at the end, which lists every note
that still mentions a model by name.
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The portable surface. `predict` is the one tool all three engines expose.
#
# Deliberately the *logical* name, not the wire name. The name a client actually calls is
# context-dependent: bare when the backend is the only one enabled, or when config names it
# as the default, and `<backend>_<tool>` otherwise. Pinning `julia_predict` into 34 notes
# would be both wrong most of the time and noise everywhere else. The rule is stated once,
# in reference/mcp-tools.md.
PORTABLE_TOOL = {
    "onesystem.predict": ["predict"],
}
LAYA_ONLY_TOOL = {
    "onesystem.route": "laya_route",
    "onesystem.status": "laya_status",
    "onesystem.preset": "laya_preset",
    "onesystem.shortlist": "laya_shortlist",
    "onesystem.decide": "laya_decide",
    "onesystem.predict_batch": "laya_predict_batch",
    "onesystem.route_batch": "laya_route_batch",
}
SURFACE_MAP = {
    # `python` and `langchain`/`onnx` were laya's own surfaces. onesystem has none of
    # them: it is an HTTP + MCP service, and a model is reached through it, not imported.
    "python": "http",
    "serve": "http",
    "langchain": "http",
    "onnx": "http",
    "ts": "http",
    "mcp": "mcp",
    "cli": "cli",
}

# Engines reachable with an object-shaped state -- that is rizzo and laya. julia needs the
# state flattened to a string, which is a real porting step and is documented rather than
# hidden.
OBJECT_STATE_ENGINES = ["laya", "rizzo"]
ALL_ENGINES = ["julia", "laya", "rizzo"]


def split_list(value: str) -> list[str]:
    # Strip the brackets first. Without this the index ends up with `["[laya", "rizzo]"]`,
    # which reads as a two-element list of truncated strings rather than two engines.
    return [x.strip() for x in value.strip("[]").split(",") if x.strip()]


def render_list(values: list[str]) -> str:
    return "[" + ", ".join(values) + "]"


def transform(text: str, path: pathlib.Path) -> tuple[str, set[str]]:
    """Return the new text and the set of model-specific facts it still asserts."""
    notes: set[str] = set()

    def sub(pattern: str, repl, flags=re.M) -> None:
        nonlocal text
        text = re.sub(pattern, repl, text, flags=flags)

    # --- tools -> real names, plus which engines have them -----------------------
    def fix_tools(m: re.Match) -> str:
        tools = split_list(m.group(1))
        out: list[str] = []
        for tool in tools:
            if tool in PORTABLE_TOOL:
                # List the engine-facing names, since that is what a caller types.
                out.extend(PORTABLE_TOOL[tool])
            elif tool in LAYA_ONLY_TOOL:
                out.append(LAYA_ONLY_TOOL[tool])
                notes.add("laya-only tool")
            else:
                out.append(tool)
        # Deduplicate, keep order.
        seen: set[str] = set()
        uniq = [x for x in out if not (x in seen or seen.add(x))]
        return f"tools: {render_list(uniq)}"

    sub(r"^tools: \[(.*?)\]", fix_tools)

    # --- surface ----------------------------------------------------------------
    def fix_surface(m: re.Match) -> str:
        return f"surface: {render_list([SURFACE_MAP.get(s, s) for s in split_list(m.group(1))])}"

    sub(r"^surface: \[(.*?)\]", fix_surface)

    # --- drop machine-specific frontmatter -------------------------------------
    sub(r"^laya_version: .*\n", "")
    sub(r"^projects: .*\n", "")
    sub(r"^cost_ms: .*\n", "")

    # --- engines ----------------------------------------------------------------
    # Insert after `tools`, which every note has. A note using a laya-only tool is
    # laya-only, and saying so in frontmatter is the difference between a portable
    # pattern and a broken one.
    uses_laya_only = "laya-only tool" in notes
    engines = ["laya"] if uses_laya_only else list(OBJECT_STATE_ENGINES)
    engines_note = (
        "# Only laya. Uses a laya-only tool; see reference/compatibility for what that costs.\n"
        if uses_laya_only
        else "# Reachable as written. julia needs the state flattened to a string.\n"
    )
    sub(r"^(tools: .*\n)", lambda m: m.group(1) + engines_note + f"engines: {render_list(engines)}\n")

    # --- body references to the old tool names ----------------------------------
    text = text.replace("onesystem.predict", "the `predict` tool")
    text = text.replace("onesystem.route", "`laya_route`")
    text = text.replace("onesystem.status", "`laya_status`")
    text = text.replace("onesystem.preset", "`laya_preset`")
    text = text.replace("onesystem.shortlist", "`laya_shortlist`")
    text = text.replace("onesystem.decide", "`laya_decide`")

    return text, notes


def main() -> int:
    targets = sorted(
        p for p in ROOT.glob("use-cases/*.md")
    ) + sorted(ROOT.glob("patterns/*.md"))

    flagged: dict[str, set[str]] = {}
    for path in targets:
        original = path.read_text(encoding="utf-8")
        updated, notes = transform(original, path)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
        if notes:
            flagged[str(path.relative_to(ROOT))] = notes

    # Rebuild the index from the notes, so the machine-readable half cannot drift from
    # the prose half. The `criteria` block is preserved verbatim -- it is the ranking
    # surface and it is engine-agnostic.
    index_path = ROOT / "index" / "usecases.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    notes_by_id: dict[str, pathlib.Path] = {}
    for path in sorted(ROOT.glob("use-cases/*.md")):
        front = path.read_text(encoding="utf-8").split("---")[1]
        ident = re.search(r"^id: (\S+)", front, re.M)
        if ident:
            notes_by_id[ident.group(1)] = path

    def front_field(path: pathlib.Path, field: str) -> str | None:
        front = path.read_text(encoding="utf-8").split("---")[1]
        found = re.search(rf"^{field}: (.*)$", front, re.M)
        return found.group(1).strip() if found else None

    for record in index["use_cases"]:
        path = notes_by_id.get(record["id"])
        if not path:
            continue
        record["tools"] = split_list(front_field(path, "tools") or "")
        record["engines"] = split_list(front_field(path, "engines") or "")
        record["question_types"] = split_list(front_field(path, "question_types") or "")
        record["status"] = front_field(path, "status") or record.get("status")
        record["human_review"] = front_field(path, "human_review")
        record["risk_when_wrong"] = front_field(path, "risk_when_wrong")
        record["trigger"] = front_field(path, "trigger") or record.get("trigger")
        # Private repo names and a single engine's latency are not facts a public index
        # should carry.
        record.pop("projects", None)
        record.pop("cost_ms", None)

    index.pop("laya_version", None)
    index.pop("device_measured_on", None)
    index["$comment"] = (
        "Machine-readable index of the use cases, searched by whichever engine is active. "
        "`criteria` is drop-in valid as a `choice` question's criteria, so an engine can "
        "rank this vault against a live situation with no adapter. Prose may elaborate, "
        "never contradict."
    )
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")

    print(f"transformed {len(targets)} notes, rebuilt index with {len(index['use_cases'])} records")
    if flagged:
        print("\nlaya-only notes (frontmatter now says so):")
        for name in sorted(flagged):
            print(f"  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
