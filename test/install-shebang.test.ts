/**
 * The staging rename breaks console scripts, and `verify` did not notice.
 *
 * `uv sync` writes each console script's shebang as the absolute path of the environment
 * it just created. This module installs into `<dir>.partial` and then renames that to
 * `<dir>`, so every script in the finished runtime came out naming a path that no longer
 * exists:
 *
 *     #!/…/runtimes/laya.partial/.venv/bin/python
 *
 * Running one fails with `bad interpreter: No such file or directory`. The venv's own
 * `python` still works, and `verify` runs exactly that, so an install reported success and
 * published a runtime whose entry points were all dead. Found by installing from scratch and
 * then trying to use what it produced.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pythonIn, repairShebangs } from "../src/install.ts"

/** A runtime directory mid-rename, with the staging path already gone. */
async function brokenRuntime() {
  const root = await mkdtemp(join(tmpdir(), "onesystem-shebang-"))
  const staging = join(root, "demo.partial")
  const dir = join(root, "demo")
  const bin = join(staging, ".venv", "bin")
  await mkdir(bin, { recursive: true })

  await writeFile(
    join(bin, "demo"),
    `#!${staging}/.venv/bin/python\n# -*- coding: utf-8 -*-\nimport sys\nsys.exit(0)\n`,
    { mode: 0o755 },
  )
  // A script naming some other interpreter. Repair is for what this rename broke, not for
  // every shebang in the directory.
  await writeFile(join(bin, "unrelated"), "#!/usr/bin/python3\nprint(1)\n", { mode: 0o755 })
  // A real binary. Reading a shebang must not mean reading several megabytes of it.
  await writeFile(join(bin, "python"), Buffer.alloc(4096, 0x7f))

  const body = (await readFile(join(bin, "demo"), "utf8")).split("\n").slice(1).join("\n")

  await rename(staging, dir)
  return { staging, dir, bin: join(dir, ".venv", "bin"), body }
}

const shebangOf = async (file: string) => (await readFile(file, "utf8")).split("\n")[0]!

describe("repairing shebangs after the staging rename", () => {
  test("a script naming the staging path is repointed at the published interpreter", async () => {
    const { staging, dir, bin } = await brokenRuntime()
    const fixed = await repairShebangs(dir, staging, pythonIn(dir))
    expect(fixed).toBe(1)

    const line = await shebangOf(join(bin, "demo"))
    // `env -S` because a shebang cannot contain an argument boundary portably, and the
    // venv path can contain spaces.
    expect(line).toContain(pythonIn(dir))
    expect(line).not.toContain(staging)
  })

  test("the rest of the script survives the rewrite", async () => {
    // Rewriting the shebang must not touch the body. The body is the actual program, so a
    // repair that truncates it is worse than the bug it was fixing. Compared byte for byte
    // against the pre-rename text rather than by line count, which a trailing newline
    // makes a bad way to measure this.
    const { staging, dir, bin, body } = await brokenRuntime()
    await repairShebangs(dir, staging, pythonIn(dir))
    const after = await readFile(join(bin, "demo"), "utf8")
    expect(after.split("\n").slice(1).join("\n")).toBe(body)
    expect(after).toContain("sys.exit(0)")
  })

  test("a script naming another interpreter is left alone", async () => {
    const { staging, dir, bin } = await brokenRuntime()
    await repairShebangs(dir, staging, pythonIn(dir))
    expect(await shebangOf(join(bin, "unrelated"))).toBe("#!/usr/bin/python3")
  })

  test("nothing is left pointing at the staging path", async () => {
    // The general form of the bug, checked the way a user would hit it: not "did the one
    // script we knew about get fixed" but "is anything in here still dead".
    const { staging, dir, bin } = await brokenRuntime()
    await repairShebangs(dir, staging, pythonIn(dir))
    const stillBroken: string[] = []
    for (const name of await readdir(bin)) {
      const first = await shebangOf(join(bin, name)).catch(() => "")
      if (first.includes(staging)) stillBroken.push(name)
    }
    expect(stillBroken).toEqual([])
  })

  test("it is safe on a directory with no venv, and idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "onesystem-shebang-"))
    // Repair runs inside install's `try`, so a throw here would delete a runtime that had
    // already passed every other check.
    expect(await repairShebangs(join(root, "absent"), join(root, "absent.partial"), "/x")).toBe(0)

    const { staging, dir, bin } = await brokenRuntime()
    expect(await repairShebangs(dir, staging, pythonIn(dir))).toBe(1)
    // Second pass has nothing left to do, and must not count the same script twice.
    expect(await repairShebangs(dir, staging, pythonIn(dir))).toBe(0)
    expect(await shebangOf(join(bin, "demo"))).toContain(pythonIn(dir))
  })
})
