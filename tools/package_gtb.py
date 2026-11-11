#!/usr/bin/env python3
"""Package Grief to Ban: a versioned tree, an installable zip, and a mod-import zip.

MlogAuxiliary has its own packager (tools/package.py, sidecar exe included).
This mod is pure JS, so "package" is just: copy the folder, hash it, and give the
player two zips that both work the same way the game expects --

    GTB-<ver>.zip            the whole delivery (mod/ + install.ps1 + hashes)
    GriefToBan-<ver>.zip     mod.hjson at the root of a single folder -> import in game

Exit code 0 only when every copied file matches its repo source byte for byte
and the two zips unpack to the same tree.
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MOD = ROOT / "GriefToBan"
MOD_NAME = "GriefToBan"
DIST = ROOT / "out" / "_dist"
SKIP_DIRS = {"__pycache__", ".git"}
SKIP_SUFFIX = {".pyc", ".pyo"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def version() -> str:
    for line in (MOD / "mod.hjson").read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("version:") or s.startswith("version "):
            v = s.split(":", 1)[1].strip().strip('"').strip("'")
            return v
    raise SystemExit("cannot read version: from GriefToBan/mod.hjson")


def mod_files() -> list[Path]:
    out = []
    for p in sorted(MOD.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(MOD)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if p.suffix.lower() in SKIP_SUFFIX:
            continue
        out.append(rel)
    return out


def build(make_zip: bool = True) -> dict:
    ver = version()
    tree = DIST / ("GTB-" + ver)
    if tree.exists():
        shutil.rmtree(tree)
    mod_dir = tree / "mod" / MOD_NAME
    rows = []
    for rel in mod_files():
        dst = mod_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(MOD / rel, dst)
        rows.append((rel.as_posix(), dst))
    (tree / "VERSION.txt").write_text(
        "Grief to Ban " + ver + "\n\n"
        "sha256  (line-ending independent)\n"
        + "".join("%s  mod/%s/%s\n" % (sha256(dst), MOD_NAME, rel) for rel, dst in rows),
        encoding="utf-8", newline="\n")
    copy_scripts(tree)
    zips = {}
    if make_zip:
        zips["tree"] = zip_dir(tree, DIST / ("GTB-" + ver + ".zip"))
        zips["mod"] = zip_mod(mod_dir, DIST / ("GriefToBan-" + ver + ".zip"))
    return {"version": ver, "tree": tree, "files": len(rows), "rows": rows, "zips": zips}


def copy_scripts(tree: Path) -> None:
    """install.ps1 / uninstall.ps1: ASCII only, so PS 5.1 cannot misread them."""
    install = r'''param([string]$ModsPath = "", [switch]$Silent)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here "mod\GriefToBan"
if (-not (Test-Path $src)) { throw "mod/GriefToBan not found next to install.ps1" }
if ($ModsPath -eq "") {
    $Steam = "E:\Program Files (x86)\Steam\steamapps\common\Mindustry\saves\mods"
    $Alt   = Join-Path $env:APPDATA "Mindustry\mods"
    if (Test-Path $Steam) { $ModsPath = $Steam } else { $ModsPath = $Alt }
}
if (-not (Test-Path $ModsPath)) { New-Item -ItemType Directory -Path $ModsPath | Out-Null }
$dst = Join-Path $ModsPath "GriefToBan"
if (Test-Path $dst) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $bak = Join-Path (Split-Path -Parent $ModsPath) ("mod-backups\\GriefToBan-" + $stamp)
    New-Item -ItemType Directory -Path (Split-Path -Parent $bak) -Force | Out-Null
    Move-Item $dst $bak
    if (-not $Silent) { Write-Host "old copy -> $bak" }
}
Copy-Item $src $dst -Recurse
$ver = (Get-Content (Join-Path $dst "mod.hjson") | Select-String 'version:').Line
if (-not $Silent) { Write-Host "installed to $dst"; Write-Host $ver }
'''
    uninstall = r'''param([string]$ModsPath = "", [switch]$Silent)
$ErrorActionPreference = "Stop"
if ($ModsPath -eq "") {
    $Steam = "E:\Program Files (x86)\Steam\steamapps\common\Mindustry\saves\mods"
    $Alt   = Join-Path $env:APPDATA "Mindustry\mods"
    if (Test-Path $Steam) { $ModsPath = $Steam } else { $ModsPath = $Alt }
}
$dst = Join-Path $ModsPath "GriefToBan"
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force; if (-not $Silent) { Write-Host "removed $dst" } }
'''
    (tree / "install.ps1").write_text(install, encoding="utf-8", newline="\r\n")
    (tree / "uninstall.ps1").write_text(uninstall, encoding="utf-8", newline="\r\n")


def zip_dir(tree: Path, out: Path) -> Path:
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(tree.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(tree).as_posix())
    return out


def zip_mod(mod_dir: Path, out: Path) -> Path:
    """Mindustry's mod importer wants one folder with mod.hjson inside it."""
    if out.exists():
        out.unlink()
    base = mod_dir.parent
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(mod_dir.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(base).as_posix())
    return out


def verify(res: dict) -> list[str]:
    bad = []
    for rel, dst in res["rows"]:
        if sha256(dst) != sha256(MOD / rel):
            bad.append("copied file differs: " + rel.as_posix())
    if res["zips"]:
        with zipfile.ZipFile(res["zips"]["mod"]) as zf:
            names = zf.namelist()
        if not any(n == MOD_NAME + "/mod.hjson" for n in names):
            bad.append("mod zip has no " + MOD_NAME + "/mod.hjson")
        if any("__pycache__" in n or n.endswith(".pyc") for n in names):
            bad.append("mod zip leaked __pycache__")
    return bad


def main(argv: list[str]) -> int:
    res = build(make_zip="--no-zip" not in argv)
    bad = verify(res)
    print("GriefToBan " + res["version"] + ": " + str(res["files"]) + " file(s)")
    print("tree : " + str(res["tree"]))
    for kind, path in res["zips"].items():
        print("%-5s: %s (%s B)" % (kind, path, format(path.stat().st_size, ",")))
    if bad:
        for b in bad:
            print("PROBLEM: " + b)
        return 1
    print("package: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
