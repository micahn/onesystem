#!/usr/bin/env python3
"""MCP stdio bridge for the `julia` backend.

laya ships its own MCP server; the `julia` package is a library with the same
predict(state, questions) contract and no server, so this is the adapter that
puts it behind the same tool surface onesystem already speaks.

Deliberately thin: one tool call in, one library call out.

## Where the idle window and the per-call timeout are

Both of them are the daemon's, and this file implements neither.

    idle window    src/supervisor.ts -- a backend is quiesced once it is local,
                   warm, idle past ``idleShutdownSecs``, and not in flight
    per-call cap   the supervisor layers the config's ``requestTimeoutSecs`` over
                   the forward, as a backstop on the adapter's own signal

This file used to read ``JULIA_IDLE_UNLOAD_SECS`` and ``JULIA_TOOL_TIMEOUT_SECS``,
and carried an ``Engine.reap_if_idle`` that nothing in the file ever called next to
a ``TOOL_TIMEOUT_SECS`` that nothing in the file ever read. All three were dead, and
all three were worse than absent: a maintainer debugging a hung call opens the shim
because the shim is where the model lives, finds the constant, and finds it unused.
The shipped config set both of those variables as well, which made three places
assert that a child enforces a per-call cap that no child enforces.

They are gone. If you are adding a cap, add it to the config and read it in the
daemon; if you are adding an unload, ``quiesce`` is the hook and the supervisor
calls it.
"""
import os
import sys
import traceback

CHECKPOINT = os.environ.get("JULIA_CHECKPOINT", "")


def _device():
    # ROCm reports itself as "cuda", which is correct and confusing. laya does the
    # same thing, so the name here is not a signal that something is wrong.
    return os.environ.get("JULIA_DEVICE", "cuda")


class Engine:
    """Lazily loaded, and nothing more.

    Loading costs ~6s and ~0.7 GB, so a session that never calls a tool should not
    pay for it. That laziness is the whole of this class. The *release* is the
    daemon's: it quiesces the process rather than reaching in here to drop a
    reference, so an in-process unload would have been a second and quieter version
    of a policy the supervisor already owns.
    """

    def __init__(self):
        self._model = None

    def get(self):
        if self._model is None:
            from julia import load_model

            self._model = load_model(CHECKPOINT, device=_device())
        return self._model


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
