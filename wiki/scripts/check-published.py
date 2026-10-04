#!/usr/bin/env python3
"""
Keep the published copy honest about being a different document.

There are two onesystem wikis and they are **not** the same document:

  ~/Vault/onesystem/                  the machine-local vault. It knows what is installed
                                      here, so it names one engine and leads with how to
                                      call it. Agents read this one.

  ~/Projects/onesystem/wiki/          the published copy, on GitHub. It has to work for
                                      anyone, so it cannot name an engine as *the* one and
                                      it leads with how to detect what you have.

The local vault is the source for the parts that are genuinely shared — the use cases, the
payloads, the glossary, the data contract. The framing pages are deliberately different,
so a blind copy is wrong in both directions: it leaks this machine's configuration into a
public document, and it would drag "the engine here is X" into a page that has to work for a
reader who has Y.

So this does not copy. It checks three things:

  1. Shared files are byte-identical. They are one fact stated twice, so they must not drift.
  2. The published copy contains no claim about what is installed *here*. A phrase like
     "this machine runs" or "is the only enabled engine" is a bug in the public copy.
  3. The published copy leads with detection, so a reader who does not know their engines
     is told how to find out before being told anything that depends on it.

    python3 scripts/check-published.py          # check
    python3 scripts/check-published.py -v       # with diffs
"""

import difflib
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
LOCAL = HERE.parent
PUBLISHED = pathlib.Path("/home/micah/Projects/onesystem/wiki")

# Files that must be identical. They are the parts with no machine in them: what a decision
# point looks like, the payload that implements it, and the terms.
SHARED = ("use-cases/", "glossary.md", "index/", "Home.md.agnostic-check")

# Shared: the notes with no machine in them. patterns/ belongs here -- it links into
# use-cases/, and treating it as machine-local is what left the published copy with a dead
# link once a use case was renamed.
SHARED_DIRS = ("use-cases/", "patterns/", "index/")

# Framing: written separately in each place, because they lead with what is installed here.
FRAMING = ("Home.md", "README.md", "reference/")

# A published copy that says any of these is describing one machine, not a general wiki.
# Matched case-insensitively; each is a bug in the public copy, not a style preference.
# Deliberately specific phrasings. A loose entry like "rizzo only" reads as a violation in
# "measured on rizzo only", which is a caveat about a measurement and belongs in a shared
# note -- so the patterns here name a claim about the installation, not about the text.
MACHINE_CLAIMS = (
    "this machine runs",
    "this machine has",
    "the engine this machine",
    "on this machine rizzo",
    "rizzo is the one enabled",
    "only enabled engine",
    "is the engine here",
    "what this machine has",
    "whose runtime exists here",
    "runtimes have been deleted",
    "installed but disabled",
)

failures: list[str] = []
notes_checked = 0


def fail(msg: str) -> None:
    failures.append(msg)


def local_notes() -> dict[str, pathlib.Path]:
    return {str(p.relative_to(LOCAL)): p for p in sorted(LOCAL.rglob("*.md")) if ".git" not in p.parts}


def published_notes() -> dict[str, pathlib.Path]:
    return {
        str(p.relative_to(PUBLISHED)): p
        for p in sorted(PUBLISHED.rglob("*.md"))
        if ".git" not in p.parts and "node_modules" not in p.parts
    }


def main() -> int:
    global notes_checked
    verbose = "-v" in sys.argv
    local, published = local_notes(), published_notes()

    if not local:
        fail(f"no local vault at {LOCAL}")
    if not published:
        fail(f"no published copy at {PUBLISHED}")

    # 1. Shared files identical.
    for prefix in (*SHARED_DIRS, "glossary.md"):
        names = [n for n in local if n.startswith(prefix)]
        for name in sorted(names):
            notes_checked += 1
            if name not in published:
                fail(f"missing from the published copy: {name}")
            elif local[name].read_bytes() != published[name].read_bytes():
                fail(f"shared file has drifted: {name}")
                if verbose:
                    diff = difflib.unified_diff(
                        local[name].read_text(encoding="utf-8").splitlines(),
                        published[name].read_text(encoding="utf-8").splitlines(),
                        fromfile="local", tofile="published", lineterm="", n=1,
                    )
                    for line in list(diff)[:30]:
                        print(f"      {line}")

    # 2. No machine claims in the published copy.
    for name, path in sorted(published.items()):
        text = path.read_text(encoding="utf-8").lower()
        for claim in MACHINE_CLAIMS:
            if claim in text:
                fail(f"published copy claims a machine-specific fact: {claim!r} in {name}")

    # 3. The published entry point detects before it asserts.
    home = (PUBLISHED / "Home.md")
    if home.exists():
        text = home.read_text(encoding="utf-8")
        head = text[: text.find("## The contract") if "## The contract" in text else 4000].lower()
        if "catalog" not in head:
            fail("the published Home.md does not tell the reader how to find out which "
                 "engines they have before it says anything that depends on it")
        if "json.parse" not in text.lower():
            fail("the published Home.md does not mention that the tool returns a string")

    # Framing pages are expected to differ; say so, so nobody "fixes" it into a copy.
    for prefix in FRAMING:
        shared = [n for n in local if n.startswith(prefix) and n in published]
        same = [n for n in shared if local[n].read_bytes() == published[n].read_bytes()]
        print(f"  framing {prefix:16} {len(same)}/{len(shared)} identical to the local vault")

    for f in failures:
        print(f"  MISMATCH {f}")
    print(f"\n{notes_checked} shared notes checked, {len(failures)} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
