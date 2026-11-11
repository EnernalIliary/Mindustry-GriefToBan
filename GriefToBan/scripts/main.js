// Grief to Ban · 游戏绑定层
// 纯 JS + Rhino，无 Java。逻辑/文案在 gtb-lib.js，设置在 gtb-ui.js。
// 编码约束：ES5（var/function），禁止正则字面量，所有可能被无头环境拒绝的调用都包 try。

var LIB = require("gtb-lib");

var UIMOD = null;
try { UIMOD = require("gtb-ui"); } catch (uiErr) { UIMOD = null; }

var Vars = Packages.mindustry.Vars;
var Events = Packages.arc.Events;
var ET = Packages.mindustry.game.EventType;
var Core = Packages.arc.Core;
var Pal = Packages.mindustry.graphics.Pal;
var Color = Packages.arc.graphics.Color;
var Team = Packages.mindustry.game.Team;
var Call = Packages.mindustry.gen.Call;
var Log = Packages.arc.util.Log;
var Items = Packages.mindustry.content.Items;

var GTB = {
    cfg: null,
    win: null,
    banned: {},
    watched: {},
    joinedAt: {},
    afk: {},
    builders: {},
    origTeam: {},
    vote: null,
    vanBan: {},
    update: null,
    lastTick: 0,
    lastScan: 0,
    uiHost: null,
    registered: false
};

// ---------------------------------------------------------------- 设置读写

var DEF = {};
DEF[LIB.KEYS.enable] = LIB.DEFAULTS.enable;
DEF[LIB.KEYS.vanillaBan] = LIB.DEFAULTS.vanillaBan;
DEF[LIB.KEYS.langMode] = LIB.DEFAULTS.langMode;
DEF[LIB.KEYS.langs] = LIB.DEFAULTS.langs;
DEF[LIB.KEYS.blacklist] = "[]";
DEF[LIB.KEYS.watch] = "[]";
DEF[LIB.KEYS.bh] = LIB.dumpBehaviors(LIB.DEFAULTS.bh);
DEF[LIB.KEYS.thInteractCount] = LIB.DEFAULTS.thInteractCount;
DEF[LIB.KEYS.thInteractWindow] = LIB.DEFAULTS.thInteractWindow;
DEF[LIB.KEYS.thReactorNear] = LIB.DEFAULTS.thReactorNear;
DEF[LIB.KEYS.afkMinutes] = LIB.DEFAULTS.afkMinutes;
DEF[LIB.KEYS.votekick] = LIB.DEFAULTS.votekick;
DEF[LIB.KEYS.updateCheck] = LIB.DEFAULTS.updateCheck;
DEF[LIB.KEYS.repo] = LIB.DEFAULTS.repo;
DEF[LIB.KEYS.theme] = LIB.DEFAULTS.theme;
DEF[LIB.KEYS.emph] = LIB.DEFAULTS.emph;

function sread(key) {
    var d = DEF[key];
    try {
        if (typeof d === "boolean") return Core.settings.getBool(key, d);
        if (typeof d === "number") return Core.settings.getInt(key, d);
        var v = Core.settings.getString(key, d);
        return v == null ? d : v;
    } catch (e) {
        return d;
    }
}

function swrite(key, value) {
    try {
        if (typeof value === "boolean") Core.settings.put(key, value);
        else if (typeof value === "number") Core.settings.put(key, LIB.toInt(value, 0));
        else {
            var s = value == null ? "" : String(value);
            Core.settings.put(key, s);
            var back = "";
            try { back = Core.settings.getString(key, ""); } catch (e1) { back = ""; }
            if (String(back) !== s) dbg("swrite MISMATCH " + key + " want=" + s.length + " got=" + String(back).length);
            else dbg("swrite " + key + " len=" + String(back).length);
        }
        try { Core.settings.autosave(); } catch (e9) { }
    } catch (e) {
        logInfo("写设置失败 " + key + "：" + e);
    }
}

function rebuildMaps() {
    var cfg = GTB.cfg == null ? LIB.readConfig(sread) : GTB.cfg;
    GTB.banned = {};
    for (var i = 0; i < cfg.blacklist.length; i++) {
        var u = LIB.trimStr(cfg.blacklist[i].uuid);
        if (u !== "") GTB.banned[u] = true;
    }
    GTB.watched = {};
    for (var j = 0; j < cfg.watch.length; j++) {
        var w = LIB.trimStr(cfg.watch[j].uuid);
        if (w !== "") GTB.watched[w] = true;
    }
    if (GTB.win == null) GTB.win = new LIB.Window(cfg.thInteractWindow * 1000);
    else GTB.win.winMs = cfg.thInteractWindow * 1000;
}

function reload() {
    GTB.cfg = LIB.readConfig(sread);
    rebuildMaps();
    if (GTB.win == null) GTB.win = new LIB.Window(GTB.cfg.thInteractWindow * 1000);
}

function cfg() {
    if (GTB.cfg == null) reload();
    return GTB.cfg;
}

// ---------------------------------------------------------------- 小工具

// ---------------------------------------------------------------- 调试日志
// 真机排查用：<config>/gtb-debug.log。10 秒一条心跳，名单/处置/停用各记一行。
// 设置界面「维护」段有「打开日志」「诊断」入口。
var GTB_DBG = { file: null, ready: false, lastBeat: 0, lines: 0 };
GTB.stat = { reactors: 0, hot: 0, logic: 0, virus: 0, gens: 0 };

function dbgFile() {
    if (GTB_DBG.ready) return GTB_DBG.file;
    GTB_DBG.ready = true;
    try {
        var dir = Packages.mindustry.Vars.dataDirectory;
        if (dir == null) return null;
        GTB_DBG.file = dir.child("gtb-debug.log");
    } catch (e) { GTB_DBG.file = null; }
    return GTB_DBG.file;
}

function dbg(msg) {
    try {
        var f = dbgFile();
        if (f == null) return;
        if (GTB_DBG.lines >= 3000) return;
        GTB_DBG.lines = GTB_DBG.lines + 1;
        f.writeString(nowMs() + " " + String(msg) + "\n", true);
    } catch (e) { }
}

function dbgClear() {
    try {
        var f = dbgFile();
        if (f == null) return false;
        f.writeString("", false);
        GTB_DBG.lines = 0;
        dbg("log cleared");
        return true;
    } catch (e) { return false; }
}

function dbgText() {
    try {
        var f = dbgFile();
        if (f == null) return "拿不到 dataDirectory";
        if (!f.exists()) return "还没有日志（gtb-debug.log）";
        return f.readString();
    } catch (e) { return "读日志失败：" + e; }
}

function playerCount() {
    try { return seqSize(Packages.mindustry.gen.Groups.player); } catch (e) { return 0; }
}

// 网络角色：房主 / 单机 / 服务端 vs 连别人服的客户端。真机诊断最需要的一行。
function authInfo() {
    var s = "auth=" + (isAuthority() ? "yes" : "no");
    var n = null;
    try { n = Vars.net; } catch (e) { return s + " net=err"; }
    if (n == null) return s + " net=null";
    try { s = s + " server=" + (n.server() === true ? 1 : 0); } catch (e1) { }
    try { s = s + " active=" + (n.active() === true ? 1 : 0); } catch (e2) { }
    try { s = s + " client=" + (n.client() === true ? 1 : 0); } catch (e3) { s = s + " client=?"; }
    try { s = s + " netServer=" + (Vars.netServer == null ? 0 : 1); } catch (e4) { }
    return s;
}

function diagText() {
    var cfg0 = cfg();
    var out = [];
    out.push("Grief to Ban v" + LIB.VERSION);
    out.push(authInfo());
    out.push("enable=" + (cfg0.enable ? 1 : 0) + " vanillaBan=" + (cfg0.vanillaBan ? 1 : 0) + " langMode=" + cfg0.langMode + " langs=" + cfg0.langs);
    out.push("bh=" + LIB.dumpBehaviors(cfg0.bh));
    out.push("blacklist=" + cfg0.blacklist.length + " watch=" + cfg0.watch.length + " vanBan=" + (GTB.vanBan == null ? 0 : seqSize(GTB.vanBan)));
    out.push("players=" + playerCount() + " builds=" + nBuilds());
    out.push("stat reactors=" + GTB.stat.reactors + " hot=" + GTB.stat.hot + " logic=" + GTB.stat.logic + " virus=" + GTB.stat.virus);
    out.push("settings blacklist len=" + LIB.trimStr(sread(LIB.KEYS.blacklist)).length + " watch len=" + LIB.trimStr(sread(LIB.KEYS.watch)).length);
    var f = dbgFile();
    out.push("log=" + (f == null ? "-" : String(f.absolutePath())));
    return out.join("\n");
}

// 探针/排查用：把内部状态挂到系统属性上，控制台 js 里 System.getProperty 就能读
function expose(key, val) {
    try { Packages.java.lang.System.setProperty(key, String(val)); } catch (e) { }
}

function nBuilds() {
    try { return seqSize(Packages.mindustry.gen.Groups.build); } catch (e) { return 0; }
}

function logInfo(msg) {
    try { Log.info("[GTB] " + msg); } catch (e) { }
}

function logErr(msg) {
    try { Log.err("[GTB] " + msg); } catch (e) { }
}

function broadcast(msg) {
    try { Call.sendMessage(msg); } catch (e) { logInfo(LIB.stripTags(msg)); }
}

function nowMs() {
    try { return new Date().getTime(); } catch (e) { return 0; }
}

// 只有服务端（含单机/房主）能改队伍、封人、发聊天；纯客户端上这些调用会被转发或报错。
function isAuthority() {
    var n = null;
    try { n = Vars.net; } catch (e) { return true; }
    if (n == null) return true;
    var server = false, active = false, client = false;
    try { server = n.server() === true; } catch (e1) { }
    try { active = n.active() === true; } catch (e2) { }
    try { client = n.client() === true; } catch (e3) { }
    if (server) return true;
    if (!active) return true;              // 单机 / 根本没连网
    if (client) return false;              // 连了别人的服：改不了名单、换不了队伍
    return true;                           // 说不清时按房主处理，宁可多记一行日志也别静默失效
}

function seqSize(seq) {
    if (seq == null) return 0;
    try {
        var s = seq.size;
        if (typeof s === "number") return s;
    } catch (e) { }
    try { return LIB.toInt(seq.size(), 0); } catch (e2) { return 0; }
}

// EntityGroup 只能顺序遍历：给「需要原始对象」的地方用
function seqEach(seq, fn) {
    var n = seqSize(seq);
    for (var i = 0; i < n; i++) {
        var it = seqGet(seq, i);
        if (it != null) fn(it, i);
    }
}

// Groups.* 在 v160 里是 mindustry.entities.EntityGroup（不是 arc 的 Seq）：
// 只有 size() / index(int) / each(...)，**没有 get(int)**。这一条曾让所有扫描静默空转。
function seqGet(seq, i) {
    if (seq == null) return null;
    try { var a = seq.get(i); if (a != null) return a; } catch (e) { }
    try { var b2 = seq.index(i); if (b2 != null) return b2; } catch (e2) { }
    try { var arr = seq.items; if (arr != null && i < arr.length) return arr[i]; } catch (e3) { }
    return null;
}

function eachPlayer(fn) {
    var seq = null;
    try { seq = Packages.mindustry.gen.Groups.player; } catch (e) { return; }
    var n = seqSize(seq);
    for (var i = 0; i < n; i++) {
        var p = seqGet(seq, i);
        if (p != null) {
            try { fn(p); } catch (e) { logErr("player loop: " + e); }
        }
    }
}

function playerByUuid(uuid) {
    var found = null;
    uuid = LIB.trimStr(uuid);
    eachPlayer(function (p) {
        if (found == null && LIB.trimStr(p.uuid()) === uuid) found = p;
    });
    return found;
}

function uuidOf(p) {
    try { return LIB.trimStr(p.uuid()); } catch (e) { return ""; }
}

function nameOf(p) {
    try { return LIB.safeName(p.name); } catch (e) { return "?"; }
}

function isAdmin(p) {
    try { return p.admin === true; } catch (e) { return false; }
}

function isWatched(uuid) {
    return GTB.watched[LIB.trimStr(uuid)] === true;
}

function isBanned(uuid) {
    var u = LIB.trimStr(uuid);
    if (GTB.banned[u] === true) return true;
    return GTB.vanBan != null && GTB.vanBan[u] === true;
}

function targetOf(p) {
    return LIB.targetKind(cfg(), isAdmin(p), isWatched(uuidOf(p)));
}

function tileKey(tile) {
    try { return tile.x + "," + tile.y; } catch (e) { return ""; }
}

function blockNameOf(b) {
    try { return String(b.block.name); } catch (e) { return ""; }
}

// ---------------------------------------------------------------- 队伍 / 旁观

// 记录原队伍后把玩家转成旁观（队伍 0）
function toDerelict(p, reason, quiet) {
    if (p == null) return false;
    var uuid = uuidOf(p);
    try {
        if (GTB.origTeam[uuid] == null) {
            var t = p.team();
            if (t != null && String(t.name) !== "derelict") GTB.origTeam[uuid] = t;
        }
    } catch (e) { }
    try {
        var u = p.unit();
        if (u != null) p.clearUnit();
    } catch (e2) { }
    var ok = false;
    try { p.team(Team.derelict); ok = true; } catch (e3) { logErr("转旁观失败：" + e3); }
    if (ok && quiet !== true) {
        try { p.sendMessage(LIB.textSpectate(nameOf(p), reason)); } catch (e4) { }
    }
    return ok;
}

function restoreTeam(p) {
    if (p == null) return false;
    var uuid = uuidOf(p);
    var t = GTB.origTeam[uuid];
    if (t == null) return false;
    delete GTB.origTeam[uuid];
    try { p.team(t); return true; } catch (e) { logErr("恢复队伍失败：" + e); return false; }
}

// ---------------------------------------------------------------- 名单

function addBlacklist(uuid, name, reason, silent) {
    var cfg0 = cfg();
    var list = LIB.addEntry(cfg0.blacklist, { uuid: uuid, name: name, reason: reason, at: nowMs() });
    cfg0.blacklist = list;
    GTB.banned[LIB.trimStr(uuid)] = true;
    swrite(LIB.KEYS.blacklist, LIB.dumpJsonArray(list));
    if (cfg0.vanillaBan) banVanilla(uuid);
    if (silent !== true) broadcast(LIB.textBan(name, reason));
    return true;
}

function removeBlacklist(uuid, why) {
    var cfg0 = cfg();
    var list = LIB.removeEntry(cfg0.blacklist, uuid);
    cfg0.blacklist = list;
    delete GTB.banned[LIB.trimStr(uuid)];
    swrite(LIB.KEYS.blacklist, LIB.dumpJsonArray(list));
    if (cfg0.vanillaBan) unbanVanilla(uuid);
    broadcast(LIB.textInfo("已移出黑名单（" + (why == null ? "手动" : why) + "）：" + LIB.safeName(uuid)));
    return true;
}

function addWatch(uuid, name) {
    var cfg0 = cfg();
    if (LIB.findIndex(cfg0.watch, uuid) >= 0) return false;
    cfg0.watch = LIB.addEntry(cfg0.watch, { uuid: uuid, name: name, at: nowMs() });
    GTB.watched[LIB.trimStr(uuid)] = true;
    swrite(LIB.KEYS.watch, LIB.dumpJsonArray(cfg0.watch));
    broadcast(LIB.textWatchAdd(name));
    return true;
}

function removeWatch(uuid) {
    var cfg0 = cfg();
    cfg0.watch = LIB.removeEntry(cfg0.watch, uuid);
    delete GTB.watched[LIB.trimStr(uuid)];
    swrite(LIB.KEYS.watch, LIB.dumpJsonArray(cfg0.watch));
    broadcast(LIB.textInfo("已移出观察名单：" + LIB.safeName(uuid)));
    return true;
}

function banVanilla(uuid) {
    try {
        if (Vars.netServer == null || Vars.netServer.admins == null) return false;
        return Vars.netServer.admins.banPlayerID(String(uuid)) === true;
    } catch (e) {
        logErr("写入游戏封禁失败：" + e);
        return false;
    }
}

function unbanVanilla(uuid) {
    try {
        if (Vars.netServer == null || Vars.netServer.admins == null) return false;
        return Vars.netServer.admins.unbanPlayerID(String(uuid)) === true;
    } catch (e) {
        return false;
    }
}

// 惩罚：拉黑 + 立刻转旁观
function punish(p, reason) {
    if (p == null) return;
    var uuid = uuidOf(p);
    var name = nameOf(p);
    addBlacklist(uuid, name, reason, true);
    broadcast(LIB.textBan(name, reason));
    toDerelict(p, reason, true);
    try { p.sendMessage("[scarlet]你已被移出本局：" + reason); } catch (e) { }
}

// ---------------------------------------------------------------- 行为：交互计数

function noteInteract(p, kind) {
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.interact) return;
    if (p == null) return;
    if (targetOf(p) !== "target") return;
    var uuid = uuidOf(p);
    var now = nowMs();
    var joined = GTB.joinedAt[uuid];
    if (joined != null && now - joined < 60000) return;
    var n = GTB.win.hit(uuid, now);
    if (n >= cfg0.thInteractCount) {
        GTB.win.clear(uuid);
        punish(p, LIB.REASON.interact + "：" + cfg0.thInteractWindow + " 秒内 " + n + " 次" + (kind == null ? "" : "（" + kind + "）"));
    }
}

// ---------------------------------------------------------------- 行为：病毒逻辑

function isLogicBuild(b) {
    try {
        if (b instanceof Packages.mindustry.world.blocks.logic.LogicBlock.LogicBuild) return true;
    } catch (e) { }
    return isLogicBlock(b);
}

// 判据同检查器 rules/virus-logic.json：某行是 ucontrol build … 且参数里出现 @this
function isVirusCode(code) {
    if (code == null) return false;
    var s = String(code);
    if (s === "") return false;
    var lines = s.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var line = LIB.trimStr(lines[i]);
        if (line === "") continue;
        if (line.indexOf("#") === 0) continue;
        if (line.indexOf("ucontrol build") !== 0) continue;
        if (line.indexOf("@this") >= 0) return true;
    }
    return false;
}

function disableLogic(b) {
    try {
        var asm = Packages.mindustry.logic.LAssembler.assemble("", false);
        b.executor.load(asm);
        // 代码也清掉：否则保存/重载、或别人再点一下配置，会按原代码重新编译回去。
        try { b.code = ""; } catch (e0) { }
        return true;
    } catch (e) {
        logErr("禁用逻辑失败：" + e);
        dbg("disableLogic failed " + e);
        return false;
    }
}

function checkVirus(b, p) {
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.virus) return false;
    var code = "";
    try { code = b.code == null ? "" : String(b.code); } catch (e) { return false; }
    if (!isVirusCode(code)) return false;
    var key = "";
    try { key = b.tile.x + "," + b.tile.y; } catch (e2) { key = ""; }
    if (key !== "") GTB_VIRUS[key] = true;
    disableLogic(b);
    dbg("virus disabled " + key + " by=" + (p == null ? "-" : nameOf(p)));
    broadcast(LIB.textInfo("已停用一处自复制逻辑（" + (key === "" ? "?" : key) + "）"));
    if (p == null || targetOf(p) !== "target") return true;
    punish(p, LIB.REASON.virus);
    return true;
}

// ---------------------------------------------------------------- 行为：钍堆

function nearestCoreTiles(b) {
    try {
        var team = b.team;
        if (team == null) return -1;
        var cores = team.data().cores;
        var n = seqSize(cores);
        var best = -1;
        for (var i = 0; i < n; i++) {
            var c = seqGet(cores, i);
            if (c == null) continue;
            var dx = (c.x - b.x) / 8.0;
            var dy = (c.y - b.y) / 8.0;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (best < 0 || d < best) best = d;
        }
        return best;
    } catch (e) {
        return -1;
    }
}

function checkReactorNear(b, p) {
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.reactorNear) return;
    if (p == null || targetOf(p) !== "target") return;
    var d = nearestCoreTiles(b);
    if (d < 0) return;
    if (d > cfg0.thReactorNear) return;
    var dist = Math.round(d * 10) / 10;
    broadcast(LIB.textWarn(nameOf(p), LIB.REASON.reactorNear + "：离核心 " + dist + " 格（上限 " + cfg0.thReactorNear + " 格）"));
    try { p.sendMessage(LIB.textWarn(nameOf(p), "钍堆离核心太近（" + dist + " 格 < " + cfg0.thReactorNear + " 格），请挪远。")); } catch (e) { }
}

// ---------------------------------------------------------------- 反射
//
// Rhino 里 "Packages.xxx.SomeClass" 是 NativeJavaClass，只暴露 **static** 成员：
// getDeclaredField / getField / getSuperclass / getName 这些 java.lang.Class 的实例方法
// 在它上面一律不可达（实测会抛 InternalError，或静默返回 null）。
// 但 "Packages.java.lang.Class.forName(name)" 返回的是**真 Class**，实例方法全可用。
// 所以按类名取字段要走 findFieldByName，不能直接拿类引用当 Class 用。
function findField(cls, name) {
    var c = cls;
    var guard = 0;
    while (c != null && guard < 64) {
        guard++;
        try { return c.getDeclaredField(name); } catch (e) { }
        try { c = c.getSuperclass(); } catch (e2) { return null; }
    }
    return null;
}

function findFieldByName(className, name) {
    try { return Packages.java.lang.Class.forName(className).getDeclaredField(name); } catch (e) { return null; }
}

function fieldByObject(obj, name) {
    // 真实例上 getClass() 返回可用 Class，所以先按动态类型找，再按类名兜底。
    var f = null;
    try { f = findField(obj.getClass(), name); } catch (e) { f = null; }
    if (f != null) return f;
    try { return findFieldByName(String(obj.getClass().getName()), name); } catch (e2) { return null; }
}

// ---------------------------------------------------------------- enabled 字段

// v146+ 的发布 jar 里没有 entities/comp 包：ECS 字段是"生成物"，
// mindustry/gen/Building.class 上声明 public boolean enabled（实测 flags 0x81）。
// public 字段在 Rhino 里可以直接读写，反射只是兜底。
function setEnabled(b, v) {
    if (b == null) return false;
    try { b.enabled = v === true; return b.enabled === (v === true); } catch (e) { }
    try {
        var f = fieldByObject(b, "enabled");
        if (f == null) return false;
        f.setAccessible(true);
        f.setBoolean(b, v === true);
        return true;
    } catch (e2) {
        return false;
    }
}

function getEnabled(b) {
    if (b == null) return true;
    try { return b.enabled === true; } catch (e) { }
    try {
        var f = fieldByObject(b, "enabled");
        if (f == null) return true;
        f.setAccessible(true);
        return f.getBoolean(b) === true;
    } catch (e2) {
        return true;
    }
}

// 读数字字段：先直接读（public 字段），失败走反射。
// 注意 heat 是 0..1 的**比例**（NuclearReactor 里 heat >= 0.999 就 kill()），不是绝对值。
function readNum(obj, name, dflt) {
    if (obj == null) return dflt;
    try {
        var v = obj[name];
        if (v != null) {
            var n = Number(v);
            if (!isNaN(n)) return n;
        }
    } catch (e) { }
    try {
        var f = fieldByObject(obj, name);
        if (f != null) {
            f.setAccessible(true);
            var m = Number(f.getFloat(obj));
            if (!isNaN(m)) return m;
        }
    } catch (e2) { }
    return dflt;
}

// 逻辑建筑判据：按方块类型判（issubclass），比 instanceof 嵌套 build 类更稳。
function isLogicBlock(b) {
    if (b == null) return false;
    try {
        return b.block instanceof Packages.mindustry.world.blocks.logic.LogicBlock;
    } catch (e) { return false; }
}

// ---------------------------------------------------------------- 扫描：钍堆热量 / 爆混发电机

var GTB_REACTORS = {};

function scanReactors() {
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    var arr = null;
    try { arr = Packages.mindustry.gen.Groups.build; } catch (e) { return; }
    var n = seqSize(arr);
    for (var i = 0; i < n; i++) {
        var b = seqGet(arr, i);
        if (b == null) continue;
        if (blockNameOf(b) !== "thorium-reactor") continue;
        var key = "";
        try { key = b.tile.x + "," + b.tile.y; } catch (e) { key = "?" + i; }
        var where0 = "第 " + LIB.toInt(key.split(",")[0], 0) + "," + LIB.toInt(key.split(",")[1], 0) + " 格";
        // heat 是 0..1 的比例（NuclearReactor 里 heat >= 0.999 就 kill()），不是绝对值
        var heat = readNum(b, "heat", 0);
        GTB.stat.reactors = GTB.stat.reactors + 1;
        if (heat > 0.0001) GTB.stat.hot = GTB.stat.hot + 1;
        if (cfg0.bh.reactorBoom && heat > 0.0001) {
            var seen = GTB_REACTORS[key] == true;
            if (getEnabled(b) !== true) {
                // 已经停过：不重复通告、不重复处置，只补记
                GTB_REACTORS[key] = true;
                continue;
            }
            var off = setEnabled(b, false);
            GTB_REACTORS[key] = true;
            var pct = Math.round(heat * 1000) / 10;
            dbg("reactor off " + key + " heat=" + pct + "% setEnabled=" + off + " seen=" + seen + " owner=" + (GTB.builders[key] == null ? "-" : GTB.builders[key].name));
            if (seen) continue;
            var owner = GTB.builders[key];
            if (owner == null) {
                broadcast(LIB.textInfo("发现正在升温的钍堆（" + where0 + "，热量 " + pct + "%），已停用。"));
            } else {
                var op = playerByUuid(owner.uuid);
                if (op != null) punish(op, LIB.REASON.reactorBoom + "（热量 " + pct + "%）");
                else addBlacklist(owner.uuid, owner.name, LIB.REASON.reactorBoom, true);
                broadcast(LIB.textInfo("已停用远端的升温钍堆（热量 " + pct + "%）"));
            }
        } else if (heat <= 0.0001 && GTB_REACTORS[key] == true) {
            setEnabled(b, true);
            delete GTB_REACTORS[key];
            dbg("reactor restored " + key);
        }
    }
}

function scanGenerators() {
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.blastGen) return;
    var arr = null;
    try { arr = Packages.mindustry.gen.Groups.build; } catch (e) { return; }
    var n = seqSize(arr);
    for (var i = 0; i < n; i++) {
        var b = seqGet(arr, i);
        if (b == null) continue;
        var name = blockNameOf(b);
        if (name !== "steam-generator" && name !== "combustion-generator" && name !== "turbine-generator") continue;
        var count = 0;
        try {
            if (b.items != null) count = LIB.toInt(b.items.get(Items.blastCompound), 0);
        } catch (e2) { count = 0; }
        GTB.stat.gens = GTB.stat.gens + 1;
        if (count <= 0) continue;
        try { b.items.set(Items.blastCompound, 0); } catch (e3) { try { b.items.clear(); } catch (e4) { } }
        setEnabled(b, false);
        var key = "";
        try { key = b.tile.x + "," + b.tile.y; } catch (e5) { key = "?" + i; }
        var owner = GTB.builders[key];
        var where = "第 " + LIB.toInt(key.split(",")[0], 0) + "," + LIB.toInt(key.split(",")[1], 0) + " 格";
        if (owner != null) {
            var op = playerByUuid(owner.uuid);
            if (op != null) {
                broadcast(LIB.textWarn(nameOf(op), LIB.REASON.blastGen + "：" + where + " 的" + (name === "steam-generator" ? "涡轮" : "发电机") + "已清空并停用"));
                try { op.sendMessage(LIB.textWarn(nameOf(op), "别给发电机装爆混（" + where + "）")); } catch (e6) { }
            }
        } else {
            broadcast(LIB.textInfo("已清空" + where + "发电机里的爆混并停用"));
        }
    }
}

// ---------------------------------------------------------------- 行为：AFK

function tickAfk(now) {
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.afk) return;
    var limit = cfg0.afkMinutes * 60000;
    eachPlayer(function (p) {
        var uuid = uuidOf(p);
        if (targetOf(p) !== "target") { delete GTB.afk[uuid]; return; }
        var u = null;
        try { u = p.unit(); } catch (e) { u = null; }
        if (u == null) { delete GTB.afk[uuid]; return; }
        var ax = 0, ay = 0;
        try { ax = Number(u.aimX()); ay = Number(u.aimY()); } catch (e2) { delete GTB.afk[uuid]; return; }
        var rec = GTB.afk[uuid];
        if (rec == null) { GTB.afk[uuid] = { ax: ax, ay: ay, at: now }; return; }
        var moved = Math.abs(rec.ax - ax) > 0.5 || Math.abs(rec.ay - ay) > 0.5;
        if (moved) { rec.ax = ax; rec.ay = ay; rec.at = now; return; }
        if (now - rec.at >= limit) {
            delete GTB.afk[uuid];
            var nm = nameOf(p);
            try { p.kick(Packages.mindustry.net.Packets.KickReason.kick); } catch (e3) { logErr("踢出失败：" + e3); }
            broadcast(LIB.textKick(nm, LIB.REASON.afk + "：" + cfg0.afkMinutes + " 分钟没瞄准"));
        }
    });
}

// ---------------------------------------------------------------- /vote kick 观察

function readField(obj, name) {
    if (obj == null) return null;
    try {
        var v = obj[name];
        if (v != null) return v;
    } catch (e) { }
    try {
        var f = fieldByObject(obj, name);
        if (f == null) return null;
        f.setAccessible(true);
        return f.get(obj);
    } catch (e2) {
        return null;
    }
}

function tickVote() {
    var cfg0 = cfg();
    var ns = null;
    try { ns = Vars.netServer; } catch (e) { return; }
    if (ns == null) return;
    var cur = null;
    try { cur = ns.currentlyKicking; } catch (e2) { return; }
    if (cur == null) {
        if (GTB.vote != null) {
            var saved = GTB.vote;
            GTB.vote = null;
            var p = playerByUuid(saved.uuid);
            if (p != null) {
                restoreTeam(p);
                try { p.sendMessage(LIB.textVoteBack(saved.name)); } catch (e3) { }
            }
        }
        return;
    }
    if (!cfg0.enable || !cfg0.votekick) return;
    var target = readField(cur, "target");
    if (target == null) return;
    var uuid = uuidOf(target);
    if (uuid === "") return;
    if (GTB.vote != null && GTB.vote.uuid === uuid) return;
    if (GTB.vote != null) {
        var old = GTB.vote;
        GTB.vote = null;
        var op = playerByUuid(old.uuid);
        if (op != null) restoreTeam(op);
    }
    if (isAdmin(target)) return;
    if (String(target.team().name) === "derelict") return;
    var t = null;
    try { t = target.team(); } catch (e4) { t = null; }
    GTB.vote = { uuid: uuid, name: nameOf(target), team: t };
    if (toDerelict(target, "投票踢出期间先旁观", true)) {
        broadcast(LIB.textVoteWatch(nameOf(target)));
    }
}

// ---------------------------------------------------------------- 管理员自动移出黑名单

function tickAdmins() {
    var cfg0 = cfg();
    eachPlayer(function (p) {
        if (!isAdmin(p)) return;
        var uuid = uuidOf(p);
        if (isBanned(uuid)) {
            removeBlacklist(uuid, "已设为管理员");
            try { p.sendMessage(LIB.textInfo("你已是管理员，已从 Grief to Ban 黑名单移出。")); } catch (e) { }
        }
    });
}

// ---------------------------------------------------------------- 加入 / 离开

function onJoin(p) {
    if (p == null) return;
    if (!isAuthority()) return;
    var uuid = uuidOf(p);
    GTB.joinedAt[uuid] = nowMs();
    delete GTB.afk[uuid];
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    if (isAdmin(p)) {
        if (isBanned(uuid)) removeBlacklist(uuid, "已是管理员");
        return;
    }
    if (isBanned(uuid)) {
        var e = LIB.findEntry(cfg0.blacklist, uuid);
        var reason = e == null ? "在黑名单中" : LIB.trimStr(e.reason);
        if (toDerelict(p, "黑名单：" + reason)) {
            broadcast(LIB.textSpectate(nameOf(p), "黑名单：" + reason));
        }
        return;
    }
    if (LIB.langHit(cfg0, p.locale)) {
        if (cfg0.langMode === "ban") {
            addBlacklist(uuid, nameOf(p), LIB.REASON.lang + "（" + LIB.normLocale(p.locale) + "）", true);
            broadcast(LIB.textBan(nameOf(p), LIB.REASON.lang + "（" + LIB.normLocale(p.locale) + "）"));
            toDerelict(p, LIB.REASON.lang, true);
        } else {
            addWatch(uuid, nameOf(p));
        }
    }
}

function onLeave(p) {
    if (p == null) return;
    var uuid = uuidOf(p);
    delete GTB.joinedAt[uuid];
    delete GTB.afk[uuid];
    delete GTB.origTeam[uuid];
    if (GTB.vote != null && GTB.vote.uuid === uuid) GTB.vote = null;
    try { GTB.win.clear(uuid); } catch (e) { }
}

// ---------------------------------------------------------------- 事件

function onBuildEnd(e) {
    if (!isAuthority()) return;
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    if (e.breaking === true) return;
    var p = null;
    try {
        var u = e.unit;
        if (u != null) p = u.getPlayer();
    } catch (err) { p = null; }
    // 建造不计入「交互」：正常铺产线 10 秒 20 块很常见，计入会误伤；
    // 交互只统计方块配置 / 控单位 / 指挥（见 onConfig 与 UnitControlEvent/BuildingCommandEvent）。
    var b = null;
    try { b = e.tile == null ? null : e.tile.build; } catch (e2) { b = null; }
    if (b == null) return;
    if (isLogicBuild(b)) {
        try { delete GTB_VIRUS[tileKey(e.tile)]; } catch (e9) { }
        checkVirus(b, p);
    }
    if (blockNameOf(b) === "thorium-reactor") {
        GTB.builders[tileKey(e.tile)] = { uuid: uuidOf(p), name: nameOf(p) };
        checkReactorNear(b, p);
    }
}

function onConfig(e) {
    if (!isAuthority()) return;
    var p = null;
    try { p = e.player; } catch (e1) { p = null; }
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    if (p != null) {
        noteInteract(p, "配置");
        if (targetOf(p) === "target") {
            var b = null;
            try { b = e.tile == null ? null : e.tile.build; } catch (e2) { b = null; }
            if (b != null) {
                if (isLogicBuild(b)) { try { delete GTB_VIRUS[tileKey(e.tile)]; } catch (e9) { } checkVirus(b, p); }
                if (blockNameOf(b) === "thorium-reactor") {
                    GTB.builders[tileKey(e.tile)] = { uuid: uuidOf(p), name: nameOf(p) };
                    checkReactorNear(b, p);
                }
                if (blockNameOf(b) === "steam-generator" || blockNameOf(b) === "combustion-generator") {
                    var cnt = 0;
                    try { cnt = LIB.toInt(b.items.get(Items.blastCompound), 0); } catch (e3) { cnt = 0; }
                    if (cnt > 0) {
                        try { b.items.set(Items.blastCompound, 0); } catch (e4) { try { b.items.clear(); } catch (e5) { } }
                        setEnabled(b, false);
                        broadcast(LIB.textWarn(nameOf(p), LIB.REASON.blastGen));
                    }
                }
            }
        }
    }
}

// 游戏默认封禁列表（vanillaBan 打开时以它为准）：每轮扫描缓存一次 uuid 集合
function refreshVanBan() {
    GTB.vanBan = {};
    var cfg0 = cfg();
    if (!cfg0.vanillaBan) return;
    try {
        if (Vars.netServer == null || Vars.netServer.admins == null) return;
        var seq = Vars.netServer.admins.getBanned();
        var n = seqSize(seq);
        for (var i = 0; i < n; i++) {
            var info = seqGet(seq, i);
            if (info == null) continue;
            try { GTB.vanBan[LIB.trimStr(info.id)] = true; } catch (e) { }
        }
    } catch (e2) { }
}

// 兜底：全图扫一遍已经存在的病毒逻辑（模组后加载 / 事件漏掉的情况）
var GTB_VIRUS = {};

function scanVirusQuick() {
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.virus) return;
    var arr = null;
    try { arr = Packages.mindustry.gen.Groups.build; } catch (e) { return; }
    var n = seqSize(arr);
    for (var i = 0; i < n; i++) {
        var b = seqGet(arr, i);
        if (b == null || !isLogicBuild(b)) continue;
        GTB.stat.logic = GTB.stat.logic + 1;
        var key = "";
        try { key = b.tile.x + "," + b.tile.y; } catch (e2) { key = "?" + i; }
        if (GTB_VIRUS[key] === true) continue;
        var code = "";
        try { code = b.code == null ? "" : String(b.code); } catch (e3) { continue; }
        if (!isVirusCode(code)) continue;
        GTB.stat.virus = GTB.stat.virus + 1;
        var owner = GTB.builders[key];
        var op = owner == null ? null : playerByUuid(owner.uuid);
        // 停用与处置分开：没主 / 不在观察名单，也要把逻辑停掉
        checkVirus(b, op);
        if (owner != null && op == null) addBlacklist(owner.uuid, owner.name, LIB.REASON.virus, true);
    }
}

function tick() {
    var now = nowMs();
    if (!isAuthority()) return;
    if (now - GTB.lastTick < 250) return;
    GTB.lastTick = now;
    try { tickVote(); } catch (e) { logErr("vote: " + e); }
    try { tickAdmins(); } catch (e2) { logErr("admins: " + e2); }
    try { tickAfk(now); } catch (e3) { logErr("afk: " + e3); }
    // 1 秒一轮：钍堆从开始升温到炸只有几秒，3 秒轮询会漏
    if (now - GTB.lastScan >= 1000) {
        GTB.lastScan = now;
        GTB.stat = { reactors: 0, hot: 0, logic: 0, virus: 0, gens: 0 };
        try { refreshVanBan(); } catch (e7) { }
        try { scanReactors(); } catch (e4) { logErr("reactors: " + e4); }
        try { scanGenerators(); } catch (e5) { logErr("gens: " + e5); }
        try { scanVirusQuick(); } catch (e8) { logErr("virus sweep: " + e8); }
        try {
            expose("gtb.scan", "builds=" + nBuilds() + " react=" + GTB.stat.reactors + " hot=" + GTB.stat.hot
                + " logic=" + GTB.stat.logic + " virus=" + GTB.stat.virus + " gens=" + GTB.stat.gens
                + " reactBoom=" + (cfg().bh.reactorBoom ? 1 : 0) + " virusOn=" + (cfg().bh.virus ? 1 : 0));
        } catch (eX) { }
        if (now - GTB_DBG.lastBeat >= 10000) {
            GTB_DBG.lastBeat = now;
            var c = cfg();
            dbg("beat " + authInfo() + " en=" + (c.enable ? 1 : 0) + " players=" + playerCount()
                + " builds=" + nBuilds() + " react=" + GTB.stat.reactors + " hot=" + GTB.stat.hot
                + " logic=" + GTB.stat.logic + " virus=" + GTB.stat.virus
                + " list=" + c.blacklist.length + " watch=" + c.watch.length);
        }
    }
    try { applyBlacklistToOnline(); } catch (e6) { }
}

// 配置变化/新加入的人：黑名单里的在线玩家一律旁观
function applyBlacklistToOnline() {
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    eachPlayer(function (p) {
        if (isAdmin(p)) return;
        var uuid = uuidOf(p);
        if (!isBanned(uuid)) return;
        var t = null;
        try { t = p.team(); } catch (e) { return; }
        if (String(t.name) === "derelict") return;
        toDerelict(p, "黑名单", true);
    });
}

function bindEvents() {
    Events.on(ET.PlayerJoin, function (e) { try { onJoin(e.player); } catch (err) { logErr("join: " + err); } });
    Events.on(ET.PlayerLeave, function (e) { try { onLeave(e.player); } catch (err) { } });
    Events.on(ET.BlockBuildEndEvent, function (e) { try { onBuildEnd(e); } catch (err) { logErr("build: " + err); } });
    Events.on(ET.ConfigEvent, function (e) { try { onConfig(e); } catch (err) { logErr("config: " + err); } });
    Events.on(ET.UnitControlEvent, function (e) { try { if (e.player != null) noteInteract(e.player, "控单位"); } catch (err) { } });
    Events.on(ET.BuildingCommandEvent, function (e) { try { if (e.player != null) noteInteract(e.player, "指挥方块"); } catch (err) { } });
    Events.run(ET.Trigger.update, function () { try { tick(); } catch (err) { } });
    Events.on(ET.WorldLoadEvent, function () {
        GTB.builders = {};
        GTB.win.clearAll();
        GTB.afk = {};
        GTB_REACTORS = {};
        GTB_VIRUS = {};
        GTB.lastScan = 0;
        GTB.lastTick = 0;
        try { reload(); } catch (e) { }
        dbg("world loaded " + authInfo());
    });
}

// ---------------------------------------------------------------- 设置界面

function themeColor() {
    try {
        var hex = LIB.trimStr(cfg().theme);
        if (hex !== "") return Color.valueOf(hex);
    } catch (e) { }
    try { return Pal.accent.cpy().lerp(Color.white, 0.3); } catch (e2) { return Color.white; }
}

function emphColor() {
    try {
        var hex = LIB.trimStr(cfg().emph);
        if (hex !== "") return Color.valueOf(hex);
    } catch (e) { }
    try { return Pal.accent; } catch (e2) { return Color.white; }
}

function statusObj() {
    var o = { version: LIB.VERSION, players: [], blacklistN: 0, watchN: 0, vanillaBanN: 0 };
    try {
        var cfg0 = cfg();
        o.blacklistN = cfg0.blacklist.length;
        o.watchN = cfg0.watch.length;
        if (cfg0.vanillaBan) {
            try { o.vanillaBanN = seqSize(Vars.netServer.admins.getBanned()); } catch (e) { o.vanillaBanN = 0; }
        }
        eachPlayer(function (p) {
            var team = "?";
            try { team = String(p.team().name); } catch (e) { }
            var loc = "";
            try { loc = String(p.locale == null ? "" : p.locale); } catch (e2) { loc = ""; }
            o.players.push({ uuid: uuidOf(p), name: nameOf(p), admin: isAdmin(p), locale: loc, team: team });
        });
    } catch (e3) { }
    return o;
}

// mod.hjson 里的 version（不能写正则字面量：v160.7 的 Rhino 会在构造期 codeBug）
function parseHjsonVersion(text) {
    var s = String(text == null ? "" : text);
    var i = s.indexOf("version");
    while (i >= 0) {
        var start = s.lastIndexOf("\n", i) + 1;
        var end = s.indexOf("\n", i);
        if (end < 0) end = s.length;
        var t = LIB.trimStr(s.substring(start, end));
        if (t.length > 8 && t.substring(0, 7) === "version") {
            var q1 = t.indexOf("\"");
            var q2 = q1 < 0 ? -1 : t.indexOf("\"", q1 + 1);
            if (q1 >= 0 && q2 > q1) return t.substring(q1 + 1, q2);
        }
        i = s.indexOf("version", i + 7);
    }
    return "";
}

// api.github.com 按 IP 限流（本机实测 403 rate limit exceeded），退一步读仓库里的 mod.hjson。
// raw.githubusercontent 走 CDN，没有这层限制，代价只是拿到的是 main 上的版本号。
function fetchRawVersion(tail, finish) {
    var url = "https://raw.githubusercontent.com/" + tail + "/main/GriefToBan/mod.hjson";
    try {
        Packages.arc.util.Http.get(url, function (res) {
            try {
                var v = parseHjsonVersion(String(res.getResultAsString()));
                if (v === "") { finish({ ok: false, latest: "", url: "", error: "读不到版本号" }); return; }
                finish({ ok: true, latest: v, url: "https://github.com/" + tail + "/releases", error: "" });
            } catch (e2) {
                finish({ ok: false, latest: "", url: "", error: "解析失败：" + e2 });
            }
        }, function (err) {
            finish({ ok: false, latest: "", url: "", error: String(err) });
        });
    } catch (e3) {
        finish({ ok: false, latest: "", url: "", error: String(e3) });
    }
}

function checkUpdate(cb) {
    var done = false;
    function finish(r) {
        if (done) return;
        done = true;
        GTB.update = r;
        try { cb(r); } catch (e) { }
    }
    var repo = LIB.trimStr(cfg().repo);
    if (repo === "") { finish({ ok: false, latest: "", url: "", error: "没有配置仓库地址" }); return; }
    var api = repo;
    var tail = "";
    var gi = repo.indexOf("github.com");
    if (gi >= 0) {
        tail = repo.substring(gi + "github.com".length);
        if (tail.length > 0 && tail.charAt(0) === "/") tail = tail.substring(1);
        while (tail.length > 0 && tail.charAt(tail.length - 1) === "/") tail = tail.substring(0, tail.length - 1);
        if (tail.length > 4 && tail.substring(tail.length - 4) === ".git") tail = tail.substring(0, tail.length - 4);
        api = "https://api.github.com/repos/" + tail + "/releases/latest";
    }
    try {
        Packages.arc.util.Http.get(api, function (res) {
            try {
                var body = String(res.getResultAsString());
                var o = JSON.parse(body);
                var tag = o.tag_name == null ? "" : String(o.tag_name);
                if (tag.length > 1 && tag.charAt(0) === "v") tag = tag.substring(1);
                var url = o.html_url == null ? "" : String(o.html_url);
                finish({ ok: true, latest: tag, url: url, error: "" });
            } catch (e2) {
                finish({ ok: false, latest: "", url: "", error: "解析失败：" + e2 });
            }
        }, function (err) {
            dbg("update: api failed (" + String(err) + "), trying raw");
            if (tail !== "") { fetchRawVersion(tail, finish); return; }
            finish({ ok: false, latest: "", url: "", error: String(err) });
        });
    } catch (e3) {
        if (tail !== "") { fetchRawVersion(tail, finish); return; }
        finish({ ok: false, latest: "", url: "", error: String(e3) });
    }
}

// 纯客户端（连别人的服）改不了名单，界面点了要给一句真话
function noAuth() {
    try { if (Vars.ui != null) Vars.ui.showText("Grief to Ban", "只有房主 / 服务端才能改名单与处置玩家。"); } catch (e) { }
    return false;
}

// 界面上的「写入自检」：写一个临时键、读回来、删掉，证明 Core.settings 真的能落盘
function selfTestWrite() {
    var key = "grief-to-ban.selftest";
    var val = "gtb-" + nowMs();
    var got = "";
    try {
        Core.settings.put(key, val);
        got = Core.settings.getString(key, "");
        try { Core.settings.remove(key); } catch (e1) { }
        try { Core.settings.autosave(); } catch (e2) { }
    } catch (e) {
        dbg("testWrite crash " + e);
        return "写入崩溃：" + e;
    }
    var ok = got === val;
    dbg("testWrite ok=" + ok + " want=" + val + " got=" + got);
    if (ok) return "写入自检通过（读完 " + val.length + " 字符一致）";
    return "写入自检失败：写进去的是 [" + val + "]，读回来的是 [" + got + "]";
}

var uiApi = {
    lib: LIB,
    cfg: function () { return cfg(); },
    set: function (key, value) { swrite(key, value); reload(); },
    setList: function (key, arr) { swrite(key, LIB.dumpJsonArray(arr)); reload(); },
    changed: function () { reload(); },
    rebuild: function () {
        var host = GTB.uiHost;
        if (host == null) return;
        try {
            Core.app.post(function () {
                try { buildSettingsTable(host); } catch (e) { logErr("rebuild: " + e); }
            });
        } catch (e2) { }
    },
    theme: function () { return themeColor(); },
    emph: function () { return emphColor(); },
    status: function () { return statusObj(); },
    // 名单动作成功后必须重画：不然「加进去了但列表还是空的」看起来像没写入
    addBlacklist: function (uuid, name, reason) {
        if (!isAuthority()) return noAuth();
        var r = addBlacklist(uuid, LIB.safeName(name), reason == null ? "手动" : reason, false);
        uiApi.rebuild();
        return r;
    },
    removeBlacklist: function (uuid) { if (!isAuthority()) return noAuth(); var r = removeBlacklist(uuid, "手动"); uiApi.rebuild(); return r; },
    addWatch: function (uuid, name) { if (!isAuthority()) return noAuth(); var r = addWatch(uuid, name == null ? LIB.shortId(uuid) : LIB.safeName(name)); uiApi.rebuild(); return r; },
    removeWatch: function (uuid) { if (!isAuthority()) return noAuth(); var r = removeWatch(uuid); uiApi.rebuild(); return r; },
    unbanVanilla: function (uuid) { if (!isAuthority()) return noAuth(); return unbanVanilla(uuid); },
    checkUpdate: function (cb) { checkUpdate(cb); },
    authInfo: function () { return authInfo(); },
    diag: function () { return diagText(); },
    logPath: function () { var f = dbgFile(); return f == null ? "" : String(f.absolutePath()); },
    logText: function () { return dbgText(); },
    clearLog: function () { dbgClear(); return "日志已清空"; },
    testWrite: function () { return selfTestWrite(); },
    notice: function (text) {
        try { if (Vars.ui != null) Vars.ui.showText("Grief to Ban", String(text)); } catch (e) { }
    }
};

function buildSettingsTable(t) {
    GTB.uiHost = t;
    try { t.clearChildren(); } catch (e) { }
    if (UIMOD == null) {
        try { t.add("[scarlet]gtb-ui.js 没有加载").row(); } catch (e2) { }
        return;
    }
    var mk = function () { return new Packages.arc.scene.ui.layout.Table(); };
    try {
        UIMOD.build(t, mk, uiApi);
    } catch (e3) {
        logErr("界面构建失败：" + e3);
        try { t.add("[scarlet]界面构建失败：" + e3).row(); } catch (e4) { }
    }
}

function buildCategory() {
    if (GTB.registered === true) return;
    if (Vars.ui == null) return;
    try {
        if (Vars.ui.settings == null) return;
    } catch (e) { return; }
    var icon = null;
    try { icon = Packages.mindustry.gen.Icon.hammer; } catch (e2) { icon = null; }
    var builder = function (t) { buildSettingsTable(t); };
    try {
        if (icon != null) Vars.ui.settings.addCategory("Grief to Ban", icon, builder);
        else Vars.ui.settings.addCategory("Grief to Ban", builder);
        GTB.registered = true;
        logInfo("设置分类已注册");
    } catch (e3) {
        logErr("注册设置分类失败：" + e3);
    }
}

function registerSettings() {
    Events.on(ET.ClientLoadEvent, function () {
        try { buildCategory(); } catch (e) { logErr("注册设置分类：" + e); }
        try { registerPauseMenu(); } catch (e2) { logErr("暂停菜单：" + e2); }
        try { autoUpdateNotice(); } catch (e3) { }
    });
    // 单机 / 房主这边 ClientLoadEvent 可能已经走过了，先补一次
    try { buildCategory(); } catch (e4) { }
    try { registerPauseMenu(); } catch (e5) { }
    try { autoUpdateNotice(); } catch (e6) { }
}

// ---------------------------------------------------------------- 暂停菜单入口

function openGtbDialog() {
    try {
        var d = new Packages.arc.scene.ui.Dialog("Grief to Ban");
        var host = new Packages.arc.scene.ui.layout.Table();
        buildSettingsTable(host);
        try { d.cont.pane(host).width(620).height(420).row(); }
        catch (ep) { d.cont.add(host).row(); }
        d.buttons.button("关闭", function () { d.hide(); }).width(110);
        d.show();
        dbg("pause dialog opened");
    } catch (e) {
        logErr("打开设置窗失败：" + e);
        try { if (Vars.ui != null) Vars.ui.showText("Grief to Ban", "打开设置窗失败：" + e); } catch (e2) { }
    }
}

function addPauseEntry(pd) {
    if (pd == null) return false;
    try {
        if (pd.cont == null) return false;
        pd.cont.row();
        pd.cont.button("Grief to Ban", openGtbDialog).size(220, 50).pad(5);
        return true;
    } catch (e) {
        logErr("暂停菜单条目失败：" + e);
        return false;
    }
}

function registerPauseMenu() {
    var ui = null;
    try { ui = Vars.ui; } catch (e) { ui = null; }
    if (ui == null) return false;
    var pd = null;
    try { pd = ui.paused; } catch (e2) { pd = null; }
    if (pd == null) return false;
    if (GTB.pauseHooked === true) return true;
    try {
        pd.shown(function () {
            // PausedDialog 每次 show 都 rebuild + clearChildren，所以每次都重挂一遍
            try { Core.app.post(function () { addPauseEntry(pd); }); } catch (e3) { addPauseEntry(pd); }
        });
        GTB.pauseHooked = true;
        logInfo("暂停菜单入口已挂");
        return true;
    } catch (e4) {
        logErr("挂暂停菜单失败：" + e4);
        return false;
    }
}

// ---------------------------------------------------------------- 更新检查（进服/建房时自动跑一次）

function autoUpdateNotice() {
    if (GTB.cfg != null && GTB.cfg.updateCheck !== true) return;
    try {
        checkUpdate(function (r) {
            try {
                if (r == null) { dbg("update: no result"); return; }
                if (r.ok !== true) {
                    var msg = String(r.error);
                    if (msg.indexOf("404") >= 0) dbg("update: repo has no release yet");
                    else dbg("update: check failed " + msg);
                    return;
                }
                if (LIB.newerAvailable(LIB.VERSION, r.latest)) {
                    dbg("update available " + r.latest + " " + r.url);
                    broadcast(LIB.textInfo("Grief to Ban 有新版本 v" + r.latest + "：" + r.url));
                } else {
                    dbg("update: latest=" + r.latest + " current=" + LIB.VERSION);
                }
            } catch (e) { dbg("update cb crash " + e); }
        });
    } catch (e2) { dbg("update crash " + e2); }
}

// ---------------------------------------------------------------- 自检（服务器探针用）

function selfTest() {
    var fails = [];
    var lines = [];
    function chk(cond, label) { lines.push((cond ? "ok " : "FAIL ") + label); if (!cond) fails.push(label); }
    chk(LIB.trimStr("  a ") === "a", "lib.trim");
    chk(LIB.safeName("[scarlet]bob[white]") === "bob", "lib.safeName");
    chk(LIB.localeInList("zh_CN", "zh_cn,en"), "lib.localeInList");
    var w = new LIB.Window(1000);
    w.hit("k", 1000); w.hit("k", 1500);
    chk(w.count("k", 1800) === 2, "lib.Window.count");
    chk(w.count("k", 2600) === 0, "lib.Window.expire");
    chk(LIB.cmpVersion("1.2.10", "1.2.9") === 1, "lib.cmpVersion");
    var c = LIB.readConfig(function () { return undefined; });
    chk(c.enable === true && c.langMode === "off" && c.thReactorNear === 30, "lib.readConfig defaults");
    chk(LIB.dumpBehaviors(c.bh) === LIB.dumpBehaviors(LIB.DEFAULTS.bh), "lib.behaviors roundtrip");
    chk(LIB.isVirusProbe === undefined, "no stray export");
    // gtb-ui.js 在 main.js:8 就 require 了：这条同时证明"界面模块能在 Rhino 里解析并导出 build"
    chk(UIMOD != null && typeof UIMOD.build === "function", "ui module build()");
    chk(typeof dbg === "function" && typeof authInfo === "function", "debug helpers");
    try { chk(diagText().indexOf("auth=") >= 0, "diag text"); } catch (eD) { lines.push("FAIL diag: " + eD); fails.push("diag"); }
    chk(readNum({ heat: 0.5 }, "heat", 0) === 0.5, "readNum public field");
    chk(isLogicBuild({ block: Packages.mindustry.content.Blocks.microProcessor }) === true, "isLogicBuild by block");
    try {
        var gb = Packages.mindustry.gen.Groups.build;
        chk(seqSize(gb) >= 0, "seq size");
        chk(seqGet(gb, 0) !== undefined, "seq get/index");
    } catch (eQ) { lines.push("FAIL seq: " + eQ); fails.push("seq"); }
    // 黑名单落盘这条路：写进去 → 从 Core.settings 读回 → 再删掉（只在 GTB_SELFTEST 时跑）
    try {
        var beforeN = cfg().blacklist.length;
        addBlacklist("selftest-uuid", "SelfTest", "自检", true);
        var raw = "";
        try { raw = String(Core.settings.getString(LIB.KEYS.blacklist, "")); } catch (eR) { raw = ""; }
        chk(raw.indexOf("selftest-uuid") >= 0, "blacklist persisted");
        removeBlacklist("selftest-uuid", "自检");
        chk(cfg().blacklist.length === beforeN, "blacklist removed");
    } catch (eBL) { lines.push("FAIL blacklist: " + eBL); fails.push("blacklist"); }
    var f = findFieldByName("mindustry.gen.Building", "enabled");
    chk(f != null, "field gen.Building.enabled");
    if (f != null) {
        try { chk((f.getModifiers() & 1) !== 0, "enabled is public"); } catch (e1) { lines.push("FAIL enabled publics: " + e1); fails.push("enabled public"); }
        try { chk(String(f.getType().getName()) === "boolean", "enabled is boolean"); } catch (e2) { lines.push("FAIL enabled type: " + e2); fails.push("enabled type"); }
    }
    chk(findFieldByName("mindustry.core.NetServer$VoteSession", "target") != null, "field VoteSession.target");
    chk(getEnabled({ enabled: true }) === true && getEnabled({ enabled: false }) === false, "enabled reader");
    chk(setEnabled({}, true) === true, "enabled writer");
    try { chk(Packages.mindustry.content.Items.blastCompound != null, "item blastCompound"); } catch (e) { lines.push("FAIL item: " + e); fails.push("item"); }
    try { chk(Packages.mindustry.content.Blocks.thoriumReactor != null, "block thoriumReactor"); } catch (e) { lines.push("FAIL block: " + e); fails.push("block"); }
    try { chk(Packages.mindustry.world.blocks.logic.LogicBlock.LogicBuild != null, "class LogicBuild"); } catch (e) { lines.push("FAIL logic: " + e); fails.push("logic"); }
    try { chk(Packages.arc.util.Http != null, "http"); } catch (e) { lines.push("FAIL http: " + e); fails.push("http"); }
    chk(parseHjsonVersion('name: "x"\nversion: "0.1.2"\nminGameVersion: "146"') === "0.1.2", "hjson version");
    chk(parseHjsonVersion('minGameVersion: "146"') === "", "hjson skips minGameVersion");
    chk(isVirusCode("ucontrol build 1 2 @micro-processor 0 @this") === true, "virus detect true");
    chk(isVirusCode("sensor x core1 @copper") === false, "virus detect false");
    var tag = fails.length === 0 ? "OK" : "FAIL";
    logInfo("selftest " + tag + " (" + fails.length + " fail)\n" + lines.join("\n"));
}

function selftestIfAsked() {
    var v = null;
    try { v = String(Packages.java.lang.System.getenv("GTB_SELFTEST")); } catch (e) { v = null; }
    if (v == null || v === "null" || v === "") return;
    try { selfTest(); } catch (e) { logErr("selftest crashed: " + e); }
    try { Core.app.exit(); } catch (e2) { }
}

// ---------------------------------------------------------------- 启动

function init() {
    try { reload(); } catch (e) { logErr("读取配置失败：" + e); }
    try { bindEvents(); } catch (e2) { logErr("绑定事件失败：" + e2); }
    try { registerSettings(); } catch (e3) { }
    dbg("init v" + LIB.VERSION + " " + authInfo());
    GTB_DBG.lastBeat = nowMs();
    logInfo("Grief to Ban v" + LIB.VERSION + " 已加载（enable=" + (GTB.cfg == null ? "?" : GTB.cfg.enable) + "，黑名单 " + (GTB.cfg == null ? 0 : GTB.cfg.blacklist.length) + " 条）");
    selftestIfAsked();
}

init();
