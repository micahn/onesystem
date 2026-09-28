#!/usr/bin/env python3
"""Expose julia's predict(state, questions) library call over MCP stdio.

The daemon's src/supervisor.ts owns idle shutdown (idleShutdownSecs) and per-call
timeouts (requestTimeoutSecs). Add lifecycle policy there; quiesce stops this
process to release the model.
"""
import os
import sys
import traceback

CHECKPOINT = os.environ.get("JULIA_CHECKPOINT", "")


def _device():
    # PyTorch uses "cuda" for both ROCm and NVIDIA devices.
    return os.environ.get("JULIA_DEVICE", "cuda")


class Engine:
    """Load on first use. The daemon releases the model by stopping this process."""

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
    # Support MCPServer in mcp 2.x and FastMCP in 1.x.
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

        Describe each criterion. Measured noul accuracy was about 80% with
        descriptions and 65% with bare false/true labels.
        """
        try:
            return _predict({"state": state, "questions": questions})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            raise

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
