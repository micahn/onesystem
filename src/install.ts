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
import { spawn } from "node:child_process"
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

export function runtimesRoot(): string {
  return process.env.ONESYSTEM_DATA_DIR ?? join(homedir(), ".local", "share", "onesystem", "runtimes")
}

export function runtimeDir(model: string): string {
  return join(runtimesRoot(), model)
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += String(d)))
    child.stderr?.on("data", (d) => (stderr += String(d)))
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err) }))
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function have(cmd: string): Promise<boolean> {
  const { code } = await run("sh", ["-c", `command -v ${cmd}`])
  return code === 0
}

/**
 * Identify the GPU, or refuse.
 *
 * Vendor from `lspci`, which needs no ROCm install at all. Arch from `rocm-smi`, which
 * prints it directly on this machine. `/sys/class/kdev` is not used: it is a Tegra path
 * and does not exist here, so a detection ladder that includes it is a ladder that fails
 * on a machine that has a perfectly good GPU.
 */
export async function detectGpu(): Promise<Gpu> {
  const lspci = await have("lspci") ? await run("sh", ["-c", "lspci | grep -iE 'vga|3d|display'"]) : null
  const vendorLine = lspci?.stdout ?? ""

  if (/NVIDIA/i.test(vendorLine)) return { vendor: "nvidia" }
  if (!/AMD|ATI/i.test(vendorLine)) {
    throw new Error(
      "could not identify the GPU vendor from lspci; refusing to install rather than " +
        "guessing a wheel index. On AMD, make sure lspci is installed and the card is visible.",
    )
  }

  let gfx: string | undefined
  if (await have("rocm-smi")) {
    const out = await run("rocm-smi", ["--showproductname"])
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
 */
export function pyprojectFor(spec: ModelSpec): string {
  return `# Generated by \`onesystem install ${spec.name}\`. Edits will be overwritten.
[project]
name = "onesystem-runtime-${spec.name}"
version = "0.0.0"
requires-python = "${spec.requiresPython}"
dependencies = [
  "${spec.requirement}",
  # Declared so the source pin below can bind to it. See the module comment.
  "torch>=2.0.0",
  "triton-rocm>=0.0.0",
  "pytorch-triton-rocm>=0.0.0",
]

[tool.uv]
environments = ["sys_platform == 'linux'"]

[tool.uv.sources]
torch = { index = "${ROCM_INDEX.name}" }
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
  /** Skip the download and only resolve. Useful for checking a manifest. */
  lockOnly?: boolean
  onProgress?: (message: string) => void
}

/**
 * Install a model into a runtime directory onesystem owns.
 *
 * Written last, not first: a directory with a `meta.json` is a finished install, and one
 * without is garbage from a killed run. `listRuntimes` treats the second as absent, so a
 * half-install is invisible rather than half-working.
 */
export async function install(spec: ModelSpec, options: InstallOptions = {}): Promise<Runtime> {
  if (!(await have("uv"))) {
    throw new Error("uv is not on PATH. Install it from https://docs.astral.sh/uv/ — it is the only dependency.")
  }
  const gpu = await detectGpu()
  if (gpu.vendor !== "amd") {
    throw new Error(
      `this installer only knows the AMD/ROCm path (found ${gpu.vendor}). A CUDA machine ` +
        `wants the default PyPI torch, which is what a plain \`uv venv\` already gives you.`,
    )
  }

  const dir = runtimeDir(spec.name)
  const say = options.onProgress ?? (() => {})
  say(`installing ${spec.name} for ${gpu.gfx} into ${dir}`)

  // Built in place and moved into position at the end, so a killed run never leaves a
  // directory that looks installed.
  const staging = `${dir}.partial`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await writeFile(join(staging, "pyproject.toml"), pyprojectFor(spec))

  const lock = await run("uv", ["lock"], { cwd: staging })
  if (lock.code !== 0) throw new Error(`uv lock failed:\n${lock.stderr.trim()}`)
  assertNoAcceleratorMixups(await readFile(join(staging, "uv.lock"), "utf8"), gpu)
  say("resolved, no NVIDIA packages")

  if (options.lockOnly) {
    // Deliberately not published. Nothing was installed, and a directory that exists
    // without a meta.json is exactly what `runtimes` reports as a half-install.
    await rm(staging, { recursive: true, force: true })
    return { name: spec.name, dir, python: pythonIn(dir), installed: false }
  }

  const sync = await run("uv", ["sync", "--frozen"], { cwd: staging })
  if (sync.code !== 0) throw new Error(`uv sync failed:\n${sync.stderr.trim()}`)
  const check = await verify(staging, gpu)
  if (!check.ok) {
    await rm(staging, { recursive: true, force: true })
    throw new Error(`the installed environment failed its checks:\n  ${check.problems.join("\n  ")}`)
  }

  await rm(dir, { recursive: true, force: true })
  await writeFile(
    join(staging, "meta.json"),
    JSON.stringify({ model: spec.name, gfx: gpu.gfx, created: new Date().toISOString() }, null, 2),
  )
  await rename(staging, dir)

  return { name: spec.name, dir, python: pythonIn(dir), installed: true }
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
 */
export async function verify(dir: string, gpu: Gpu): Promise<{ ok: boolean; problems: string[]; torch?: string }> {
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

  const { code, stdout, stderr } = await run(python, ["-c", script])
  if (code !== 0) return { ok: false, problems: [`could not import torch: ${stderr.trim().slice(-400)}`] }

  let info: { hip: string | null; cuda: string | null; available: boolean; arch: string[] }
  try {
    info = JSON.parse(stdout.trim().split("\n").pop()!)
  } catch {
    return { ok: false, problems: [`torch did not report readable state: ${stdout.trim().slice(-200)}`] }
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
  const env = spec.interpreterEnv ? `\n        "${spec.interpreterEnv}": "${runtime.python}"` : ""
  return `  "${spec.name}": {
    "transport": "stdio-mcp",
    "command": ["/path/to/shim"],${env}
  }`
}
