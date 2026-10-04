#!/usr/bin/env python3
"""
Run the payloads this vault documents against the engine that actually runs here.

The vault's own rule is that a payload nobody has run is a `candidate`, not a `proven`. This
script is how a candidate gets promoted, and it is the check that matters most right now: a
documented payload that the installed engine rejects is worse than no payload, because the
first agent to try it concludes the engine is broken and stops using it.

    onesystem start
    python3 scripts/run-payloads.py            # all of them
    python3 scripts/run-payloads.py ticket-gate # one

Exits non-zero if anything the vault hands out does not work.
"""

import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:7331"

# The engine this machine runs. Not a default: laya and julia are installed but disabled,
# and a payload that only works on one of them is a payload nobody will use.
ENGINE = "rizzo"

PAYLOAD = re.compile(r"```json\n(.*?)\n```", re.S)
# A `<placeholder>` or an explicit `...` inside the block means the note is showing
# the shape of a call rather than a runnable one.
ELIDED = re.compile(r"<[^>]*\.{0,3}[^>]*>|\"\.\.\.|\.\.\.\"")

failures: list[str] = []
ran = 0


def call(state: object, questions: object) -> tuple[bool, str]:
    body = json.dumps({"backend": ENGINE, "tool": "predict", "arguments": {"state": state, "questions": questions}}).encode()
    request = urllib.request.Request(f"{BASE}/call", data=body, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            envelope = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read().decode()[:200]}"
    content = envelope.get("result", {}).get("content", [{}])[0].get("text", "")
    if envelope.get("result", {}).get("isError"):
        return False, content.replace("\n", " ")[:200]
    try:
        answers = json.loads(content)["answers"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        return False, f"unparseable answer ({exc}): {content[:160]}"
    return True, answers


def engines_of(path: pathlib.Path) -> list[str]:
    front = path.read_text(encoding="utf-8").split("---")[1]
    found = re.search(r"^engines: \[(.*?)\]", front, re.M)
    return [x.strip() for x in found.group(1).split(",")] if found else []


def main() -> int:
    global ran
    only = sys.argv[1] if len(sys.argv) > 1 else None

    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=60) as response:
            health = json.loads(response.read().decode())
    except (urllib.error.URLError, OSError) as exc:
        print(f"no onesystem answering on {BASE} ({exc}). Start one: `onesystem start`")
        return 1

    enabled = [b["name"] for b in health["backends"]]
    if ENGINE not in enabled:
        print(f"{ENGINE} is not enabled. Enabled: {', '.join(enabled) or 'none'}")
        return 1

    notes = sorted(ROOT.glob("use-cases/*.md"))
    for note in notes:
        ident = note.stem
        if ident == "index" or (only and ident != only):
            continue
        text = note.read_text(encoding="utf-8")
        blocks = PAYLOAD.findall(text)
        if not blocks:
            continue
        engines = engines_of(note)
        # A note scoped to another engine is not expected to run here, and saying so out
        # loud is the point -- otherwise a failure looks like a bug rather than a scope.
        if engines and ENGINE not in engines:
            print(f"  skip  {ident:32} engines={engines}")
            continue

        for index, block in enumerate(blocks):
            # Check for elision *before* parsing. Two notes carry a block that is not meant
            # to be sent -- one shows a different tool entirely, one shows the index itself
            # with its criteria elided -- and parsing first reported both as broken JSON,
            # which is a failure of this script rather than of the vault.
            if ELIDED.search(block):
                print(f"  skip  {ident:32} payload {index} is elided")
                continue

            try:
                payload = json.loads(block)
            except json.JSONDecodeError as exc:
                failures.append(f"{ident} payload {index}: not valid JSON ({exc})")
                print(f"  FAIL  {ident:32} payload {index}: invalid JSON")
                continue

            if not isinstance(payload, dict):
                failures.append(f"{ident} payload {index}: not a JSON object")
                continue
            if "questions" not in payload:
                # A different tool's payload -- `preset`, say -- rather than a bad one.
                other = sorted(set(payload) - {"state"})
                print(f"  skip  {ident:32} payload {index} is not a predict call ({', '.join(other)})")
                continue
            if "state" not in payload:
                failures.append(f"{ident} payload {index}: has questions but no state")
                continue
            ran += 1
            ok, answer = call(payload["state"], payload["questions"])
            name = f"{ident} payload {index}"
            if not ok:
                failures.append(f"{name}: {answer}")
                print(f"  FAIL  {ident:32} payload {index}: {answer[:100]}")
            else:
                top = list(answer)[0] if isinstance(answer, dict) else "?"
                print(f"  ok    {ident:32} payload {index} -> {top}")

    print(f"\n{ran} payload(s) run against {ENGINE}, {len(failures)} failed")
    for f in failures:
        print(f"  FAILED {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
