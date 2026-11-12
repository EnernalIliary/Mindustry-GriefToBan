#!/usr/bin/env node
"use strict";

// GriefToBan . main.js 源码级红线（0.1.3 性能回归）
//
// 背景（用户 2026-11-12 报「启用 Grief to Ban 后进地图编辑器加载很久、长时间未响应」）：
//   1) seqGet() 老写法先试 seq.get(i)，但 v160 的 mindustry.entities.EntityGroup 没有 get(int)
//      （EntityGroup.java:231/235 只有 index(int)/size()）⇒ 每个方块抛一次 TypeError 再被 catch，
//      大图 8311 方块 × 每秒 3 遍扫描 ≈ 每秒 2.5 万次异常。
//   2) scanReactors / scanGenerators / scanVirusQuick 三遍全图扫描，合并成一遍 scanWorld。
//   3) 地图编辑器（Rules.editor）里整套逻辑不该跑。
//   4) 名单每次变更就 autosave settings.bin ⇒ 主线程磁盘 I/O；改成脏标记 + tick 里节流落盘。
//   5) 一轮最多处置 GTB_PUNISH.max 个建造者，防一次性几十次 autosave/广播。
//   6) dbg() 每行一次 open/append/close ⇒ 改成内存缓冲 + dbgFlush() 批量落盘。
//
// 这里只读源码文本做断言（不执行 main.js，它依赖 Java/Rhino 运行时），所以能在纯 Node 里跑。
// 零依赖；不改 GriefToBan/ 下任何文件。
// 运行：node tests/grief-to-ban/run_perf_static_tests.js
// 全绿：打印 "GTB perf static: N passed" 并 exit 0；失败：打印期望/实际（含行号）+ exit 1。

var path = require("path");
var fs = require("fs");

var ROOT = path.resolve(__dirname, "..", "..");
// 默认只查仓库里的 main.js；GTB_MAIN_JS 只给测试自己用（拿临时副本验证红线真的会红）。
var MAIN_FILE = process.env.GTB_MAIN_JS
  ? path.resolve(process.env.GTB_MAIN_JS)
  : path.join(ROOT, "GriefToBan", "scripts", "main.js");
var MAIN_REL = process.env.GTB_MAIN_JS
  ? String(process.env.GTB_MAIN_JS)
  : "GriefToBan/scripts/main.js";

var passed = 0;
var failures = [];
var stats = Object.create(null);
var notes = [];
var sectionName = "(root)";

function section(name) {
  sectionName = name;
  if (!stats[name]) stats[name] = { passed: 0, failed: 0 };
}

function ok(name, cond, expected, actual) {
  if (!stats[sectionName]) stats[sectionName] = { passed: 0, failed: 0 };
  if (cond) {
    stats[sectionName].passed++;
    passed++;
    return true;
  }
  stats[sectionName].failed++;
  failures.push({
    section: sectionName,
    name: name,
    expected: expected,
    actual: actual,
  });
  return false;
}

function lineAt(text, index) {
  if (index < 0) return -1;
  var n = 0;
  for (var i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n + 1;
}

function where(text, index) {
  return index < 0 ? "未出现" : MAIN_REL + ":" + lineAt(text, index);
}

// 把 // 与 /* */ 注释替换成等长空格（保留换行），这样：
//   - 索引/行号不变，仍可直接报 main.js:<行号>；
//   - 注释里提到的名字（例如「原来先试 seq.get(i)」的说明）不会误伤计数断言。
// 字符串字面量原样保留（扫描时按引号跳过，注释符出现在字符串里不算注释）。
function stripComments(src) {
  var out = [];
  var i = 0;
  var n = src.length;
  var mode = 0; // 0=code 1=line 2=block 3='...' 4="..."
  while (i < n) {
    var c = src.charAt(i);
    var c2 = src.substr(i, 2);
    if (mode === 0) {
      if (c2 === "//") { mode = 1; out.push("  "); i += 2; continue; }
      if (c2 === "/*") { mode = 2; out.push("  "); i += 2; continue; }
      if (c === '"') { mode = 4; out.push(c); i++; continue; }
      if (c === "'") { mode = 3; out.push(c); i++; continue; }
      out.push(c); i++; continue;
    }
    if (mode === 1) {
      if (c === "\n") { mode = 0; out.push("\n"); } else out.push(" ");
      i++; continue;
    }
    if (mode === 2) {
      if (c2 === "*/") { mode = 0; out.push("  "); i += 2; continue; }
      out.push(c === "\n" ? "\n" : " ");
      i++; continue;
    }
    // 字符串里
    if (c === "\\") { out.push(c); out.push(src.charAt(i + 1) || ""); i += 2; continue; }
    if ((mode === 4 && c === '"') || (mode === 3 && c === "'")) { mode = 0; out.push(c); i++; continue; }
    out.push(c); i++;
  }
  return out.join("");
}

// 找到 "function name(" 的函数体（含首尾花括号），返回 {body, startLine, endLine}。
// 花括号配对时跳过字符串，避免字符串里的 { } 干扰。
function findFunction(text, name) {
  var re = new RegExp("function\\s+" + name + "\\s*\\(");
  var m = re.exec(text);
  if (!m) return null;
  var braceStart = text.indexOf("{", m.index + m[0].length);
  if (braceStart < 0) return null;
  var depth = 0;
  var quote = "";
  for (var i = braceStart; i < text.length; i++) {
    var c = text.charAt(i);
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return {
          body: text.slice(braceStart, i + 1),
          startLine: lineAt(text, m.index),
          endLine: lineAt(text, i),
        };
      }
    }
  }
  return null;
}

function occurrences(text, needle) {
  var out = [];
  var at = text.indexOf(needle);
  while (at >= 0) {
    out.push(at);
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}

function inBody(fn, needle) {
  return fn != null && fn.body.indexOf(needle) >= 0;
}

function bodyPos(fn, needle) {
  return fn == null ? -1 : fn.body.indexOf(needle);
}

function fnLabel(fn) {
  return fn == null ? "(函数不存在)" : MAIN_REL + ":" + fn.startLine + "-" + fn.endLine;
}

var src = "";
try {
  src = fs.readFileSync(MAIN_FILE, "utf8");
} catch (err) {
  console.log("GTB perf static: FAILED to read " + MAIN_REL);
  console.log("  " + String(err && err.message ? err.message : err));
  process.exit(1);
}

var clean = stripComments(src);

var F = {};
var FN_NAMES = [
  "seqGet", "seqIter", "seqEach", "scanWorld", "tick", "onBuildEnd", "onConfig",
  "inEditor", "dbg", "dbgFlush", "dbgClear", "flushSettings", "swrite", "selfTestWrite",
];
for (var fi = 0; fi < FN_NAMES.length; fi++) {
  F[FN_NAMES[fi]] = findFunction(clean, FN_NAMES[fi]);
}

// ================================================================ 1. seqGet 热路径
section("seqGet 热路径");
ok(
  "seqGet 存在",
  F.seqGet != null,
  "main.js 里应有 function seqGet(seq, i)",
  F.seqGet == null ? "没找到 function seqGet(" : fnLabel(F.seqGet)
);
ok(
  "seqGet 里调用 seq.index(i)",
  inBody(F.seqGet, "seq.index("),
  "seqGet 首选 EntityGroup.index(int)（v160 里唯一存在的按下标取值）",
  "seqGet 函数体里找不到 seq.index(（" + fnLabel(F.seqGet) + "）"
);
(function () {
  var idxPos = bodyPos(F.seqGet, "seq.index(");
  var getPos = bodyPos(F.seqGet, "seq.get(");
  ok(
    "seqGet 里 seq.index( 在 seq.get( 之前",
    idxPos >= 0 && (getPos < 0 || idxPos < getPos),
    "Hot path 必须先 index(i)；seq.get(i) 只能作为兜底、且排在其后",
    "index 位置=" + idxPos + "，seq.get( 位置=" + getPos + "（" + fnLabel(F.seqGet) + "）"
  );
})();
ok(
  "seqIter 存在且只用 seq.index(",
  F.seqIter != null && inBody(F.seqIter, "seq.index(") && !inBody(F.seqIter, "seq.get("),
  "热路径遍历函数 seqIter：size 只算一次、循环里只调 index(i)，不碰 get(i)",
  F.seqIter == null ? "没找到 function seqIter(" : "seqIter 体：" + F.seqIter.body.replace(/\s+/g, " ").slice(0, 160)
);

// ================================================================ 2. 单遍 scanWorld
section("单遍 scanWorld");
ok(
  "scanWorld 存在",
  F.scanWorld != null,
  "三遍全图扫描应合并成一遍 scanWorld(now)",
  F.scanWorld == null ? "没找到 function scanWorld(" : fnLabel(F.scanWorld)
);
var LEGACY = ["scanReactors", "scanGenerators", "scanVirusQuick"];
var legacyHits = [];
for (var li = 0; li < LEGACY.length; li++) {
  var ln = LEGACY[li];
  var occ = occurrences(clean, ln);
  if (occ.length) legacyHits.push(ln + "(" + occ.length + " 处，首个 " + where(clean, occ[0]) + ")");
}
ok(
  "旧的三遍扫描函数已不存在",
  legacyHits.length === 0,
  "scanReactors / scanGenerators / scanVirusQuick 全部删除（含定义与调用），只剩 scanWorld",
  legacyHits.length === 0 ? "已全部消失" : "仍存在：" + legacyHits.join("；")
);
ok(
  "scanWorld 里只取一次 Groups.build",
  occurrences(F.scanWorld ? F.scanWorld.body : "", "Packages.mindustry.gen.Groups.build").length === 1,
  "一遍遍历：Groups.build 只取一次，之后 逐方块分派 stepReactor/stepGen/stepLogic",
  "出现次数=" + occurrences(F.scanWorld ? F.scanWorld.body : "", "Packages.mindustry.gen.Groups.build").length + "（" + fnLabel(F.scanWorld) + "）"
);
var DISPATCH = [
  ["stepReactor(", "钍堆"],
  ["stepGen(", "爆混发电机"],
  ["stepLogic(", "自复制逻辑"],
];
for (var di = 0; di < DISPATCH.length; di++) {
  var dname = DISPATCH[di][0];
  ok(
    "scanWorld 分派到 " + dname,
    inBody(F.scanWorld, dname),
    "同一遍遍历里按方块类型分派到 " + dname + "（" + DISPATCH[di][1] + "）",
    "scanWorld 函数体里找不到 " + dname + "（" + fnLabel(F.scanWorld) + "）"
  );
}
ok(
  "scanWorld 循环里用 arr.index(i)",
  inBody(F.scanWorld, "arr.index(i)") && !inBody(F.scanWorld, "seqGet("),
  "热循环直接 arr.index(i)，不经 seqGet 的多级 try（否则仍有一次 get 异常）",
  "arr.index(i)=" + inBody(F.scanWorld, "arr.index(i)") + "，seqGet= " + inBody(F.scanWorld, "seqGet(") + "（" + fnLabel(F.scanWorld) + "）"
);
ok(
  "tick 里调用 scanWorld(",
  inBody(F.tick, "scanWorld("),
  "tick 的每秒扫描调用 scanWorld(now)",
  "tick 函数体里找不到 scanWorld(（" + fnLabel(F.tick) + "）"
);
ok(
  "tick 每秒一轮扫描",
  inBody(F.tick, "now - GTB.lastScan >= 1000"),
  "扫描节奏 1000ms（钍堆升温到炸只有几秒，不能退到 3 秒）",
  "tick 里找不到 \"now - GTB.lastScan >= 1000\"（" + fnLabel(F.tick) + "）"
);
ok(
  "GTB_PERF 记录 scan/worst",
  /var\s+GTB_PERF\s*=\s*\{\s*scan:\s*0,\s*worst:\s*0,\s*builds:\s*0\s*\}/.test(clean),
  "var GTB_PERF = { scan: 0, worst: 0, builds: 0 }",
  "没找到 GTB_PERF 的三个字段定义"
);
ok(
  "scanWorld 计算耗时",
  inBody(F.scanWorld, "GTB_PERF.scan") && inBody(F.scanWorld, "GTB_PERF.worst") && inBody(F.scanWorld, "nowNanos()"),
  "scanWorld 用 nowNanos() 记 GTB_PERF.scan / worst（心跳里才看得到真实开销）",
  "nowNanos=" + inBody(F.scanWorld, "nowNanos()") + "，GTB_PERF.scan=" + inBody(F.scanWorld, "GTB_PERF.scan") + "，worst=" + inBody(F.scanWorld, "GTB_PERF.worst")
);
ok(
  "心跳行带 scan=NNms worst=NNms",
  inBody(F.tick, '" scan=" + Math.round(GTB_PERF.scan) + "ms worst="') || clean.indexOf('" scan=" + Math.round(GTB_PERF.scan) + "ms worst="') >= 0,
  "dbg 心跳行含 \" scan=NNms worst=NNms\"（真机排查靠这一行）",
  "心跳行里没有 scan=/worst= 片段（" + fnLabel(F.tick) + "）"
);
ok(
  "GTB_PUNISH.max === 6",
  /GTB_PUNISH\s*=\s*\{\s*n:\s*0,\s*max:\s*6\s*\}/.test(clean),
  "var GTB_PUNISH = { n: 0, max: 6 }（一轮最多处置 6 个，其余下一秒再拉黑）",
  "没找到 GTB_PUNISH = { n: 0, max: 6 }"
);

// ================================================================ 3. 编辑器早退
section("编辑器早退");
var guarded = [
  ["tick", F.tick],
  ["onBuildEnd", F.onBuildEnd],
  ["onConfig", F.onConfig],
];
for (var gi = 0; gi < guarded.length; gi++) {
  var gname = guarded[gi][0];
  var gfn = guarded[gi][1];
  ok(
    gname + " 里有 if (inEditor()) return;",
    inBody(gfn, "if (inEditor()) return;"),
    "function " + gname + " 开头（动了世界之前）必须有 if (inEditor()) return;",
    "没找到（" + fnLabel(gfn) + "）"
  );
}
(function () {
  var a = bodyPos(F.tick, "if (inEditor()) return;");
  var b = bodyPos(F.tick, "scanWorld(");
  ok(
    "tick 的编辑器早退在 scanWorld 之前",
    a >= 0 && b >= 0 && a < b,
    "先 inEditor() 早退，再谈扫描（否则编辑器里照样全图扫）",
    "inEditor 位置=" + a + "，scanWorld 位置=" + b
  );
})();
(function () {
  var a = bodyPos(F.tick, "flushSettings(");
  var b = bodyPos(F.tick, "if (inEditor()) return;");
  ok(
    "tick 里落盘在编辑器早退之前",
    a >= 0 && b >= 0 && a < b,
    "编辑器里改设置也得存得住：dbgFlush/flushSettings 放在 inEditor 早退之前，只是不扫世界",
    "flushSettings 位置=" + a + "，inEditor 早退位置=" + b
  );
})();
(function () {
  var a = bodyPos(F.onBuildEnd, "if (inEditor()) return;");
  var b = bodyPos(F.onBuildEnd, "checkVirus(");
  ok(
    "onBuildEnd 早退在 checkVirus 之前",
    a >= 0 && b >= 0 && a < b,
    "编辑器里不改 enabled、不记建造者：早退必须早于 checkVirus/checkReactorNear 等世界操作",
    "inEditor 位置=" + a + "，checkVirus 位置=" + b
  );
})();
(function () {
  var a = bodyPos(F.onConfig, "if (inEditor()) return;");
  var b = bodyPos(F.onConfig, "noteInteract(");
  ok(
    "onConfig 早退在 noteInteract 之前",
    a >= 0 && b >= 0 && a < b,
    "编辑器里的方块配置不算玩家交互：早退必须早于 noteInteract",
    "inEditor 位置=" + a + "，noteInteract 位置=" + b
  );
})();
ok(
  "心跳/WorldLoad 日志带 editor=1",
  clean.indexOf('(inEditor() ? 1 : 0)') >= 0 && /dbg\("world loaded "/.test(clean),
  "心跳行 \" editor=\" + (inEditor() ? 1 : 0) 与 WorldLoad 的 editor=1 提示（排查用）",
  "没找到 editor=1 的诊断输出"
);

// ================================================================ 4. autosave 单点
section("autosave 单点");
var AUTO = "Core.settings.autosave()";
var autoPositions = occurrences(clean, AUTO);
ok(
  "flushSettings 里有且只有一次 autosave",
  occurrences(F.flushSettings ? F.flushSettings.body : "", AUTO).length === 1,
  "设置落盘唯一入口：flushSettings(now) 里 Core.settings.autosave()",
  "flushSettings 里出现 " + occurrences(F.flushSettings ? F.flushSettings.body : "", AUTO).length + " 次（" + fnLabel(F.flushSettings) + "）"
);
ok(
  "flushSettings 有 1500ms 节流与脏标记",
  inBody(F.flushSettings, "if (!GTB_DIRTY.on) return;") && inBody(F.flushSettings, "now - GTB_DIRTY.at < 1500"),
  "if (!GTB_DIRTY.on) return; + if (now - GTB_DIRTY.at < 1500) return;（tick 每 1.5s 最多落一次盘）",
  "flushSettings 里缺脏标记门或 1500ms 节流（" + fnLabel(F.flushSettings) + "）"
);
var hotFns = ["tick", "scanWorld", "swrite", "dbg", "dbgFlush"];
var hotOffenders = [];
for (var hi = 0; hi < hotFns.length; hi++) {
  if (inBody(F[hotFns[hi]], AUTO)) hotOffenders.push(hotFns[hi]);
}
ok(
  "热路径函数里没有 autosave",
  hotOffenders.length === 0,
  "tick / scanWorld / swrite / dbg / dbgFlush 里一次都不能出现 Core.settings.autosave()",
  hotOffenders.length === 0 ? "干净" : "出现在：" + hotOffenders.join(", ") + "（" + fnLabel(F[hotOffenders[0]]) + "）"
);
(function () {
  var allowed = [];
  var outside = [];
  for (var i = 0; i < autoPositions.length; i++) {
    var p = autoPositions[i];
    var inFlush = F.flushSettings != null &&
      p >= clean.indexOf(F.flushSettings.body) &&
      p < clean.indexOf(F.flushSettings.body) + F.flushSettings.body.length;
    var inSelfTest = F.selfTestWrite != null &&
      p >= clean.indexOf(F.selfTestWrite.body) &&
      p < clean.indexOf(F.selfTestWrite.body) + F.selfTestWrite.body.length;
    if (inFlush) allowed.push("flushSettings(" + where(clean, p) + ")");
    else if (inSelfTest) {
      allowed.push("selfTestWrite(" + where(clean, p) + ")");
      notes.push(
        "Core.settings.autosave() 在 " + where(clean, p) + " 还有 1 处，位于 selfTestWrite（界面「写入自检」按钮，"
        + "用户点一次才跑一次、不是热路径）。若要让「全文件只此一处」绝对成立，删掉那一行即可，本测试会随之收紧。"
      );
    } else outside.push(where(clean, p));
  }
  ok(
    "autosave 只落在 flushSettings / selfTestWrite",
    outside.length === 0 && autoPositions.length >= 1 && autoPositions.length <= 2,
    "非注释代码里 autosave 出现 1~2 次：flushSettings 唯一热路径入口 + selfTestWrite（手动按钮）；"
    + "其它任何位置出现都算回归（每次名单变动写 287KB settings.bin）",
    "出现 " + autoPositions.length + " 次：" + allowed.concat(outside).join(", ")
  );
})();
ok(
  "swrite 同值不重复写",
  inBody(F.swrite, "if (String(sread(key)) === s) return;") && inBody(F.swrite, "GTB_DIRTY.on = true;"),
  "swrite 内容没变就直接 return，只在真写成功时置 GTB_DIRTY.on = true",
  "swrite 里缺「同值不写」或脏标记（" + fnLabel(F.swrite) + "）"
);

// ================================================================ 5. inEditor 判定
section("inEditor 判定");
ok(
  "inEditor 用 r.editor === true 判定",
  inBody(F.inEditor, "r.editor === true"),
  "function inEditor() 里 if (r != null && r.editor === true)（Rules.editor，Rules.java:51）",
  "没找到 r.editor === true（" + fnLabel(F.inEditor) + "）"
);
ok(
  "inEditor 对空 state 返回 false",
  inBody(F.inEditor, "if (st == null) return false;") && inBody(F.inEditor, "Vars.state"),
  "无头/未进入世界时 Vars.state == null ⇒ 返回 false，不抛",
  "缺 Vars.state/null 保护（" + fnLabel(F.inEditor) + "）"
);

// ================================================================ 6. dbg 缓冲
section("dbg 缓冲");
ok(
  "dbg 不再直接 writeString",
  F.dbg != null && !inBody(F.dbg, "writeString"),
  "dbg(msg) 只把行推进 GTB_DBG_BUF.lines（攒满 40 行才 dbgFlush），不做文件 I/O",
  F.dbg == null ? "没找到 function dbg(" : "dbg 里仍有 writeString（" + fnLabel(F.dbg) + "）"
);
ok(
  "dbgFlush 才是写盘点",
  inBody(F.dbgFlush, "writeString") && inBody(F.dbgFlush, "f.writeString(s, true)"),
  "dbgFlush() 里 f.writeString(s, true) 一次批量追加",
  "dbgFlush 里找不到 f.writeString(s, true)（" + fnLabel(F.dbgFlush) + "）"
);
(function () {
  var wsPos = occurrences(clean, "writeString");
  var bad = [];
  for (var i = 0; i < wsPos.length; i++) {
    var p = wsPos[i];
    var inFlush = F.dbgFlush != null &&
      p >= clean.indexOf(F.dbgFlush.body) &&
      p < clean.indexOf(F.dbgFlush.body) + F.dbgFlush.body.length;
    var inClear = F.dbgClear != null &&
      p >= clean.indexOf(F.dbgClear.body) &&
      p < clean.indexOf(F.dbgClear.body) + F.dbgClear.body.length;
    if (!inFlush && !inClear) bad.push(where(clean, p));
  }
  ok(
    "writeString 只出现在 dbgFlush / dbgClear",
    bad.length === 0 && wsPos.length > 0,
    "文件写入只允许 dbgFlush（批量追加）与 dbgClear（清空重写），别处出现 writeString 就是逐行 I/O 回归",
    bad.length === 0 ? wsPos.length + " 处，均在白名单内" : "越界：" + bad.join(", ")
  );
})();
ok(
  "dbg 攒满 40 行触发 dbgFlush",
  inBody(F.dbg, "dbgFlush()") && inBody(F.dbg, ">= 40"),
  "dbg 里 if (GTB_DBG_BUF.lines.length >= 40) dbgFlush();",
  "dbg 里缺 40 行批量落盘触发（" + fnLabel(F.dbg) + "）"
);
ok(
  "tick 每 500ms 冲一次缓冲",
  inBody(F.tick, "dbgFlush()") && inBody(F.tick, ">= 500"),
  "tick 里 if (GTB_DBG_BUF.lines.length > 0 && now - GTB_DBG_BUF.at >= 500) dbgFlush();",
  "tick 里缺 500ms dbgFlush（" + fnLabel(F.tick) + "）"
);
ok(
  "日志行数上限 3000",
  inBody(F.dbg, ">= 3000"),
  "dbg 里 if (GTB_DBG.lines >= 3000) return;（日志不无限长）",
  "dbg 里缺 3000 行上限（" + fnLabel(F.dbg) + "）"
);

// ================================================================ 汇总
function summary() {
  var names = Object.keys(stats);
  for (var i = 0; i < names.length; i++) {
    var s = stats[names[i]];
    console.log(
      (s.failed === 0 ? "[ok]   " : "[FAIL] ") + names[i] + ": " + s.passed + " passed" +
      (s.failed ? ", " + s.failed + " failed" : "")
    );
  }
  for (var ni = 0; ni < notes.length; ni++) {
    console.log("NOTE: " + notes[ni]);
  }
  if (failures.length === 0) {
    console.log("GTB perf static: " + passed + " passed");
    return 0;
  }
  console.log("");
  for (var fi2 = 0; fi2 < failures.length; fi2++) {
    var f = failures[fi2];
    console.log("FAIL [" + f.section + "] " + f.name);
    console.log("  expected: " + f.expected);
    console.log("  actual:   " + f.actual);
  }
  console.log("");
  console.log("GTB perf static: FAILED (" + failures.length + " failed, " + passed + " passed)");
  return 1;
}

process.exit(summary());
