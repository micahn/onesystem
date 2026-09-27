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
}

export const MODELS: readonly ModelSpec[] = [
  {
    name: "laya",
    requirement: "laya[mcp]==0.3.21",
    requiresPython: ">=3.12,<3.15",
    interpreterEnv: "LAYA_PYTHON",
  },
  {
    name: "julia",
    // The distribution name is not the model name; the repo's pyproject says
    // `supersonic-julia`, and a source whose metadata name disagrees is refused.
    requirement: "supersonic-julia==0.1.0",
    requiresPython: ">=3.11,<3.15",
    source: { repo: "SupersonicLabs/Julia-1", allow: ["julia/**", "pyproject.toml", "README.md"] },
  },
]

export function findModel(name: string): ModelSpec {
  const spec = MODELS.find((m) => m.name === name)
  if (!spec) {
    throw new Error(`unknown model "${name}"; known: ${MODELS.map((m) => m.name).join(", ")}`)
  }
  return spec
}
