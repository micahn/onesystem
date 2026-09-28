import { describe, expect, test } from "bun:test"
import {
  attribute,
  formatVram,
  parseDrmFdinfo,
  parseNvidiaTotal,
  parseRocmTotal,
  readClientVram,
  VramReader,
  type VramSample,
} from "../src/vram.ts"
import type { RunResult, Runner } from "../src/subprocess.ts"

const result = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: "", timedOut: false })

/** A runner that answers from a table, and counts the calls so caching can be measured. */
function scripted(answers: Record<string, RunResult>): Runner & { calls: string[] } {
  const calls: string[] = []
  const runner = (async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "))
    return answers[`${cmd} ${args.join(" ")}`] ?? result("", 127)
  }) as Runner & { calls: string[] }
  runner.calls = calls
  return runner
}

describe("the DRM client's own accounting", () => {
  test("it reads resident VRAM in the driver's own KiB", () => {
    // Real fdinfo from an RX 9070 XT running rizzo.
    const info = `pos:\t0
flags:\t02100002
drm-driver:\tamdgpu
drm-client-id:\t1173
drm-resident-gtt:\t676976 KiB
drm-resident-vram:\t5566796 KiB
`
    expect(parseDrmFdinfo(info)).toEqual({
      vramBytes: 5566796 * 1024,
      gttBytes: 676976 * 1024,
    })
  })

  test("a client on another driver still parses, because the fields are the standard", () => {
    // nvidia publishes the same drm-* names, so a machine that changes cards keeps working
    // without a code change.
    expect(parseDrmFdinfo("drm-driver:\tnvidia\ndrm-resident-vram:\t100 KiB\n")?.vramBytes).toBe(102400)
  })

  test("a non-DRM fd is not a client, so it contributes nothing", () => {
    // A socket or a file has fdinfo too. Reading a memory figure out of one would be
    // inventing a number.
    expect(parseDrmFdinfo("pos:\t0\nflags:\t02\nmnt_id:\t1\n")).toBeNull()
  })

  test("a DRM client that has allocated nothing is absent, not zero", () => {
    // `drm-driver:` is present but no memory fields: the process opened the card and used
    // none of it. Reporting 0 would be true here, but it is indistinguishable from a parse
    // failure, so it is treated as nothing to say.
    expect(parseDrmFdinfo("drm-driver:\tamdgpu\ndrm-client-id:\t9\n")).toBeNull()
  })
})

describe("reading a process", () => {
  test("a pid that does not exist is absent rather than a crash", async () => {
    // Backends quiesce constantly. A pid that has gone is the normal case, not an error.
    expect(await readClientVram(2 ** 30)).toBeNull()
  })

  test("this process holds no VRAM, and says so", async () => {
    // The test runner is not a GPU client. A false positive here would mean the parse is
    // matching something other than DRM memory.
    expect(await readClientVram(process.pid)).toBeNull()
  })
})

describe("the card's own totals", () => {
  test("rocm-smi is read per card and summed", () => {
    const csv = `device,VRAM Total Memory (B),VRAM Total Used Memory (B)
card0,17163076096,11000000000
card1,8589938688,0
`
    // Two cards is a workstation, and a model is not pinned to one. Reading only card0
    // would report half the machine.
    expect(parseRocmTotal(csv)).toEqual({ totalBytes: 25753014784, usedBytes: 11000000000 })
  })

  test("rocm-smi's warning line is not mistaken for a card row", () => {
    expect(parseRocmTotal("WARNING: AMD GPU device(s) is/are in a low-power state.\n\ndevice,X\n")).toEqual({
      totalBytes: null,
      usedBytes: null,
    })
  })

  test("nvidia-smi is read in MiB and converted", () => {
    expect(parseNvidiaTotal("24576, 1024\n12288, 0\n")).toEqual({
      totalBytes: 36864 * 1024 * 1024,
      usedBytes: 1024 * 1024 * 1024,
    })
  })

  test("a missing card is unknown, never zero", () => {
    // The difference matters: 0/0 is a card that is present and empty, and would be read
    // as "nothing is loaded" on a machine whose driver simply cannot be queried.
    expect(parseRocmTotal("")).toEqual({ totalBytes: null, usedBytes: null })
    expect(parseNvidiaTotal("")).toEqual({ totalBytes: null, usedBytes: null })
  })

  test("a short or blank row is skipped rather than counted as zero", () => {
    expect(parseNvidiaTotal("24576\n1024\n")).toEqual({ totalBytes: null, usedBytes: null })
  })
})

describe("attributing memory to a model", () => {
  const sample = (byPid: [number, number][], usedBytes = 10): VramSample => ({
    totalBytes: 16,
    usedBytes,
    byPid: new Map(byPid),
  })

  test("a model's memory is the process onesystem owns for it", () => {
    const gpu = attribute(sample([[100, 3_000_000_000]]), new Map([["rizzo", [100]]]))
    expect(gpu.byBackend.rizzo).toBe(3_000_000_000)
  })

  test("a process we do not own is not counted, even though the driver lists it", () => {
    // The browser is on the same card. Its memory is real, and it belongs to the card's
    // total, but attributing it to a model would be a lie about what that model costs.
    const gpu = attribute(
      sample([[100, 3_000_000_000], [200, 500_000_000]]),
      new Map([["rizzo", [100]]]),
    )
    expect(gpu.byBackend.rizzo).toBe(3_000_000_000)
    expect(gpu.byBackend.rizzo).not.toBe(3_500_000_000)
  })

  test("a cold model is absent, not zero", () => {
    // It owns no process, so nothing was measured on its behalf. A zero here would claim
    // it was weighed and found empty, which is a different statement.
    expect(attribute(sample([]), new Map([["laya", []]])).byBackend.laya).toBeNull()
  })

  test("a model whose process the driver does not list is absent", () => {
    expect(attribute(sample([]), new Map([["laya", [100]]])).byBackend.laya).toBeNull()
  })

  test("a model with several processes is summed, and a partial answer is refused", () => {
    // A sum of what happens to be listed would understate the card, and this is the one
    // number someone reads to decide whether the next model will fit.
    expect(attribute(sample([[1, 10], [2, 20]]), new Map([["laya", [1, 2]]])).byBackend.laya).toBe(30)
    expect(attribute(sample([[1, 10]]), new Map([["laya", [1, 2]]])).byBackend.laya).toBeNull()
  })

  test("a remote service is reported as holding nothing of ours", () => {
    const gpu = attribute(sample([[100, 5_000_000_000]]), new Map([["rev", []]]))
    expect(gpu.byBackend.rev).toBeNull()
  })

  test("the card totals are carried through untouched", () => {
    const gpu = attribute({ totalBytes: 16, usedBytes: 9, byPid: new Map() }, new Map())
    expect([gpu.totalBytes, gpu.usedBytes]).toEqual([16, 9])
  })
})

describe("sampling", () => {
  const amd = {
    "rocm-smi --version": result("rocm-smi 6.4"),
    "rocm-smi --showmeminfo vram --csv": result("card0,17163076096,11000000000\n"),
  }

  test("the vendor is asked once, not on every poll", async () => {
    // The probe is two subprocesses and the card does not change vendor mid-session.
    let probes = 0
    const reader = new VramReader(scripted(amd), 0, () => 0, async () => {
      probes++
      return "amd"
    })
    for (let i = 0; i < 5; i++) await reader.sample([])
    expect(`probed ${probes} times`).toBe("probed 1 times")
  })

  test("a card that cannot be read keeps its answer as unknown across polls", async () => {
    // Re-probing every poll would spawn two failing subprocesses every four seconds
    // forever on a machine with no supported GPU.
    const runner = scripted({ "nvidia-smi --version": result("no driver", 127) })
    const reader = new VramReader(runner, 0, () => 0)
    for (let i = 0; i < 3; i++) {
      expect((await reader.sample([])).totalBytes).toBeNull()
    }
    expect(runner.calls.filter((c) => c === "nvidia-smi --version")).toHaveLength(1)
  })

  test("the totals are cached for the poll interval and then re-read", async () => {
    // The card, the footer and a dialog can all ask inside one interval, and the driver is
    // a subprocess. Per-process figures are not cached, because a model finishing a load is
    // exactly when the number is wanted.
    const runner = scripted(amd)
    // The clock starts at zero on purpose: a reader that used 0 to mean "never sampled"
    // would skip its first read here, and this is the test that would have said so.
    let now = 0
    const reader = new VramReader(runner, 3_000, () => now, async () => "amd")
    await reader.sample([])
    await reader.sample([])
    await reader.sample([])
    expect(runner.calls.filter((c) => c.startsWith("rocm-smi --showmeminfo"))).toHaveLength(1)
    now += 3_000
    await reader.sample([])
    expect(runner.calls.filter((c) => c.startsWith("rocm-smi --showmeminfo"))).toHaveLength(2)
  })

  test("a tool that is present but failing yields unknown, not a crash", async () => {
    const reader = new VramReader(scripted({}), 0, () => 0, async () => "amd")
    const sample = await reader.sample([])
    expect([sample.totalBytes, sample.usedBytes]).toEqual([null, null])
  })
})

describe("displaying a figure", () => {
  test("powers of 1024, so a 16 GB card does not read as 16000M", () => {
    expect(formatVram(17_163_076_096)).toBe("16.0G")
    expect(formatVram(5_566_796 * 1024)).toBe("5.3G")
    expect(formatVram(900 * 1024 * 1024)).toBe("900M")
  })

  test("unknown is a dash, so it is never mistaken for a measurement", () => {
    expect(formatVram(null)).toBe("—")
    expect(formatVram(undefined)).toBe("—")
    expect(formatVram(Number.NaN)).toBe("—")
  })
})
