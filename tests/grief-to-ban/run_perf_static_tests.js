#!/usr/bin/env node
"use strict";

// GriefToBan . main.js 源码级红线（0.1.4 事件驱动架构）
//
// 背景（用户 2026-11-12 报「启用 Grief to Ban 后进地图编辑器加载很久、长时间未响应」，随后又嫌「每秒全图扫描」）：
//   1) seqGet() 老写法先试 seq.get(i)，但 v160 的 mindustry.entities.EntityGroup 没有 get(int)
//      （EntityGroup.java:231/235 只有 index(int)/size()）⇒ 每个方块抛一次 TypeError 再被 catch，
//      大图 8311 方块 × 每秒多遍扫描 ≈ 每秒上万次异常。seqGet 必须先走 index(i)，循环里直接 arr.index(i)。
//   2) v0.1.3 曾把三遍全图扫描合并成「每秒一遍」的 scanWorld；v0.1.4 进一步换成三层结构：
//      ① 世界载入 seedWatch() 一次性播种；
//      ② 事件增量：onBuildEnd / onConfig 里 watchAdd()，BlockDestroyEvent → onBuildDestroy() → watchDrop()；
//      ③ 每 tick sweepWorld() 只登记 GTB_SWEEP.per = 64 个方块（滚动兜底），
//         每秒 watchStep(now) 只遍历 GTB_WATCH.react / .gen / .logic 三张登记表。
//      scanWorld() 应已整个删除；watchStep() 里一次 Groups.build 都不许有（那就是又回到全图）。
//   3) 地图编辑器（Rules.editor，Rules.java:51）里整套逻辑不跑：tick / onBuildEnd / onConfig 开头早退。
//   4) 名单每次变更就 autosave settings.bin ⇒ 主线程磁盘 I/O；改成脏标记 + tick 里节流落盘。
//   5) 一轮最多处置 GTB_PUNISH.max 个建造者，防一次性几十次 autosave/广播。
//   6) dbg() 每行一次 open/append/close ⇒ 改成内存缓冲 + dbgFlush() 批量落盘。
//
// 这里只读源码文本做断言（不执行 main.js，它依赖 Java/Rhino 运行时），所以能在纯 Node 里跑。
// 零依赖；不改 GriefToBan/ 下任何文件。
// 运行：node tests/grief-to-ban/run_perf_static_tests.js
// 全绿：打印 "GTB perf static: N passed" 并 exit 0；失败：打印期望/实际（含行号）+ exit 1。
// GTB_MAIN_JS=/path/to/main.js 可指向副本（只为验证红线真的会红）。

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

// 从 startIdx 之后第一个 "{" 开始做花括号配对（用于取匿名回调体，如 WorldLoadEvent 的 function () {...}）。
function blockAt(text, startIdx) {
  var braceStart = text.indexOf("{", startIdx);
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
          startLine: lineAt(text, braceStart),
          endLine: lineAt(text, i),
        };
      }
    }
  }
  return null;
}

// "var NAME = { ... };" 的声明体（用于检查常量表字段是否被偷偷改小）。
function declaration(text, name) {
  var at = text.indexOf("var " + name + " = {");
  if (at < 0) return null;
  var end = text.indexOf("};", at);
  if (end < 0) return null;
  return { body: text.slice(at, end + 2), index: at };
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

function bodyWhere(fn, offset) {
  return fn == null ? "未出现" : where(clean, clean.indexOf(fn.body) + offset);
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
  "seqGet", "seqIter", "seqEach",
  "watchKind", "watchAdd", "watchDrop", "watchCount", "watchLive",
  "seedWatch", "sweepWorld", "watchStep",
  "tick", "onBuildEnd", "onConfig", "onBuildDestroy", "bindEvents", "stepLogic",
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

// ================================================================ 2. 事件驱动 + 滚动兜底（v0.1.4）
// 用户嫌「每秒全图扫描」：现在只有世界载入那一次全图（seedWatch），平时靠建造/配置/拆除事件
// 增量维护登记表，再每 tick 滚动登记 64 个兜底；每秒只遍历登记表里的 100~200 个方块。
section("事件驱动 + 滚动兜底");

// --- 2.0 scanWorld 彻底消失（含注释：留着注释容易被下一个人当成还能用的入口）
(function () {
  var hits = occurrences(src, "scanWorld");
  ok(
    "scanWorld 已彻底删除",
    hits.length === 0,
    "v0.1.4 不该再有 scanWorld（连注释都不留）：全图遍历换成 seedWatch 一次 + sweepWorld 每 tick 64 个 + watchStep 只走登记表",
    hits.length === 0 ? "0 处" : "仍有 " + hits.length + " 处，首个 " + where(src, hits[0])
  );
})();

// --- 2.1 三层结构的三张表
var WATCH_DECL = declaration(clean, "GTB_WATCH");
ok(
  "GTB_WATCH 是三张登记表",
  WATCH_DECL != null &&
    /react:\s*\{\}/.test(WATCH_DECL.body) &&
    /gen:\s*\{\}/.test(WATCH_DECL.body) &&
    /logic:\s*\{\}/.test(WATCH_DECL.body),
  "var GTB_WATCH = { react: {}, gen: {}, logic: {} }（钍堆 / 爆混发电机 / 逻辑块）",
  WATCH_DECL == null ? "没找到 var GTB_WATCH = {" : WATCH_DECL.body.replace(/\s+/g, " ")
);
var SWEEP_DECL = declaration(clean, "GTB_SWEEP");
ok(
  "GTB_SWEEP 每 tick 只走 64 个",
  SWEEP_DECL != null &&
    /i:\s*0/.test(SWEEP_DECL.body) &&
    /per:\s*64/.test(SWEEP_DECL.body) &&
    /rounds:\s*0/.test(SWEEP_DECL.body),
  "var GTB_SWEEP = { i: 0, per: 64, rounds: 0 }（滚动兜底的游标/步长）",
  SWEEP_DECL == null ? "没找到 var GTB_SWEEP = {" : SWEEP_DECL.body.replace(/\s+/g, " ")
);
var PERF_DECL = declaration(clean, "GTB_PERF");
ok(
  "GTB_PERF 记录 sweep/watch 指标",
  PERF_DECL != null &&
    /scan:/.test(PERF_DECL.body) &&
    /worst:/.test(PERF_DECL.body) &&
    /builds:/.test(PERF_DECL.body) &&
    /sweep:/.test(PERF_DECL.body) &&
    /sweepWorst:/.test(PERF_DECL.body) &&
    /watch:/.test(PERF_DECL.body),
  "var GTB_PERF = { scan, worst, builds, sweep, sweepWorst, watch }（心跳里看每轮真实开销与登记表大小）",
  PERF_DECL == null ? "没找到 var GTB_PERF = {" : PERF_DECL.body.replace(/\s+/g, " ")
);

// --- 2.2 watchStep：每秒只遍历登记表，不许碰 Groups.build
ok(
  "watchStep 存在",
  F.watchStep != null,
  "每秒只检查登记表：function watchStep(now)",
  F.watchStep == null ? "没找到 function watchStep(" : fnLabel(F.watchStep)
);
(function () {
  var hits = occurrences(F.watchStep ? F.watchStep.body : "", "Groups.build");
  ok(
    "watchStep 里没有 Groups.build",
    F.watchStep != null && hits.length === 0,
    "每秒检查绝不能全图：watchStep 只遍历 GTB_WATCH.react / .gen / .logic，一次 Groups.build 都不许出现",
    F.watchStep == null
      ? "(函数不存在)"
      : hits.length === 0
        ? "0 次"
        : "出现 " + hits.length + " 次，首个 " + bodyWhere(F.watchStep, hits[0])
  );
})();
var WATCH_TABLES = [
  ["react", "钍堆"],
  ["gen", "爆混发电机"],
  ["logic", "自复制逻辑"],
];
for (var wi = 0; wi < WATCH_TABLES.length; wi++) {
  var kind = WATCH_TABLES[wi][0];
  var kindDesc = WATCH_TABLES[wi][1];
  var forIn = new RegExp("for\\s*\\(\\s*\\w+\\s+in\\s+GTB_WATCH\\." + kind + "\\s*\\)");
  ok(
    "watchStep 遍历 GTB_WATCH." + kind + "（" + kindDesc + "）",
    F.watchStep != null && forIn.test(F.watchStep.body),
    "watchStep 里 for (key in GTB_WATCH." + kind + ") —— 每秒只走这一张表（" + kindDesc + "）",
    F.watchStep == null ? "(函数不存在)" : "没找到 for (… in GTB_WATCH." + kind + ")（" + fnLabel(F.watchStep) + "）"
  );
}
ok(
  "watchStep 用 watchLive 校验登记项",
  inBody(F.watchStep, "watchLive("),
  "遍历登记表时先 watchLive(ref, key)（isValid() 为假就 watchDrop），避免对已拆方块空转",
  "watchStep 里没调 watchLive(（" + fnLabel(F.watchStep) + "）"
);
var STEP_CALLS = [
  ["stepReactor(", "钍堆热量"],
  ["stepGen(", "爆混发电机"],
  ["stepLogic(", "自复制逻辑"],
];
for (var si = 0; si < STEP_CALLS.length; si++) {
  var stepName = STEP_CALLS[si][0];
  ok(
    "watchStep 调 " + stepName,
    inBody(F.watchStep, stepName),
    "登记表里的" + STEP_CALLS[si][1] + "由 watchStep 每秒调 " + stepName + " 检查",
    "watchStep 里找不到 " + stepName + "（" + fnLabel(F.watchStep) + "）"
  );
}
ok(
  "watchStep 记录 GTB_PERF.scan / worst / watch",
  inBody(F.watchStep, "GTB_PERF.scan") &&
    inBody(F.watchStep, "GTB_PERF.worst") &&
    inBody(F.watchStep, "GTB_PERF.watch"),
  "watchStep 用 nowNanos() 记 GTB_PERF.scan / worst，并刷新 GTB_PERF.watch = watchCount()（心跳里能看出登记表多大）",
  "GTB_PERF.scan=" + inBody(F.watchStep, "GTB_PERF.scan") +
    "，GTB_PERF.worst=" + inBody(F.watchStep, "GTB_PERF.worst") +
    "，GTB_PERF.watch=" + inBody(F.watchStep, "GTB_PERF.watch")
);

// --- 2.3 sweepWorld：每 tick 只滚动登记 64 个
ok(
  "sweepWorld 存在",
  F.sweepWorld != null,
  "滚动兜底：function sweepWorld()（每 tick 只登记 GTB_SWEEP.per 个方块）",
  F.sweepWorld == null ? "没找到 function sweepWorld(" : fnLabel(F.sweepWorld)
);
(function () {
  var hits = occurrences(F.sweepWorld ? F.sweepWorld.body : "", "Packages.mindustry.gen.Groups.build");
  ok(
    "sweepWorld 里只取一次 Groups.build",
    F.sweepWorld != null && hits.length === 1,
    "滚动兜底每 tick 取一次 Groups.build，只看 GTB_SWEEP.i 起的 64 个（不是整张表都遍历）",
    F.sweepWorld == null
      ? "(函数不存在)"
      : "出现 " + hits.length + " 次" + (hits.length ? "，首个 " + bodyWhere(F.sweepWorld, hits[0]) : "")
  );
})();
ok(
  "sweepWorld 用 GTB_SWEEP.per 限量",
  inBody(F.sweepWorld, "GTB_SWEEP.per"),
  "步长来自 GTB_SWEEP.per（= 64），别写成硬编码大数或一次扫完",
  "sweepWorld 里没引用 GTB_SWEEP.per（" + fnLabel(F.sweepWorld) + "）"
);
ok(
  "sweepWorld 滚动推进 GTB_SWEEP.i",
  inBody(F.sweepWorld, "GTB_SWEEP.i = end") && inBody(F.sweepWorld, "GTB_SWEEP.i >= n"),
  "游标推进 GTB_SWEEP.i = end >= n ? 0 : end，并在 GTB_SWEEP.i >= n 时回到 0（÷ 轮次计数）",
  "GTB_SWEEP.i = end 或 GTB_SWEEP.i >= n 缺失（" + fnLabel(F.sweepWorld) + "）"
);
ok(
  "sweepWorld 记录 GTB_PERF.sweep / sweepWorst",
  inBody(F.sweepWorld, "GTB_PERF.sweep") && inBody(F.sweepWorld, "GTB_PERF.sweepWorst"),
  "sweepWorld 记 GTB_PERF.sweep 与 sweepWorst（单 tick 兜底开销应 < 0.05ms）",
  "GTB_PERF.sweep=" + inBody(F.sweepWorld, "GTB_PERF.sweep") +
    "，sweepWorst=" + inBody(F.sweepWorld, "GTB_PERF.sweepWorst")
);

// --- 2.4 seedWatch：世界载入一次性播种
ok(
  "seedWatch 存在",
  F.seedWatch != null,
  "世界载入播种：function seedWatch()（全图只在这次过一遍）",
  F.seedWatch == null ? "没找到 function seedWatch(" : fnLabel(F.seedWatch)
);
ok(
  "seedWatch 里读 Groups.build",
  inBody(F.seedWatch, "Packages.mindustry.gen.Groups.build"),
  "seedWatch 需要一次全图播种：arr = Packages.mindustry.gen.Groups.build",
  "seedWatch 里找不到 Groups.build（" + fnLabel(F.seedWatch) + "）"
);
ok(
  "seedWatch 重置 GTB_WATCH",
  inBody(F.seedWatch, "GTB_WATCH = {"),
  "播种前先 GTB_WATCH = { react: {}, gen: {}, logic: {} }，换图不残留上一张图的引用",
  "seedWatch 里没重置 GTB_WATCH（" + fnLabel(F.seedWatch) + "）"
);
ok(
  "seedWatch 用 arr.index(i) 而不是 seqGet",
  inBody(F.seedWatch, "arr.index(i)") && !inBody(F.seedWatch, "seqGet("),
  "全图播种也走 arr.index(i)（seqGet 有多级 try，8311 次调用会慢）",
  "arr.index(i)=" + inBody(F.seedWatch, "arr.index(i)") + "，seqGet=" + inBody(F.seedWatch, "seqGet(")
);

// --- 2.5 tick：每 tick 滚动兜底 + 每秒遍历登记表（不再有任何全图）
(function () {
  var sweepCalls = occurrences(F.tick ? F.tick.body : "", "sweepWorld()");
  ok(
    "tick 里 sweepWorld() 恰好 1 次",
    F.tick != null && sweepCalls.length === 1,
    "每 tick 都滚动登记 64 个：tick 里 try { sweepWorld(); } 只调一次",
    F.tick == null ? "(函数不存在)" : "出现 " + sweepCalls.length + " 次（" + fnLabel(F.tick) + "）"
  );
})();
(function () {
  var wsCalls = occurrences(F.tick ? F.tick.body : "", "watchStep(");
  ok(
    "tick 里 watchStep( 恰好 1 次",
    F.tick != null && wsCalls.length === 1,
    "每秒一轮只调 watchStep(now) 一次（别在 tick / 其它事件里重复遍历登记表）",
    F.tick == null ? "(函数不存在)" : "出现 " + wsCalls.length + " 次（" + fnLabel(F.tick) + "）"
  );
})();
ok(
  "tick 里没有 scanWorld",
  F.tick != null && occurrences(F.tick.body, "scanWorld").length === 0,
  "tick 不该再调 scanWorld（v0.1.3 的每秒全图入口）",
  F.tick == null ? "(函数不存在)" : "仍有 " + occurrences(F.tick.body, "scanWorld").length + " 处（" + fnLabel(F.tick) + "）"
);
(function () {
  var pSweep = bodyPos(F.tick, "sweepWorld()");
  var pPerSec = bodyPos(F.tick, "now - GTB.lastScan >= 1000");
  ok(
    "sweepWorld 在每秒块之前（每 tick 都跑）",
    pSweep >= 0 && pPerSec >= 0 && pSweep < pPerSec,
    "滚动兜底必须每 tick 跑（不跟 1 秒节流），位置在 if (now - GTB.lastScan >= 1000) 之前",
    "sweepWorld 位置=" + pSweep + "，1 秒块位置=" + pPerSec + "（" + fnLabel(F.tick) + "）"
  );
})();
(function () {
  var pPerSec = bodyPos(F.tick, "now - GTB.lastScan >= 1000");
  var pWatch = bodyPos(F.tick, "watchStep(");
  ok(
    "watchStep 在每秒块之内",
    pPerSec >= 0 && pWatch >= 0 && pWatch > pPerSec,
    "每秒只遍历登记表一次：watchStep(now) 必须在 if (now - GTB.lastScan >= 1000) { … } 里面",
    "1 秒块位置=" + pPerSec + "，watchStep 位置=" + pWatch + "（" + fnLabel(F.tick) + "）"
  );
})();

// --- 2.6 事件增量：建造/配置登记，拆除注销
ok(
  "bindEvents 绑定 BlockDestroyEvent → onBuildDestroy",
  inBody(F.bindEvents, "ET.BlockDestroyEvent") && inBody(F.bindEvents, "onBuildDestroy(e)"),
  "Events.on(ET.BlockDestroyEvent, function (e) { try { onBuildDestroy(e); } catch (err) { } });",
  "bindEvents 里缺 BlockDestroyEvent 绑定或 onBuildDestroy(e)（" + fnLabel(F.bindEvents) + "）"
);
ok(
  "onBuildEnd 里 watchAdd(",
  inBody(F.onBuildEnd, "watchAdd("),
  "新方块建成即登记：onBuildEnd 里 var wk = watchAdd(b, bk)（只有钍堆/爆混机/逻辑块入表）",
  "onBuildEnd 里没调 watchAdd(（" + fnLabel(F.onBuildEnd) + "）"
);
ok(
  "onConfig 里 watchAdd(",
  inBody(F.onConfig, "watchAdd("),
  "配置变化也续登记：onConfig 里 try { watchAdd(b, tileKey(e.tile)); }（逻辑块改代码 / 发电机塞爆混）",
  "onConfig 里没调 watchAdd(（" + fnLabel(F.onConfig) + "）"
);
ok(
  "onBuildDestroy 里 watchDrop(tileKey(",
  inBody(F.onBuildDestroy, "watchDrop(tileKey("),
  "拆方块即注销：onBuildDestroy 里 watchDrop(tileKey(t))",
  "onBuildDestroy 里没调 watchDrop(tileKey(（" + fnLabel(F.onBuildDestroy) + "）"
);

// --- 2.7 watchDrop 必须清掉全部派生表（只涨不消比全图扫描更糟）
(function () {
  var DROP_TABLES = [
    ["delete GTB_WATCH.react[key]", "GTB_WATCH.react"],
    ["delete GTB_WATCH.gen[key]", "GTB_WATCH.gen"],
    ["delete GTB_WATCH.logic[key]", "GTB_WATCH.logic"],
    ["delete GTB_REACTORS[key]", "GTB_REACTORS"],
    ["delete GTB_GENS[key]", "GTB_GENS"],
    ["delete GTB_VIRUS[key]", "GTB_VIRUS"],
    ["delete GTB.builders[key]", "GTB.builders"],
  ];
  var missing = [];
  for (var di = 0; di < DROP_TABLES.length; di++) {
    if (!inBody(F.watchDrop, DROP_TABLES[di][0])) missing.push(DROP_TABLES[di][1]);
  }
  ok(
    "watchDrop 清掉三张登记表 + 四张派生表",
    F.watchDrop != null && missing.length === 0,
    "watchDrop(key) 要 delete：GTB_WATCH.react/gen/logic、GTB_REACTORS、GTB_GENS、GTB_VIRUS、GTB.builders（表只涨不消是回归）",
    F.watchDrop == null ? "(函数不存在)" : (missing.length === 0 ? "7 张表都清了" : "漏清：" + missing.join("、"))
  );
})();

// --- 2.8 世界载入：重置 + 只播种一次
(function () {
  var at = clean.indexOf("ET.WorldLoadEvent");
  var wl = at >= 0 ? blockAt(clean, at) : null;
  var seeds = occurrences(wl ? wl.body : "", "seedWatch(");
  ok(
    "WorldLoadEvent 回调里 seedWatch() 恰好 1 次",
    wl != null && seeds.length === 1,
    "全图只在这里过一遍：WorldLoadEvent 回调里 var seeded = 0; try { seeded = seedWatch(); }",
    wl == null
      ? "bindEvents 里没找到 ET.WorldLoadEvent"
      : "seedWatch( 出现 " + seeds.length + " 次（" + where(clean, at) + " 起的回调体）"
  );
  ok(
    "WorldLoad 重置 GTB_WATCH / GTB_SWEEP.i",
    wl != null && wl.body.indexOf("GTB_WATCH = {") >= 0 && wl.body.indexOf("GTB_SWEEP.i = 0") >= 0,
    "换图先清空 GTB_WATCH 与 GTB_SWEEP.i/rounds，避免沿用上一张图（旧世界）的方块引用",
    wl == null
      ? "(回调不存在)"
      : "GTB_WATCH 重置=" + (wl.body.indexOf("GTB_WATCH = {") >= 0) +
        "，GTB_SWEEP.i 重置=" + (wl.body.indexOf("GTB_SWEEP.i = 0") >= 0)
  );
})();

// --- 2.9 登记表自身的正确性
ok(
  "watchKind 把三类方块分到 react/gen/logic",
  inBody(F.watchKind, '"thorium-reactor") return "react"') &&
    inBody(F.watchKind, 'isBlastGenName(name)) return "gen"') &&
    inBody(F.watchKind, 'isLogicBuild(b)) return "logic"'),
  'watchKind(b)：thorium-reactor → "react"，isBlastGenName → "gen"，isLogicBuild → "logic"，其余返回 ""',
  "watchKind 的三条分类缺失（" + fnLabel(F.watchKind) + "）"
);
ok(
  "watchAdd 写进 GTB_WATCH[kind][key]",
  inBody(F.watchAdd, "GTB_WATCH[kind][key] = b"),
  "登记表只存这三类：GTB_WATCH[kind][key] = b（kind 为空直接返回空串）",
  "watchAdd 里没写 GTB_WATCH[kind][key]（" + fnLabel(F.watchAdd) + "）"
);
ok(
  "watchLive 用 isValid() 校验并 watchDrop",
  inBody(F.watchLive, "ref.isValid()") && inBody(F.watchLive, "watchDrop(key)"),
  "登记项可能已被拆（事件漏了 / 换了图）：watchLive 里 try { ok = ref.isValid() === true }，为假就 watchDrop",
  "watchLive 缺 isValid() 校验或 watchDrop（" + fnLabel(F.watchLive) + "）"
);
ok(
  "watchCount 统计三张表",
  inBody(F.watchCount, "GTB_WATCH.react") &&
    inBody(F.watchCount, "GTB_WATCH.gen") &&
    inBody(F.watchCount, "GTB_WATCH.logic"),
  "watchCount() 三个 for-in 累加（心跳里的 watch=N 就是这个数）",
  "watchCount 里没统计全三张表（" + fnLabel(F.watchCount) + "）"
);
(function () {
  var pVirus = bodyPos(F.stepLogic, "isVirusCode(");
  var pStat = bodyPos(F.stepLogic, "GTB.stat.virus");
  ok(
    "stepLogic 先判 isVirusCode 并清旧标记",
    pVirus >= 0 && pStat >= 0 && pVirus < pStat && inBody(F.stepLogic, "delete GTB_VIRUS[key]"),
    "stepLogic 里代码不匹配 isVirusCode 就 delete GTB_VIRUS[key] 并 return（否则改干净后再注入不再报、且会白算 virus 计数）",
    "isVirusCode 位置=" + pVirus + "，GTB.stat.virus 位置=" + pStat +
      "，delete GTB_VIRUS=" + inBody(F.stepLogic, "delete GTB_VIRUS[key]")
  );
})();

// --- 2.10 心跳/诊断行（真机排查靠它）
ok(
  "心跳行带 scan=NNms worst=NNms",
  inBody(F.tick, '" scan=" + Math.round(GTB_PERF.scan) + "ms worst="') ||
    clean.indexOf('" scan=" + Math.round(GTB_PERF.scan) + "ms worst="') >= 0,
  'dbg 心跳行含 " scan=NNms worst=NNms"（真机排查靠这一行）',
  "心跳行里没有 scan=/worst= 片段（" + fnLabel(F.tick) + "）"
);
ok(
  "心跳行带 watch=N sweep=NNms",
  inBody(F.tick, '" watch=" + GTB_PERF.watch') &&
    clean.indexOf('" sweep=" + Math.round(GTB_PERF.sweepWorst * 1000) / 1000') >= 0,
  'dbg 心跳行含 " watch=N"（登记表大小）与 " sweep=NNms"（滚动兜底最坏开销）',
  '心跳行里缺 " watch=" + GTB_PERF.watch 或 " sweep=" 片段（' + fnLabel(F.tick) + "）"
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
  var early = bodyPos(F.tick, "if (inEditor()) return;");
  var sweep = bodyPos(F.tick, "sweepWorld()");
  var watch = bodyPos(F.tick, "watchStep(");
  ok(
    "tick 的编辑器早退在 sweepWorld / watchStep 之前",
    early >= 0 && sweep >= 0 && watch >= 0 && early < sweep && early < watch,
    "先 inEditor() 早退，再谈兜底登记与每秒遍历（否则编辑器里照样动登记表和世界）",
    "inEditor 位置=" + early + "，sweepWorld 位置=" + sweep + "，watchStep 位置=" + watch
  );
})();
(function () {
  var a = bodyPos(F.tick, "flushSettings(");
  var b = bodyPos(F.tick, "if (inEditor()) return;");
  ok(
    "tick 里落盘在编辑器早退之前",
    a >= 0 && b >= 0 && a < b,
    "编辑器里改设置也得存得住：dbgFlush/flushSettings 放在 inEditor 早退之前，只是不碰世界",
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
  clean.indexOf("(inEditor() ? 1 : 0)") >= 0 && /dbg\("world loaded "/.test(clean),
  '心跳行 " editor=" + (inEditor() ? 1 : 0) 与 WorldLoad 的 editor=1 提示（排查用）',
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
var hotFns = ["tick", "sweepWorld", "watchStep", "seedWatch", "swrite", "dbg", "dbgFlush"];
var hotOffenders = [];
for (var hi = 0; hi < hotFns.length; hi++) {
  if (inBody(F[hotFns[hi]], AUTO)) hotOffenders.push(hotFns[hi]);
}
ok(
  "热路径函数里没有 autosave",
  hotOffenders.length === 0,
  "tick / sweepWorld / watchStep / seedWatch / swrite / dbg / dbgFlush 里一次都不能出现 Core.settings.autosave()",
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
