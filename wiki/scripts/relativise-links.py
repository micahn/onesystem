#!/usr/bin/env python3
"""
Rewrite Obsidian wikilinks as relative Markdown links.

The vault was authored for Obsidian, where `[[use-cases/ticket-gate]]` is a link. GitHub
does not resolve those: it renders them as literal brackets. Since this vault has to be
readable on GitHub -- that is where it lives -- the links have to be ordinary relative
Markdown links, which Obsidian also follows.

Rewrites both forms:

    [[use-cases/ticket-gate]]                  -> [use-cases/ticket-gate](use-cases/ticket-gate.md)
    [[use-cases/ticket-gate|Gate a ticket]]     -> [Gate a ticket](use-cases/ticket-gate.md)
    [[ticket-gate]]                             -> [ticket-gate](ticket-gate.md)   (same dir)

Targets are resolved against the linking file's directory and checked for existence, so a
broken link is reported rather than shipped.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# `[[target#anchor|label]]` and `[[target#anchor]]` both occur; the anchor has to survive.
LINK = re.compile(r"\[\[([^\]|#]+)(?:#([^\]|]+))?(\|[^\]]+)?\]\]")


def resolve(source: pathlib.Path, target: str) -> str | None:
    """The relative path from `source` to the note `target` names, or None if absent."""
    target = target.strip()
    if not target:
        return None
    # A bare name means a sibling; a path means from the vault root. Try both, because
    # Obsidian resolves the shorter form against the current note first.
    candidates = []
    if "/" in target:
        candidates.append(ROOT / f"{target}.md")
    else:
        candidates.append(source.parent / f"{target}.md")
        candidates.append(ROOT / f"{target}.md")
    for candidate in candidates:
        if candidate.exists():
            # os.path.relpath rather than Path.relative_to: a link from `use-cases/index.md`
            # up to `index/schema.md` leaves the source directory, and relative_to refuses
            # to express that even though it is a perfectly ordinary `../` link.
            import os

            return os.path.relpath(candidate, source.parent).replace("\\", "/")
    return None


def main() -> int:
    changed = 0
    broken: list[tuple[str, str]] = []
    for path in sorted(ROOT.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        if "[[" not in text:
            continue

        def replace(m: re.Match) -> str:
            target, anchor, label = m.group(1), m.group(2), m.group(3)
            resolved = resolve(path, target)
            if resolved is None:
                broken.append((str(path.relative_to(ROOT)), target.strip()))
                return m.group(0)
            label_text = (label[1:] if label else target.strip())
            frag = f"#{anchor.strip().replace(' ', '-').lower()}" if anchor else ""
            return f"[{label_text}]({resolved}{frag})"

        updated = LINK.sub(replace, text)
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            changed += 1

    print(f"rewrote links in {changed} files")
    if broken:
        print(f"\n{len(broken)} link(s) point at nothing:")
        for source, target in broken:
            print(f"  {source} -> {target}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
