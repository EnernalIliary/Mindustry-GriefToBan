#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""GriefToBan 测试总入口：JS 语法检查 + 纯逻辑层单测。

用法：python -X utf8 tests/grief-to-ban/run_gtb_tests.py
  rc 0 = 全部通过（含 node 缺失时的 SKIP）
  rc 1 = 有语法错误 / lib 单测失败 / 脚本缺失

只做三件事：
  1. 对 GriefToBan/scripts/*.js 逐个跑 node --check（语法检查，不执行）；
  2. 跑 node tests/grief-to-ban/run_lib_tests.js（gtb-lib.js 的行为测试）；
  3. 汇总打印 "GTB tests: X file(s) checked, lib tests <passed|failed>"。
不启动游戏、不跑 gate.py、不调 git。
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "GriefToBan" / "scripts"
LIB_TESTS = ROOT / "tests" / "grief-to-ban" / "run_lib_tests.js"


def force_utf8_stdio() -> None:
    """Windows 控制台/管道默认不是 UTF-8，中文输出会炸；能改就改成 utf-8。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def run(argv: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def indent(text: str) -> str:
    return "\n".join("    " + line for line in text.splitlines())


def dump_output(result: subprocess.CompletedProcess) -> None:
    out = (result.stdout or "").strip()
    err = (result.stderr or "").strip()
    if out:
        print(indent(out))
    if err:
        print(indent(err))


def main() -> int:
    force_utf8_stdio()

    node = shutil.which("node")
    if node is None:
        print("SKIP: node not found on PATH — 无法做 node --check，也无法跑 lib 单测")
        print("GTB tests: 0 file(s) checked, lib tests skipped")
        return 0

    if not SCRIPTS_DIR.is_dir():
        print("ERROR: 找不到目录 " + rel(SCRIPTS_DIR))
        print("GTB tests: 0 file(s) checked, lib tests failed")
        return 1

    files = sorted(p for p in SCRIPTS_DIR.glob("*.js") if p.is_file())
    if not files:
        print("WARN: " + rel(SCRIPTS_DIR) + " 下没有 *.js，语法检查跳过")

    checked = 0
    syntax_errors: list[Path] = []
    for path in files:
        result = run([node, "--check", str(path)])
        if result.returncode == 0:
            checked += 1
            print("syntax ok : " + rel(path))
            continue
        syntax_errors.append(path)
        print("syntax ERR: " + rel(path) + " (node --check rc " + str(result.returncode) + ")")
        dump_output(result)

    lib_failed = True
    if not LIB_TESTS.is_file():
        print("ERROR: 找不到 lib 测试脚本 " + rel(LIB_TESTS))
    else:
        result = run([node, str(LIB_TESTS)])
        lib_failed = result.returncode != 0
        if result.stdout:
            print(result.stdout.rstrip("\n"))
        if result.stderr and result.stderr.strip():
            print("lib tests stderr:")
            print(indent(result.stderr.strip()))
        if result.returncode != 0:
            print("lib tests: node rc " + str(result.returncode))

    failed = bool(syntax_errors) or lib_failed
    print(
        "GTB tests: {} file(s) checked, lib tests {}".format(
            checked, "failed" if lib_failed else "passed"
        )
    )
    if syntax_errors:
        print("syntax 失败文件：" + ", ".join(rel(p) for p in syntax_errors))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
