#!/usr/bin/env python3
"""
Structural checks on the vault.

It checks that the vault is internally consistent. It cannot check whether a gloss is still
*true* -- that is a human job, which is the correct division of labour for a wiki, and the
reason this script does not pretend otherwise.

    python3 scripts/validate.py
"""

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "index" / "usecases.json"

FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.S)
LINK = re.compile(r"\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)")

errors: list[str] = []
warnings: list[str] = []


def error(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def frontmatter(path: pathlib.Path) -> dict[str, str]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER.match(text)
    if not match:
        return {}
    out: dict[str, str] = {}
    for line in match.group(1).split("\n"):
        found = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if found:
            out[found.group(1)] = found.group(2).strip()
    return out


def list_field(value: str | None) -> list[str]:
    if not value:
        return []
    return [x.strip() for x in value.strip("[]").split(",") if x.strip()]


# --- the index -----------------------------------------------------------------

if not INDEX.exists():
    print(f"missing {INDEX}")
    sys.exit(1)

try:
    index = json.loads(INDEX.read_text(encoding="utf-8"))
except json.JSONDecodeError as exc:
    # The one file that must never break, so it is the one with the loudest failure.
    print(f"index/usecases.json does not parse: {exc}")
    sys.exit(1)

criteria = index.get("criteria", {})
records = {r["id"]: r for r in index.get("use_cases", [])}

if index.get("count") != len(records):
    error(f"count is {index.get('count')} but there are {len(records)} records")

if len(criteria) != len(records):
    error(f"{len(criteria)} criteria keys but {len(records)} records")

for key in criteria:
    if not isinstance(criteria[key], str) or not criteria[key].strip():
        error(f"criteria[{key!r}] is empty; it is the text that gets embedded")
    if key not in records:
        error(f"criteria key {key!r} has no record")
for ident in records:
    if ident not in criteria:
        error(f"record {ident!r} has no criteria key, so it cannot be ranked")

# --- notes ---------------------------------------------------------------------

notes = {p.stem: p for p in sorted(ROOT.glob("use-cases/*.md"))}
if "index" in notes:
    del notes["index"]  # the index page is a list of the others, not a use case

for ident, path in notes.items():
    front = frontmatter(path)
    if not front:
        error(f"{path.relative_to(ROOT)} has no frontmatter")
        continue
    if front.get("id") != ident:
        error(f"{path.relative_to(ROOT)}: id is {front.get('id')!r}, filename says {ident!r}")
    if ident not in records:
        error(f"{path.relative_to(ROOT)} has no record in the index")
        continue

    record = records[ident]
    if front.get("status") != record.get("status"):
        error(
            f"{ident}: frontmatter status={front.get('status')!r} but index says "
            f"{record.get('status')!r} -- prose may elaborate, never contradict"
        )
    # Compare as lists: the frontmatter is `[choice, noul]` and the index holds
    # `["choice", "noul"]`, so a string comparison reports a contradiction that is only a
    # formatting difference.
    for field in ("question_types", "tools", "engines"):
        if list_field(front.get(field)) != record.get(field, []):
            error(
                f"{ident}: frontmatter {field}={list_field(front.get(field))} but index says "
                f"{record.get(field)} -- prose may elaborate, never contradict"
            )
    if list_field(front.get("engines")) != record.get("engines", []):
        error(f"{ident}: engines disagree between frontmatter and the index")

    # Engines is the portability claim, and it must name real engines.
    engines = list_field(front.get("engines"))
    if not engines:
        error(f"{ident}: no engines field; the portability claim cannot be absent")
    for engine in engines:
        if engine not in ("julia", "laya", "rizzo"):
            error(f"{ident}: unknown engine {engine!r}")

    # A note that claims portability but calls a laya-only tool is lying, and this is
    # cheap to catch.
    tools = list_field(front.get("tools"))
    if engines != ["laya"] and any(t != "predict" for t in tools):
        warn(f"{ident}: claims engines {engines} but uses a non-portable tool {tools}")

    for field in ("kind", "title"):
        if not front.get(field):
            error(f"{ident}: missing {field}")

# --- links ---------------------------------------------------------------------

for path in sorted(ROOT.rglob("*.md")):
    text = path.read_text(encoding="utf-8")
    for _, target in LINK.findall(text):
        if target.startswith(("http://", "https://", "mailto:")):
            continue
        resolved = (path.parent / target).resolve()
        if not resolved.exists():
            error(f"{path.relative_to(ROOT)}: link to {target} resolves to nothing")

leftover = [str(p.relative_to(ROOT)) for p in ROOT.rglob("*.md") if "[[" in p.read_text(encoding="utf-8")]
for path in leftover:
    warn(f"{path} still contains a [[wikilink]]; GitHub will not render it")

# --- report --------------------------------------------------------------------

for w in warnings:
    print(f"  warn  {w}")
for e in errors:
    print(f"  ERROR {e}")

print(f"\n{len(records)} use cases, {len(list(ROOT.rglob('*.md')))} notes, "
      f"{len(errors)} errors, {len(warnings)} warnings")
sys.exit(1 if errors else 0)
