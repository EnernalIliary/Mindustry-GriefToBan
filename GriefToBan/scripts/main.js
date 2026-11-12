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

// 同值不重复写，autosave 攒起来由 tick 最多 1.5 秒落一次盘。
// 原来每次名单变动都 put + 读回 + Core.settings.autosave()（写 287KB settings.bin 并滚动备份），
// 而真机日志里黑名单成对重写（len=106 → len=2）每秒来一次 ⇒ 主线程被磁盘 I/O 拖住。
var GTB_DIRTY = { on: false, at: 0 };

function swrite(key, value) {
    try {
        if (typeof value === "boolean") {
            if (sread(key) === value) return;
            Core.settings.put(key, value);
        } else if (typeof value === "number") {
            if (LIB.toInt(sread(key), -999999) === LIB.toInt(value, 0)) return;
            Core.settings.put(key, LIB.toInt(value, 0));
        } else {
            var s = value == null ? "" : String(value);
            if (String(sread(key)) === s) return;          // 内容没变：不写、不落盘、不记日志
            Core.settings.put(key, s);
            var back = "";
            try { back = Core.settings.getString(key, ""); } catch (e1) { back = ""; }
            if (String(back) !== s) dbg("swrite MISMATCH " + key + " want=" + s.length + " got=" + String(back).length);
            else dbg("swrite " + key + " len=" + String(back).length);
        }
        GTB_DIRTY.on = true;
    } catch (e) {
        logInfo("写设置失败 " + key + "：" + e);
    }
}

function flushSettings(now) {
    if (!GTB_DIRTY.on) return;
    if (now - GTB_DIRTY.at < 1500) return;
    GTB_DIRTY.at = now;
    GTB_DIRTY.on = false;
    try { Core.settings.autosave(); } catch (e9) { }
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

// 日志先攒内存、成批落盘：原来每行一次 open/append/close，大图上每秒几十行 ⇒ 主线程 I/O。
// 攒满 40 行或每 500ms 由 tick 冲一次；行数上限仍是 3000。
var GTB_DBG_BUF = { lines: [], at: 0 };

function dbg(msg) {
    try {
        if (GTB_DBG.lines >= 3000) return;
        GTB_DBG.lines = GTB_DBG.lines + 1;
        GTB_DBG_BUF.lines.push(nowMs() + " " + String(msg));
        if (GTB_DBG_BUF.lines.length >= 40) dbgFlush();
    } catch (e) { }
}

function dbgFlush() {
    try {
        if (GTB_DBG_BUF.lines.length === 0) return;
        var s = GTB_DBG_BUF.lines.join("\n") + "\n";
        GTB_DBG_BUF.lines = [];
        GTB_DBG_BUF.at = nowMs();
        var f = dbgFile();
        if (f == null) return;
        f.writeString(s, true);
    } catch (e) { try { GTB_DBG_BUF.lines = []; } catch (e2) { } }
}

function dbgClear() {
    try {
        var f = dbgFile();
        if (f == null) return false;
        try { GTB_DBG_BUF.lines = []; } catch (e0) { }
        f.writeString("", false);
        GTB_DBG.lines = 0;
        dbg("log cleared");
        dbgFlush();
        return true;
    } catch (e) { return false; }
}

function dbgText() {
    try {
        dbgFlush();
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

// 地图编辑器（Rules.editor=true，Rules.java:51）是单人沙盒：没有别人可 grief，
// 方块只是地图数据。以前这套东西在里面照跑（每秒 3 遍全图扫描 + 改 enabled），
// 这就是「启用本模组后进编辑器很慢、长时间未响应」的来源（用户 2026-11-12 报）。
// 编辑器里 tick / onBuildEnd / onConfig 一律不碰世界。
var GTB_EDITOR_SEEN = false;

function inEditor() {
    try {
        var st = Vars.state;
        if (st == null) return false;
        var r = st.rules;
        if (r != null && r.editor === true) { GTB_EDITOR_SEEN = true; return true; }
    } catch (e) { }
    return false;
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
// 只有 size() / index(int) / each(...)（EntityGroup.java:231/235），**没有 get(int)**。
// 这条曾让所有扫描静默空转；更糟的是老写法「先试 seq.get(i)」会给每个元素抛一次
// TypeError 再被 catch 吃掉 —— 大图 8311 个方块 × 每秒 3 遍扫描 ≈ 每秒 2.5 万次异常构造，
// 主线程被吃干净，真机表现就是「进地图编辑器后长时间未响应」（用户 2026-11-12 报）。
// 现在 index() 在前，热路径不再产生任何异常。
function seqGet(seq, i) {
    if (seq == null) return null;
    try { var b2 = seq.index(i); if (b2 != null) return b2; } catch (e2) { }
    try { var a = seq.get(i); if (a != null) return a; } catch (e) { }
    try { var arr = seq.items; if (arr != null && i < arr.length) return arr[i]; } catch (e3) { }
    return null;
}

// 热路径遍历：size 只算一次，循环里只调 index(i)。
function seqIter(seq, fn) {
    if (seq == null || fn == null) return 0;
    var n = seqSize(seq);
    for (var i = 0; i < n; i++) {
        var it = null;
        try { it = seq.index(i); } catch (e) { continue; }
        if (it != null) fn(it, i);
    }
    return n;
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
    // 控单位 / 指挥 / 配置都算「做过别的事」，之后不再按「进服第一个动作」判
    firstClear(p);
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
var GTB_GENS = {};
// 进服后的第一个动作：如果第一件事就是拆建筑，直接拉黑 + 通告，并把建筑按原样放回去。
// 只跟踪「刚进服、还没做过任何别的事」的人；建方块 / 改配置 / 控单位 / 指挥都算做过别的事。
var GTB_FIRST = {};
// 正在被拆、但还没拆完的建筑：键是 tileKey，值是 { snap, name }。
// 拆除一开始（Build.beginBreak）tile 就被换成 ConstructBlock、原方块存进 previous，
// 等到 deconstructFinish 时 tile.block() 已经是 build1/2/3 —— 拿它还原会得到一个
// previous=air 的构造块，看上去就是"放回去的是空的"。所以快照必须在拆的一开始做。
var GTB_BREAK = {};

function firstMark(p) {
    var uuid = uuidOf(p);
    if (uuid === "") return;
    GTB_FIRST[uuid] = { t: nowMs(), done: false };
}

function firstClear(p) {
    if (p == null) return;
    var rec = GTB_FIRST[uuidOf(p)];
    if (rec != null) rec.done = true;
}

function firstPending(p) {
    if (p == null) return false;
    var rec = GTB_FIRST[uuidOf(p)];
    return rec != null && rec.done !== true;
}

// 时间窗与「多次交互」共用同一个秒数（cfg.thInteractWindow，默认 10 秒）：
// 进服后才动手的快速骚扰号才判，进服很久以后拆一块自己的东西不该被算成第一件事。
function firstRecent(p, winSec) {
    if (p == null) return false;
    var rec = GTB_FIRST[uuidOf(p)];
    if (rec == null || rec.done === true) return false;
    var win = LIB.toInt(winSec, 0) * 1000;
    if (win <= 0) return true;
    return (nowMs() - LIB.toInt(rec.t, 0)) <= win;
}

// 建筑里装的物品 / 液体：content 表的每一项都问一次，只留数量 > 0 的。
// 不用 ItemModule.each(LiquidModule.each)：那是 Java 单方法接口，无头环境里传 JS 函数不一定认。
function itemSnapshot(m) {
    var out = [];
    try {
        var seq = Packages.mindustry.Vars.content.items();
        if (seq == null) return out;
        var n = LIB.toInt(seq.size, 0);
        for (var i = 0; i < n; i++) {
            var it = seq.get(i);
            var q = LIB.toInt(m.get(it), 0);
            if (q > 0) out.push({ item: it, amount: q });
        }
    } catch (e) { }
    return out;
}

function liquidSnapshot(m) {
    var out = [];
    try {
        var seq = Packages.mindustry.Vars.content.liquids();
        if (seq == null) return out;
        var n = LIB.toInt(seq.size, 0);
        for (var i = 0; i < n; i++) {
            var lq = seq.get(i);
            var q = Number(m.get(lq));
            if (q > 0.0001) out.push({ liquid: lq, amount: q });
        }
    } catch (e) { }
    return out;
}

function restoreInventory(b, snap) {
    if (b == null || snap == null) return;
    try {
        if (b.items != null && snap.items != null) {
            try { b.items.clear(); } catch (e0) { }
            for (var i = 0; i < snap.items.length; i++) {
                try { b.items.set(snap.items[i].item, snap.items[i].amount); } catch (e1) { }
            }
        }
    } catch (e) { }
    try {
        if (b.liquids != null && snap.liquids != null) {
            try { b.liquids.clear(); } catch (e2) { }
            for (var j = 0; j < snap.liquids.length; j++) {
                try { b.liquids.set(snap.liquids[j].liquid, snap.liquids[j].amount); } catch (e3) { }
            }
        }
    } catch (e4) { }
}

function isConstructBlock(b) {
    if (b == null) return false;
    try { return b instanceof Packages.mindustry.world.blocks.ConstructBlock; } catch (e) { return false; }
}

// 拆除刚开始时的快照：这时候 tile.block() 已经变成 ConstructBlock，
// 原方块在 cb.previous、原建筑实例（还带着物品与液体）在 cb.prevBuild[0]。
function breakSnapshot(t, cb) {
    if (t == null || cb == null) return null;
    var snap = { block: null, team: null, rot: 0, conf: null, hp: 1, items: null, liquids: null };
    try { snap.block = cb.previous; } catch (e1) { snap.block = null; }
    try { if (snap.block === Packages.mindustry.content.Blocks.air) snap.block = null; } catch (e2) { }
    if (snap.block == null) return null;
    var old = null;
    try { if (cb.prevBuild != null && cb.prevBuild.size > 0) old = cb.prevBuild.get(0); } catch (e3) { old = null; }
    if (old != null) {
        try { snap.team = old.team; } catch (e4) { }
        try { snap.rot = old.rotation; } catch (e5) { }
        try { snap.conf = old.config(); } catch (e6) { }
        try { snap.hp = old.healthf(); } catch (e7) { }
        try { if (old.items != null) snap.items = itemSnapshot(old.items); } catch (e8) { }
        try { if (old.liquids != null) snap.liquids = liquidSnapshot(old.liquids); } catch (e9) { }
    } else {
        try { snap.rot = cb.rotation; } catch (e10) { }
    }
    if (snap.team == null) { try { snap.team = t.team(); } catch (e11) { } }
    return snap;
}

// 拆除事件发生在 tile.remove() 之前 ⇒ 这时候还能读到原方块的种类 / 队伍 / 朝向 / 配置 / 血量 / 库存
function tileSnapshot(t) {
    if (t == null) return null;
    var snap = { block: null, team: null, rot: 0, conf: null, hp: 1, items: null, liquids: null };
    try {
        snap.block = t.block();
        snap.team = t.team();
        var b = t.build;
        if (b != null) {
            try { snap.rot = b.rotation; } catch (e1) { }
            try { snap.conf = b.config(); } catch (e2) { }
            try { snap.hp = b.healthf(); } catch (e3) { }
            try { if (b.items != null) snap.items = itemSnapshot(b.items); } catch (e4) { }
            try { if (b.liquids != null) snap.liquids = liquidSnapshot(b.liquids); } catch (e5) { }
        }
    } catch (e) { return null; }
    return snap.block == null ? null : snap;
}

// 联机时服务端改图要走 setNet（Call.setTile），否则只有主机自己看得见；
// 有的版本 setNet 只发不收，落不下去就退回 setBlock。
function placeBlock(t, snap) {
    var on = false;
    try { on = Packages.mindustry.Vars.net != null && Packages.mindustry.Vars.net.active() === true; } catch (e1) { on = false; }
    if (on) {
        try { t.setNet(snap.block, snap.team, snap.rot); } catch (e2) { }
        try { if (t.block() === snap.block) return true; } catch (e3) { }
    }
    t.setBlock(snap.block, snap.team, snap.rot);
    return true;
}

// 放回原方块。allowConstruct=true 时允许覆盖正在拆的 ConstructBlock（拆除刚开始就原地撤销）；
// 否则只在原位已经空了（tile.remove() 之后是 air）时才动，避免盖掉别人刚铺的东西。
function restoreTile(t, snap, allowConstruct) {
    if (t == null || snap == null) return false;
    try {
        var air = Packages.mindustry.content.Blocks.air;
        var cur = t.block();
        if (cur !== air && !(allowConstruct === true && isConstructBlock(cur))) return false;
        placeBlock(t, snap);
        var nb = t.build;
        if (nb != null) {
            try { if (snap.hp < 1) nb.health = snap.block.health * snap.hp; } catch (e1) { }
            if (snap.conf != null) { try { nb.configured(null, snap.conf); } catch (e2) { } }
            restoreInventory(nb, snap);
        }
        return true;
    } catch (e) { logErr("restore: " + e); return false; }
}

// 拆除刚开始（Build.beginBreak 里 tile 已换成 ConstructBlock 之后触发）：这一瞬间就能判，
// 不用等方块真的被拆完；而且原地把 ConstructBlock 换回原方块就等于撤销了这次拆除。
function firstBreakBegin(e, p) {
    if (p == null || !firstPending(p)) return false;
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.firstBreak) { firstClear(p); return false; }
    if (!firstRecent(p, cfg0.thInteractWindow)) { firstClear(p); return false; }
    if (isAdmin(p) || targetOf(p) !== "target") { firstClear(p); return false; }
    var t = null, cb = null, snap = null;
    try { t = e.tile; } catch (e1) { t = null; }
    try { cb = t == null ? null : t.build; } catch (e2) { cb = null; }
    if (!isConstructBlock(cb)) return false;
    try { snap = breakSnapshot(t, cb); } catch (e3) { snap = null; }
    if (snap == null) return false;
    var nm = nameOf(p);
    var key = tileKey(t);
    firstClear(p);
    punish(p, LIB.REASON.firstBreak);
    if (key !== "") GTB_BREAK[key] = { snap: snap, name: nm };
    var back = false;
    try { back = restoreTile(t, snap, true); } catch (e4) { back = false; }
    if (back) {
        if (key !== "") delete GTB_BREAK[key];
        broadcast(LIB.textInfo("已把 " + nm + " 拆掉的建筑放回原处。"));
    }
    return back;
}

// 兜底：instantDeconstruct 的方块不触发 begin 事件（Build.beginBreak 里直接 deconstructFinish）；
// 以及 begin 时没能立刻放回的情况，在这里按拆除结束事件处理。
function firstBreakCheck(e, p) {
    if (p == null || !firstPending(p)) return;
    var cfg0 = cfg();
    if (!cfg0.enable || !cfg0.bh.firstBreak) { firstClear(p); return; }
    if (!firstRecent(p, cfg0.thInteractWindow)) { firstClear(p); return; }
    if (isAdmin(p) || targetOf(p) !== "target") { firstClear(p); return; }
    var t = null, cur = null, snap = null;
    try { t = e.tile; } catch (e1) { t = null; }
    try { cur = t == null ? null : t.block(); } catch (e0) { cur = null; }
    if (isConstructBlock(cur)) {
        // 拆除中途：原方块在 GTB_BREAK 里（onBuildEnd 的 breaking 分支会用），这里不重复处置
        return;
    }
    try { snap = tileSnapshot(t); } catch (e2) { snap = null; }
    var nm = nameOf(p);
    firstClear(p);
    punish(p, LIB.REASON.firstBreak);
    if (snap == null) return;
    // 拆除事件之后这一帧 tile 才被清空，下一帧再放回去
    Packages.arc.Core.app.post(function () {
        try {
            if (restoreTile(t, snap)) {
                broadcast(LIB.textInfo("已把 " + nm + " 拆掉的建筑放回原处。"));
            }
        } catch (e3) { logErr("restore post: " + e3); }
    });
}

// 读建筑里的物品 / 液体：没有对应模块的建筑上 b.items / b.liquids 是 null
function itemCount(b, item) {
    if (b == null) return 0;
    try {
        if (b.items != null) return LIB.toInt(b.items.get(item), 0);
    } catch (e) { }
    return 0;
}

function liquidAmount(b, liquid) {
    if (b == null) return 0;
    try {
        if (b.liquids != null) return Number(b.liquids.get(liquid));
    } catch (e) { }
    return 0;
}

function hasCryo(b) {
    try { return liquidAmount(b, Packages.mindustry.content.Liquids.cryofluid) > 0.0001; } catch (e) { return false; }
}

// 钍堆什么时候可以重新启用：钍被取空，或者已经通上冷冻液（热量会自己降下来）。
// 不用「热量归零」当判据 —— 钍还在时热量会一直涨，归零就恢复等于让它在 0 和 100 之间来回跳。
function reactorSafe(b) {
    try { if (itemCount(b, Packages.mindustry.content.Items.thorium) <= 0) return true; } catch (e) { }
    return hasCryo(b);
}

function isBlastGenName(name) {
    return name === "steam-generator" || name === "combustion-generator" || name === "turbine-generator";
}

function genLabel(name) {
    if (name === "steam-generator") return "蒸汽发电机";
    if (name === "turbine-generator") return "涡轮发电机";
    return "火电";
}

// 处置建造者：在线就当场拉黑 + 转旁观，离线就写进黑名单。
// 爆混发电机 / 钍堆都要能追到人，否则「停用了但没人被拉黑」等于没处置。
function punishBuilder(owner, reason, extra) {
    var msg = extra == null ? "" : String(extra);
    // 一轮扫描里处置太多人 = 一次性几十次 autosave + 广播，主线程会被堵住；
    // 超出预算的先只停用，下一秒那轮再拉黑（对 grief 来说晚 1 秒没有区别）。
    if (GTB_PUNISH.n >= GTB_PUNISH.max) {
        dbg("punish budget full, defer " + (owner == null ? "-" : owner.name));
        if (msg !== "") broadcast(LIB.textInfo(msg));
        return;
    }
    GTB_PUNISH.n = GTB_PUNISH.n + 1;
    if (owner != null) {
        var op = playerByUuid(owner.uuid);
        if (op != null) {
            if (isAdmin(op)) {
                dbg("owner is admin, skip punish: " + nameOf(op));
                broadcast(LIB.textInfo("建造者是管理员 " + nameOf(op) + "，只停用不拉黑。" + msg));
                return;
            }
            punish(op, reason);
            if (msg !== "") broadcast(LIB.textInfo(msg));
            return;
        }
        addBlacklist(owner.uuid, owner.name, reason, true);
        broadcast(LIB.textBan(owner.name, reason));
        if (msg !== "") broadcast(LIB.textInfo(msg));
        return;
    }
    if (msg !== "") broadcast(LIB.textInfo(msg));
}

// 单个钍堆：由 watchStep 每秒对登记表里调用（不再自己遍历全图）
function stepReactor(b, key) {
    var cfg0 = cfg();
    {
        var rec = GTB_REACTORS[key];
        // heat 是 0..1 的比例（NuclearReactor 里 heat >= 0.999 就 kill()），不是绝对值
        var heat = readNum(b, "heat", 0);
        GTB.stat.reactors = GTB.stat.reactors + 1;
        if (heat > 0.0001) GTB.stat.hot = GTB.stat.hot + 1;
        var on = getEnabled(b) === true;
        if (cfg0.bh.reactorBoom && heat > 0.0001) {
            if (rec == null) {
                var off = setEnabled(b, false);
                GTB_REACTORS[key] = { byUs: off === true };
                var pct = Math.round(heat * 1000) / 10;
                var where0 = "第 " + LIB.toInt(key.split(",")[0], 0) + "," + LIB.toInt(key.split(",")[1], 0) + " 格";
                dbg("reactor off " + key + " heat=" + pct + "% setEnabled=" + off + " owner=" + (GTB.builders[key] == null ? "-" : GTB.builders[key].name));
                punishBuilder(GTB.builders[key], LIB.REASON.reactorBoom + "（热量 " + pct + "%）",
                    "已停用" + where0 + "的钍堆：把钍取空或通入冷冻液后会自动恢复。");
            } else if (on) {
                // 玩家又把它打开了：再停一次，但不重复通告、不重复拉黑
                setEnabled(b, false);
                dbg("reactor re-off " + key);
            }
            return;
        }
        // 不再升温：只恢复「我们自己停的」，而且要先满足安全条件
        if (rec != null && rec.byUs === true && !on) {
            if (reactorSafe(b)) {
                setEnabled(b, true);
                delete GTB_REACTORS[key];
                dbg("reactor restored " + key + " heat=" + Math.round(heat * 1000) / 10 + "%");
            } else if (rec.waiting !== true) {
                rec.waiting = true;
                dbg("reactor held " + key + " (thorium left, no cryo)");
            }
        }
    }
}

// 爆混发电机：不清空爆混，只停用。同一个方块只提示 / 拉黑一次，
// 玩家再打开就静默再停 —— 这样「禁用的爆混火电或涡轮」不会再刷屏。
function handleBlastGen(b, name, key) {
    var on = getEnabled(b) === true;
    var rec = GTB_GENS[key];
    if (rec != null) {
        if (on) setEnabled(b, false);
        return false;
    }
    var off = setEnabled(b, false);
    GTB_GENS[key] = { byUs: off === true };
    var where = "第 " + LIB.toInt(key.split(",")[0], 0) + "," + LIB.toInt(key.split(",")[1], 0) + " 格";
    var lab = genLabel(name);
    dbg("gen off " + key + " " + name + " setEnabled=" + off + " owner=" + (GTB.builders[key] == null ? "-" : GTB.builders[key].name));
    punishBuilder(GTB.builders[key], LIB.REASON.blastGen + "（" + where + "的" + lab + "）",
        "已停用" + where + "的" + lab + "：爆混不用清，保持停用就不会再提示。");
    return true;
}

// 单个爆混发电机：同样由 watchStep 调用
function stepGen(b, name, key) {
    GTB.stat.gens = GTB.stat.gens + 1;
    var count = itemCount(b, Items.blastCompound);
    var rec = GTB_GENS[key];
    if (count <= 0) {
        // 爆混被取走了：忘掉它，玩家想开就开
        if (rec != null) delete GTB_GENS[key];
        return;
    }
    handleBlastGen(b, name, key);
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
    eachPlayer(function (p) {
        if (!isAdmin(p)) return;
        var uuid = uuidOf(p);
        var banned = isBanned(uuid);
        var hadTeam = GTB.origTeam[uuid] != null;
        if (!banned && !hadTeam) return;
        if (banned) removeBlacklist(uuid, "已设为管理员");
        // 关键：拉黑时被转成了旁观，光移出黑名单人还站在队伍 0 —— 看起来就像「没移出」
        var back = hadTeam ? restoreTeam(p) : false;
        dbg("admin promoted " + nameOf(p) + " banned=" + banned + " team=" + back);
        broadcast(LIB.textInfo("管理员 " + nameOf(p) + " 已移出黑名单" + (back ? "，并恢复到他原来的队伍" : "") + "。"));
        try { p.sendMessage(LIB.textInfo("你已是管理员：已从 Grief to Ban 黑名单移出" + (back ? "，并恢复到你原来的队伍" : "") + "。")); } catch (e) { }
        try { uiApi.rebuild(); } catch (e2) { }
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
    if (targetOf(p) === "target") firstMark(p);
}

function onLeave(p) {
    if (p == null) return;
    var uuid = uuidOf(p);
    delete GTB.joinedAt[uuid];
    delete GTB.afk[uuid];
    delete GTB.origTeam[uuid];
    delete GTB_FIRST[uuid];
    if (GTB.vote != null && GTB.vote.uuid === uuid) GTB.vote = null;
    try { GTB.win.clear(uuid); } catch (e) { }
}

// ---------------------------------------------------------------- 事件

// 拆方块的第一步：Build.beginBreak 把 tile 换成 ConstructBlock 后触发，此时方块还没被移除。
// 在这里判「进服第一个动作就是拆」，并当场把 ConstructBlock 换回原方块 —— 等于撤销这次拆除。
function onBuildBegin(e) {
    if (!isAuthority()) return;
    if (inEditor()) return;
    if (e.breaking !== true) return;
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    var p = null;
    try { var u = e.unit; if (u != null) p = u.getPlayer(); } catch (e0) { p = null; }
    if (p == null) return;
    try { firstBreakBegin(e, p); } catch (eB) { logErr("first break begin: " + eB); }
}

function onBuildEnd(e) {
    if (!isAuthority()) return;
    if (inEditor()) return;                 // 编辑器：既不改 enabled，也不记建造者
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    // 拆建筑（ConstructBlock.deconstructFinish 里 tile.remove() 之前触发，带 builder 单位）：
    // 只有「进服后第一个动作就是拆」要处置 —— 拉黑 + 通告 + 把建筑按原样放回去。
    if (e.breaking === true) {
        var tEnd = null, pend = null, kEnd = "";
        try { tEnd = e.tile; } catch (eT) { tEnd = null; }
        try { kEnd = tEnd == null ? "" : tileKey(tEnd); } catch (eK) { kEnd = ""; }
        if (kEnd !== "") pend = GTB_BREAK[kEnd] == null ? null : GTB_BREAK[kEnd];
        if (pend != null) {
            // begin 时已经判过（人已拉黑）：只负责把方块放回去
            if (kEnd !== "") delete GTB_BREAK[kEnd];
            (function (tt, sp, nm) {
                Packages.arc.Core.app.post(function () {
                    try {
                        if (restoreTile(tt, sp)) {
                            broadcast(LIB.textInfo("已把 " + nm + " 拆掉的建筑放回原处。"));
                        }
                    } catch (e5) { logErr("restore post: " + e5); }
                });
            })(tEnd, pend.snap, pend.name);
            return;
        }
        var pb = null;
        try { var ub = e.unit; if (ub != null) pb = ub.getPlayer(); } catch (e0) { pb = null; }
        if (pb != null) { try { firstBreakCheck(e, pb); } catch (eB) { logErr("first break: " + eB); } }
        return;
    }
    var p = null;
    try {
        var u = e.unit;
        if (u != null) p = u.getPlayer();
    } catch (err) { p = null; }
    firstClear(p);
    // 建造不计入「交互」：正常铺产线 10 秒 20 块很常见，计入会误伤；
    // 交互只统计方块配置 / 控单位 / 指挥（见 onConfig 与 UnitControlEvent/BuildingCommandEvent）。
    var b = null;
    try { b = e.tile == null ? null : e.tile.build; } catch (e2) { b = null; }
    if (b == null) return;
    if (isLogicBuild(b)) {
        try { delete GTB_VIRUS[tileKey(e.tile)]; } catch (e9) { }
        checkVirus(b, p);
    }
    var bname = "";
    try { bname = blockNameOf(b); } catch (e3) { bname = ""; }
    // 建造者要记全：钍堆、爆混发电机的处置都得追得到人（原来只记钍堆，所以发电机没人被拉黑）
    var bk = tileKey(e.tile);
    // 登记进监视表（钍堆 / 爆混机 / 逻辑块）。只有这三类会被处置，也只有它们需要记建造者：
    // 以前所有方块都记，铺线久了表只涨不消，拆掉也不清。
    var wk = watchAdd(b, bk);
    if (wk !== "" && bk !== "" && p != null) {
        GTB.builders[bk] = { uuid: uuidOf(p), name: nameOf(p) };
    }
    if (bname === "thorium-reactor") { try { checkReactorNear(b, p); } catch (e4) { } }
    if (isBlastGenName(bname) && bk !== "" && itemCount(b, Items.blastCompound) > 0) {
        try { handleBlastGen(b, bname, bk); } catch (e5) { logErr("blast gen on build: " + e5); }
    }
}

function onConfig(e) {
    if (!isAuthority()) return;
    if (inEditor()) return;
    var p = null;
    try { p = e.player; } catch (e1) { p = null; }
    var cfg0 = cfg();
    if (!cfg0.enable) return;
    if (p != null) {
        firstClear(p);
        noteInteract(p, "配置");
        if (targetOf(p) === "target") {
            var b = null;
            try { b = e.tile == null ? null : e.tile.build; } catch (e2) { b = null; }
            if (b != null) {
                // 配置变化也顺手续上登记（逻辑块改代码 / 发电机被塞爆混）
                try { watchAdd(b, tileKey(e.tile)); } catch (eW) { }
                if (isLogicBuild(b)) { try { delete GTB_VIRUS[tileKey(e.tile)]; } catch (e9) { } checkVirus(b, p); }
                if (blockNameOf(b) === "thorium-reactor") {
                    GTB.builders[tileKey(e.tile)] = { uuid: uuidOf(p), name: nameOf(p) };
                    checkReactorNear(b, p);
                }
                var bname2 = "";
                try { bname2 = blockNameOf(b); } catch (eB) { bname2 = ""; }
                if (isBlastGenName(bname2)) {
                    var gk = tileKey(e.tile);
                    if (gk !== "") {
                        if (p != null) GTB.builders[gk] = { uuid: uuidOf(p), name: nameOf(p) };
                        // 不清空爆混，只停用；同一个方块只提示 / 拉黑一次
                        if (itemCount(b, Items.blastCompound) > 0) handleBlastGen(b, bname2, gk);
                    }
                }
            }
        }
    }
}

// 方块被拆掉：从监视表、处置记录、建造者表里一并抹掉（表只涨不消会更糟）
function onBuildDestroy(e) {
    var t = null;
    try { t = e.tile; } catch (e1) { return; }
    if (t == null) return;
    watchDrop(tileKey(t));
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

function stepLogic(b, key) {
    GTB.stat.logic = GTB.stat.logic + 1;
    var code = "";
    try { code = b.code == null ? "" : String(b.code); } catch (e3) { return; }
    // 代码被改干净就把「已处置」标记清掉：否则同一块以后再被注入也不会再报
    if (!isVirusCode(code)) { if (GTB_VIRUS[key] === true) delete GTB_VIRUS[key]; return; }
    if (GTB_VIRUS[key] === true) return;
    GTB.stat.virus = GTB.stat.virus + 1;
    var owner = GTB.builders[key];
    var op = owner == null ? null : playerByUuid(owner.uuid);
    // 停用与处置分开：没主 / 不在观察名单，也要把逻辑停掉
    checkVirus(b, op);
    if (owner != null && op == null) addBlacklist(owner.uuid, owner.name, LIB.REASON.virus, true);
}

// ---- 监视表（v0.1.4）：事件增量维护 + 滚动兜底 ----
// 用户问过「什么东西需要全图扫描」。三处检查（钍堆热量 / 发电机里的爆混 / 自复制逻辑）
// 盯的是**随时间变化的状态**，原版没有对应事件：ConfigEvent 只在玩家点配置时触发
// （InputHandler.java:729），物品进出、热量累积、逻辑代码被远程改都不发事件 ——
// 所以「检查」只能轮询。但「有哪些方块」不该每秒全图找，拆成三层：
//   ① 世界载入播种一遍（一次性 ~3 ms）；
//   ② BlockBuildEndEvent / ConfigEvent 登记、BlockDestroyEvent 注销；
//   ③ 每 tick 滚动看 64 个（≈30 秒扫完 8311 方块，单 tick <0.05 ms），兜住
//      world processor setblock / 模组直接改世界 / 事件漏发。
// 结果：每秒真正被检查的方块从全图 8311 降到登记表里的 100~200 个。
var GTB_WATCH = { react: {}, gen: {}, logic: {} };
var GTB_SWEEP = { i: 0, per: 64, rounds: 0 };
var GTB_PERF = { scan: 0, worst: 0, builds: 0, sweep: 0, sweepWorst: 0, watch: 0 };
var GTB_PUNISH = { n: 0, max: 6 };

function nowNanos() {
    try { return Packages.java.lang.System.nanoTime(); } catch (e) { return 0; }
}

function tileKeyOf(b, i) {
    try { return b.tile.x + "," + b.tile.y; } catch (e) { return "?" + i; }
}

// 这个方块归哪张表（react/gen/logic），不是我们要盯的就返回 ""
function watchKind(b) {
    if (b == null) return "";
    var name = "";
    try { name = blockNameOf(b); } catch (e) { return ""; }
    if (name === "thorium-reactor") return "react";
    if (isBlastGenName(name)) return "gen";
    try { if (isLogicBuild(b)) return "logic"; } catch (e2) { }
    return "";
}

function watchAdd(b, key) {
    var kind = watchKind(b);
    if (kind === "") return "";
    if (key == null || key === "") key = tileKeyOf(b, 0);
    if (key === "" || key.charAt(0) === "?") return "";
    GTB_WATCH[kind][key] = b;
    return kind;
}

function watchDrop(key) {
    if (key == null || key === "") return;
    delete GTB_WATCH.react[key];
    delete GTB_WATCH.gen[key];
    delete GTB_WATCH.logic[key];
    delete GTB_REACTORS[key];
    delete GTB_GENS[key];
    delete GTB_VIRUS[key];
    delete GTB.builders[key];
}

function watchSize(tbl) {
    var n = 0, k;
    if (tbl == null) return 0;
    for (k in tbl) if (tbl.hasOwnProperty(k)) n++;
    return n;
}

function watchCount() {
    var n = 0, k;
    for (k in GTB_WATCH.react) if (GTB_WATCH.react.hasOwnProperty(k)) n++;
    for (k in GTB_WATCH.gen) if (GTB_WATCH.gen.hasOwnProperty(k)) n++;
    for (k in GTB_WATCH.logic) if (GTB_WATCH.logic.hasOwnProperty(k)) n++;
    return n;
}

// 登记表里的方块可能已经被拆掉（事件漏了 / 换了图）：这里顺手验证并清掉
function watchLive(ref, key) {
    if (ref == null) { watchDrop(key); return null; }
    var ok = false;
    try { ok = ref.isValid() === true; } catch (e) { ok = false; }
    if (!ok) { watchDrop(key); return null; }
    return ref;
}

// 世界载入：整图播种一遍，之后全靠事件 + 滚动兜底
function seedWatch() {
    GTB_WATCH = { react: {}, gen: {}, logic: {} };
    GTB_SWEEP.i = 0;
    GTB_SWEEP.rounds = 0;
    var arr = null;
    try { arr = Packages.mindustry.gen.Groups.build; } catch (e) { return 0; }
    var n = seqSize(arr);
    for (var i = 0; i < n; i++) {
        var b = null;
        try { b = arr.index(i); } catch (e2) { continue; }
        if (b == null) continue;
        try { watchAdd(b, tileKeyOf(b, i)); } catch (e3) { }
    }
    return n;
}

// 每 tick 64 个方块：不算什么，约 30 秒（8311 方块）滚一遍全图
function sweepWorld() {
    var arr = null;
    try { arr = Packages.mindustry.gen.Groups.build; } catch (e) { return; }
    var n = seqSize(arr);
    GTB_PERF.builds = n;
    if (n <= 0) return;
    if (GTB_SWEEP.i >= n) { GTB_SWEEP.i = 0; GTB_SWEEP.rounds = GTB_SWEEP.rounds + 1; }
    var t0 = nowNanos();
    var end = GTB_SWEEP.i + GTB_SWEEP.per;
    if (end > n) end = n;
    for (var i = GTB_SWEEP.i; i < end; i++) {
        var b = null;
        try { b = arr.index(i); } catch (e2) { continue; }
        if (b == null) continue;
        try { watchAdd(b, tileKeyOf(b, i)); } catch (e3) { }
    }
    GTB_SWEEP.i = end >= n ? 0 : end;
    var ms = (nowNanos() - t0) / 1000000;
    GTB_PERF.sweep = ms;
    if (ms > GTB_PERF.sweepWorst) GTB_PERF.sweepWorst = ms;
}

// 每秒只检查登记表里的方块（热量、爆混、逻辑代码都是会变的状态）
function watchStep(now) {
    GTB_PUNISH.n = 0;
    var cfg0 = cfg();
    GTB.stat = { reactors: 0, hot: 0, logic: 0, virus: 0, gens: 0 };
    var wantR = cfg0.enable && cfg0.bh.reactorBoom === true;
    var wantG = cfg0.enable && cfg0.bh.blastGen === true;
    var wantV = cfg0.enable && cfg0.bh.virus === true;
    var t0 = nowNanos();
    var key, b, gname;
    if (wantR) {
        for (key in GTB_WATCH.react) {
            if (!GTB_WATCH.react.hasOwnProperty(key)) continue;
            b = watchLive(GTB_WATCH.react[key], key);
            if (b == null) continue;
            try { stepReactor(b, key); } catch (e1) { logErr("react: " + e1); }
        }
    }
    if (wantG) {
        for (key in GTB_WATCH.gen) {
            if (!GTB_WATCH.gen.hasOwnProperty(key)) continue;
            b = watchLive(GTB_WATCH.gen[key], key);
            if (b == null) continue;
            gname = "";
            try { gname = blockNameOf(b); } catch (e2) { gname = ""; }
            try { stepGen(b, gname, key); } catch (e3) { logErr("gen: " + e3); }
        }
    }
    if (wantV) {
        for (key in GTB_WATCH.logic) {
            if (!GTB_WATCH.logic.hasOwnProperty(key)) continue;
            b = watchLive(GTB_WATCH.logic[key], key);
            if (b == null) continue;
            try { stepLogic(b, key); } catch (e4) { logErr("logic: " + e4); }
        }
    }
    // 计数取「登记表里的方块数」而不是这一轮碰到的次数：世界里有几台钍堆 / 几台发电机
    // 是稳定值，不该因为某一秒刚好把开关关掉就显示 0（hot / virus 是此刻状态，仍按这一轮算）
    GTB.stat.reactors = watchSize(GTB_WATCH.react);
    GTB.stat.gens = watchSize(GTB_WATCH.gen);
    GTB.stat.logic = watchSize(GTB_WATCH.logic);
    var ms = (nowNanos() - t0) / 1000000;
    GTB_PERF.scan = ms;
    GTB_PERF.watch = watchCount();
    if (ms > GTB_PERF.worst) GTB_PERF.worst = ms;
    if (ms >= 40) dbg("watch slow " + Math.round(ms) + "ms watched=" + GTB_PERF.watch + " builds=" + GTB_PERF.builds);
    return GTB_PERF.watch;
}

function tick() {
    var now = nowMs();
    if (!isAuthority()) return;
    if (now - GTB.lastTick < 250) return;
    GTB.lastTick = now;
    // 攒批落盘：日志每 500ms 一次，设置变更最多每 1.5s 一次 autosave
    if (GTB_DBG_BUF.lines.length > 0 && now - GTB_DBG_BUF.at >= 500) dbgFlush();
    flushSettings(now);
    // 地图编辑器（单人沙盒）：整套防 grief 逻辑一行都不跑 —— 见 inEditor() 的注释。
    // 注意放在落盘之后：编辑器里改设置也得存得住，只是不扫世界。
    if (inEditor()) return;
    // 滚动兜底：每 tick 只登记 64 个方块，几乎不占时间（见 sweepWorld 注释）
    try { sweepWorld(); } catch (eS) { logErr("sweep: " + eS); }
    try { tickVote(); } catch (e) { logErr("vote: " + e); }
    try { tickAdmins(); } catch (e2) { logErr("admins: " + e2); }
    try { tickAfk(now); } catch (e3) { logErr("afk: " + e3); }
    // 1 秒一轮：钍堆从开始升温到炸只有几秒，3 秒轮询会漏
    if (now - GTB.lastScan >= 1000) {
        GTB.lastScan = now;
        try { refreshVanBan(); } catch (e7) { }
        try { watchStep(now); } catch (e4) { logErr("watch: " + e4); }
        try {
            expose("gtb.scan", "builds=" + GTB_PERF.builds + " watch=" + GTB_PERF.watch + " react=" + GTB.stat.reactors + " hot=" + GTB.stat.hot
                + " logic=" + GTB.stat.logic + " virus=" + GTB.stat.virus + " gens=" + GTB.stat.gens
                + " ms=" + Math.round(GTB_PERF.scan) + " worst=" + Math.round(GTB_PERF.worst)
                + " sweep=" + Math.round(GTB_PERF.sweepWorst * 1000) / 1000
                + " reactBoom=" + (cfg().bh.reactorBoom ? 1 : 0) + " virusOn=" + (cfg().bh.virus ? 1 : 0));
        } catch (eX) { }
        if (now - GTB_DBG.lastBeat >= 10000) {
            GTB_DBG.lastBeat = now;
            var c = cfg();
            dbg("beat " + authInfo() + " en=" + (c.enable ? 1 : 0) + " players=" + playerCount()
                + " builds=" + GTB_PERF.builds + " react=" + GTB.stat.reactors + " hot=" + GTB.stat.hot
                + " logic=" + GTB.stat.logic + " virus=" + GTB.stat.virus
                + " scan=" + Math.round(GTB_PERF.scan) + "ms worst=" + Math.round(GTB_PERF.worst) + "ms"
                + " watch=" + GTB_PERF.watch + " sweep=" + Math.round(GTB_PERF.sweepWorst * 1000) / 1000 + "ms"
                + " list=" + c.blacklist.length + " watch=" + c.watch.length
                + " editor=" + (inEditor() ? 1 : 0));
            dbgFlush();
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
    // 拆除行为在「刚开始」就要判（Build.beginBreak 记完 ConstructBlock 后触发），不要等拆完
    Events.on(ET.BlockBuildBeginEvent, function (e) { try { onBuildBegin(e); } catch (err) { logErr("buildBegin: " + err); } });
    Events.on(ET.ConfigEvent, function (e) { try { onConfig(e); } catch (err) { logErr("config: " + err); } });
    Events.on(ET.BlockDestroyEvent, function (e) { try { onBuildDestroy(e); } catch (err) { } });
    Events.on(ET.UnitControlEvent, function (e) { try { if (e.player != null) noteInteract(e.player, "控单位"); } catch (err) { } });
    Events.on(ET.BuildingCommandEvent, function (e) { try { if (e.player != null) noteInteract(e.player, "指挥方块"); } catch (err) { } });
    Events.run(ET.Trigger.update, function () { try { tick(); } catch (err) { } });
    Events.on(ET.WorldLoadEvent, function () {
        GTB.builders = {};
        GTB.win.clearAll();
        GTB.afk = {};
        GTB_REACTORS = {};
        GTB_GENS = {};
        GTB_VIRUS = {};
        GTB_WATCH = { react: {}, gen: {}, logic: {} };
        GTB_FIRST = {};
        GTB_BREAK = {};
        GTB_SWEEP.i = 0;
        GTB_SWEEP.rounds = 0;
        GTB.lastScan = 0;
        GTB.lastTick = 0;
        // 全图只在这里过一遍（一次性播种）：此后靠建造/拆除事件 + 每 tick 64 个的滚动兜底
        var seeded = 0;
        try { seeded = seedWatch(); } catch (eS2) { seeded = 0; }
        try { reload(); } catch (e) { }
        dbg("world loaded " + authInfo() + " builds=" + seeded + " watch=" + watchCount()
            + (inEditor() ? " editor=1（编辑器里本模组不工作）" : ""));
        try { dbgFlush(); } catch (e5) { }
        try { flushSettings(nowMs()); } catch (e6) { }
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
        var icon = null;
        try { icon = Packages.mindustry.gen.Icon.hammer; } catch (e1) { icon = null; }
        if (icon != null) {
            try {
                // 带锤子图标（Icon 实现了 Drawable，Table.button(text, image, clicked)）
                pd.cont.button("Grief to Ban", icon, openGtbDialog).size(220, 50).pad(5);
                return true;
            } catch (e2) { logErr("暂停菜单图标失败，退回纯文字：" + e2); }
        }
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
        chk(seqGet({ index: function (i) { return i === 0 ? "x" : null; } }, 0) === "x", "seqGet 先走 index()（EntityGroup 没有 get）");
        chk(typeof watchStep === "function" && typeof sweepWorld === "function" && typeof seedWatch === "function"
            && typeof inEditor === "function" && typeof flushSettings === "function", "perf/editor helpers");
        chk(watchKind(null) === "" && watchCount() === 0, "watch starts empty");
        chk(typeof watchDrop === "function" && typeof watchAdd === "function", "watch registry helpers");
    chk(typeof firstBreakCheck === "function" && typeof restoreTile === "function" && typeof tileSnapshot === "function", "first-break helpers");
    chk(typeof firstRecent === "function" && typeof itemSnapshot === "function" && typeof liquidSnapshot === "function" && typeof restoreInventory === "function", "first-break window / inventory helpers");
    chk(firstPending(null) === false && firstRecent(null, 10) === false, "first-break starts clean");
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
