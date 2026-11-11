// Grief to Ban · 纯逻辑层
// 这里只有字符串/JSON/计时，不引用任何 Java 类，所以可以用 node 直接跑测试。
// 编码约束：本文件会被 Mindustry 的 Rhino 加载，只允许 ES5 写法（var / function），
// 禁止正则字面量（Rhino 构造期会 FAILED ASSERTION: invalid bytecode），一律手写字符扫描。

var VERSION = "0.1.2";
var P = "grief-to-ban.";

// 设置键（存进 Core.settings）
var K = {
    enable: P + "enable",
    vanillaBan: P + "vanilla-ban",
    langMode: P + "lang-mode",
    langs: P + "langs",
    blacklist: P + "blacklist",
    watch: P + "watch",
    bh: P + "behaviors",
    thInteractCount: P + "th-interact-count",
    thInteractWindow: P + "th-interact-window",
    thReactorNear: P + "th-reactor-near",
    afkMinutes: P + "th-afk-minutes",
    votekick: P + "votekick",
    updateCheck: P + "update-check",
    repo: P + "repo",
    theme: P + "theme-color",
    emph: P + "emph-color"
};

var BH_KEYS = ["interact", "virus", "reactorNear", "reactorBoom", "blastGen", "afk"];

var DEFAULTS = {
    enable: true,
    vanillaBan: false,
    langMode: "off",
    langs: "",
    bh: { interact: true, virus: true, reactorNear: true, reactorBoom: true, blastGen: true, afk: true },
    thInteractCount: 20,
    thInteractWindow: 10,
    thReactorNear: 30,
    afkMinutes: 3,
    votekick: true,
    updateCheck: true,
    repo: "https://github.com/EnernalIliary/Mindustry-GriefToBan",
    theme: "",
    emph: ""
};

// ---------------------------------------------------------------- 字符串工具

function isSpace(ch) {
    return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function trimStr(s) {
    if (s == null) return "";
    s = String(s);
    var a = 0, b = s.length;
    while (a < b && isSpace(s.charAt(a))) a++;
    while (b > a && isSpace(s.charAt(b - 1))) b--;
    return s.substring(a, b);
}

function lower(s) {
    if (s == null) return "";
    s = String(s);
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var n = s.charCodeAt(i);
        if (n >= 65 && n <= 90) out += String.fromCharCode(n + 32);
        else out += c;
    }
    return out;
}

function startsWith(s, p) {
    s = s == null ? "" : String(s);
    return s.substring(0, p.length) === p;
}

function indexOfStr(s, p) {
    s = s == null ? "" : String(s);
    return s.indexOf(p);
}

// 把 Mindustry 的颜色标签 [xxx] 去掉，只留纯文本（用于名字、日志）
function stripTags(s) {
    if (s == null) return "";
    s = String(s);
    var out = "", i = 0;
    while (i < s.length) {
        var c = s.charAt(i);
        if (c === "[") {
            var j = i + 1, ok = false;
            while (j < s.length) {
                var d = s.charAt(j);
                if (d === "]") { ok = true; break; }
                if (d === "[") break;
                j++;
                if (j - i > 24) break;
            }
            if (ok) { i = j + 1; continue; }
        }
        out += c;
        i++;
    }
    return out;
}

// 玩家名字进聊天栏前要消毒：去掉颜色标签与方括号，避免伪造系统提示
function safeName(name) {
    var s = stripTags(name == null ? "" : String(name));
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === "[") out += "(";
        else if (c === "]") out += ")";
        else out += c;
    }
    out = trimStr(out);
    if (out === "") out = "?";
    if (out.length > 32) out = out.substring(0, 32) + "…";
    return out;
}

function shortId(uuid) {
    uuid = uuid == null ? "" : String(uuid);
    if (uuid.length <= 8) return uuid;
    return uuid.substring(0, 8);
}

// ---------------------------------------------------------------- 数字工具

function toInt(v, def) {
    var n = Number(v);
    if (isNaN(n) || !isFinite(n)) return def;
    return Math.round(n);
}

function clampInt(v, lo, hi, def) {
    var n = toInt(v, def);
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
}

function toNum(v, def) {
    var n = Number(v);
    if (isNaN(n) || !isFinite(n)) return def;
    return n;
}

// ---------------------------------------------------------------- 名单（JSON 数组）

function parseJsonArray(s) {
    if (s == null) return [];
    s = trimStr(s);
    if (s === "") return [];
    var arr = null;
    try { arr = JSON.parse(s); } catch (e) { return []; }
    if (!arr || typeof arr.length !== "number") return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var e = arr[i];
        if (!e || typeof e !== "object") continue;
        if (e.uuid == null || trimStr(e.uuid) === "") continue;
        out.push(e);
    }
    return out;
}

function dumpJsonArray(a) {
    if (!a) return "[]";
    try { return JSON.stringify(a); } catch (e) { return "[]"; }
}

function findIndex(list, uuid) {
    if (!list || uuid == null) return -1;
    uuid = trimStr(uuid);
    for (var i = 0; i < list.length; i++) {
        if (trimStr(list[i].uuid) === uuid) return i;
    }
    return -1;
}

function findEntry(list, uuid) {
    var i = findIndex(list, uuid);
    return i < 0 ? null : list[i];
}

// 加一条（同 uuid 覆盖；返回新数组，不改入参）
function addEntry(list, entry) {
    var out = [];
    var uuid = trimStr(entry == null ? "" : entry.uuid);
    if (uuid === "") return list ? list.slice(0) : [];
    var src = list ? list : [];
    for (var i = 0; i < src.length; i++) {
        if (trimStr(src[i].uuid) === uuid) continue;
        out.push(src[i]);
    }
    var e = { uuid: uuid };
    e.name = entry.name == null ? "" : String(entry.name);
    e.reason = entry.reason == null ? "" : String(entry.reason);
    e.at = toInt(entry.at, 0);
    if (entry.by != null) e.by = String(entry.by);
    out.push(e);
    return out;
}

function removeEntry(list, uuid) {
    var out = [];
    if (!list) return out;
    var target = trimStr(uuid);
    for (var i = 0; i < list.length; i++) {
        if (trimStr(list[i].uuid) === target) continue;
        out.push(list[i]);
    }
    return out;
}

function entryLine(e) {
    if (!e) return "";
    var name = safeName(e.name);
    var s = name + " [gray](" + shortId(e.uuid) + ")";
    if (e.reason != null && trimStr(e.reason) !== "") s += " · " + trimStr(e.reason);
    if (toInt(e.at, 0) > 0) s += " · " + fmtDate(e.at);
    return s;
}

function watchLine(e) {
    if (!e) return "";
    var s = safeName(e.name) + " [gray](" + shortId(e.uuid) + ")";
    if (toInt(e.at, 0) > 0) s += " · " + fmtDate(e.at);
    return s;
}

// 日期：用本地时区，格式 yyyy-MM-dd HH:mm（不依赖 Java，Node 与 Rhino 都能跑）
function fmtDate(ms) {
    var n = toNum(ms, 0);
    if (n <= 0) return "";
    var d = new Date(n);
    var y = d.getFullYear(), mo = d.getMonth() + 1, da = d.getDate();
    var h = d.getHours(), mi = d.getMinutes();
    return "" + y + "-" + pad2(mo) + "-" + pad2(da) + " " + pad2(h) + ":" + pad2(mi);
}

function pad2(n) {
    n = toInt(n, 0);
    return n < 10 ? "0" + n : "" + n;
}

// 时长文案：ms -> "3 分 20 秒"
function fmtDuration(ms) {
    var sec = Math.floor(toNum(ms, 0) / 1000);
    if (sec < 0) sec = 0;
    var m = Math.floor(sec / 60), s = sec - m * 60;
    if (m <= 0) return "" + s + " 秒";
    return "" + m + " 分 " + s + " 秒";
}

// ---------------------------------------------------------------- 语言

// "zh-CN" / "ZH_cn " -> "zh_cn"
function normLocale(s) {
    s = lower(trimStr(s));
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === "-") out += "_";
        else out += c;
    }
    return out;
}

function parseLangs(s) {
    s = s == null ? "" : String(s);
    var out = [], cur = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === "," || c === ";" || isSpace(c)) {
            if (trimStr(cur) !== "") out.push(normLocale(cur));
            cur = "";
        } else cur += c;
    }
    if (trimStr(cur) !== "") out.push(normLocale(cur));
    return out;
}

function joinLangs(arr) {
    if (!arr) return "";
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        var v = normLocale(arr[i]);
        if (v !== "" && indexOfStr("," + out.join(",") + ",", "," + v + ",") < 0) out.push(v);
    }
    return out.join(",");
}

// 列表里存 "zh_cn,en"；玩家 locale "zh_CN" -> 命中
function localeInList(locale, listStr) {
    var a = normLocale(locale);
    if (a === "") return false;
    var list = parseLangs(listStr);
    for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e === a) return true;
        if (startsWith(a, e + "_")) return true;
        if (startsWith(e, a + "_")) return true;
    }
    return false;
}

// 界面上的语言候选（代码, 显示名）
var LANGS = [
    ["zh_cn", "中文（简体）"],
    ["zh_tw", "中文（繁體）"],
    ["en", "English"],
    ["ru", "Русский"],
    ["ja", "日本語"],
    ["ko", "한국어"],
    ["fr", "Français"],
    ["de", "Deutsch"],
    ["es", "Español"],
    ["pt", "Português"],
    ["it", "Italiano"],
    ["pl", "Polski"],
    ["tr", "Türkçe"],
    ["vi", "Tiếng Việt"],
    ["uk", "Українська"],
    ["th", "ไทย"],
    ["id", "Indonesia"],
    ["cs", "Čeština"],
    ["nl", "Nederlands"],
    ["fa", "فارسی"]
];

function langLabel(code) {
    var c = normLocale(code);
    for (var i = 0; i < LANGS.length; i++) {
        if (LANGS[i][0] === c) return LANGS[i][1];
    }
    return c === "" ? "?" : c;
}

// ---------------------------------------------------------------- 行为开关

function parseBehaviors(s) {
    var out = {};
    for (var i = 0; i < BH_KEYS.length; i++) out[BH_KEYS[i]] = DEFAULTS.bh[BH_KEYS[i]];
    if (s == null) return out;
    var o = null;
    try { o = JSON.parse(trimStr(s)); } catch (e) { return out; }
    if (!o || typeof o !== "object") return out;
    for (var j = 0; j < BH_KEYS.length; j++) {
        var k = BH_KEYS[j];
        // 存的是 dumpBehaviors 写的严格布尔；手工改存档时容许 "true"/"1"（大小写不敏感，
        // 与 boolOf 对齐），但 "yes"/"on" 这类仍然算"关"——别把写歪的字符串静默当开。
        var v = o[k];
        if (v == null) continue;
        if (v === true || v === 1) out[k] = true;
        else if (v === false || v === 0) out[k] = false;
        else {
            var sv = lower(trimStr(v));
            out[k] = (sv === "true" || sv === "1");
        }
    }
    return out;
}

function dumpBehaviors(bh) {
    var src = bh ? bh : DEFAULTS.bh;
    var o = {};
    for (var i = 0; i < BH_KEYS.length; i++) {
        var k = BH_KEYS[i];
        o[k] = src[k] === true;
    }
    try { return JSON.stringify(o); } catch (e) { return "{}"; }
}

// ---------------------------------------------------------------- 目标判定

// 返回 "skip"（不处理）/ "target"（当作「成员」处理）
// 规则：管理员永远跳过（房主设其为管理员即移出黑名单）；观察模式下只处理观察名单里的人。
function targetKind(cfg, isAdmin, watched) {
    if (isAdmin) return "skip";
    if (!cfg) return "skip";
    if (cfg.langMode === "watch") return watched ? "target" : "skip";
    return "target";
}

// 语言是否命中惩罚/观察
function langHit(cfg, locale) {
    if (!cfg) return false;
    if (cfg.langMode !== "ban" && cfg.langMode !== "watch") return false;
    return localeInList(locale, cfg.langs);
}

// ---------------------------------------------------------------- 计数窗

// 每次交互记一笔时间戳，count() 返回窗口内的笔数
function Window(winMs) {
    this.winMs = toNum(winMs, 10000);
    if (this.winMs <= 0) this.winMs = 10000;
    this.map = {};
}

Window.prototype.pruneKey = function (key, nowMs) {
    var arr = this.map[key];
    if (!arr) return null;
    var cut = nowMs - this.winMs;
    var out = [];
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] >= cut) out.push(arr[i]);
    }
    if (out.length === 0) { delete this.map[key]; return null; }
    this.map[key] = out;
    return out;
};

Window.prototype.hit = function (key, nowMs) {
    var n = toNum(nowMs, 0);
    var arr = this.pruneKey(key, n);
    if (!arr) arr = [];
    arr.push(n);
    this.map[key] = arr;
    return arr.length;
};

Window.prototype.count = function (key, nowMs) {
    var arr = this.pruneKey(key, toNum(nowMs, 0));
    return arr ? arr.length : 0;
};

Window.prototype.clear = function (key) {
    delete this.map[key];
};

Window.prototype.clearAll = function () {
    this.map = {};
};

Window.prototype.pruneAll = function (nowMs) {
    var n = toNum(nowMs, 0);
    var keys = [];
    for (var k in this.map) keys.push(k);
    for (var i = 0; i < keys.length; i++) this.pruneKey(keys[i], n);
};

// ---------------------------------------------------------------- 文案

var COLOR = {
    bad: "[scarlet]",
    warn: "[orange]",
    ok: "[green]",
    info: "[lightgray]",
    hi: "[accent]",
    plain: "[white]",
    gray: "[gray]"
};

function textPrefix() {
    return "[accent][Grief to Ban][] ";
}

function textBan(name, reason) {
    return textPrefix() + COLOR.bad + "已拉黑 " + COLOR.plain + safeName(name) + COLOR.bad + "：" + (reason == null ? "" : String(reason));
}

function textWatchAdd(name) {
    return textPrefix() + COLOR.warn + "已加入观察名单：" + COLOR.plain + safeName(name);
}

function textKick(name, reason) {
    return textPrefix() + COLOR.bad + "已踢出 " + COLOR.plain + safeName(name) + COLOR.bad + "：" + (reason == null ? "" : String(reason));
}

function textWarn(name, reason) {
    return textPrefix() + COLOR.warn + "警告 " + COLOR.plain + safeName(name) + COLOR.warn + "：" + (reason == null ? "" : String(reason));
}

function textSpectate(name, reason) {
    return textPrefix() + COLOR.warn + "已把 " + COLOR.plain + safeName(name) + COLOR.warn + " 转为旁观：" + (reason == null ? "" : String(reason));
}

function textVoteWatch(name) {
    return textPrefix() + COLOR.info + safeName(name) + " 正在被投票踢出，先转为旁观。";
}

function textVoteBack(name) {
    return textPrefix() + COLOR.info + "投票结束，" + safeName(name) + " 回到原队伍。";
}

function textInfo(s) {
    return textPrefix() + COLOR.info + (s == null ? "" : String(s));
}

// 行为原因（写进黑名单 reason 字段，也广播给全服）
var REASON = {
    interact: "短时间大量交互/指挥",
    virus: "放置病毒逻辑（@this 自复制）",
    reactorNear: "钍堆离核心太近",
    reactorBoom: "钍堆热量不为 0（随时会炸）",
    blastGen: "给涡轮/火电装爆混",
    afk: "附身单位 AFK 过久",
    lang: "语言黑名单"
};

// ---------------------------------------------------------------- 版本

function cmpVersion(a, b) {
    var pa = verParts(a), pb = verParts(b);
    var n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
        var x = i < pa.length ? pa[i] : 0;
        var y = i < pb.length ? pb[i] : 0;
        if (x < y) return -1;
        if (x > y) return 1;
    }
    return 0;
}

function verParts(v) {
    v = trimStr(v);
    var out = [], cur = "";
    for (var i = 0; i < v.length; i++) {
        var c = v.charAt(i);
        var n = v.charCodeAt(i);
        if (n >= 48 && n <= 57) cur += c;
        else {
            if (cur !== "") out.push(parseInt(cur, 10));
            cur = "";
        }
    }
    if (cur !== "") out.push(parseInt(cur, 10));
    return out;
}

function newerAvailable(current, latest) {
    if (trimStr(latest) === "") return false;
    // 当前版本未知（首次运行 / 读不到）时不要谎报"有新版本"
    if (trimStr(current) === "") return false;
    return cmpVersion(current, latest) < 0;
}

// ---------------------------------------------------------------- 配置整形

// 把「原始设置读取函数」变成一份完整配置对象
// read(key) -> 字符串/数字/布尔（可能为 null）
function readConfig(read) {
    var cfg = {};
    cfg.enable = boolOf(read(K.enable), DEFAULTS.enable);
    cfg.vanillaBan = boolOf(read(K.vanillaBan), DEFAULTS.vanillaBan);
    var mode = lower(trimStr(read(K.langMode)));
    if (mode !== "off" && mode !== "ban" && mode !== "watch") mode = DEFAULTS.langMode;
    cfg.langMode = mode;
    cfg.langs = joinLangs(parseLangs(read(K.langs)));
    cfg.blacklist = parseJsonArray(read(K.blacklist));
    cfg.watch = parseJsonArray(read(K.watch));
    cfg.bh = parseBehaviors(read(K.bh));
    cfg.thInteractCount = clampInt(read(K.thInteractCount), 3, 500, DEFAULTS.thInteractCount);
    cfg.thInteractWindow = clampInt(read(K.thInteractWindow), 2, 120, DEFAULTS.thInteractWindow);
    cfg.thReactorNear = clampInt(read(K.thReactorNear), 1, 200, DEFAULTS.thReactorNear);
    cfg.afkMinutes = clampInt(read(K.afkMinutes), 1, 120, DEFAULTS.afkMinutes);
    cfg.votekick = boolOf(read(K.votekick), DEFAULTS.votekick);
    cfg.updateCheck = boolOf(read(K.updateCheck), DEFAULTS.updateCheck);
    cfg.repo = trimStr(read(K.repo));
    if (cfg.repo === "") cfg.repo = DEFAULTS.repo;
    cfg.theme = trimStr(read(K.theme));
    cfg.emph = trimStr(read(K.emph));
    return cfg;
}

function boolOf(v, def) {
    if (v == null) return def;
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    var s = lower(trimStr(v));
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    return def;
}

// ---------------------------------------------------------------- 导出

module.exports = {
    VERSION: VERSION,
    KEYS: K,
    DEFAULTS: DEFAULTS,
    BH_KEYS: BH_KEYS,
    LANGS: LANGS,
    COLOR: COLOR,
    REASON: REASON,
    Window: Window,
    trimStr: trimStr,
    lower: lower,
    stripTags: stripTags,
    safeName: safeName,
    shortId: shortId,
    toInt: toInt,
    toNum: toNum,
    clampInt: clampInt,
    parseJsonArray: parseJsonArray,
    dumpJsonArray: dumpJsonArray,
    findIndex: findIndex,
    findEntry: findEntry,
    addEntry: addEntry,
    removeEntry: removeEntry,
    entryLine: entryLine,
    watchLine: watchLine,
    fmtDate: fmtDate,
    fmtDuration: fmtDuration,
    normLocale: normLocale,
    parseLangs: parseLangs,
    joinLangs: joinLangs,
    localeInList: localeInList,
    langLabel: langLabel,
    parseBehaviors: parseBehaviors,
    dumpBehaviors: dumpBehaviors,
    targetKind: targetKind,
    langHit: langHit,
    textPrefix: textPrefix,
    textBan: textBan,
    textWatchAdd: textWatchAdd,
    textKick: textKick,
    textWarn: textWarn,
    textSpectate: textSpectate,
    textVoteWatch: textVoteWatch,
    textVoteBack: textVoteBack,
    textInfo: textInfo,
    cmpVersion: cmpVersion,
    newerAvailable: newerAvailable,
    readConfig: readConfig,
    boolOf: boolOf
};
