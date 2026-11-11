#!/usr/bin/env node
"use strict";

// GriefToBan . gtb-lib.js 纯逻辑层测试
// 零依赖：只用 node 内置能力；不加载 Java、不跑游戏、不联网。
// 运行：node tests/grief-to-ban/run_lib_tests.js
// 全绿：打印 "GTB lib tests: N passed" 并 exit 0；任一失败：打印期望/实际 + exit 1。

const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const LIB_FILE = path.join(ROOT, "GriefToBan", "scripts", "gtb-lib.js");

let L = null;
try {
  L = require(LIB_FILE);
} catch (err) {
  console.log("GTB lib tests: FAILED to load " + LIB_FILE);
  console.log("  " + String(err && err.message ? err.message : err));
  process.exit(1);
}

let passed = 0;
const failures = [];
const stats = Object.create(null);
let sectionName = "(root)";

function sec(name) {
  sectionName = name;
  if (!stats[name]) stats[name] = { passed: 0, failed: 0 };
}

function bucket() {
  if (!stats[sectionName]) stats[sectionName] = { passed: 0, failed: 0 };
  return stats[sectionName];
}

function repr(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
  if (typeof v === "number" && !isFinite(v)) return String(v);
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch (e) {
    return String(v);
  }
}

function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number" && isNaN(a) && isNaN(b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq(a[k], b[k])) return false;
  }
  return true;
}

function eq(name, actual, expected) {
  if (deepEq(actual, expected)) {
    passed++;
    bucket().passed++;
    return true;
  }
  failures.push({ section: sectionName, name: name, expected: repr(expected), actual: repr(actual) });
  bucket().failed++;
  return false;
}

function ok(name, cond, actual) {
  if (cond) {
    passed++;
    bucket().passed++;
    return true;
  }
  failures.push({
    section: sectionName,
    name: name,
    expected: "truthy",
    actual: actual === undefined ? "falsy" : repr(actual)
  });
  bucket().failed++;
  return false;
}

function contains(name, haystack, needle) {
  const h = haystack == null ? "" : String(haystack);
  ok(name, h.indexOf(needle) >= 0, h);
}

function notContains(name, haystack, needle) {
  const h = haystack == null ? "" : String(haystack);
  ok(name, h.indexOf(needle) < 0, h);
}

// ================================================================ 字符串
sec("字符串: trimStr / lower / stripTags / safeName / shortId");

eq("trimStr(null) -> ''", L.trimStr(null), "");
eq("trimStr(undefined) -> ''", L.trimStr(undefined), "");
eq("trimStr('  a b  ') -> 'a b'", L.trimStr("  a b  "), "a b");
eq("trimStr 裁掉 tab/CR/LF", L.trimStr("\t\r\n x \n\r\t"), "x");
eq("trimStr('') -> ''", L.trimStr(""), "");
eq("trimStr 只认 ASCII 空白（全角空格保留）", L.trimStr("\u3000a\u3000"), "\u3000a\u3000");
eq("trimStr(123) -> '123'", L.trimStr(123), "123");

eq("lower(null) -> ''", L.lower(null), "");
eq("lower('AbC-1') -> 'abc-1'", L.lower("AbC-1"), "abc-1");
eq("lower 只折 ASCII 大写（ÄÖ 不变）", L.lower("ÄÖ"), "ÄÖ");

eq("stripTags(null) -> ''", L.stripTags(null), "");
eq("stripTags('[scarlet]名字[white]') -> '名字'", L.stripTags("[scarlet]名字[white]"), "名字");
eq("stripTags 无标签原样返回", L.stripTags("no tags"), "no tags");
eq("stripTags 未闭合的 [ 保留", L.stripTags("[scarlet"), "[scarlet");
eq("stripTags 中段标签被吃掉", L.stripTags("a[b]c"), "ac");
eq("stripTags 内层未闭合时保留原文", L.stripTags("[a[b]c]"), "[ac]");
const longTag = "[" + "x".repeat(29) + "]tail";
eq("stripTags 超过 24 字符的标签不吞（原样保留）", L.stripTags(longTag), longTag);

eq("safeName(null) -> '?'", L.safeName(null), "?");
eq("safeName 全空白 -> '?'", L.safeName("   "), "?");
eq("safeName 去颜色标签", L.safeName("[scarlet]Bob[white]"), "Bob");
eq("safeName 未闭合 [ -> (", L.safeName("a[b"), "a(b");
eq("safeName ] -> )", L.safeName("x]y"), "x)y");
eq("safeName 只有标签 -> '?'", L.safeName("[scarlet]"), "?");
const longSafe = L.safeName("x".repeat(40));
eq("safeName 超长 -> 32 字 + 省略号（长度 33）", longSafe.length, 33);
eq("safeName 超长 -> 前 32 字 + 省略号", longSafe, "x".repeat(32) + "…");
eq("safeName 恰好 32 字不截断", L.safeName("y".repeat(32)), "y".repeat(32));

eq("shortId 十位取前 8 位", L.shortId("1234567890"), "12345678");
eq("shortId 不足 8 位原样", L.shortId("abc"), "abc");
eq("shortId(null) -> ''", L.shortId(null), "");

// ================================================================ 数字
sec("数字: toInt / clampInt / toNum");

eq("toInt('12.5') -> 13（四舍五入）", L.toInt("12.5", 0), 13);
eq("toInt('abc') -> def", L.toInt("abc", 7), 7);
eq("toInt(NaN) -> def", L.toInt(NaN, 7), 7);
eq("toInt(Infinity) -> def", L.toInt(Infinity, 7), 7);
eq("toInt(-Infinity) -> def", L.toInt(-Infinity, 7), 7);
eq("toInt('') -> 0（Number('')===0）", L.toInt("", 3), 0);
eq("toInt('-4.5') -> -4（Math.round 向 +∞ 取整）", L.toInt("-4.5", 0), -4);

eq("clampInt 超上界被压到 hi", L.clampInt("999", 3, 500, 20), 500);
eq("clampInt 超下界被抬到 lo", L.clampInt(-5, 3, 500, 20), 3);
eq("clampInt 非法 -> def", L.clampInt("abc", 3, 500, 20), 20);
eq("clampInt 区间内原值", L.clampInt("42", 3, 500, 20), 42);

eq("toNum('1.5') -> 1.5", L.toNum("1.5", 0), 1.5);
eq("toNum 非法 -> def", L.toNum("x", 9), 9);
eq("toNum(Infinity) -> def", L.toNum(Infinity, 9), 9);
eq("toNum('') -> 0", L.toNum("", 9), 0);

// ================================================================ 名单
sec("名单: parseJsonArray / dumpJsonArray / findIndex / addEntry / removeEntry / entryLine / watchLine");

eq("parseJsonArray(null) -> []", L.parseJsonArray(null), []);
eq("parseJsonArray('') -> []", L.parseJsonArray(""), []);
eq("parseJsonArray 非法 JSON -> []", L.parseJsonArray("not json {"), []);
eq("parseJsonArray 非数组（对象）-> []", L.parseJsonArray('{"uuid":"a"}'), []);
eq("parseJsonArray 非数组（数字）-> []", L.parseJsonArray("123"), []);
eq("parseJsonArray 非数组（字符串）-> []", L.parseJsonArray('"abc"'), []);
const parsedList = L.parseJsonArray(
  '[{"uuid":"a","name":"A"},{"name":"no-uuid"},null,{"uuid":"   "},"str",{"uuid":"b"}]'
);
eq("parseJsonArray 丢掉缺 uuid / 非对象条目", parsedList.length, 2);
eq("parseJsonArray 保留合法条目顺序", [parsedList[0].uuid, parsedList[1].uuid], ["a", "b"]);

eq("dumpJsonArray(null) -> '[]'", L.dumpJsonArray(null), "[]");
eq("dumpJsonArray([]) -> '[]'", L.dumpJsonArray([]), "[]");
eq("dumpJsonArray 序列化", L.dumpJsonArray([{ uuid: "a" }]), '[{"uuid":"a"}]');

const listAB = [{ uuid: "a", name: "A" }, { uuid: "b", name: "B" }];
eq("findIndex 命中第二条", L.findIndex(listAB, "b"), 1);
eq("findIndex 未命中 -> -1", L.findIndex(listAB, "zzz"), -1);
eq("findIndex(null 列表) -> -1", L.findIndex(null, "a"), -1);
eq("findIndex(null uuid) -> -1", L.findIndex(listAB, null), -1);
eq("findIndex 比较前 trim uuid", L.findIndex([{ uuid: " x " }], "x"), 0);
eq("findEntry 命中返回条目对象", L.findEntry(listAB, "a"), { uuid: "a", name: "A" });
eq("findEntry 未命中 -> null", L.findEntry(listAB, "zzz"), null);

const addSame = L.addEntry(listAB, { uuid: "a", name: "A2", reason: "cheat", at: 1000 });
eq("addEntry 同 uuid 覆盖（条数不变）", addSame.length, 2);
eq("addEntry 同 uuid 移到末尾", addSame[addSame.length - 1].name, "A2");
eq("addEntry 同 uuid 不重复", addSame.filter(function (e) { return e.uuid === "a"; }).length, 1);
eq("addEntry 不改入参（内容）", listAB, [{ uuid: "a", name: "A" }, { uuid: "b", name: "B" }]);
ok("addEntry 不改入参（返回新数组）", addSame !== listAB, addSame === listAB);

const addUuidTrim = L.addEntry([], { uuid: "  zz  ", name: "Z", reason: 1, at: "42" });
eq("addEntry 新建条目形状", addUuidTrim, [{ uuid: "zz", name: "Z", reason: "1", at: 42 }]);
const addBy = L.addEntry([], { uuid: "q", by: "admin" });
eq("addEntry 有 by 才保留 by", Object.prototype.hasOwnProperty.call(addBy[0], "by"), true);
eq("addEntry by 值转字符串", addBy[0].by, "admin");
eq("addEntry 默认 name/reason 为空串", [addBy[0].name, addBy[0].reason], ["", ""]);
const copied = L.addEntry(listAB, { uuid: "" });
eq("addEntry uuid 空 -> 原样拷贝内容", copied, listAB);
ok("addEntry uuid 空 -> 新数组", copied !== listAB, copied === listAB);
eq("addEntry(null, 非法 entry) -> []", L.addEntry(null, { uuid: "" }), []);
eq("addEntry(null, 合法 entry) -> 单条", L.addEntry(null, { uuid: "n" }).length, 1);

eq("removeEntry 删除指定 uuid", L.removeEntry(listAB, "a"), [{ uuid: "b", name: "B" }]);
eq("removeEntry 不存在则原样", L.removeEntry(listAB, "zzz"), listAB);
eq("removeEntry(null) -> []", L.removeEntry(null, "a"), []);
eq("removeEntry uuid 两侧空白也能删", L.removeEntry(listAB, " a "), [{ uuid: "b", name: "B" }]);

const TS = new Date(2024, 4, 6, 7, 8, 0, 0).getTime();
eq("fmtDate 午夜时间戳给 entryLine/watchLine 用", L.fmtDate(TS), "2024-05-06 07:08");
eq(
  "entryLine 完整：名字 + shortId + reason + 日期",
  L.entryLine({ uuid: "1234567890", name: "[scarlet]Bob", reason: "cheat", at: TS }),
  "Bob [gray](12345678) · cheat · 2024-05-06 07:08"
);
eq(
  "entryLine 无 reason/at 只有名字与 id",
  L.entryLine({ uuid: "1234567890", name: "Bob" }),
  "Bob [gray](12345678)"
);
eq(
  "entryLine 空白 reason 不追加",
  L.entryLine({ uuid: "abc", name: "Bob", reason: "   " }),
  "Bob [gray](abc)"
);
eq("entryLine(null) -> ''", L.entryLine(null), "");
eq(
  "watchLine 不显示 reason",
  L.watchLine({ uuid: "abcdefghij", name: "Bob", reason: "cheat", at: TS }),
  "Bob [gray](abcdefgh) · 2024-05-06 07:08"
);
eq("watchLine(null) -> ''", L.watchLine(null), "");

// ================================================================ 时间
sec("时间: fmtDate / fmtDuration");

eq("fmtDate(0) -> ''", L.fmtDate(0), "");
eq("fmtDate(null) -> ''", L.fmtDate(null), "");
eq("fmtDate(负数) -> ''", L.fmtDate(-1000), "");
eq("fmtDate 格式化 yyyy-MM-dd HH:mm", L.fmtDate(TS), "2024-05-06 07:08");
eq(
  "fmtDate 个位数补零",
  L.fmtDate(new Date(2024, 0, 2, 3, 4, 0, 0).getTime()),
  "2024-01-02 03:04"
);
eq("fmtDuration(0) -> '0 秒'", L.fmtDuration(0), "0 秒");
eq("fmtDuration(200000) -> '3 分 20 秒'", L.fmtDuration(200000), "3 分 20 秒");
eq("fmtDuration(59000) -> '59 秒'", L.fmtDuration(59000), "59 秒");
eq("fmtDuration(60000) -> '1 分 0 秒'", L.fmtDuration(60000), "1 分 0 秒");
eq("fmtDuration 负数按 0 处理", L.fmtDuration(-5000), "0 秒");
eq("fmtDuration(1500) 向下取整到秒", L.fmtDuration(1500), "1 秒");

// ================================================================ 语言
sec("语言: normLocale / parseLangs / joinLangs / localeInList / langLabel");

eq("normLocale('ZH-CN ') -> 'zh_cn'", L.normLocale("ZH-CN "), "zh_cn");
eq("normLocale(null) -> ''", L.normLocale(null), "");
eq("normLocale 下划线保持", L.normLocale("zh_TW"), "zh_tw");
eq("normLocale('EN') -> 'en'", L.normLocale("EN"), "en");

eq("parseLangs 逗号/分号/空白分隔并归一化", L.parseLangs("zh-CN, en; ja ru"), ["zh_cn", "en", "ja", "ru"]);
eq("parseLangs('') -> []", L.parseLangs(""), []);
eq("parseLangs(null) -> []", L.parseLangs(null), []);
eq("parseLangs 连续分隔符不产生空项", L.parseLangs("zh_cn,,en"), ["zh_cn", "en"]);
eq("parseLangs 首尾空白", L.parseLangs("  zh_cn  "), ["zh_cn"]);

eq("joinLangs 归一化 + 去重", L.joinLangs(["ZH-CN", "en", "zh_cn", ""]), "zh_cn,en");
eq("joinLangs(null) -> ''", L.joinLangs(null), "");
eq("joinLangs([]) -> ''", L.joinLangs([]), "");

eq("localeInList('zh_CN','zh_cn') 命中", L.localeInList("zh_CN", "zh_cn"), true);
eq("localeInList('zh' 对 'zh_cn') 前缀命中", L.localeInList("zh", "zh_cn"), true);
eq("localeInList('zh_cn' 对 'zh') 前缀命中", L.localeInList("zh_cn", "zh"), true);
eq("localeInList('en' 不在 'zh_cn') 不命中", L.localeInList("en", "zh_cn"), false);
eq("localeInList('zh_tw' 对 'zh_cn') 不命中", L.localeInList("zh_tw", "zh_cn"), false);
eq("localeInList 空 locale -> false", L.localeInList("", "zh_cn"), false);
eq("localeInList 多语言列表命中", L.localeInList("en", "zh_cn, en"), true);

eq("langLabel('zh_cn') -> 中文（简体）", L.langLabel("zh_cn"), "中文（简体）");
eq("langLabel('ZH-CN') 归一化后命中", L.langLabel("ZH-CN"), "中文（简体）");
eq("langLabel 未知 -> 归一化原样", L.langLabel("xx-YY"), "xx_yy");
eq("langLabel('') -> '?'", L.langLabel(""), "?");
eq("langLabel(null) -> '?'", L.langLabel(null), "?");
eq("LANGS 第一项是 zh_cn / 中文（简体）", L.LANGS[0], ["zh_cn", "中文（简体）"]);

// ================================================================ 行为开关
sec("行为: parseBehaviors / dumpBehaviors");

const bhAllTrue = { interact: true, virus: true, reactorNear: true, reactorBoom: true, blastGen: true, afk: true };
eq("parseBehaviors('') -> 全默认", L.parseBehaviors(""), bhAllTrue);
eq("parseBehaviors(null) -> 全默认", L.parseBehaviors(null), bhAllTrue);
eq("parseBehaviors 非法 JSON -> 全默认", L.parseBehaviors("garbage"), bhAllTrue);
const bhOff = L.parseBehaviors('{"interact":false}');
eq("parseBehaviors 单项 false", bhOff.interact, false);
eq("parseBehaviors 其它项保持默认", bhOff.virus, true);
eq("parseBehaviors 字符串 'true' 视为 true", L.parseBehaviors('{"interact":"true"}').interact, true);
eq("parseBehaviors 数字 1 视为 true", L.parseBehaviors('{"virus":1}').virus, true);
eq("parseBehaviors 其它字符串视为 false", L.parseBehaviors('{"virus":"yes"}').virus, false);
eq("parseBehaviors 'TRUE'（大写）视为 true", L.parseBehaviors('{"virus":"TRUE"}').virus, true);
const bhUnknown = L.parseBehaviors('{"nope":true,"interact":false}');
eq("parseBehaviors 未知键被忽略", Object.keys(bhUnknown).sort(), L.BH_KEYS.slice().sort());
eq("parseBehaviors 未知键不影响已知键", bhUnknown.interact, false);

const bhDump = L.dumpBehaviors(null);
eq(
  "dumpBehaviors(null) -> 全 true 的 JSON（键序 = BH_KEYS）",
  bhDump,
  '{"interact":true,"virus":true,"reactorNear":true,"reactorBoom":true,"blastGen":true,"afk":true}'
);
eq("dumpBehaviors 只认严格 true（1 不算）", JSON.parse(L.dumpBehaviors({ interact: 1 })).interact, false);
eq(
  "dumpBehaviors/parseBehaviors 往返一致",
  L.dumpBehaviors(L.parseBehaviors(bhDump)),
  bhDump
);
eq(
  "dumpBehaviors/parseBehaviors 往返（单项 false）",
  L.parseBehaviors(L.dumpBehaviors(L.parseBehaviors('{"afk":false}'))).afk,
  false
);

// ================================================================ 判定
sec("判定: targetKind / langHit");

eq("targetKind 管理员永远 skip（即便 ban 模式）", L.targetKind({ langMode: "ban" }, true, true), "skip");
eq("targetKind cfg 为空 -> skip", L.targetKind(null, false, true), "skip");
eq("watch 模式 + 已观察 -> target", L.targetKind({ langMode: "watch", langs: "zh_cn" }, false, true), "target");
eq("watch 模式 + 未观察 -> skip", L.targetKind({ langMode: "watch", langs: "zh_cn" }, false, false), "skip");
eq("ban 模式 -> target（不看是否观察）", L.targetKind({ langMode: "ban", langs: "zh_cn" }, false, false), "target");
eq("off 模式非管理员仍算 target", L.targetKind({ langMode: "off" }, false, false), "target");

eq("langHit off -> false（即便语言在列表里）", L.langHit({ langMode: "off", langs: "zh_cn" }, "zh_CN"), false);
eq("langHit ban 命中 -> true", L.langHit({ langMode: "ban", langs: "zh_cn" }, "zh_CN"), true);
eq("langHit watch 命中 -> true", L.langHit({ langMode: "watch", langs: "zh_cn" }, "zh-CN"), true);
eq("langHit 列表不含 -> false", L.langHit({ langMode: "ban", langs: "en" }, "zh_CN"), false);
eq("langHit cfg 为空 -> false", L.langHit(null, "zh_CN"), false);

// ================================================================ 计数窗
sec("计数窗: Window 构造 / hit / count / clear / clearAll / pruneAll");

const w1 = new L.Window(5000);
eq("Window(5000).winMs", w1.winMs, 5000);
eq("Window(0) 兜底 10000", new L.Window(0).winMs, 10000);
eq("Window(-5) 兜底 10000", new L.Window(-5).winMs, 10000);
eq("Window(undefined) 兜底 10000", new L.Window(undefined).winMs, 10000);
eq("Window('abc') 兜底 10000", new L.Window("abc").winMs, 10000);
eq("Window('8000') 按数字处理", new L.Window("8000").winMs, 8000);

eq("hit 第一次返回 1", w1.hit("a", 1000), 1);
eq("hit 累计返回 2", w1.hit("a", 2000), 2);
eq("count 窗口内", w1.count("a", 2000), 2);
eq("不同 key 互不影响", w1.count("b", 2000), 0);
eq("窗口边界（恰好 winMs 之前）仍算", w1.count("a", 6000), 2);
eq("超出窗口的旧记录过期", w1.count("a", 6001), 1);
eq("全部过期 -> 0", w1.count("a", 7001), 0);
ok("全部过期后 key 被清掉", w1.map.a === undefined, w1.map);

const w2 = new L.Window(5000);
w2.hit("a", 0);
eq("过期后 hit 重新从 1 开始", w2.hit("a", 20000), 1);

const w3 = new L.Window(5000);
w3.hit("a", 1000);
w3.hit("b", 1000);
w3.clear("a");
eq("clear 只清一个 key", w3.count("a", 1000), 0);
eq("clear 不影响其它 key", w3.count("b", 1000), 1);
w3.clearAll();
eq("clearAll 清空所有计数", [w3.count("a", 1000), w3.count("b", 1000)], [0, 0]);
eq("clearAll 后 map 为空", Object.keys(w3.map), []);

const w4 = new L.Window(1000);
w4.hit("old", 0);
w4.hit("new", 5000);
w4.pruneAll(5001);
eq("pruneAll 只保留未过期的 key", Object.keys(w4.map), ["new"]);
eq("pruneAll 后新 key 计数不变", w4.count("new", 5001), 1);

const w5 = new L.Window(5000);
w5.hit("a", 1000);
w5.hit("a", 1200);
w5.hit("a", 1400);
eq("多次 hit 累计", w5.count("a", 1400), 3);

// ================================================================ 版本
sec("版本: cmpVersion / newerAvailable");

eq("版本相同 -> 0", L.cmpVersion("0.1.0", "0.1.0"), 0);
eq("0.2.0 > 0.1.0 -> 1", L.cmpVersion("0.2.0", "0.1.0"), 1);
eq("0.1.0 < 0.2.0 -> -1", L.cmpVersion("0.1.0", "0.2.0"), -1);
eq("0.1.10 > 0.1.9 -> 1（按数字段比较）", L.cmpVersion("0.1.10", "0.1.9"), 1);
eq("忽略 v 前缀", L.cmpVersion("v0.1.0", "0.1.0"), 0);
eq("缺段补 0", L.cmpVersion("1.0", "1.0.0"), 0);
eq("空串之间 -> 0", L.cmpVersion("", ""), 0);

eq("newerAvailable latest 空 -> false", L.newerAvailable("0.1.0", ""), false);
eq("newerAvailable latest null -> false", L.newerAvailable("0.1.0", null), false);
eq("current 更新 -> false", L.newerAvailable("0.2.0", "0.1.0"), false);
eq("latest 更新 -> true", L.newerAvailable("0.1.0", "0.2.0"), true);
eq("版本相同 -> false", L.newerAvailable("0.1.0", "0.1.0"), false);

// ================================================================ readConfig
sec("配置整形: readConfig 默认值与纠正");

const seenKeys = [];
const cfgDef = L.readConfig(function (k) {
  seenKeys.push(k);
  return undefined;
});
eq("readConfig 默认 enable", cfgDef.enable, true);
eq("readConfig 默认 vanillaBan", cfgDef.vanillaBan, false);
eq("readConfig 默认 langMode", cfgDef.langMode, "off");
eq("readConfig 默认 langs 空串", cfgDef.langs, "");
eq("readConfig 默认 blacklist 空数组", cfgDef.blacklist, []);
eq("readConfig 默认 watch 空数组", cfgDef.watch, []);
eq("readConfig 默认 bh 全 true", cfgDef.bh, bhAllTrue);
eq("readConfig 默认 thInteractCount", cfgDef.thInteractCount, 20);
eq("readConfig 默认 thInteractWindow", cfgDef.thInteractWindow, 10);
eq("readConfig 默认 thReactorNear", cfgDef.thReactorNear, 30);
eq("readConfig 默认 afkMinutes", cfgDef.afkMinutes, 3);
eq("readConfig 默认 votekick", cfgDef.votekick, true);
eq("readConfig 默认 updateCheck", cfgDef.updateCheck, true);
eq("readConfig 默认 repo", cfgDef.repo, "https://github.com/EnernalIliary/Mindustry-GriefToBan");
eq("readConfig 默认 theme 空串", cfgDef.theme, "");
eq("readConfig 默认 emph 空串", cfgDef.emph, "");
ok("readConfig 用 KEYS.langMode 取设置", seenKeys.indexOf(L.KEYS.langMode) >= 0, seenKeys);
ok("readConfig 用 KEYS.blacklist 取设置", seenKeys.indexOf(L.KEYS.blacklist) >= 0, seenKeys);
ok("readConfig 用 KEYS.watch 取设置", seenKeys.indexOf(L.KEYS.watch) >= 0, seenKeys);

function mkRead(map) {
  return function (k) {
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : undefined;
  };
}

const cfgMode = L.readConfig(mkRead({ [L.KEYS.langMode]: "BAN " }));
eq("langMode 'BAN ' -> ban（去空白 + 小写）", cfgMode.langMode, "ban");
eq("langMode 'x' -> off（非法回落默认）", L.readConfig(mkRead({ [L.KEYS.langMode]: "x" })).langMode, "off");
eq("langMode 'WATCH' -> watch", L.readConfig(mkRead({ [L.KEYS.langMode]: "WATCH" })).langMode, "watch");
eq("langMode ' Off ' -> off", L.readConfig(mkRead({ [L.KEYS.langMode]: " Off " })).langMode, "off");
eq("langMode 数字等怪值 -> off", L.readConfig(mkRead({ [L.KEYS.langMode]: 123 })).langMode, "off");

eq(
  "thInteractCount '99999' -> 500（上界）",
  L.readConfig(mkRead({ [L.KEYS.thInteractCount]: "99999" })).thInteractCount,
  500
);
eq(
  "thInteractCount '-3' -> 3（下界）",
  L.readConfig(mkRead({ [L.KEYS.thInteractCount]: "-3" })).thInteractCount,
  3
);
eq(
  "thInteractCount 'abc' -> 20（默认）",
  L.readConfig(mkRead({ [L.KEYS.thInteractCount]: "abc" })).thInteractCount,
  20
);
eq(
  "thInteractWindow '1' -> 2（下界）",
  L.readConfig(mkRead({ [L.KEYS.thInteractWindow]: "1" })).thInteractWindow,
  2
);
eq(
  "thInteractWindow '999' -> 120（上界）",
  L.readConfig(mkRead({ [L.KEYS.thInteractWindow]: "999" })).thInteractWindow,
  120
);
eq("afkMinutes 0 -> 1", L.readConfig(mkRead({ [L.KEYS.afkMinutes]: 0 })).afkMinutes, 1);
eq("afkMinutes '0' -> 1", L.readConfig(mkRead({ [L.KEYS.afkMinutes]: "0" })).afkMinutes, 1);
eq("afkMinutes '999' -> 120", L.readConfig(mkRead({ [L.KEYS.afkMinutes]: "999" })).afkMinutes, 120);
eq("thReactorNear 0 -> 1", L.readConfig(mkRead({ [L.KEYS.thReactorNear]: 0 })).thReactorNear, 1);
eq("thReactorNear '999' -> 200", L.readConfig(mkRead({ [L.KEYS.thReactorNear]: "999" })).thReactorNear, 200);

eq("repo 空白 -> DEFAULTS.repo", L.readConfig(mkRead({ [L.KEYS.repo]: "   " })).repo, "https://github.com/EnernalIliary/Mindustry-GriefToBan");
eq("repo 两侧空白被裁", L.readConfig(mkRead({ [L.KEYS.repo]: " https://x.example/a " })).repo, "https://x.example/a");

eq(
  "langs 带空格乱序 -> 归一化去重",
  L.readConfig(mkRead({ [L.KEYS.langs]: " EN , zh-CN ;ru  zh_cn " })).langs,
  "en,zh_cn,ru"
);
eq("langs 非法字符仍归一化", L.readConfig(mkRead({ [L.KEYS.langs]: "ZH_TW" })).langs, "zh_tw");
eq("blacklist 非法 JSON -> []", L.readConfig(mkRead({ [L.KEYS.blacklist]: "not json" })).blacklist, []);
eq(
  "blacklist 缺 uuid 的条目被丢",
  L.readConfig(mkRead({ [L.KEYS.blacklist]: '[{"uuid":"u1","name":"A"},{"name":"B"}]' })).blacklist,
  [{ uuid: "u1", name: "A" }]
);
eq(
  "watch 正常条目保留",
  L.readConfig(mkRead({ [L.KEYS.watch]: '[{"uuid":"w1"}]' })).watch,
  [{ uuid: "w1" }]
);
eq("enable 'off' -> false", L.readConfig(mkRead({ [L.KEYS.enable]: "off" })).enable, false);
eq("enable 'on' -> true", L.readConfig(mkRead({ [L.KEYS.enable]: "on" })).enable, true);
eq("votekick 0 -> false", L.readConfig(mkRead({ [L.KEYS.votekick]: 0 })).votekick, false);
eq("updateCheck 'no' -> false", L.readConfig(mkRead({ [L.KEYS.updateCheck]: "no" })).updateCheck, false);
eq(
  "bh 传入 {afk:false} -> afk false、其余默认",
  L.readConfig(mkRead({ [L.KEYS.bh]: '{"afk":false}' })).bh.afk,
  false
);
eq(
  "bh 单项关掉不影响其它项",
  L.readConfig(mkRead({ [L.KEYS.bh]: '{"afk":false}' })).bh.interact,
  true
);
eq("theme 被 trim", L.readConfig(mkRead({ [L.KEYS.theme]: "  [accent] " })).theme, "[accent]");
eq("emph 被 trim", L.readConfig(mkRead({ [L.KEYS.emph]: "  #ff0 " })).emph, "#ff0");

// ================================================================ 文案
sec("文案: textPrefix / textBan / textWarn / textKick / COLOR");

const prefix = L.textPrefix();
ok("textPrefix() 非空", typeof prefix === "string" && prefix.length > 0, prefix);
contains("textPrefix 含 Grief to Ban", prefix, "Grief to Ban");

const banText = L.textBan("[scarlet]Eve[white]", "短时间大量交互/指挥");
contains("textBan 含 safeName 结果", banText, "Eve");
contains("textBan 含原因", banText, "短时间大量交互/指挥");
contains("textBan 以 prefix 开头", banText, prefix);
contains("textBan 用 bad 颜色", banText, L.COLOR.bad);
notContains("textBan 不含 null", banText, "null");
notContains("textBan 里名字的标签已被清掉", banText, "[scarlet][scr");

const warnText = L.textWarn("[orange]Mallory", "放置病毒逻辑");
contains("textWarn 含 safeName 结果", warnText, "Mallory");
contains("textWarn 以 prefix 开头", warnText, prefix);
contains("textWarn 含原因", warnText, "放置病毒逻辑");

const kickText = L.textKick("[blue]Trudy", "AFK");
contains("textKick 含 safeName 结果", kickText, "Trudy");
contains("textKick 以 prefix 开头", kickText, prefix);
eq("textKick 无原因时结尾是冒号", L.textKick("x").slice(-1), "：");
contains("textKick(null reason) 不含 null", L.textKick("x", null), "x");

contains("textWatchAdd 含名字", L.textWatchAdd("Sam"), "Sam");
contains("textSpectate 含名字", L.textSpectate("Sam", "投票"), "Sam");
contains("textVoteWatch 含名字", L.textVoteWatch("Sam"), "Sam");
contains("textVoteBack 含名字", L.textVoteBack("Sam"), "Sam");
eq("textInfo 直接拼内容", L.textInfo("hello"), prefix + L.COLOR.info + "hello");
eq("textInfo(null) 不带 null", L.textInfo(null), prefix + L.COLOR.info);

eq("COLOR 键齐全", Object.keys(L.COLOR).sort(), ["bad", "gray", "hi", "info", "ok", "plain", "warn"]);
ok(
  "COLOR 各项都是 [xxx] 形式",
  Object.keys(L.COLOR).every(function (k) {
    return /^\[[a-z]+\]$/.test(String(L.COLOR[k]));
  }),
  L.COLOR
);
eq("REASON 键齐全", Object.keys(L.REASON).sort(), [
  "afk",
  "blastGen",
  "interact",
  "lang",
  "reactorBoom",
  "reactorNear",
  "virus"
]);

// ================================================================ boolOf
sec("boolOf");

eq("boolOf(null) -> def", L.boolOf(null, true), true);
eq("boolOf(undefined) -> def", L.boolOf(undefined, "fallback"), "fallback");
eq("boolOf(true) -> true", L.boolOf(true, false), true);
eq("boolOf(1) -> true", L.boolOf(1, false), true);
eq("boolOf('on') -> true", L.boolOf("on", false), true);
eq("boolOf('yes') -> true", L.boolOf("yes", false), true);
eq("boolOf('TRUE') -> true", L.boolOf("TRUE", false), true);
eq("boolOf(false) -> false", L.boolOf(false, true), false);
eq("boolOf(0) -> false", L.boolOf(0, true), false);
eq("boolOf('off') -> false", L.boolOf("off", true), false);
eq("boolOf(' no ') -> false", L.boolOf(" no ", true), false);
eq("boolOf('') -> def", L.boolOf("", true), true);
eq("boolOf('garbage') -> def", L.boolOf("garbage", 7), 7);

// ================================================================ 常量
sec("常量: VERSION / KEYS / BH_KEYS");

ok("VERSION 是非空字符串", typeof L.VERSION === "string" && L.VERSION.length > 0, L.VERSION);
ok("VERSION 形如数字版本号", L.cmpVersion(L.VERSION, "0.0.0") > 0, L.VERSION);
const keyNames = Object.keys(L.KEYS);
ok("KEYS 非空", keyNames.length > 0, keyNames.length);
ok(
  "KEYS 全部带 grief-to-ban. 前缀",
  keyNames.every(function (k) {
    return String(L.KEYS[k]).indexOf("grief-to-ban.") === 0;
  }),
  L.KEYS
);
eq("KEYS.langMode", L.KEYS.langMode, "grief-to-ban.lang-mode");
eq("KEYS.thInteractCount", L.KEYS.thInteractCount, "grief-to-ban.th-interact-count");
eq("BH_KEYS 顺序与默认一致", L.BH_KEYS, ["interact", "virus", "reactorNear", "reactorBoom", "blastGen", "afk"]);

// ================================================================ 汇总
function summary() {
  const names = Object.keys(stats);
  for (let i = 0; i < names.length; i++) {
    const s = stats[names[i]];
    console.log(
      (s.failed === 0 ? "[ok]   " : "[FAIL] ") + names[i] + ": " + s.passed + " passed" + (s.failed ? ", " + s.failed + " failed" : "")
    );
  }
  if (failures.length === 0) {
    console.log("GTB lib tests: " + passed + " passed");
    return;
  }
  console.log("");
  for (let i = 0; i < failures.length; i++) {
    const f = failures[i];
    console.log("FAIL [" + f.section + "] " + f.name);
    console.log("  expected: " + f.expected);
    console.log("  actual:   " + f.actual);
  }
  console.log("");
  console.log("GTB lib tests: FAILED (" + failures.length + " failed, " + passed + " passed)");
  process.exit(1);
}

summary();
