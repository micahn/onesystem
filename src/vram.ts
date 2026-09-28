/**
 * GPU memory in use, per model and across the card.
 *
 * Two sources, because no single one answers both questions:
 *
 * - **Per process**, from the DRM client's own accounting in
 *   `/proc/<pid>/fdinfo/<fd>`: `drm-resident-vram`, summed over the process's fds on
 *   `/dev/dri`. This is the driver's standard per-client figure, it is what the memory
 *   actually resident in VRAM costs, and — unlike a vendor tool's process table — it
 *   covers every client regardless of the API it used. That distinction is not academic:
 *   `rocm-smi --showpids` lists KFD *compute* processes only, so a model on Vulkan does not
 *   appear in it at all and reads as holding nothing.
 * - **Card totals**, from `rocm-smi` or `nvidia-smi`, since only the vendor tool knows the
 *   capacity of the card. Nothing in `/proc` sums to it.
 *
 * A figure is the driver's or it is absent. "0 bytes" is a claim that something was
 * measured and found empty, so a card this cannot read is reported as unknown rather than
 * zero, and a backend whose process the driver does not list is absent rather than empty.
 */

import { readdir, readFile } from "node:fs/promises"
import type { GpuMemory } from "./health.ts"
import type { Runner } from "./subprocess.ts"

export interface VramSample {
  totalBytes: number | null
  usedBytes: number | null
  /** VRAM held by each requested pid. A pid with no DRM client is absent, not zero. */
  byPid: Map<number, number>
}

export const UNKNOWN: VramSample = { totalBytes: null, usedBytes: null, byPid: new Map() }

/** The vendor whose tool is present, or null when neither is. */
export type Vendor = "amd" | "nvidia" | null

/**
 * Parse the DRM client's memory fields out of one `/proc/<pid>/fdinfo/<fd>`.
 *
 * `drm-resident-vram` rather than `drm-total-vram`: the total is what the client has ever
 * mapped, resident is what the card is being charged for right now. Exported because the
 * unit is the driver's own (KiB) and is worth a test of its own.
 */
export function parseDrmFdinfo(text: string): { vramBytes: number; gttBytes: number } | null {
  const resident = /^drm-resident-vram:\s*(\d+)\s*KiB$/m.exec(text)
  const gtt = /^drm-resident-gtt:\s*(\d+)\s*KiB$/m.exec(text)
  // A DRM fd with neither field is a client that has not allocated anything, or one whose
  // driver does not publish accounting. Both mean nothing to add.
  if (!resident && !gtt) return null
  return {
    vramBytes: resident ? Number(resident[1]) * 1024 : 0,
    gttBytes: gtt ? Number(gtt[1]) * 1024 : 0,
  }
}

/**
 * VRAM resident for one process, summed over its DRM fds, or null when it holds no
 * accounted memory or the process is gone.
 *
 * GTT is included: a client over budget pages through GTT, so a model can be holding real
 * video memory that is not in `drm-resident-vram`. Leaving it out would understate a model
 * exactly when it is closest to running out.
 */
export async function readClientVram(pid: number): Promise<number | null> {
  let fds: string[]
  try {
    fds = await readdir(`/proc/${pid}/fd`)
  } catch {
    // Gone, or not ours to look at. Absent is the honest answer.
    return null
  }
  let total = 0
  let found = false
  for (const fd of fds) {
    let info: string
    try {
      info = await readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8")
    } catch {
      // The fd closed between the two reads, which is normal under load.
      continue
    }
    if (!info.includes("drm-driver:")) continue
    const parsed = parseDrmFdinfo(info)
    if (!parsed) continue
    found = true
    total += parsed.vramBytes + parsed.gttBytes
  }
  return found ? total : null
}

/**
 * Parse `rocm-smi --showmeminfo vram --csv`:
 * `device,VRAM Total Memory (B),VRAM Total Used Memory (B)` then one row per card.
 *
 * Summed across cards, because a model is not pinned to one and a workstation with two GPUs
 * should not read as though only one exists.
 */
export function parseRocmTotal(stdout: string): { totalBytes: number | null; usedBytes: number | null } {
  let total = 0
  let used = 0
  let rows = 0
  for (const line of stdout.split("\n")) {
    if (!/^card\d+,/.test(line.trim())) continue
    const cells = line.split(",").map((c) => Number(c.trim()))
    const cardTotal = cell(cells, 1)
    const cardUsed = cell(cells, 2)
    if (cardTotal === null || cardUsed === null) continue
    total += cardTotal
    used += cardUsed
    rows++
  }
  if (rows === 0) return { totalBytes: null, usedBytes: null }
  return { totalBytes: total, usedBytes: used }
}

/** Parse `nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits`. */
export function parseNvidiaTotal(stdout: string): { totalBytes: number | null; usedBytes: number | null } {
  let total = 0
  let used = 0
  let rows = 0
  for (const line of stdout.split("\n")) {
    const cells = line.split(",").map((c) => Number(c.trim()))
    const cardTotal = cell(cells, 0)
    const cardUsed = cell(cells, 1)
    if (cardTotal === null || cardUsed === null) continue
    total += cardTotal
    used += cardUsed
    rows++
  }
  if (rows === 0) return { totalBytes: null, usedBytes: null }
  // Reported in MiB.
  return { totalBytes: total * 1024 * 1024, usedBytes: used * 1024 * 1024 }
}

/** A finite number at `index`, or null. A short row or a blank cell is not a zero. */
function cell(cells: number[], index: number): number | null {
  const value = cells[index]
  return value !== undefined && Number.isFinite(value) ? value : null
}

/**
 * Ask which tool answers. `--version` is the cheapest question a vendor tool accepts, and
 * it does not need a device to be present — only the driver userspace, which is exactly
 * what decides whether the totals can be read at all.
 */
export async function detectVendor(runner: Runner): Promise<Vendor> {
  for (const [tool, vendor] of [
    ["rocm-smi", "amd"],
    ["nvidia-smi", "nvidia"],
  ] as const) {
    const res = await runner(tool, ["--version"], { timeoutMs: 5_000 })
    if (res.code === 0) return vendor
  }
  return null
}

export interface CardTotals {
  totalBytes: number | null
  usedBytes: number | null
}

/** Read the card's capacity and use. The only place a subprocess is spent. */
export async function readCardTotals(vendor: Vendor, runner: Runner): Promise<CardTotals> {
  if (vendor === null) return { totalBytes: null, usedBytes: null }
  if (vendor === "nvidia") {
    const res = await runner(
      "nvidia-smi",
      ["--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"],
      { timeoutMs: 5_000 },
    )
    return res.code === 0 ? parseNvidiaTotal(res.stdout) : { totalBytes: null, usedBytes: null }
  }
  const res = await runner("rocm-smi", ["--showmeminfo", "vram", "--csv"], { timeoutMs: 5_000 })
  return res.code === 0 ? parseRocmTotal(res.stdout) : { totalBytes: null, usedBytes: null }
}

/**
 * The whole answer, for the pids a caller asked about.
 *
 * The card totals are cached because they cost two subprocesses and the footer, the card
 * and a dialog can all ask inside one poll interval. The per-process figures are not
 * cached: they are a handful of small reads out of `/proc`, and a model finishing a load is
 * precisely when the number is wanted and a stale one would be a lie.
 */
export class VramReader {
  /**
   * Null until the card has been read once. Not a timestamp of 0: 0 is a time a real
   * clock can return, and treating it as "already sampled" would skip the first read on
   * any reader whose clock starts at the epoch.
   */
  #totals: CardTotals | null = null
  #readAt = 0
  #vendor: Vendor = null
  #probed = false

  constructor(
    private readonly runner: Runner,
    private readonly ttlMs: number = 3_000,
    private readonly now: () => number = Date.now,
    /** Injectable so a test can name the vendor instead of spawning a tool. */
    private readonly vendorProbe: () => Promise<Vendor> = () => detectVendor(runner),
  ) {}

  async sample(pids: number[]): Promise<VramSample> {
    if (this.#totals === null || this.now() - this.#readAt >= this.ttlMs) {
      // Asked once, and the answer kept even when it is null: a machine with no supported
      // GPU would otherwise spawn two failing subprocesses on every poll, forever. The flag
      // is separate from the answer because null is a result, not an absence of one.
      if (!this.#probed) {
        this.#vendor = await this.vendorProbe()
        this.#probed = true
      }
      this.#totals = await readCardTotals(this.#vendor, this.runner)
      this.#readAt = this.now()
    }
    const byPid = new Map<number, number>()
    for (const pid of pids) {
      const bytes = await readClientVram(pid)
      if (bytes !== null) byPid.set(pid, bytes)
    }
    return { ...this.#totals, byPid }
  }
}

/**
 * Split a sample across the backends that asked for it, by pid.
 *
 * A backend that owns no process is null, not zero. It is either a service somebody else
 * runs, or a model that has not loaded; in both cases nothing was measured on its behalf,
 * and a zero would claim otherwise. The same goes for a backend with several processes
 * where only some are accounted: a partial sum would understate what the card is doing,
 * which is the one thing a person is reading this to find out.
 */
export function attribute(sample: VramSample, owned: Map<string, number[]>): GpuMemory {
  const byBackend: Record<string, number | null> = {}
  for (const [name, pids] of owned) {
    if (pids.length === 0) {
      byBackend[name] = null
      continue
    }
    const seen = pids.map((pid) => sample.byPid.get(pid))
    byBackend[name] = seen.every((v) => v !== undefined)
      ? seen.reduce<number>((sum, v) => sum + v!, 0)
      : null
  }
  return { totalBytes: sample.totalBytes, usedBytes: sample.usedBytes, byBackend }
}

/** Bytes as a short human string. Powers of 1024, matching the rest of the UI. */
export function formatVram(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`
  if (n < 1024 * 1024 * 1024) return `${Math.round(n / 1024 / 1024)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`
}
