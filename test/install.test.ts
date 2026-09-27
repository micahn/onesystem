/**
 * The installer's decisions, tested without a GPU or a network.
 *
 * The parts worth testing are the ones that fail silently. A wrong wheel index does not
 * raise: it installs something that imports cleanly and then runs on the CPU, which on
 * this machine has already happened once. So the manifest and the check that guards it
 * are asserted here, against lock files both ways.
 */

import { describe, expect, test } from "bun:test"
import { assertNoAcceleratorMixups, pyprojectFor, ROCM_INDEX } from "../src/install.ts"
import { findModel, MODELS } from "../src/models.ts"

const amd = { vendor: "amd", gfx: "gfx1201" } as const

/** A lock file shaped like uv's, which is all the check reads. */
const lock = (versions: Record<string, string>) =>
  Object.entries(versions)
    .map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`)
    .join("\n")

describe("the manifest", () => {
  const toml = pyprojectFor(findModel("laya"))

  test("torch is pinned to the ROCm index, not just to a version", () => {
    // The distinction the whole module exists for. A constraint file pins `torch==2.14.0`
    // and the CUDA wheel answers to that too, so a version pin buys nothing here.
    expect(toml).toContain(`torch = { index = "${ROCM_INDEX.name}" }`)
    expect(toml).toContain(`url = "${ROCM_INDEX.url}"`)
  })

  test("the ROCm index is explicit, or PyPI stays a candidate for torch", () => {
    // uv resolves `explicit = true` indexes only for names named in tool.uv.sources.
    // Without it the CUDA wheel wins and the install looks fine.
    expect(toml).toMatch(/\[\[tool\.uv\.index\]\][\s\S]*explicit = true/)
  })

  test("torch is a declared dependency, because source pins bind to declared names only", () => {
    // The quiet failure: `[tool.uv.sources] torch = {...}` does nothing at all if torch
    // is not in `dependencies`. It looks correct and produces a CUDA install.
    expect(toml).toContain('"torch>=2.0.0"')
    // Both spellings of the companion: it was renamed at torch 2.14, and only one of
    // them exists depending on the version.
    expect(toml).toContain('"triton-rocm>=0.0.0"')
    expect(toml).toContain('"pytorch-triton-rocm>=0.0.0"')
  })

  test("the model itself is pinned to an exact version", () => {
    // `laya` shipped 0.3.21 the same day this was written, against 0.3.10 installed. An
    // unpinned requirement moves torch and transformers under you on a routine re-run.
    expect(toml).toMatch(/laya\[mcp\]==\d+\.\d+\.\d+/)
  })
})

describe("refusing an NVIDIA build on an AMD card", () => {
  test("a ROCm lock passes", () => {
    const good = lock({ torch: "2.14.0+rocm7.2", "triton-rocm": "3.8.0", transformers: "5.17.0", numpy: "2.5.3" })
    expect(() => assertNoAcceleratorMixups(good, amd)).not.toThrow()
  })

  test("nvidia packages are caught, and named", () => {
    // The exact wreckage this check exists to prevent: a CUDA torch drags in fifteen
    // `nvidia-*` wheels plus a CUDA triton, none of which can ever run here.
    const bad = lock({ torch: "2.14.0", "nvidia-cudnn-cu13": "9.24.0.43", "nvidia-nccl-cu13": "2.32.3", triton: "3.8.0" })
    expect(() => assertNoAcceleratorMixups(bad, amd)).toThrow(/nvidia-cudnn-cu13/)
    expect(() => assertNoAcceleratorMixups(bad, amd)).toThrow(/nvidia-nccl-cu13/)
    // And the message says why, not just that.
    expect(() => assertNoAcceleratorMixups(bad, amd)).toThrow(/AMD/)
  })

  test("a bare CUDA triton is caught even with no nvidia packages", () => {
    // `triton` is the CUDA one; `triton-rocm` is ours. Matching on the substring "triton"
    // would flag both, so the pattern anchors on the whole name.
    const bad = lock({ torch: "2.14.0+rocm7.2", triton: "3.8.0" })
    expect(() => assertNoAcceleratorMixups(bad, amd)).toThrow(/triton/)
    const ours = lock({ torch: "2.14.0+rocm7.2", "triton-rocm": "3.8.0" })
    expect(() => assertNoAcceleratorMixups(ours, amd)).not.toThrow()
  })

  test("a torch that resolved to a plain version is rejected", () => {
    // No `+rocm` local segment means it came from somewhere that is not the ROCm index.
    expect(() => assertNoAcceleratorMixups(lock({ torch: "2.14.0" }), amd)).toThrow(/not a ROCm build/)
  })

  test("a repeated package name does not make it read the wrong version", () => {
    // A lock can list one name twice under different markers. Reading the first match and
    // calling it the version would reject a correct lock, or accept a wrong one.
    const ambiguous = lock({ numpy: "2.5.3", torch: "2.9.0+rocm6.4" }) + lock({ torch: "2.14.0+rocm7.2" })
    expect(() => assertNoAcceleratorMixups(ambiguous, amd)).not.toThrow()
  })

  test("a lock with no torch at all is an error, not a pass", () => {
    expect(() => assertNoAcceleratorMixups(lock({ numpy: "2.5.3", transformers: "5.17.0" }), amd)).toThrow(/no torch/)
  })

  test("on an NVIDIA card none of this applies", () => {
    // The denylist is an AMD-specific guard. Running it on a CUDA box would refuse a
    // perfectly correct install.
    const cuda = lock({ torch: "2.14.0", "nvidia-cudnn-cu13": "9.24.0.43" })
    expect(() => assertNoAcceleratorMixups(cuda, { vendor: "nvidia" })).not.toThrow()
  })
})

describe("the model table", () => {
  test("laya is known and names the env var the shim needs", () => {
    // `LAYA_PYTHON` is the entire integration point and is not inherited from the shell,
    // so a config without it makes the shim fall back to an interpreter that cannot see
    // the GPU and the daemon keeps answering with error payloads.
    expect(findModel("laya").interpreterEnv).toBe("LAYA_PYTHON")
  })

  test("an unknown model lists the ones that exist", () => {
    expect(() => findModel("nope")).toThrow(/laya/)
  })

  test("every model pins an exact requirement and a python range", () => {
    for (const m of MODELS) {
      expect(m.requirement).toMatch(/==\d+\.\d+\.\d+/)
      expect(m.requiresPython).toMatch(/^>=\d+\.\d+/)
    }
  })
})
