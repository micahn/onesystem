/**
 * The installer's decisions, tested without a GPU or a network.
 *
 * The parts worth testing are the ones that fail silently. A wrong wheel index does not
 * raise: it installs something that imports cleanly and then runs on the CPU, which on
 * this machine has already happened once. So the manifest and the check that guards it
 * are asserted here, against lock files both ways.
 */

import { describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { assertNoAcceleratorMixups, configHint, pyprojectFor, ROCM_INDEX } from "../src/install.ts"
import { validate } from "../src/config.ts"
import { findModel, MODELS } from "../src/models.ts"

const amd = { vendor: "amd", gfx: "gfx1201" } as const

/** A lock file shaped like uv's, which is all the check reads. */
const lock = (versions: Record<string, string>) =>
  Object.entries(versions)
    .map(([name, version]) => `[[package]]\nname = "${name}"\nversion = "${version}"\n`)
    .join("\n")

describe("the manifest", () => {
  const toml = pyprojectFor(findModel("laya"), amd)

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

describe("the manifest on an NVIDIA card", () => {
  // This branch had no coverage at all, and the reason was in the signature rather than in
  // anybody's diligence: `gpu` defaulted to this machine's AMD card, so the one test on
  // this machine called `pyprojectFor(spec)` and got the default. The NVIDIA path was
  // unreachable without a second machine.
  //
  // That also made the signature a trap rather than a convenience. On an NVIDIA box,
  // `pyprojectFor(spec)` produced an AMD manifest — ROCm index, `triton-rocm`, and a
  // `gfx1201` arch check — for a card that is not there. The parameter is required now, so
  // the lie is a compile error and this test can be written on any machine at all.
  const cuda = { vendor: "nvidia" } as const
  const toml = pyprojectFor(findModel("laya"), cuda)

  test("it names no accelerator index, because PyPI's linux torch already is the CUDA build", () => {
    // The absence of work is the correct configuration here, not an omission. This is the
    // mirror of the AMD manifest's whole argument.
    expect(toml).not.toContain(ROCM_INDEX.url)
    expect(toml).not.toContain(ROCM_INDEX.name)
    expect(toml).not.toMatch(/rocm/i)
    // And so no `explicit` index, which on this branch would be a no-op at best.
    expect(toml).not.toContain("explicit = true")
  })

  test("the model is still pinned exactly, because the pin is not about the accelerator", () => {
    expect(toml).toMatch(/laya\[mcp\]==\d+\.\d+\.\d+/)
  })

  test("a fetched model is installed from its local copy there too", () => {
    // The source-pin logic is shared by both branches, so it is worth one assertion that it
    // did not get lost when the branch was untested.
    const julia = pyprojectFor(findModel("julia"), cuda)
    expect(julia).toContain('supersonic-julia = { path = "julia-src" }')
    expect(julia).toContain('"mcp"')
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

describe("the config hint", () => {
  const runtimeFor = (name: string) => ({
    name,
    dir: `/data/runtimes/${name}`,
    python: `/data/runtimes/${name}/.venv/bin/python`,
    installed: true,
  })

  /**
   * Parse the hint the way a person would: paste it into a config and load that.
   *
   * The hint's whole job is to be pasteable, and it is printed by `onesystem install` as the
   * answer to "how do I use this". It shipped without `tools`, which `validate` rejects, so
   * the documented path produced a config that could not load and the error named a missing
   * key rather than the install. Asserting the *string* would not have caught that; the
   * failure was only visible by running the real validator.
   */
  const asBackend = (name: string) => {
    const spec = findModel(name)
    const hint = configHint(spec, runtimeFor(name))
    // The hint is a backend fragment, so wrap it in the minimum config that holds one.
    const text = `{"port": 7331, "backends": {${hint}}}`
    return { spec, hint, text, parsed: parse(text) as Record<string, unknown> }
  }

  test("it produces a backend the validator accepts, for every model", () => {
    for (const m of MODELS) {
      const { spec, text, parsed } = asBackend(m.name)
      let rejected: string | null = null
      try {
        validate(parsed, "hint.json")
      } catch (err) {
        rejected = err instanceof Error ? err.message : String(err)
      }
      expect(`${spec.name}: ${rejected ?? "accepted"}`).toBe(`${spec.name}: accepted`)
      // Silence the unused-variable warning while keeping the text for the failure message.
      expect(typeof text).toBe("string")
    }
  })

  test("it never prints a placeholder command", () => {
    // The one output whose entire purpose is to contain no placeholders used to print
    // `["/path/to/shim"]` for a model with no local weights.
    for (const m of MODELS) {
      expect(`${m.name}: ${configHint(m, runtimeFor(m.name))}`).not.toContain("/path/to/shim")
    }
  })

  test("a model that ships its own server says which binary to point at", () => {
    // laya runs a binary onesystem has no way to locate, so the hint has to name it rather
    // than invent a path. This is the one field a person still fills in.
    const { hint } = asBackend("laya")
    expect(hint).toMatch(/laya-mcp-idle-server/)
  })

  test("a model that ships a library points at this repo's shim", () => {
    // julia has no server of its own, so the command is fully determined and must not
    // leave a person guessing.
    const { hint } = asBackend("julia")
    expect(hint).toContain("/src/shims/julia-mcp.py")
    expect(hint).toContain("/data/runtimes/julia/.venv/bin/python")
  })

  test("it declares the model's tool surface, because it cannot be discovered", () => {
    for (const m of MODELS) {
      expect(`${m.name}: ${JSON.stringify(m.tools)}`).not.toMatch(/: undefined/)
      const { hint } = asBackend(m.name)
      for (const tool of m.tools!) expect(hint).toContain(`"${tool}"`)
    }
  })

  test("a model that declares no tools is refused rather than given an empty list", () => {
    // `validate` rejects an empty `tools`, so emitting one would print a snippet that cannot
    // load. The gap belongs in the model table, so the hint says so instead of hiding it.
    const spec = { ...findModel("julia"), tools: [] }
    expect(() => configHint(spec, runtimeFor("julia"))).toThrow(/declares no tools/)
    const missing = { ...findModel("julia"), tools: undefined }
    expect(() => configHint(missing, runtimeFor("julia"))).toThrow(/declares no tools/)
  })

  test("a weights env var points at the directory the installer actually writes", () => {
    // Weights are fetched outside the runtime so a reinstall does not take them with it, so
    // the path here is the weights directory and not the runtime that sits next to it.
    const { hint } = asBackend("julia")
    expect(hint).toContain("JULIA_CHECKPOINT")
    expect(hint).toMatch(/weights[\\/]julia/)
  })
})
