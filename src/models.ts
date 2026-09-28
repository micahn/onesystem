/**
 * Installable model definitions: package, interpreter range, weights, and MCP tools.
 * Each model gets its own Python environment.
 */

export interface ModelSpec {
  /** Directory name under the runtimes root, and the name used on the command line. */
  readonly name: string
  /** What to pip-install. Pinned: an unpinned resolution moves torch under you. */
  readonly requirement: string
  /**
   * Supported Python range. Keep upper bounds required by model dependencies.
   */
  readonly requiresPython: string
  /**
   * Interpreter variable written to backend env so all sessions use the installed runtime.
   */
  readonly interpreterEnv?: string
  /**
   * Fetch selected package files and install from a local path. Cloning a Hugging
   * Face Git source would also download LFS weights during dependency resolution.
   */
  readonly source?: { readonly repo: string; readonly allow: readonly string[] }
  /**
   * Install the MCP SDK in this runtime for models exposed through our shim.
   */
  readonly needsMcp?: boolean
  /**
   * Download required weights before use. Store outside the runtime to survive reinstalls.
   */
  readonly weights?: { readonly repo: string; readonly envVar: string }
  /**
   * Tool names without the product prefix, copied into generated config. Update
   * when the model changes; discovering them at setup would start the model.
   */
  readonly tools?: readonly string[]
  /**
   * Manual command guidance for a model without a known entryPoint.
   */
  readonly commandNote?: string
  /**
   * Console script in the runtime's bin directory. Its shebang selects the installed Python.
   */
  readonly entryPoint?: string
}

export const MODELS: readonly ModelSpec[] = [
  {
    name: "laya",
    requirement: "laya[mcp]==0.3.21",
    requiresPython: ">=3.12,<3.15",
    interpreterEnv: "LAYA_PYTHON",
    // Verified against laya 0.3.21 tools/list.
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
    // Laya's own server uses the runtime interpreter; lifecycle policy stays in the daemon.
    entryPoint: "laya-mcp-server",
  },
  {
    name: "julia",
    // Match the package's distribution name, not the model name.
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
