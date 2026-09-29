#!/usr/bin/env python3
"""
Check the wiki's factual claims against the running system.

The wiki asserts things about the three engines -- which tool names exist, which `state`
shapes are accepted, what a refusal looks like. Those are all checkable against a live
onesystem, and a wiki that documents a contract nobody verifies is how a wiki goes stale
quietly.

    onesystem start
    python3 scripts/verify-claims.py

Exits non-zero on a mismatch. Reads the vault, so it fails if the documentation and the
system disagree -- which is the whole point.
"""

import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:7331"

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


def call(backend: str, tool: str, arguments: dict) -> tuple[bool, str]:
    """POST /call, returning (ok, text). `text` is the answer or the error message."""
    body = json.dumps({"backend": backend, "tool": tool, "arguments": arguments}).encode()
    request = urllib.request.Request(
        f"{BASE}/call",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        envelope = json.loads(response.read().decode())
    return True, str(envelope.get("result", {}).get("content", [{}])[0].get("text", ""))


# --- what the vault claims -----------------------------------------------------

vault_text = "\n".join(p.read_text(encoding="utf-8") for p in ROOT.rglob("*.md"))

# --- the service is up ---------------------------------------------------------

try:
    health = get("/health")
except (urllib.error.URLError, OSError) as exc:
    print(f"no onesystem answering on {BASE} ({exc}). Start one: `onesystem start`")
    sys.exit(1)

catalog = get("/catalog")
by_backend = {b["backend"]: b for b in catalog["backends"]}
enabled = [b["name"] for b in health["backends"]]

# --- claim: every enabled engine publishes `predict` ---------------------------

for name in enabled:
    tools = {t["name"] for t in by_backend.get(name, {}).get("tools", {}).get("tools", [])}
    check("predict" in tools or any(t.endswith("predict") for t in tools),
          f"{name} is enabled but publishes no `predict` tool; the wiki's portable surface assumes one")

# --- claim: laya needs an object, julia needs a string, rizzo takes either -----

SITUATION = "A payments endpoint began returning 503 for 4% of requests after the pool cap was lowered to 5."
QUESTION = {
    "probe": {
        "type": "choice",
        "instructions": "What is the proximate cause?",
        "criteria": {"pool": "The pool is saturated at its cap.", "upstream": "The upstream is degraded."},
    }
}

for backend, accepts_object, accepts_string in (("laya", True, False), ("julia", False, True), ("rizzo", True, True)):
    if backend not in enabled:
        continue
    for shape, state, should_work in (
        ("object", {"situation": SITUATION}, accepts_object),
        ("string", SITUATION, accepts_string),
    ):
        ok, text = call(backend, "predict", {"state": state, "questions": QUESTION})
        answered = ok and text.strip().startswith("{") and "answers" in text
        check(answered == should_work,
              f"{backend} with state as {shape}: expected "
              f"{'acceptance' if should_work else 'refusal'}, got {'an answer' if answered else text[:90]!r}")

# --- claim: score takes an ordered array, not an object ------------------------

if "laya" in enabled:
    ok, text = call("laya", "predict", {
        "state": {"situation": SITUATION},
        "questions": {"probe": {"type": "score", "instructions": "How severe?",
                                "criteria": {"low": "Minor.", "high": "Major."}}},
    })
    check(not (ok and '"answers"' in text and "probe" in text and "legend" in text),
          "laya accepted an object for score criteria; the wiki says it wants an ordered array")

# --- claim: a refusal is isError with plain text, not a JSON-RPC error ---------

if "laya" in enabled:
    import http.client

    conn_headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
    init = urllib.request.Request(
        f"{BASE}/mcp/laya",
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "verify", "version": "1"}}}).encode(),
        headers=conn_headers, method="POST")
    with urllib.request.urlopen(init, timeout=120) as response:
        sid = response.headers.get("mcp-session-id")
        response.read()
    check(bool(sid), "laya's MCP endpoint returned no session id")

    if sid:
        urllib.request.urlopen(urllib.request.Request(
            f"{BASE}/mcp/laya",
            data=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}).encode(),
            headers={**conn_headers, "mcp-session-id": sid}, method="POST"), timeout=120).read()
        bad = urllib.request.Request(
            f"{BASE}/mcp/laya",
            data=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": "predict",
                                        "arguments": {"state": "a bare string", "questions": QUESTION}}}).encode(),
            headers={**conn_headers, "mcp-session-id": sid}, method="POST")
        with urllib.request.urlopen(bad, timeout=120) as response:
            frame = response.read().decode()
            status = response.status
        envelope = json.loads(re.search(r"^data: (.*)$", frame, re.M).group(1))
        check(status == 200, f"a shape refusal returned HTTP {status}, not 200; the wiki says 200 + isError")
        check("error" not in envelope, "a shape refusal came back as a JSON-RPC error, not isError")
        check(bool(envelope.get("result", {}).get("isError")),
              "a shape refusal did not set isError; the wiki says check isError before parsing")
        text_block = str(envelope.get("result", {}).get("content", [{}])[0].get("text", ""))
        check(not text_block.strip().startswith("{"),
              "a refusal's content text parsed as JSON; the wiki says it is plain text")
        check("state" in text_block, "the refusal message does not name the offending field")

# --- claim: the compatibility page's matrix matches reality ---------------------

compat = ROOT / "reference" / "compatibility.md"
if compat.exists():
    body = compat.read_text(encoding="utf-8")
    for backend, shape, word in (("laya", "string", "refused"), ("julia", "object", "refused")):
        row = re.search(rf"\|\s*\*\*{backend}\*\*\s*\|([^|]*)\|([^|]*)\|", body)
        if row and backend in enabled:
            cell = row.group(1) if shape == "object" else row.group(2)
            check(word in cell.lower(),
                  f"compatibility.md says {backend} {word} a {shape} state, but the live system disagrees")

# --- claim: `act_probability` really is a constant 1.0 -------------------------

if "laya" in enabled:
    ok, text = call("laya", "predict", {"state": {"situation": SITUATION}, "questions": QUESTION})
    if ok and text.strip().startswith("{"):
        entry = json.loads(text)["answers"]["probe"]
        if "action" in entry:
            check(entry["action"].get("act_probability") == 1.0,
                  f"act_probability is {entry['action'].get('act_probability')!r}, not 1.0; "
                  "the wiki's claim that it is a constant placeholder needs revisiting")

# --- report --------------------------------------------------------------------

for f in failures:
    print(f"  MISMATCH {f}")
print(f"\n{checked} claims checked against {BASE}, {len(failures)} mismatched")
sys.exit(1 if failures else 0)
