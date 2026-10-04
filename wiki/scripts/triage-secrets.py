#!/usr/bin/env python3
"""
Rank a diff for credential risk, using whichever engines are enabled.

This is the runnable half of `use-cases/pre-push-secret-triage.md`. It **ranks**; it does not
block, and it will say so on every run.

    python3 scripts/triage-secrets.py                 # triage the working tree diff
    python3 scripts/triage-secrets.py --staged        # only staged changes
    python3 scripts/triage-secrets.py path/to/file    # specific files
    python3 scripts/triage-secrets.py --threshold 0.9 # flag the top band, do not exit non-zero

## Why it does not exit non-zero

Measured on 34 labelled files, the ten most suspicious were ten real secrets -- so the
ranking is worth trusting. But `.env.example` scores 0.97, higher than half the real
credentials, so no threshold separates them. A tool that blocked on one would block
`.env.example` on every push and be `--no-verify`'d within a week.

Four question variants were measured and none separated the classes; naming `.env.example`
in the criteria made it worse, not better. The difference between a placeholder and a
working key is not recoverable from the file's bytes.

**Blocking is a deterministic scanner's job.** This ranks what to read first, and what to
read twice.
"""

import argparse
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:7331"

# The tuned wording from the note. Do not re-tune this casually: it was measured, and the
# measurement is in the note.
INSTRUCTIONS = (
    "If this file were published, could a stranger use something in it to get into a "
    "system that is not theirs?"
)
CRITERIA = {
    "false": (
        "No. Nothing here grants access. A .env.example with placeholder values, a public "
        "key block, a password hash, a commit hash, a UUID, a test card number, and prose "
        "about rotating credentials are all no."
    ),
    "true": (
        "Yes. Something here is a working password, token, API key, connection string with "
        "a password, or private key."
    ),
}

# Largest file we will send. Measured at roughly 3 bytes per token against rizzo's
# 8192-token context, which puts the real ceiling near 24 KB -- and going over is not a
# refusal the engine can explain, it is a 422 that arrives as an opaque failure. Minified
# bundles are the usual offenders and the answer does not improve with the bytes.
MAX_BYTES = 20_000


def die(msg: str) -> None:
    print(f"  {msg}", file=sys.stderr)
    sys.exit(1)


def health() -> dict:
    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=30) as r:
            return json.loads(r.read().decode())
    except (urllib.error.URLError, OSError) as exc:
        die(f"no onesystem answering on {BASE} ({exc}). Start one: `onesystem start`")


def score(backend: str, text: str) -> tuple[float | None, str]:
    """(P(true), reason-if-not). Never raises, and never returns a bare failure.

    The reason matters: an earlier version reported every failure as "did not answer", which
    hid that the real cause was a 422 because the file exceeded the engine's context. A
    triage tool that silently skips the most important file in a diff is worse than one that
    says why.
    """
    body = json.dumps({
        "backend": backend,
        "tool": "predict",
        "arguments": {
            "state": {"text": text},
            "questions": {"q": {"type": "noul", "instructions": INSTRUCTIONS, "criteria": CRITERIA}},
        },
    }).encode()
    req = urllib.request.Request(f"{BASE}/call", data=body, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            envelope = json.loads(r.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        # onesystem surfaces a backend refusal as a 500, so the useful text is inside.
        if "exceeds the context limit" in detail:
            return None, "over the engine's context limit -- raise MAX_BYTES only with a bigger context"
        return None, f"HTTP {exc.code}: {detail[:120]}"
    except (urllib.error.URLError, TimeoutError) as exc:
        return None, f"daemon unreachable ({exc})"
    if envelope.get("result", {}).get("isError"):
        return None, envelope["result"]["content"][0]["text"].replace("\n", " ")[:120]
    try:
        payload = json.loads(envelope["result"]["content"][0]["text"])
        return float(payload["answers"]["q"]["noul"]), ""
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        return None, f"unreadable answer ({type(exc).__name__})"


def expand(paths: list[str]) -> list[str]:
    """Accept files or directories. Pointing this at a directory is the obvious thing to do
    and the first version only took files, which made it look broken."""
    out: list[str] = []
    for raw in paths:
        path = pathlib.Path(raw)
        if path.is_dir():
            out.extend(str(f) for f in sorted(path.rglob("*")) if f.is_file())
        else:
            out.append(raw)
    return out


def changed_files(staged: bool) -> list[str]:
    args = ["diff", "--cached", "--name-only", "--diff-filter=ACMR"] if staged else \
           ["diff", "HEAD", "--name-only", "--diff-filter=ACMR"]
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=60).stdout
    except (subprocess.SubprocessError, FileNotFoundError) as exc:
        die(f"could not run git: {exc}")
    return [line for line in out.split("\n") if line.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", help="files or directories; default is the working-tree diff")
    ap.add_argument("--staged", action="store_true", help="only staged changes")
    ap.add_argument("--threshold", type=float, default=None,
                    help="print a flag for anything at or above this, but do not fail the run")
    ap.add_argument("--top", type=int, default=12, help="how many rows to print")
    args = ap.parse_args()

    h = health()
    enabled = [b["name"] for b in h["backends"]]
    if not enabled:
        die("no engines are enabled, so there is nothing to triage with")

    files = expand(args.paths) if args.paths else changed_files(args.staged)
    if not files:
        print("  nothing changed, so nothing to triage")
        return 0

    results: list[tuple[float, str, int, str]] = []
    skipped: list[tuple[str, str]] = []
    for name in files:
        path = pathlib.Path(name)
        try:
            if not path.is_file():
                skipped.append((name, "not a file"))
                continue
            size = path.stat().st_size
            if size > MAX_BYTES:
                skipped.append((name, f"{size // 1024}K, over the {MAX_BYTES // 1024}K limit"))
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            skipped.append((name, str(exc)))
            continue

        # One engine is enough and one is honest: asking several and taking the max would be
        # a different tool with different false positives, and nothing here is worth that.
        got, why = score(enabled[0], text)
        if got is None:
            skipped.append((name, why or f"{enabled[0]} did not answer"))
            continue
        results.append((got, name, size, enabled[0]))

    results.sort(reverse=True)
    print(f"\n  {len(results)} file(s) scored by {enabled[0]}; {len(skipped)} skipped")
    print("  RANKING ONLY -- a deterministic scanner decides whether to block.\n")

    flagged = 0
    for got, name, size, engine in results[: args.top]:
        mark = ""
        if args.threshold is not None and got >= args.threshold:
            mark = "  <- above your threshold"
            flagged += 1
        print(f"  {got:.3f}  {name:52} {size // 1024:5}K{mark}")

    for name, why in skipped[:6]:
        print(f"  skip  {name:52} {why}")

    if args.top and len(results) > args.top:
        print(f"  ... and {len(results) - args.top} more below the cut")

    if args.threshold is not None:
        print(f"\n  {flagged} file(s) at or above {args.threshold}. Read those first.")
        print("  Exiting 0 regardless: recall .env.example at 0.97 and you have trained")
        print("  yourself to skip this. Block with gitleaks; rank with this.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
