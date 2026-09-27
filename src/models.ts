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
}

export const MODELS: readonly ModelSpec[] = [
  {
    name: "laya",
    requirement: "laya[mcp]==0.3.21",
    requiresPython: ">=3.12,<3.15",
    interpreterEnv: "LAYA_PYTHON",
  },
]

export function findModel(name: string): ModelSpec {
  const spec = MODELS.find((m) => m.name === name)
  if (!spec) {
    throw new Error(`unknown model "${name}"; known: ${MODELS.map((m) => m.name).join(", ")}`)
  }
  return spec
}
