/**
 * The models onesystem knows how to install.
 *
 * A table, not a plugin system. There are two entries today and the shape of a third is
 * already visible from the second, so a registry that loads itself from disk would be a
 * mechanism with one user.
 *
 * What a model provides is an *interpreter that can import it*. The shim, the MCP
 * surface, and the tool names stay in the config — a model is a Python environment, and
 * the daemon does not otherwise care where it came from. That split is why installing one
 * is safe: it cannot break the daemon, the lock, or the MCP surface, because it touches
 * none of them.
 */

export interface ModelSpec {
  /** Directory name under the runtimes root, and the name used on the command line. */
  readonly name: string
  /** What to pip-install. Pinned: an unpinned resolution moves torch under you. */
  readonly requirement: string
  /**
   * Interpreter range.
   *
   * Deliberately not "3.12 or newer". A model's upper bound is a real constraint —
   * `laya` needs `transformers<6` today and Julia needs `<5.1` — and a shared
   * interpreter is exactly how a model ends up silently importing the wrong torch.
   */
  readonly requiresPython: string
  /**
   * Environment variable the backend's shim reads its interpreter from.
   *
   * This is the whole integration point, and it is load-bearing: `LAYA_PYTHON` is not
   * inherited from the shell, so a config without it makes the shim fall back to the mise
   * interpreter, which cannot see the GPU, and the daemon keeps answering with error
   * payloads. The installer writes it.
   */
  readonly interpreterEnv?: string
  /**
   * A model whose Python package is not on PyPI and has to be fetched.
   *
   * `laya` is a wheel; Julia-1 is a repository that ships its package alongside a 550 MB
   * checkpoint, and the two have to be fetched differently. A git source is the obvious
   * spelling and does not work: a clone of a Hugging Face repo pulls the LFS weights, so
   * `uv lock` on the git source spends its time downloading 584 MB to read a `pyproject`.
   * So the package files are fetched on their own and installed from a local path.
   */
  readonly source?: { readonly repo: string; readonly allow: readonly string[] }
  /**
   * The runtime needs the MCP SDK in it.
   *
   * True for a model that ships a library rather than a server. The shim that exposes
   * it runs on this model's own interpreter, so the dependency goes in this venv and
   * not in a requirements file next to the shim, which nothing would install.
   */
  readonly needsMcp?: boolean
  /**
   * Weights that have to exist as a local directory before the model will load.
   *
   * A checkpoint, not code: 550 MB for Julia-1, fetched once and kept outside the runtime
   * so a reinstall does not take it with it. Fetched by the installer rather than left to
   * the model because a model that loads from a local path and has nothing there fails at
   * the first call, long after the install reported success.
   */
  readonly weights?: { readonly repo: string; readonly envVar: string }
  /**
   * The MCP tool names this model publishes, without any product prefix.
   *
   * Declared rather than discovered, because discovering it means starting the model, and
   * starting the model is the 20-54s load and 3 GB of VRAM that lazy start exists to keep
   * off a path the agent did not ask for. The installer prints these so a generated config
   * block is complete; the shipped config repeats them by hand, and nothing checks that the
   * two agree with the model itself.
   */
  readonly tools?: readonly string[]
  /**
   * A sentence about the `command` a person still has to fill in, for models that ship
   * their own server rather than a library onesystem runs a shim beside.
   */
  readonly commandNote?: string
}

export const MODELS: readonly ModelSpec[] = [
  {
    name: "laya",
    requirement: "laya[mcp]==0.3.21",
    requiresPython: ">=3.12,<3.15",
    interpreterEnv: "LAYA_PYTHON",
    // laya ships its own MCP server, so the command is that binary and not anything this
    // project can derive. Measured against laya 0.3.21 via its own `tools/list`.
    tools: [
      "predict",
      "status",
      "route",
      "decide",
      "shortlist",
      "preset",
      "predict_batch",
      "route_batch",
    ],
    commandNote: "the laya MCP server binary, e.g. laya-mcp-idle-server on your PATH",
  },
  {
    name: "julia",
    // The distribution name is not the model name; the repo's pyproject says
    // `supersonic-julia`, and a source whose metadata name disagrees is refused.
    //
    // `mcp` is here, not in the shim's requirements, because the shim runs *inside* this
    // runtime. laya ships its own MCP server; the julia package is a library with the
    // same predict contract and none, so the server is ours and its dependency belongs
    // with the interpreter that has to import it.
    requirement: "supersonic-julia==0.1.0",
    requiresPython: ">=3.11,<3.15",
    source: { repo: "SupersonicLabs/Julia-1", allow: ["julia/**", "pyproject.toml", "README.md"] },
    needsMcp: true,
    weights: { repo: "SupersonicLabs/Julia-1", envVar: "JULIA_CHECKPOINT" },
    // julia ships a library and no server, so the shim in this repo is the surface, and it
    // publishes exactly one tool.
    tools: ["predict"],
  },
]

export function findModel(name: string): ModelSpec {
  const spec = MODELS.find((m) => m.name === name)
  if (!spec) {
    throw new Error(`unknown model "${name}"; known: ${MODELS.map((m) => m.name).join(", ")}`)
  }
  return spec
}
