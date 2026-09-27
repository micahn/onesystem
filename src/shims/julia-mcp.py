#!/usr/bin/env python3
"""MCP stdio bridge for the `julia` backend.

laya ships its own MCP server; the `julia` package is a library with the same
predict(state, questions) contract and no server, so this is the adapter that
puts it behind the same tool surface onesystem already speaks.

Deliberately thin. Everything worth sharing -- the typed question contract, the
idle window, the per-call timeout -- already exists on the daemon side, so this
only has to translate one tool call into one library call.
"""
import json
import os
import sys
import time
import traceback

CHECKPOINT = os.environ.get("JULIA_CHECKPOINT", "")
IDLE_UNLOAD_SECS = int(os.environ.get("JULIA_IDLE_UNLOAD_SECS", "300"))
TOOL_TIMEOUT_SECS = int(os.environ.get("JULIA_TOOL_TIMEOUT_SECS", "120"))


def _device():
    # ROCm reports itself as "cuda", which is correct and confusing. laya does the
    # same thing, so the name here is not a signal that something is wrong.
    return os.environ.get("JULIA_DEVICE", "cuda")


class Engine:
    """Lazily loaded, with an idle unload.

    Loading costs ~6s and ~0.7 GB, so a session that never calls a tool should not
    pay for it, and a session that stops calling should give it back.
    """

    def __init__(self):
        self._model = None
        self._last_used = 0.0

    def get(self):
        if self._model is None:
            from julia import load_model

            self._model = load_model(CHECKPOINT, device=_device())
        self._last_used = time.time()
        return self._model

    def reap_if_idle(self):
        if self._model is not None and time.time() - self._last_used > IDLE_UNLOAD_SECS:
            self._model = None
            print(f"[onesystem:julia] idle {IDLE_UNLOAD_SECS}s, unloaded", file=sys.stderr, flush=True)


ENGINE = Engine()


def _predict(arguments):
    if not CHECKPOINT:
        raise RuntimeError("JULIA_CHECKPOINT is not set; it must point at the downloaded weights")
    model = ENGINE.get()
    return model.predict(
        state=arguments.get("state", ""),
        questions=arguments.get("questions", {}),
    )


def main():
    # mcp 2.x renamed FastMCP to MCPServer; 1.x has no MCPServer at all. The v1 spelling
    # is the one that fails here, and it fails at import with a message that reads like a
    # missing dependency rather than a rename.
    try:
        from mcp.server.mcpserver import MCPServer
    except ImportError:  # pragma: no cover - only on mcp 1.x
        from mcp.server.fastmcp import FastMCP as MCPServer

    mcp = MCPServer("onesystem-julia")

    @mcp.tool()
    def predict(state: str, questions: dict) -> dict:
        """Answer typed questions about a state in one forward pass.

        `questions` maps a caller-chosen id to one of:
          choice: {type, instructions, criteria: {label: description}}
          score:  {type, instructions, criteria: [ordered rubric descriptions]}
          noul:   {type, instructions, criteria: {false: ..., true: ...}}

        Descriptive criteria matter. Measured on this model, a `noul` question with real
        descriptions scores around 80% and the same question with bare `false`/`true`
        labels around 65% -- so the labels are part of the question, not decoration.
        """
        try:
            return _predict({"state": state, "questions": questions})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            raise

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
