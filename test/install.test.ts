/**
 * Check manifests, accelerator lock checks, and generated config without a GPU or network.
 */

import { describe, expect, test } from "bun:test"

import {
  assertNoAcceleratorMixups,
  backendFor,
  configHint,
  needsManualCommand,
  pyprojectFor,
  ROCM_INDEX,
} from "../src/install.ts"
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

describe("the config block an install produces", () => {
  const runtimeFor = (name: string) => ({
    name,
    dir: `/data/runtimes/${name}`,
    python: `/data/runtimes/${name}/.venv/bin/python`,
    installed: true,
  })

  /**
   * Load the block the way the daemon will: as part of a real config, through the real
   * validator.
   *
   * This used to assert on a printed string, which is how a block missing `tools` shipped:
   * the string is a perfectly good string, and the failure only appeared when a person
   * pasted it and the daemon refused the config. `onesystem install` writes this block
   * itself now, so the question is whether the written thing loads.
   */
  const loads = async (name: string) => {
    const spec = findModel(name)
    const backend = await backendFor(spec, runtimeFor(name))
    return { spec, backend, doc: { port: 7331, backends: { [name]: backend } } }
  }

  test("it produces a backend the validator accepts, for every model", async () => {
    for (const m of MODELS) {
      const { spec, doc } = await loads(m.name)
      let rejected: string | null = null
      try {
        validate(doc, "written.json")
      } catch (err) {
        rejected = err instanceof Error ? err.message : String(err)
      }
      expect(`${spec.name}: ${rejected ?? "accepted"}`).toBe(`${spec.name}: accepted`)
    }
  })

  test("it never emits a placeholder path", async () => {
    // The one output whose entire purpose is to contain no placeholders used to emit
    // `["/path/to/shim"]` for a model with no local weights.
    for (const m of MODELS) {
      const { backend } = await loads(m.name)
      expect(`${m.name}: ${JSON.stringify(backend.command)}`).not.toContain("/path/to/shim")
    }
  })

  test("a model whose entry point is missing says which binary to point at", async () => {
    // laya's runtime in this test does not exist, so there is no `laya-mcp-server` to find.
    // The fallback has to be an obvious gap rather than a plausible-looking path, because a
    // `command` naming a missing file fails at the first tool call rather than at startup.
    const { backend } = await loads("laya")
    expect(needsManualCommand(backend)).toBe(true)
    expect(backend.command[0]).toMatch(/^REPLACE: /)
    expect(backend.command[0]).toContain("laya")
  })

  test("a model that ships a library points at this repo's shim", async () => {
    // julia has no server of its own, so the command is fully determined and must not
    // leave a person guessing.
    const { backend } = await loads("julia")
    expect(backend.command[1]).toMatch(/shims[\\/]julia-mcp\.py$/)
    expect(backend.command[0]).toBe("/data/runtimes/julia/.venv/bin/python")
    expect(needsManualCommand(backend)).toBe(false)
  })

  test("it declares the model's tool surface, because it cannot be discovered", async () => {
    for (const m of MODELS) {
      expect(`${m.name}: ${JSON.stringify(m.tools)}`).not.toMatch(/: undefined/)
      const { backend } = await loads(m.name)
      expect(backend.tools).toEqual([...(m.tools ?? [])])
    }
  })

  test("a model that declares no tools is refused rather than given an empty list", async () => {
    // `validate` rejects an empty `tools`, so emitting one would write a config that cannot
    // load. The gap belongs in the model table, so this says so instead of hiding it.
    const runtime = runtimeFor("julia")
    await expect(backendFor({ ...findModel("julia"), tools: [] }, runtime)).rejects.toThrow(
      /declares no tools/,
    )
    await expect(
      backendFor({ ...findModel("julia"), tools: undefined }, runtime),
    ).rejects.toThrow(/declares no tools/)
  })

  test("a weights env var points at the directory the installer actually writes", async () => {
    // Weights are fetched outside the runtime so a reinstall does not take them with it, so
    // the path here is the weights directory and not the runtime that sits next to it.
    const { backend } = await loads("julia")
    expect(backend.env?.JULIA_CHECKPOINT).toMatch(/weights[\\/]julia$/)
  })

  test("the printed block is the written block, rendered", async () => {
    // Printing is still the fallback for `--no-config` and for a config file that will not
    // parse. It used to assemble a second copy by hand and the two drifted: the printed one
    // lost its `env` braces and its `tools` while the written one kept them, which is a
    // difference nobody sees until a paste fails.
    for (const m of MODELS) {
      const { backend } = await loads(m.name)
      const text = configHint(m, runtimeFor(m.name), backend)
      const parsed = JSON.parse(text.replace(/^\s*"\w+":\s*/, ""))
      expect(`${m.name}: ${JSON.stringify(parsed)}`).toBe(`${m.name}: ${JSON.stringify(backend)}`)
    }
  })

  test("the printed block is valid JSON, so a paste cannot half-work", async () => {
    const { backend } = await loads("laya")
    const text = configHint(findModel("laya"), runtimeFor("laya"), backend)
    // It shipped unquoted once, which meant the one output meant for pasting was not JSON.
    expect(() => JSON.parse(text.replace(/^\s*"\w+":\s*/, ""))).not.toThrow()
  })
})
