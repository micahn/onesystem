#!/usr/bin/env python3
"""
Check this vault's claims against the running system.

The vault documents a contract, and a documented contract that nobody verifies is how a
wiki goes stale quietly. Every assertion below is one the vault makes in prose, so a model
upgrade that breaks one shows up as a failing check rather than as a wrong answer months
later.

    onesystem start
    python3 scripts/verify-claims.py

Exits non-zero on a mismatch. It reads the vault's own text for the claims it can check
against documentation, and asks the live system for the rest.
"""

import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:7331"
ENGINE = "rizzo"

failures: list[str] = []
checked = 0


def check(ok: bool, claim: str) -> None:
    global checked
    checked += 1
    if not ok:
        failures.append(claim)


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=60) as response:
        return json.loads(response.read().decode())


def call(backend: str, state: object, questions: object) -> dict:
    body = json.dumps({"backend": backend, "tool": "predict", "arguments": {"state": state, "questions": questions}}).encode()
    request = urllib.request.Request(f"{BASE}/call", data=body, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=300) as response:
        envelope = json.loads(response.read().decode())
    text = envelope.get("result", {}).get("content", [{}])[0].get("text", "")
    if envelope.get("result", {}).get("isError"):
        raise RuntimeError(text)
    return json.loads(text)


SITUATION = "Checkout returns 503 for ~4% of requests since the connection pool was capped at 5. p99 went 40ms to 2.1s."
CHOICE = {"probe": {"type": "choice", "instructions": "What is the proximate cause?",
                   "criteria": {"pool": "The pool is saturated at its cap.", "upstream": "The upstream is degraded."}}}
NOUL = {"probe": {"type": "noul", "instructions": "Does this need a rollback?",
                  "criteria": {"false": "No, a forward fix.", "true": "Yes, roll back."}}}
SCORE = {"probe": {"type": "score", "instructions": "How severe is this?",
                   "criteria": ["Minor and self-clearing.", "Degraded but usable.", "Partial outage."]}}

try:
    health = get("/health")
    catalog = get("/catalog")
except (urllib.error.URLError, OSError) as exc:
    print(f"no onesystem answering on {BASE} ({exc}). Start one: `onesystem start`")
    sys.exit(1)

enabled = [b["name"] for b in health["backends"]]
by_backend = {b["backend"]: b for b in catalog["backends"]}

# --- who is enabled ---------------------------------------------------------------

check(ENGINE in enabled, f"{ENGINE} is not enabled; the vault is written for it")
check(enabled == [ENGINE],
      f"the vault says only {ENGINE} is enabled, but the config has {enabled}. "
      "The bare tool name in every payload depends on this.")
check(bool(by_backend.get(ENGINE, {}).get("tools", {}).get("tools")),
      f"{ENGINE} publishes no tools in the catalog")

# --- state shapes -----------------------------------------------------------------

for label, state, should_work in (
    ("object", {"situation": SITUATION}, True),
    ("string", SITUATION, True),
):
    try:
        call(ENGINE, state, CHOICE)
        worked = True
        detail = "answered"
    except Exception as exc:  # noqa: BLE001 -- the message is the assertion
        worked = False
        detail = str(exc)[:120]
    check(worked == should_work,
          f"the vault says {ENGINE} accepts state as a {label}; live result: {detail}")

# --- the three question types ------------------------------------------------------

for name, questions in (("choice", CHOICE), ("noul", NOUL), ("score", SCORE)):
    try:
        answer = call(ENGINE, {"situation": SITUATION}, questions)
        check("probe" in answer.get("answers", {}), f"{name} returned no answer for the probe")
    except Exception as exc:  # noqa: BLE001
        check(False, f"the vault says {ENGINE} answers `noul`/`score`/`choice`; {name} failed: {str(exc)[:120]}")

# --- score wants an array ----------------------------------------------------------

try:
    call(ENGINE, {"situation": SITUATION},
         {"probe": {"type": "score", "instructions": "How severe?",
                    "criteria": {"low": "Minor.", "high": "Major."}}})
    check(False, "an object was accepted for score criteria; the vault says it must be an ordered array")
except Exception:
    check(True, "")

# --- what rizzo says about its own numbers ----------------------------------------

try:
    answer = call(ENGINE, {"situation": SITUATION}, CHOICE)
    status = answer.get("x_rizzo", {}).get("probability_status")
    check(status == ["uncalibrated_conditional_option_scores"],
          f"probability_status is {status!r}; the vault tells readers the numbers are "
          "uncalibrated option scores, and that has to stay true or the caveat is a lie")

    # laya's trap, and rizzo's immunity to it.
    entry = answer.get("answers", {}).get("probe", {})
    check("action" not in entry,
          "a rizzo answer now carries an `action` block; the vault says rizzo has no "
          "act_probability placeholder, so the laya-only note needs revisiting")
except Exception as exc:  # noqa: BLE001
    check(False, f"could not read the rizzo payload: {str(exc)[:120]}")

# --- score is a position, not an index ---------------------------------------------

try:
    answer = call(ENGINE, {"situation": SITUATION}, SCORE)
    entry = answer["answers"]["probe"]
    check(isinstance(entry.get("probabilities"), dict) and isinstance(entry.get("legend"), dict),
          "a score answer no longer carries probabilities and legend; the vault tells readers "
          "to score by the argmax of probabilities, so that instruction is now wrong")
except Exception as exc:  # noqa: BLE001
    check(False, f"could not read the score payload: {str(exc)[:120]}")

# --- the vault's own text agrees with the system -----------------------------------

home = (ROOT / "Home.md").read_text(encoding="utf-8")
check("JSON.parse" in home,
      "Home.md does not mention JSON.parse; the tool returns a string and that is the most "
      "likely reason a first attempt looks like a failure")
check("uncalibrated" in home or "uncalibrated" in (ROOT / "reference" / "answer-payload.md").read_text(encoding="utf-8"),
      "no page records rizzo's probability_status disclaimer")

for f in failures:
    print(f"  MISMATCH {f}")
print(f"\n{checked} claims checked against {BASE}, {len(failures)} mismatched")
sys.exit(1 if failures else 0)
