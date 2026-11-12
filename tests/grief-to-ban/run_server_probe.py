#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""GriefToBan 服务端加载探针：拿官方 server jar 真实加载模组，验证脚本能在 Rhino 里跑起来。

用法：python -X utf8 tests/grief-to-ban/run_server_probe.py
  rc 0 = 模组加载 + 自检全绿（或 jar/java 缺失导致的 SKIP）
  rc 1 = 模组没加载 / 自检失败 / 脚本在 Rhino 里报错

做的事：
  1. 定位仓库根、out/_server160.jar、out/jre21 里的 java（没有就退回 PATH 的 java）；
  2. 清空重建 out/_gtb_probe/，把 GriefToBan/ 拷进 <workdir>/config/mods/GriefToBan；
  3. 用 GTB_SELFTEST=1 起服务端（cwd=workdir），逐行读输出写 server.log；
     模组自带自检会在启动时跑完并 Core.app.exit()，不用跟控制台菜单交互；
  4. 日志里必须同时出现 '[GTB] Grief to Ban v0.1.2 已加载' 与 '[GTB] selftest OK'。

不启动图形客户端、不改 GriefToBan/、不调 git、不跑 gate.py。
"""

from __future__ import annotations

import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MOD_SRC = ROOT / "GriefToBan"
JAR = ROOT / "out" / "_server160.jar"
JAVA_BUNDLED = ROOT / "out" / "jre21" / "jdk-21.0.5+11-jre" / "bin" / "java.exe"
PROBE_DIR = ROOT / "out" / "_gtb_probe"
LOG_PATH = PROBE_DIR / "server.log"

TIMEOUT_S = 120.0   # 起服务端 + 跑自检的总预算
GRACE_S = 3.0       # 看到 selftest OK/FAIL 后再收 3 秒日志
KILL_WAIT_S = 10.0

# 判定用标记（只匹配 ASCII 片段，绕开中文编码差异；完整中文行另外打印）
LOAD_MARK = "Grief to Ban v0.1.4"
LOAD_MARK_CN = "已加载"
SELFTEST_OK = "selftest OK"
SELFTEST_FAIL = "selftest FAIL"

# 失败时高亮打印的行
NOISE_MARKS = ("GTB", "Exception", "FAILED ASSERTION", "Error", "error", "Verse\") ->")

# 服务端找模组的目录（相对 workdir）；config/mods 是 Mindustry 服务端的标准位置
LAYOUTS = ("config/mods", "mods")


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


def find_java():
    """返回 (java 路径, 来源说明)；找不到返回 (None, 原因)。"""
    if JAVA_BUNDLED.is_file():
        return str(JAVA_BUNDLED), "bundled " + rel(JAVA_BUNDLED)
    found = shutil.which("java")
    if found:
        return found, "PATH java (" + found + ")，没找到 " + rel(JAVA_BUNDLED)
    return None, "既没有 " + rel(JAVA_BUNDLED) + "，PATH 里也没有 java"


def ignore_pycache(_dir, names):
    return [n for n in names if n == "__pycache__" or n.endswith(".pyc")]


def prepare_workdir(layout: str) -> Path:
    """清空重建 out/_gtb_probe/，把模组拷到 <workdir>/<layout>/GriefToBan。"""
    shutil.rmtree(str(PROBE_DIR), ignore_errors=True)
    workdir = PROBE_DIR
    mods_root = workdir.joinpath(*layout.split("/"))
    mods_root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(str(MOD_SRC), str(mods_root / "GriefToBan"), ignore=ignore_pycache)
    # Mindustry 起服务端时会自己建 config/（settings.bin、logs/、saves/ 等）
    return workdir


def _reader(stream, sink: "queue.Queue") -> None:
    """后台把子进程 stdout 按行塞进队列，避免读到一半卡住 / 管道塞满。"""
    try:
        for line in iter(stream.readline, ""):
            sink.put(line)
    except Exception as exc:  # 读线程不该把主流程带崩
        sink.put("\n[probe] stdout reader error: " + repr(exc) + "\n")
    finally:
        sink.put(None)  # EOF 哨兵


def hard_kill(pid: int, label: str = "") -> None:
    """只针对我们自己起的 pid 收尾（Windows 上没有 psutil 也能用）。"""
    if os.name != "nt":
        return
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", timeout=30)
    except Exception:
        pass


def run_server(java: str, jar: str, workdir: Path) -> dict:
    """起一次服务端，边读边写 server.log，返回结果字典。"""
    log_path = workdir / "server.log"
    lines: list = []
    argv = [java, "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-jar", str(jar)]
    env = dict(os.environ)
    env["GTB_SELFTEST"] = "1"

    print("[probe] workdir = " + rel(workdir))
    print("[probe] cmd     = " + " ".join(argv))
    print("[probe] env GTB_SELFTEST=1")

    proc = subprocess.Popen(
        argv,
        cwd=str(workdir),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    sink: "queue.Queue" = queue.Queue()
    threading.Thread(target=_reader, args=(proc.stdout, sink), daemon=True).start()

    deadline = time.monotonic() + TIMEOUT_S
    marker_at = None
    timed_out = False
    eof = False

    with log_path.open("w", encoding="utf-8", errors="replace", newline="") as log:
        while True:
            now = time.monotonic()
            if now > deadline:
                timed_out = True
                break
            try:
                line = sink.get(timeout=0.25)
            except queue.Empty:
                if eof:
                    break
                continue
            if line is None:
                eof = True
                break
            lines.append(line)
            log.write(line)
            log.flush()
            if marker_at is None and (SELFTEST_OK in line or SELFTEST_FAIL in line):
                marker_at = time.monotonic()
            if marker_at is not None and time.monotonic() - marker_at >= GRACE_S:
                break
            if eof:
                break

    # 干净收尾：先让它自己退（自检里已经 Core.app.exit()），再 terminate/kill
    if proc.poll() is None:
        try:
            proc.terminate()
            proc.wait(timeout=KILL_WAIT_S)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
                proc.wait(timeout=KILL_WAIT_S)
            except Exception:
                pass
        except Exception:
            pass
    hard_kill(proc.pid)
    for stream in (proc.stdout, proc.stdin):
        try:
            if stream is not None:
                stream.close()
        except Exception:
            pass

    text = "".join(lines)
    ret = {"lines": lines, "text": text, "log": log_path, "rc": proc.returncode,
           "timed_out": timed_out, "eof": eof}
    return ret


def judge(text: str) -> dict:
    i_load = text.find(LOAD_MARK)
    i_ok = text.find(SELFTEST_OK)
    i_fail = text.find(SELFTEST_FAIL)
    # "selftest FAIL" 里不含 "selftest OK"，但仍按 index 先到者为准
    ok = i_ok >= 0 and (i_fail < 0 or i_ok < i_fail)
    return {"load": i_load >= 0, "selftest_ok": ok,
            "selftest_fail": i_fail >= 0, "i_load": i_load, "i_ok": i_ok, "i_fail": i_fail}


def dump_tail(lines, n=80) -> None:
    tail = lines[-n:]
    print("---- 日志最后 {} 行（{}）----".format(len(tail), rel(LOG_PATH)))
    for line in tail:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")


def dump_noise(lines) -> None:
    hits = [ln.rstrip("\n") for ln in lines
            if any(m in ln for m in NOISE_MARKS) or "mods" in ln.lower()]
    print("---- 关键行（GTB / Exception / Error / mods，{} 条）----".format(len(hits)))
    for line in hits:
        print("  " + line)


def dump_selftest(lines) -> None:
    """selfTest 每条 ok xxx / FAIL xxx 单独列出（失败时最要紧的就是这条）。"""
    detail = [ln.rstrip("\n") for ln in lines
              if ln.startswith("ok ") or ln.startswith("FAIL ")]
    if not detail:
        return
    print("---- 自检明细（{} 条）----".format(len(detail)))
    for line in detail:
        print("  " + line)


def main() -> int:
    force_utf8_stdio()

    print("GTB server probe: root=" + str(ROOT))

    if not MOD_SRC.is_dir():
        print("ERROR: 找不到模组目录 " + rel(MOD_SRC))
        print("GTB server probe: FAIL (mod dir missing)")
        return 1

    java, java_note = find_java()
    missing = []
    if not JAR.is_file():
        missing.append(rel(JAR))
    if java is None:
        missing.append("java（" + java_note + "）")
    if missing:
        print("缺：" + "；".join(missing))
        print("GTB server probe: SKIP (missing " + ", ".join(missing) + ")")
        return 0
    print("[probe] java    = " + java_note)
    print("[probe] jar     = " + rel(JAR))

    result = None
    verdict = None
    used_layout = None
    first_rc = None
    for attempt, layout in enumerate(LAYOUTS, start=1):
        print("[probe] --- attempt {}: 模组放在 <workdir>/{}/GriefToBan ---".format(attempt, layout))
        workdir = prepare_workdir(layout)
        result = run_server(java, str(JAR), workdir)
        verdict = judge(result["text"])
        used_layout = layout
        print("[probe] rc={} timeout={} load={} selftest_ok={} selftest_fail={}".format(
            result["rc"], result["timed_out"], verdict["load"],
            verdict["selftest_ok"], verdict["selftest_fail"]))
        if verdict["load"] and verdict["selftest_ok"]:
            break
        if attempt == 1:
            first_rc = result["rc"]
        # 只有第一次完全没被加载（日志里连 GTB 字样都没有）才换目录重试
        if any("GTB" in ln for ln in result["lines"]):
            print("[probe] 日志里有 GTB 字样：模组已被加载，问题在自检，不再换目录重试")
            break
        print("[probe] 第一次没被加载：没有 GTB 输出，换第二种目录再试一次")
        try:
            os.replace(str(result["log"]), str(result["log"].with_name("server.attempt1.log")))
        except OSError:
            pass

    text = result["text"]
    lines = result["lines"]

    # 成功：把模组加载行与自检明细打出来（selfTest 每条 ok xxx 都在里面）
    if verdict["load"] and verdict["selftest_ok"]:
        print("[probe] 模组目录：<workdir>/" + str(used_layout) + "/GriefToBan（服务端接受这个位置）")
        print("---- 模组加载 / 自检关键行 ----")
        for line in lines:
            s = line.rstrip("\n")
            if ("GTB" in s) or s.startswith("ok ") or s.startswith("FAIL "):
                print("  " + s)
        warns = [ln.rstrip("\n") for ln in lines
                 if ("WARN" in ln or "warn" in ln or "Exception" in ln or "selftest FAIL" in ln)]
        if warns:
            print("---- 警告 ----")
            for line in warns:
                print("  " + line)
        print("GTB server probe: OK (selftest passed)")
        return 0

    # 失败：最后 80 行 + 所有关键行
    print("---- 判定失败 ----")
    if verdict["i_load"] < 0:
        print("  缺：模组加载行（'" + LOAD_MARK + "' / '" + LOAD_MARK_CN + "'）")
    if not verdict["selftest_ok"]:
        print("  缺：自检通过行（'" + SELFTEST_OK + "'）")
    if verdict["selftest_fail"]:
        print("  命中：自检失败行（'" + SELFTEST_FAIL + "'）")
    if result["timed_out"]:
        print("  超时：{}s 内没等到自检结果".format(int(TIMEOUT_S)))
    dump_tail(lines)
    dump_noise(lines)
    dump_selftest(lines)
    if first_rc is not None and used_layout != LAYOUTS[0]:
        print("[probe] 两种目录都试过：{} 与 {}".format("、".join(LAYOUTS), "，均失败"))
    print("GTB server probe: FAIL (mod not loaded / selftest failed)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
