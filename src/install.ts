/**
 * Installing a model: a Python environment onesystem owns.
 *
 * ## Why not just `pip install`
 *
 * Because `laya` declares `torch>=2.0.0` and nothing about accelerators. On Linux the
 * default PyPI torch wheel is the CUDA build, so `pip install laya` *always* means CUDA
 * torch. On this machine that had already happened: 3.2 GB of `nvidia-*` packages and
 * 1.1 GB of CUDA triton sitting in a venv on an AMD card, unreferenced and unusable,
 * left behind because force-installing the ROCm wheel over the top does not uninstall the
 * dependencies the CUDA one declared.
 *
 * So the pin has to be on the *source*, not the version. A constraint file pins
 * `torch==2.14.0` and both wheels answer to that. What actually works is a source pin:
 * torch may only come from the ROCm index, and everything else still comes from PyPI,
 * because `laya` is not on the ROCm index and a naive `--index-url` swap fails outright.
 *
 * That is one line of uv configuration and it is the entire reason this module exists
 * rather than a shell script in the README:
 *
 *     [[tool.uv.index]]
 *     explicit = true   # reachable ONLY for the names listed in tool.uv.sources
 *
 * ## What is not reimplemented
 *
 * Resolution, hashing, and installation are uv's. This module writes a manifest, runs
 * `uv lock`, runs `uv sync`, and then checks the result. It does not have a dependency
 * solver, and adding one to a project whose entire premise is "one process, shared
 * weights" would be absurd.
 *
 * ## Everything goes through the project's one subprocess seam
 *
 * This module used to have a private `run()` with no deadline, no kill, and no
 * cancellation, accumulating output into unbounded strings. `onesystem install` is the
 * longest-running command in the project — it downloads several gigabytes and spends
 * minutes inside `uv` — so a hung `uv lock` on a flaky network, a wedged `uv sync`, or a
 * `verify()` whose `import torch` stalls behind a busy GPU left it waiting forever with no
 * diagnostic. The daemon had already solved the deadline problem and expressed it once, in
 * `async.ts`; this was a third, weaker answer to the same question.
 *
 * So the runner is `src/subprocess.ts`, shared, and it is *threaded* rather than imported
 * at each site: `install`, `detectGpu` and `verify` all take a `Runner`. That is what makes
 * the sequence below testable, which matters because the sequence is this module's actual
 * subject — twelve steps whose order is the whole of its crash-safety argument, and which
 * no test could reach before. `test/install-steps.test.ts` drives the whole thing against a
 * script, detection included.
 *
 * ## Detection fails closed
 *
 * If the GPU cannot be positively identified, nothing is installed. The alternative —
 * defaulting to something — is how you get a CPU-only install that works fine until
 * someone measures a 40x slowdown. `uv pip install --torch-backend=auto` does exactly
 * that: on this machine it resolved `torch==2.14.0+cpu`, silently, with exit code 0.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { DEFAULT_TIMEOUT_MS, type Runner } from "./subprocess.ts"
import type { ModelSpec } from "./models.ts"

/**
 * The ROCm wheel index.
 *
 * The boring one, deliberately. AMD's newer multi-arch distribution at
 * `stable.repo.amd.com` would be roughly 1.1 GB instead of 6.2 GB because it ships only
 * your card's kernels, and it is a better answer on disk — but it depends on a package
 * named `rocm` that also exists on PyPI as an unrelated 0.1.0 stub, and resolving it
 * reliably needs source pins for the whole SDK. That is a second index to keep working,
 * for a saving on a one-time download. Add it when the disk actually matters.
 */
export const ROCM_INDEX = {
  name: "pytorch-rocm",
  url: "https://download.pytorch.org/whl/rocm7.2",
} as const

/**
 * Interpreter names that must never appear in a resolved environment on an AMD card.
 *
 * This is the check that would have caught the original mistake, and it is a denylist on
 * names rather than a judgement about a version string. `torch.version.cuda is None` in
 * the venv is the other half; this one runs before anything is downloaded.
 */
const FORBIDDEN_ON_AMD = /^(nvidia-|cuda-|cuda$|triton$)/

export interface Gpu {
  vendor: "amd" | "nvidia"
  /** e.g. `gfx1201`. Absent for NVIDIA, where the arch list is not the question. */
  gfx?: string
}

export interface Runtime {
  name: string
  dir: string
  python: string
  installed: boolean
  /** Only present once `meta.json` has been written, which is the last step. */
  meta?: { model: string; gfx?: string; created: string; torch?: string }
}

function dataRoot(): string {
  return process.env.ONESYSTEM_DATA_DIR ?? join(homedir(), ".local", "share", "onesystem")
}

/**
 * Where interpreters live.
 *
 * Rebuilt on every install, and nothing else may live here: an install removes this
 * directory and moves a freshly synced one into its place, so anything a user put inside
 * it is destroyed by the next `onesystem install`. That is not hypothetical -- model
 * weights were briefly stored here and lost to a reinstall.
 */
export function runtimesRoot(): string {
  return join(dataRoot(), "runtimes")
}

/**
 * Where model weights live, if a model needs them locally.
 *
 * Separate from the runtime because they are a different thing with a different
 * lifecycle: a runtime is disposable and rebuilt, a checkpoint is 550 MB and does not
 * change when the Python does. Sharing a venv between two models would be the other way
 * to avoid the duplication, and the models' transformers pins already rule that out.
 */
export function weightsDir(model: string): string {
  return join(dataRoot(), "weights", model)
}

export function runtimeDir(model: string): string {
  return join(runtimesRoot(), model)
}

/**
 * Ask whether a command exists.
 *
 * `sh -c "command -v X"` rather than a spawn of `X` itself: probing a binary by running
 * it is not a probe, and the shell form is the one that answers without side effects.
 */
async function have(cmd: string, runner: Runner): Promise<boolean> {
  const { code } = await runner("sh", ["-c", `command -v ${cmd}`])
  return code === 0
}

/**
 * Identify the GPU, or refuse.
 *
 * Vendor from `lspci`, which needs no ROCm install at all. Arch from `rocm-smi`, which
 * prints it directly on this machine. `/sys/class/kdev` is not used: it is a Tegra path
 * and does not exist here, so a detection ladder that includes it is a ladder that fails
 * on a machine that has a perfectly good GPU.
 *
 * Detection is a sequence of subprocesses, so it takes the runner rather than reaching for
 * one. That is not only for tests: it is what lets a scripted runner stand in for the whole
 * machine, and `test/install.test.ts` drives an entire install — detection included — by
 * answering `lspci` and `rocm-smi` from a script.
 */
export async function detectGpu(runner: Runner): Promise<Gpu> {
  const lspci = await have("lspci", runner)
    ? await runner("sh", ["-c", "lspci | grep -iE 'vga|3d|display'"])
    : null
  const vendorLine = lspci?.stdout ?? ""

  if (/NVIDIA/i.test(vendorLine)) return { vendor: "nvidia" }
  // Word-bounded, and the boundaries are the entire fix.
  //
  // `lspci` prints the vendor in a bracket tag — "[AMD/ATI]", "[NVIDIA Corporation]",
  // "[Intel Corporation]" — so the token is there to be matched. Unanchored, `/AMD|ATI/i`
  // also matched "Intel Corpor*ati*on", so a machine with an Intel iGPU was read as AMD and
  // sent on to demand `rocm-smi` and a gfx target that a machine without an AMD card does
  // not have. It still failed closed, so no wrong install was ever possible: the cost was
  // a refusal that named the wrong vendor on the way there, which is a poor way to tell
  // someone their lspci is fine and their card is not supported.
  //
  // The NVIDIA test above is left unanchored on purpose, because no other vendor's name
  // contains "NVIDIA" as a substring. It is not evidence that anchoring does not matter.
  if (!/\b(?:AMD|ATI)\b/i.test(vendorLine)) {
    throw new Error(
      "could not identify the GPU vendor from lspci; refusing to install rather than " +
        "guessing a wheel index. onesystem supports AMD (ROCm) and NVIDIA (CUDA); " +
        "anything else is refused. On AMD, make sure lspci is installed and the card is visible.",
    )
  }

  let gfx: string | undefined
  if (await have("rocm-smi", runner)) {
    const out = await runner("rocm-smi", ["--showproductname"])
    gfx = out.stdout.match(/GFX Version:\s*(gfx\w+)/i)?.[1]
  }
  if (!gfx) {
    throw new Error(
      "AMD GPU found, but its gfx target could not be read (tried rocm-smi). " +
        "Refusing to install: a wrong arch is a runtime crash, not a slow load.",
    )
  }
  return { vendor: "amd", gfx }
}

/**
 * The manifest uv resolves against.
 *
 * `torch` and both spellings of its triton companion are declared explicitly even though
 * nothing imports them, because `[tool.uv.sources]` binds only to *declared* dependencies.
 * A source pin for a package that is merely transitive does nothing, silently — which
 * looks exactly like the pin working right up until CUDA torch is what gets installed.
 *
 * The AMD branch is the one this machine can check, and both are now tested because the
 * signature no longer supplies a default to fall back on. The NVIDIA branch is
 * deliberately the *absence* of work: PyPI's default Linux torch wheel is already the
 * CUDA build, so naming no accelerator index is the correct configuration rather than an
 * omitted one. That is also why it needs no cu-version decision, which from a machine
 * that cannot check one would be a guess dressed as a default.
 *
 * `gpu` is required, and that is the point. It used to default to
 * `{ vendor: "amd", gfx: "gfx1201" }` — this machine's card — so a caller on an NVIDIA box
 * could write `pyprojectFor(spec)` and get an AMD manifest: ROCm index, `triton-rocm`, and
 * a `gfx1201` arch check, for a card that is not there. A defaulted hardware fact in a
 * public signature is a signature that permits a lie, and it is also why the NVIDIA branch
 * had no coverage at all: the only test on this machine called it with no argument and got
 * the default, so the branch nobody here can run was the one nobody exercised.
 */
export function pyprojectFor(spec: ModelSpec, gpu: Gpu): string {
  // A model that has to be fetched is installed from the local copy the fetch step left,
  // not from its repository — see ModelSpec#source for why a git source does not work.
  // A fetched model is pinned by the revision recorded in meta.json, not by a version
  // string, so the requirement is just the distribution name and the path source below
  // supplies the rest.
  const local = spec.source ? `${spec.name}-src` : null
  // A fetched model contributes its own dependencies; the runtime also needs the MCP
  // SDK, because the shim that puts it behind a tool surface runs inside this
  // interpreter and nowhere else.
  const extra = spec.needsMcp ? ["mcp"] : []
  const requirement = local ? spec.requirement.replace(/==.*/, "") : spec.requirement
  const declared = [requirement, ...extra]

  // A model that was fetched is installed from the local copy, and that pin is
  // orthogonal to the accelerator: it says where the *package* came from, not which
  // wheel index to look in.
  //
  // It used to be written only into the AMD template, so the NVIDIA branch declared a
  // fetched model by name and version and nothing else — `dependencies = ["supersonic-
  // julia"]` with no `[tool.uv.sources]`, asking PyPI for a package that is not on PyPI.
  // `uv lock` would fail on any NVIDIA machine trying to install julia, with a resolution
  // error that says nothing about a manifest this file wrote. The branch had no coverage,
  // which is the only reason it survived: the default in the signature meant the AMD
  // manifest was the only one anybody here could produce.
  const localSource = local
    ? `\n[tool.uv.sources]\n${requirement} = { path = "${local}" }\n`
    : ""

  if (gpu.vendor !== "amd") {
    return `# Generated by \`onesystem install ${spec.name}\`. Edits will be overwritten.
[project]
name = "onesystem-runtime-${spec.name}"
version = "0.0.0"
requires-python = "${spec.requiresPython}"
# No accelerator pin: on Linux, PyPI's torch already is the CUDA build.
dependencies = [${declared.map((d) => `"${d}"`).join(", ")}]

[tool.uv]
environments = ["sys_platform == 'linux'"]
${localSource}`
  }

  return `# Generated by \`onesystem install ${spec.name}\`. Edits will be overwritten.
[project]
name = "onesystem-runtime-${spec.name}"
version = "0.0.0"
requires-python = "${spec.requiresPython}"
dependencies = [
${declared.map((d) => `  "${d}",`).join("\n")}
  # Declared so the source pin below can bind to it. See the module comment.
  "torch>=2.0.0",
  "triton-rocm>=0.0.0",
  "pytorch-triton-rocm>=0.0.0",
]

[tool.uv]
environments = ["sys_platform == 'linux'"]

[tool.uv.sources]
${local ? `${requirement} = { path = "${local}" }
` : ""}torch = { index = "${ROCM_INDEX.name}" }
triton-rocm = { index = "${ROCM_INDEX.name}" }
pytorch-triton-rocm = { index = "${ROCM_INDEX.name}" }

[[tool.uv.index]]
name = "${ROCM_INDEX.name}"
url = "${ROCM_INDEX.url}"
# Reachable only for the three names above. Without this, PyPI stays a candidate for
# torch and the CUDA wheel wins.
explicit = true
`
}

/**
 * Parse a `uv.lock` and refuse to continue if an AMD box would get NVIDIA packages.
 *
 * Runs on the lock file, before a single byte is downloaded. The alternative is
 * discovering it afterwards, when the fix is deleting six gigabytes.
 */
export function assertNoAcceleratorMixups(lock: string, gpu: Gpu): void {
  if (gpu.vendor !== "amd") return

  // Read per `[[package]]` block rather than by a single regex over the file. A lock can
  // legitimately list the same name twice under different markers, and a pattern that
  // takes the first match then reports the wrong version for the one that matters.
  const entries = lock
    .split("[[package]]")
    .map((b) => ({
      name: b.match(/^\s*name = "([^"]+)"/m)?.[1],
      version: b.match(/^\s*version = "([^"]+)"/m)?.[1],
    }))
    .filter((e) => e.name !== undefined)
    .map((e) => ({ name: e.name!, version: e.version }))

  const bad = entries.map((e) => e.name).filter((n) => FORBIDDEN_ON_AMD.test(n))
  if (bad.length > 0) {
    throw new Error(
      `the resolved environment contains NVIDIA packages on an AMD GPU: ${bad.join(", ")}.\n` +
        `This means torch resolved from PyPI rather than ${ROCM_INDEX.url}.`,
    )
  }

  const torch = entries.find((e) => e.name === "torch")
  if (!torch) throw new Error("the lock has no torch entry; cannot check the accelerator build")
  // A ROCm wheel carries `+rocmX.Y` as a local version segment. That is the signal, and it
  // is the same one `torch.version.hip` reports from inside the venv.
  if (!/rocm|hip/i.test(torch.version ?? "")) {
    throw new Error(
      `torch resolved to ${torch.version ?? "an unknown version"}, which is not a ROCm build. ` +
        `A ROCm wheel's version carries a "+rocm" segment.`,
    )
  }
}

export interface InstallOptions {
  /**
   * The project's subprocess seam.
   *
   * Required rather than defaulted to the real `run`, deliberately. A default here is the
   * same shape of trap as the defaulted `gpu` this module used to carry: it makes the
   * mocked path the one you get by accident, and it means the seven call sites below can
   * each quietly reach for a different runner. One caller (`cmdInstall`) passes the real
   * one; a test passes a script.
   */
  runner: Runner
  /** Skip the download and only resolve. Useful for checking a manifest. */
  lockOnly?: boolean
  onProgress?: (message: string) => void
  /**
   * Deadline for each of the install's subprocesses.
   *
   * One knob rather than four because they are the same kind of wait — a build step making
   * network requests — and a caller with a slow link has one problem, not four. Generous
   * by default; it is here to stop a hang, not to police a download.
   */
  timeoutMs?: number
}

/**
 * Install a model into a runtime directory onesystem owns.
 *
 * Written last, not first: a directory with a `meta.json` is a finished install, and one
 * without is garbage from a killed run. `listRuntimes` treats the second as absent, so a
 * half-install is invisible rather than half-working.
 *
 * Every step is a subprocess, which is what makes this function's real subject — the
 * *order* — testable at all. It was written last, in an order chosen carefully, and read by
 * nobody who could check it: the crash-safety argument below rests entirely on staging and
 * `meta.json` being the only things that make a directory look installed, and not one line
 * of it was reachable from a test. `test/install.test.ts` now runs the whole thing against
 * a scripted runner, including the paths that used to be untestable and mattered most:
 * `uv sync` failing, `verify()` failing, and what is left on disk when either happens.
 */
export async function install(spec: ModelSpec, options: InstallOptions): Promise<Runtime> {
  const { runner, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  if (!(await have("uv", runner))) {
    throw new Error("uv is not on PATH. Install it from https://docs.astral.sh/uv/ — it is the only dependency.")
  }
  const gpu = await detectGpu(runner)

  const dir = runtimeDir(spec.name)
  const say = options.onProgress ?? (() => {})
  say(`installing ${spec.name} for ${gpu.gfx} into ${dir}`)

  // Built in place and moved into position at the end, so a killed run never leaves a
  // directory that looks installed.
  const staging = `${dir}.partial`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  // Everything from here to the rename is inside this, and the removal on the way out is
  // the module's crash-safety claim made true rather than merely asserted.
  //
  // It used to remove the staging directory in exactly one place — the `verify` failure —
  // while `uv lock` failing, `uv sync` failing, a fetch failing, and a dependency check
  // throwing all left it behind. That was survivable, because `listRuntimes` skips
  // `.partial` and the next install removes it before starting, but it left the directory
  // holding claim to be *the* invariant: no directory with a `meta.json`, and no
  // `<name>.partial`, exists after any failure past staging. It was true of the one path
  // it was written for and false of the other four, and the comment claiming it was not
  // checked by anything. Now it is one `catch`, and it holds for all of them.
  //
  // Weights are deliberately not in staging and are not touched here: they are fetched to
  // their own directory precisely so they survive a failed install.
  try {
    let revision: string | undefined
    if (spec.source) {
      revision = await fetchModelSource(spec, join(staging, `${spec.name}-src`), say, runner, timeoutMs)
    }
    if (spec.weights) {
      // Fetched outside the staging directory, because the weights outlive this install and
      // the directory does not.
      await fetchWeights(spec, weightsDir(spec.name), say, runner, timeoutMs)
    }
    await writeFile(join(staging, "pyproject.toml"), pyprojectFor(spec, gpu))

    // The two steps that can hang for minutes, each with its own name in the failure. A
    // bare "timed out" tells a user nothing they can act on, and `uv lock` and `uv sync`
    // fail for entirely different reasons — one is resolution, the other is the download.
    const lock = await runner("uv", ["lock"], { cwd: staging, timeoutMs })
    if (lock.timedOut) throw new Error(`uv lock did not finish within ${timeoutMs}ms`)
    if (lock.code !== 0) throw new Error(`uv lock failed:\n${lock.stderr.trim()}`)
    assertNoAcceleratorMixups(await readFile(join(staging, "uv.lock"), "utf8"), gpu)
    say("resolved, no NVIDIA packages")

    if (options.lockOnly) {
      // Deliberately not published. Nothing was installed, and a directory that exists
      // without a meta.json is exactly what `runtimes` reports as a half-install.
      await rm(staging, { recursive: true, force: true })
      return { name: spec.name, dir, python: pythonIn(dir), installed: false }
    }

    const sync = await runner("uv", ["sync", "--frozen"], { cwd: staging, timeoutMs })
    if (sync.timedOut) throw new Error(`uv sync did not finish within ${timeoutMs}ms`)
    if (sync.code !== 0) throw new Error(`uv sync failed:\n${sync.stderr.trim()}`)
    const check = await verify(staging, gpu, runner, timeoutMs)
    if (!check.ok) {
      // The `catch` below removes the staging directory; an environment that failed its
      // own checks is never published, and never left behind for `listRuntimes` to
      // reason about.
      throw new Error(`the installed environment failed its checks:\n  ${check.problems.join("\n  ")}`)
    }

    // The published directory is replaced, not merged, and only once there is something
    // verified to put in it. `rm` before `rename` is what makes this atomic from the
    // reader's side: `dir` is either the old runtime or absent, never half of each.
    await rm(dir, { recursive: true, force: true })
    await writeFile(
      join(staging, "meta.json"),
      JSON.stringify({ model: spec.name, gfx: gpu.gfx, created: new Date().toISOString(), revision }, null, 2),
    )
    await rename(staging, dir)

    return { name: spec.name, dir, python: pythonIn(dir), installed: true }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/**
 * Fetch a model's Python package without its weights.
 *
 * `huggingface_hub` is run ephemerally rather than added to anything: it is a build-time
 * tool here, and the runtime must not carry a dependency the model does not have. uv
 * caches it, so repeat installs cost nothing.
 */
async function fetchModelSource(
  spec: ModelSpec,
  into: string,
  say: (m: string) => void,
  runner: Runner,
  timeoutMs: number,
): Promise<string> {
  const { repo, allow } = spec.source!
  say(`fetching ${repo} (package only)`)
  const script = [
    "import sys, json",
    "from huggingface_hub import snapshot_download",
    `p = snapshot_download(${JSON.stringify(repo)}, local_dir=sys.argv[1], allow_patterns=${JSON.stringify(allow)})`,
    "print(json.dumps({'path': p}))",
  ].join("\n")
  const res = await runner("uv", ["run", "--quiet", "--with", "huggingface_hub", "python", "-c", script, into], {
    timeoutMs,
  })
  if (res.timedOut) throw new Error(`fetching ${repo} did not finish within ${timeoutMs}ms`)
  if (res.code !== 0) {
    throw new Error(`could not fetch ${repo}:\n${res.stderr.trim().slice(-600)}`)
  }
  return res.stdout.trim().split("\n").pop() ?? ""
}

async function fetchWeights(
  spec: ModelSpec,
  into: string,
  say: (m: string) => void,
  runner: Runner,
  timeoutMs: number,
): Promise<void> {
  if (existsSync(join(into, ".complete"))) {
    say(`weights already present in ${into}`)
    return
  }
  say(`fetching weights for ${spec.name} (${spec.weights!.repo})`)
  const script = [
    "import sys",
    "from huggingface_hub import snapshot_download",
    `snapshot_download(${JSON.stringify(spec.weights!.repo)}, local_dir=sys.argv[1])`,
  ].join("\n")
  const res = await runner("uv", ["run", "--quiet", "--with", "huggingface_hub", "python", "-c", script, into], {
    timeoutMs,
  })
  if (res.timedOut) throw new Error(`fetching weights for ${spec.name} did not finish within ${timeoutMs}ms`)
  if (res.code !== 0) throw new Error(`could not fetch weights for ${spec.name}:\n${res.stderr.trim().slice(-600)}`)
  // Written last, so an interrupted download is retried rather than trusted. This is the
  // whole of the resume story, and it is a single file's existence: no `.complete` means
  // 550 MB is fetched again, which is expensive and correct. A run killed between the
  // download and this line re-downloads, and there is no state in which a partial
  // checkpoint looks complete.
  await writeFile(join(into, ".complete"), new Date().toISOString())
}

export function pythonIn(dir: string): string {
  return join(dir, ".venv", "bin", "python")
}

/**
 * Check a runtime against the GPU it will run on.
 *
 * The cheap discriminator is `torch.version.cuda is None`: a ROCm build reports no CUDA
 * version and does have a HIP one. Everything else here is a refinement, but they are what
 * turn "wrong build" from a silent 40x slowdown into an error at install time.
 *
 * Exported because `onesystem doctor` runs it against an already-installed runtime, and it
 * takes the runner for the same reason `install` does: this is the step whose `import
 * torch` can hang behind a busy GPU, and a test cannot reach any of the branches below
 * without being able to answer with a torch that has the wrong properties.
 */
export async function verify(
  dir: string,
  gpu: Gpu,
  runner: Runner,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; problems: string[]; torch?: string }> {
  const python = pythonIn(dir)
  if (!existsSync(python)) return { ok: false, problems: [`no interpreter at ${python}`] }

  const script = [
    "import json, torch",
    "out = {",
    "  'hip': torch.version.hip,",
    "  'cuda': torch.version.cuda,",
    "  'available': torch.cuda.is_available(),",
    "  'arch': list(torch.cuda.get_arch_list()),",
    "}",
    "print(json.dumps(out))",
  ].join("\n")

  const res = await runner(python, ["-c", script], { timeoutMs })
  if (res.timedOut) {
    // Worth its own message. `import torch` on a busy GPU can take a while, and "timed
    // out" with no hint reads like a wedged process rather than a slow import.
    return { ok: false, problems: [`importing torch did not finish within ${timeoutMs}ms`] }
  }
  if (res.code !== 0) return { ok: false, problems: [`could not import torch: ${res.stderr.trim().slice(-400)}`] }

  let info: { hip: string | null; cuda: string | null; available: boolean; arch: string[] }
  try {
    info = JSON.parse(res.stdout.trim().split("\n").pop()!)
  } catch {
    return { ok: false, problems: [`torch did not report readable state: ${res.stdout.trim().slice(-200)}`] }
  }

  const problems: string[] = []
  // The cheap discriminator: a ROCm build reports a HIP version and no CUDA version.
  if (info.cuda !== null) problems.push("this is a CUDA build of torch; it cannot see an AMD GPU")
  if (info.hip === null) problems.push("torch reports no HIP version, so it is not a ROCm build")
  if (!info.available) problems.push("torch.cuda.is_available() is false: no GPU visible to this interpreter")
  if (gpu.gfx && !info.arch.includes(gpu.gfx)) {
    problems.push(`torch was not built for ${gpu.gfx}; it knows ${info.arch.join(", ") || "nothing"}`)
  }
  return { ok: problems.length === 0, problems, torch: info.hip ?? undefined }
}

export async function listRuntimes(): Promise<Runtime[]> {
  const root = runtimesRoot()
  if (!existsSync(root)) return []
  const names = await readdir(root, { withFileTypes: true })
  const out: Runtime[] = []
  for (const entry of names) {
    if (!entry.isDirectory() || entry.name.endsWith(".partial")) continue
    const dir = join(root, entry.name)
    const python = pythonIn(dir)
    const installed = existsSync(python) && existsSync(join(dir, "meta.json"))
    let meta: Runtime["meta"]
    if (installed) {
      // A missing or unreadable meta.json means `installed` is already false, so this
      // only has to survive a truncated file.
      meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"))
    }
    out.push({ name: entry.name, dir, python, installed, meta })
  }
  return out
}

export async function uninstall(name: string): Promise<boolean> {
  const dir = runtimeDir(name)
  if (!existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true })
  return true
}

/** The config snippet that points a backend at an installed runtime. */
export function configHint(spec: ModelSpec, runtime: Runtime): string {
  const env: string[] = []
  if (spec.interpreterEnv) env.push(`"${spec.interpreterEnv}": "${runtime.python}"`)
  if (spec.weights) {
    env.push(`"${spec.weights!.envVar}": "${weightsDir(spec.name)}"`)
  }
  const body = env.length > 0 ? `\n        ${env.join(",\n        ")}` : ""
  const command = spec.weights
    ? `[\n        "${runtime.python}",\n        "/path/to/onesystem/src/shims/${spec.name}-mcp.py"\n      ]`
    : `["/path/to/shim"]`
  return `  "${spec.name}": {
    "transport": "stdio-mcp",
    "command": ${command},${body}
  }`
}
