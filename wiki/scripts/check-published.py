#!/usr/bin/env python3
"""
Check the published copy in the onesystem repo against this vault.

The vault is the source. `wiki/` in the repo is what gets read on GitHub, so it has to match
— and two copies of prose drift the moment anyone edits one of them, which is how a wiki
starts contradicting itself between the copy on your disk and the copy on the internet.

    python3 scripts/check-published.py            # report
    python3 scripts/check-published.py --publish  # copy the vault into the repo, then verify

Exits non-zero on drift. `--publish` is the fix; without it this only looks.
"""

import difflib
import pathlib
import shutil
import sys

VAULT = pathlib.Path(__file__).resolve().parent.parent
REPO_WIKI = pathlib.Path("/home/micah/Projects/onesystem/wiki")

# Files that exist only in one place, and why. A vault-only file is fine if it is
# machine-local; a repo-only file means the vault is behind.
VAULT_ONLY_OK = {
    # Machine-local scratch: the publish step copies the vault, so these would only ever
    # appear in the repo by accident.
    ".obsidian",
    ".git",
    ".gitignore",
}


def notes(root: pathlib.Path) -> dict[str, pathlib.Path]:
    return {
        str(p.relative_to(root)): p
        for p in sorted(root.rglob("*.md"))
        if not any(part in VAULT_ONLY_OK for part in p.relative_to(root).parts)
    }


def main() -> int:
    publish = "--publish" in sys.argv

    if not REPO_WIKI.exists():
        print(f"no repo copy at {REPO_WIKI}")
        return 1

    if publish:
        # Replace rather than merge: a file deleted from the vault must disappear from the
        # published copy too, or the repo keeps advertising a page nobody maintains.
        for existing in sorted(REPO_WIKI.rglob("*"), reverse=True):
            if existing.is_file():
                existing.unlink()
            elif existing.is_dir() and not any(existing.iterdir()):
                existing.rmdir()
        for name, path in notes(VAULT).items():
            target = REPO_WIKI / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        # The scripts are part of the vault's contract, so publish them too.
        scripts = REPO_WIKI / "scripts"
        scripts.mkdir(parents=True, exist_ok=True)
        for path in sorted((VAULT / "scripts").glob("*.py")):
            shutil.copy2(path, scripts / path.name)
        print(f"published {len(notes(VAULT))} notes and {len(list((VAULT / 'scripts').glob('*.py')))} scripts to {REPO_WIKI}\n")

    vault_notes, repo_notes = notes(VAULT), notes(REPO_WIKI)

    only_vault = sorted(set(vault_notes) - set(repo_notes))
    only_repo = sorted(set(repo_notes) - set(vault_notes))
    differing = []
    for name in sorted(set(vault_notes) & set(repo_notes)):
        if vault_notes[name].read_bytes() != repo_notes[name].read_bytes():
            differing.append(name)

    for name in only_vault:
        print(f"  only in the vault   {name}")
    for name in only_repo:
        print(f"  only in the repo    {name}")
    for name in differing:
        print(f"  differs             {name}")
        if "-v" in sys.argv:
            diff = difflib.unified_diff(
                vault_notes[name].read_text(encoding="utf-8").splitlines(),
                repo_notes[name].read_text(encoding="utf-8").splitlines(),
                fromfile="vault", tofile="repo", lineterm="", n=1,
            )
            for line in list(diff)[:24]:
                print(f"      {line}")

    drift = len(only_vault) + len(only_repo) + len(differing)
    print(f"\n{len(vault_notes)} vault notes, {len(repo_notes)} published, {drift} difference(s)")
    if drift and "--publish" not in sys.argv:
        print("The vault is the source. Run with --publish to sync.")
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main())
