/**
 * Installable model definitions: package, interpreter range, weights, and MCP tools.
 * Each model gets its own Python environment.
 */

/**
 * What one tool takes, as JSON Schema. Deliberately not the backend's own schema:
 * `/catalog` cannot ask for it without a cold load, and the backend stays authoritative.
 */
export interface ToolSchema {
  readonly properties: { readonly [arg: string]: unknown }
  readonly required?: readonly string[]
}

export interface ModelSpec {
  /** Directory name under the runtimes root, and the name used on the command line. */
  readonly name: string
  /**
   * What to pip-install. Pinned: an unpinned resolution moves torch under you.
   *
   * Absent for a model that declares `clone`, which brings its own dependency set and is
   * never pip-installed by onesystem. `pyprojectFor` is the only reader, and a cloned model
   * never reaches it.
   */
  readonly requirement?: string
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
   * Argument schemas keyed by bare tool name, for the tools worth describing. A client
   * reads these from `/catalog` to reject a payload before starting the model. A tool
   * with no entry is advertised as an open object, as every tool was before.
   */
  readonly toolSchemas?: { readonly [tool: string]: ToolSchema }
  /**
   * Manual command guidance for a model without a known entryPoint.
   */
  readonly commandNote?: string
  /**
   * Console script in the runtime's bin directory. Its shebang selects the installed Python.
   */
  readonly entryPoint?: string
  /**
   * Product prefix on this model's tool names, without the trailing underscore.
   *
   * Belongs here rather than in a config file because it is a property of the model, and
   * because two enabled models that publish the same unprefixed tool name are
   * indistinguishable to a client. laya, julia and rizzo all publish `predict`; only laya
   * was carrying a prefix, and only because the shipped template happened to say so.
   */
  readonly toolPrefix?: string
  /**
   * A model installed by cloning a repository and letting its own tooling build the
   * environment, rather than by generating a manifest and resolving one.
   *
   * The clone *is* the runtime directory. Its virtualenv holds absolute paths and these
   * services resolve their own weights relative to where they were started, so it cannot be
   * built in a staging directory and moved into place the way a resolved one is. A failed
   * install therefore leaves a directory without a meta.json, which `runtimes` already
   * reports as a half-install.
   */
  readonly clone?: {
    readonly repo: string
    /** Run in the clone root to build its environment. */
    readonly sync: readonly string[]
    /** Console script the clone leaves behind, relative to the clone root. */
    readonly entry: string
    /** Run after `sync` to fetch whatever the service needs at runtime. */
    readonly prepare?: readonly string[]
    /** Command for `doctor`, relative to the clone root. Reports what it can use. */
    readonly doctor?: readonly string[]
    /** Where the service binds once started. */
    readonly baseUrl?: string
    /** The model name the service is asked for; it has no default of its own. */
    readonly model?: string
  }
}

export const MODELS: readonly ModelSpec[] = [
  {
    name: "laya",
    requirement: "laya[mcp]==0.3.21",
    requiresPython: ">=3.12,<3.15",
    interpreterEnv: "LAYA_PYTHON",
    toolPrefix: "laya",
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
    // predict takes a structured state. The other tools are left undescribed until
    // someone has a payload to check against them.
    toolSchemas: {
      predict: {
        properties: {
          state: { type: ["string", "object", "array"] },
          questions: { type: "object" },
        },
        required: ["state", "questions"],
      },
    },
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
    // `state: string` is the shim's declared type and is not widened here: the two models
    // disagree, and this is where a client finds out. Coercing a dict would hide it.
    toolSchemas: {
      predict: {
        properties: {
          state: { type: "string" },
          questions: { type: "object" },
        },
        required: ["state", "questions"],
      },
    },
  },
  {
    name: "rizzo",
    // Not a model onesystem resolves. Rizzo Flow ships its own server, its own pinned
    // llama.cpp runtime and its own weights, and its virtualenv is absolute-path-bound, so
    // the clone is the runtime directory.
    clone: {
      repo: "https://github.com/Rizzo-AI-Academy/rizzo-flow",
      // Its own lock file, resolved by its own tooling. `--locked` refuses to re-resolve,
      // which is what makes the environment reproducible at all.
      sync: ["uv", "sync", "--locked"],
      // Fetches the pinned llama.cpp runtime for this machine and the GGUF weights, both
      // relative to the clone root. None of it is torch.
      prepare: ["uv", "run", "rizzo", "download"],
      entry: ".venv/bin/rizzo",
      doctor: ["uv", "run", "rizzo", "devices"],
      baseUrl: "http://127.0.0.1:8017",
      model: "rizzo-latest",
    },
    requiresPython: ">=3.11",
    // `/v1/systemone` takes laya's `WireQuestion` unchanged: discriminated on `type`, with
    // `noul` using `criteria: {false, true}`. The only addition is the model name, which
    // the service requires and has no default for.
    tools: ["predict"],
    toolPrefix: "rizzo",
    toolSchemas: {
      predict: {
        properties: {
          state: { type: ["string", "object", "array"] },
          questions: { type: "object" },
        },
        required: ["state", "questions"],
      },
    },
  },
]

/** The spec for a backend name, or undefined. `findModel` throws; this one does not. */
export function modelFor(name: string): ModelSpec | undefined {
  return MODELS.find((m) => m.name === name)
}

export function findModel(name: string): ModelSpec {
  const spec = MODELS.find((m) => m.name === name)
  if (!spec) {
    throw new Error(`unknown model "${name}"; known: ${MODELS.map((m) => m.name).join(", ")}`)
  }
  return spec
}
