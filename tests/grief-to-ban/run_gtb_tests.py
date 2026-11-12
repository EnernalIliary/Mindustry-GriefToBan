#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""GriefToBan 测试总入口：JS 语法检查 + main.js 源码红线 + 纯逻辑层单测 + 真机服务端探针。

用法（默认全跑）：
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py --only lib
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py --only check,perf
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py --no-probe      # 跳过最慢的真机探针

阶段（--only 可组合，逗号分隔）：
  check = 对 GriefToBan/scripts/*.js 逐个 node --check（语法检查，不执行）
  lib   = node tests/grief-to-ban/run_lib_tests.js（gtb-lib.js 纯逻辑层行为测试）
  perf  = node tests/grief-to-ban/run_perf_static_tests.js（main.js 源码级性能红线）
  probe = python tests/grief-to-ban/run_server_probe.py（真机 v160 服务端加载模组 + selfTest）

退出码：
  0 = 全部通过（含 node 缺失 / jar 缺失导致的 SKIP）
  1 = 任一阶段失败 / 测试脚本缺失
  2 = 命令行用法错误（argparse 默认）

不启动图形客户端、不改 GriefToBan/、不调 git、不跑 gate.py。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "GriefToBan" / "scripts"
TESTS_DIR = ROOT / "tests" / "grief-to-ban"
LIB_TESTS = TESTS_DIR / "run_lib_tests.js"
PERF_TESTS = TESTS_DIR / "run_perf_static_tests.js"
PROBE_SCRIPT = TESTS_DIR / "run_server_probe.py"

STAGES = ("check", "lib", "perf", "probe")  # 执行顺序（probe 最慢，放最后）
NODE_TESTS = {"lib": LIB_TESTS, "perf": PERF_TESTS}
NODE_STAGE_DESC = {
    "lib": "纯逻辑层单测（gtb-lib.js）",
    "perf": "main.js 源码级性能红线（0.1.7）",
}
STAGE_DESC = {
    "check": "node --check 每个 GriefToBan/scripts/*.js",
    "lib": NODE_STAGE_DESC["lib"],
    "perf": NODE_STAGE_DESC["perf"],
    "probe": "真机服务端探针（v160 加载模组 + selfTest）",
}

USAGE_EXAMPLES = """examples:
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py --only lib,perf
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py --only probe
  python -X utf8 tests/grief-to-ban/run_gtb_tests.py --no-probe
"""


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


def header(index: int, total: int, name: str, desc: str) -> None:
    print("")
    print("==== [{}之一] {}：{} ====".format(index, name, desc))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run_gtb_tests.py",
        description="GriefToBan 测试总入口：node --check + lib 单测 + main.js 源码红线 + 真机服务端探针。",
        epilog=USAGE_EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--only",
        default="",
        metavar="STAGES",
        help="只跑这些阶段，逗号分隔：{}；默认全跑".format(",".join(STAGES)),
    )
    parser.add_argument(
        "--no-probe",
        "--skip-probe",
        dest="no_probe",
        action="store_true",
        help="跳过真机服务端探针（起一次 headless 服务端，最慢的一步）",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="只列出阶段名后退出",
    )
    return parser


def resolve_stages(parser: argparse.ArgumentParser, args: argparse.Namespace) -> list[str]:
    raw = args.only.replace(";", ",").replace(" ", ",") if args.only else ""
    requested = [s.strip().lower() for s in raw.split(",") if s.strip()]
    if requested:
        unknown = [s for s in requested if s not in STAGES]
        if unknown:
            parser.error(
                "未知阶段 {}；可选：{}".format("、".join(unknown), ",".join(STAGES))
            )
        stages = [s for s in STAGES if s in requested]
    else:
        stages = list(STAGES)
    if args.no_probe and "probe" in stages:
        stages = [s for s in stages if s != "probe"]
    return stages


def stage_check() -> tuple[str, int, list[Path]]:
    """对 GriefToBan/scripts/*.js 逐个 node --check。返回 (状态, 通过文件数, 失败文件)。"""
    node = shutil.which("node")
    if node is None:
        print("SKIP: node not found on PATH —— 无法做 node --check")
        return "skipped", 0, []

    if not SCRIPTS_DIR.is_dir():
        print("ERROR: 找不到目录 " + rel(SCRIPTS_DIR))
        return "failed", 0, []

    files = sorted(p for p in SCRIPTS_DIR.glob("*.js") if p.is_file())
    if not files:
        print("WARN: " + rel(SCRIPTS_DIR) + " 下没有 *.js，语法检查跳过")
        return "skipped", 0, []

    checked = 0
    errors: list[Path] = []
    for path in files:
        result = run([node, "--check", str(path)])
        if result.returncode == 0:
            checked += 1
            print("syntax ok : " + rel(path))
            continue
        errors.append(path)
        print("syntax ERR: " + rel(path) + " (node --check rc " + str(result.returncode) + ")")
        dump_output(result)

    if errors:
        print("syntax 失败文件：" + ", ".join(rel(p) for p in errors))
        return "failed", checked, errors
    return "passed", checked, errors


def stage_node_script(name: str) -> str:
    """跑一个 node 测试脚本（lib / perf）。"""
    node = shutil.which("node")
    if node is None:
        print("SKIP: node not found on PATH —— 无法跑 " + rel(NODE_TESTS[name]))
        return "skipped"

    script = NODE_TESTS[name]
    if not script.is_file():
        print("ERROR: 找不到测试脚本 " + rel(script))
        return "failed"

    print("$ node " + rel(script))
    result = run([node, str(script)])
    if result.stdout:
        print(result.stdout.rstrip("\n"))
    if result.stderr and result.stderr.strip():
        print(name + " tests stderr:")
        print(indent(result.stderr.strip()))
    if result.returncode != 0:
        print(name + " tests: node rc " + str(result.returncode) + "（" + rel(script) + "）")
        return "failed"
    return "passed"


def stage_probe() -> str:
    """跑真机服务端探针（v160 headless 服务端加载模组 + selfTest）。"""
    if not PROBE_SCRIPT.is_file():
        print("ERROR: 找不到探针脚本 " + rel(PROBE_SCRIPT))
        return "failed"

    print("$ python " + rel(PROBE_SCRIPT))
    result = run([sys.executable, str(PROBE_SCRIPT)])
    if result.stdout:
        print(result.stdout.rstrip("\n"))
    if result.stderr and result.stderr.strip():
        print("server probe stderr:")
        print(indent(result.stderr.strip()))
    if result.returncode != 0:
        print("server probe: rc " + str(result.returncode) + "（" + rel(PROBE_SCRIPT) + "）")
        return "failed"
    return "passed"


def main(argv: list[str] | None = None) -> int:
    force_utf8_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.list:
        for name in STAGES:
            print("{:6s} {}".format(name, STAGE_DESC[name]))
        return 0

    stages = resolve_stages(parser, args)
    print("GTB tests: root=" + str(ROOT))
    print("GTB tests: 阶段 = " + ", ".join(stages))

    results: dict[str, str] = {name: "skipped" for name in STAGES}
    checked = 0

    for index, name in enumerate(stages, start=1):
        if name == "check":
            header(index, len(stages), name, STAGE_DESC["check"])
            status, checked, _errors = stage_check()
            results[name] = status
        elif name in NODE_TESTS:
            header(index, len(stages), name, NODE_STAGE_DESC[name])
            results[name] = stage_node_script(name)
        elif name == "probe":
            header(index, len(stages), name, STAGE_DESC["probe"])
            results[name] = stage_probe()
        else:  # pragma: no cover - resolve_stages 已挡掉
            print("ERROR: 未知阶段 " + name)
            results[name] = "failed"

    def word(name: str) -> str:
        return results.get(name, "skipped")

    failed = [name for name in STAGES if results.get(name) == "failed"]
    print("")
    print(
        "GTB tests: {} file(s) checked, lib tests {}, static red lines {}, server probe {}".format(
            checked, word("lib"), word("perf"), word("probe")
        )
    )
    if checked == 0 and "check" in stages:
        print("GTB tests: 语法检查通过文件数 0（node 缺失或目录为空，见上面的 SKIP/WARN）")
    if failed:
        print("GTB tests: FAILED（{}）".format(", ".join(failed)))
        return 1
    print("GTB tests: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
