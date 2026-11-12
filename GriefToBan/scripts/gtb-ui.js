// Grief to Ban · 设置界面
// 纯 ES5（Rhino）：只用 var / function / prototype，不用 const / let / 箭头函数 / 模板字符串 / for-of。
// 禁止正则字面量（Rhino 构造期会 FAILED ASSERTION: invalid bytecode）—— hex 校验一律手写扫描。
// 所有 Java 侧访问（atlas / Tex / Icon / Pal / Vars.ui）都包 try/catch：无头环境建不出控件也不该抛。
//
// 由 main.js 调用：build(t, mk, api)
//   t   —— 设置分类的内容表（已经在 ScrollPane 里，这里不再套 pane）
//   mk  —— function(){ return new Packages.arc.scene.ui.layout.Table(); }
//   api —— 见 main.js；本文件只读不定义。
// 结尾：module.exports = { build: build };

var ROW_W = 540;
var LABEL_W = 128;
var LIST_MAX = 30;
var DEF_THEME = "8abcd1";
var DEF_EMPH = "ffd37f";
var MANUAL_REASON = "设置界面手动拉黑";

// build 时填进来的上下文（重建时整个覆盖）
var T = null;
var MK = null;
var API = null;
var L = null;
var CUR_VER = "";
var THEME = null;
var EMPH = null;
var GRAY = null;
var UPDATE_LBL = null;
var COLOR_CACHE = {};

// ---------------------------------------------------------------- 基础工具

function nil(v){
    if(v === null || v === undefined) return true;
    return false;
}

function txt(s){
    if(s === null || s === undefined) return "";
    return String(s);
}

// Rhino 里 Java boolean 一般已经转成 JS boolean，但复选框回调再兜一层
function truthy(v){
    if(v === true) return true;
    if(v === false || nil(v)) return false;
    var s = txt(v);
    return s === "true" || s === "1";
}

function notice(text){
    try { API.notice(txt(text)); } catch(e){ }
}

// 按钮/输入框回调统一走这里：回调体本身抛了也不让整个界面塌掉
function act(fn, what){
    var tag = txt(what);
    return function(){
        try { return fn.apply(null, arguments); }
        catch(e){ notice(tag + "失败：" + e); }
    };
}

function arrIndex(arr, v){
    if(nil(arr)) return -1;
    for(var i = 0; i < arr.length; i++){
        if(arr[i] === v) return i;
    }
    return -1;
}

function arrHas(arr, v){
    return arrIndex(arr, v) >= 0;
}

// ---------------------------------------------------------------- 颜色

function themeColor(){
    if(THEME === null){
        try { THEME = API.theme(); } catch(e){ THEME = null; }
    }
    return THEME;
}

function emphColor(){
    if(EMPH === null){
        try { EMPH = API.emph(); } catch(e){ EMPH = null; }
    }
    return EMPH;
}

function grayColor(){
    if(GRAY === null){
        try { GRAY = Packages.mindustry.graphics.Pal.gray; } catch(e){ GRAY = null; }
    }
    return GRAY;
}

// 只认 6 位十六进制；'#' 与空格容错，其它一律 null（手写扫描，不用正则）
function hex6(v){
    if(nil(v)) return null;
    var raw = txt(v), s = "", i, c, lc;
    for(i = 0; i < raw.length; i++){
        c = raw.charAt(i);
        if(c === "#" || c === " ") continue;
        s = s + c;
    }
    if(s.length !== 6) return null;
    for(i = 0; i < 6; i++){
        lc = s.charAt(i).toLowerCase();
        if(!((lc >= "0" && lc <= "9") || (lc >= "a" && lc <= "f"))) return null;
    }
    return s.toLowerCase();
}

function colorOf(h){
    var hex = hex6(h);
    if(hex === null) return null;
    var hit = COLOR_CACHE[hex];
    if(hit !== null && hit !== undefined) return hit;
    try {
        var c = Packages.arc.graphics.Color.valueOf(hex);
        COLOR_CACHE[hex] = c;
        return c;
    } catch(e){
        return null;
    }
}

function cellColor(cell, color){
    if(nil(cell) || nil(color)) return;
    try { cell.color(color); } catch(e){ }
}

function actorColor(el, color){
    if(nil(el) || nil(color)) return;
    try { el.setColor(color); } catch(e){ }
}

function cellScale(cell, scale){
    if(nil(cell)) return;
    try {
        var el = cell.get();
        if(!nil(el)) el.setFontScale(scale);
    } catch(e){ }
}

// 悬浮提示：arc 的 Tooltips.create(String) 是 Java 侧造好的 provider，Rhino 里不用实现 Cons
function tipOn(el, text){
    if(nil(el)) return false;
    try {
        if(typeof el.addListener !== "function") return false;
        if(nil(Packages.arc.Core.scene)) return false;
        var tip = Packages.arc.scene.ui.Tooltip.Tooltips.getInstance().create(txt(text));
        try { tip.setInstant(true); } catch(e1){ }
        el.addListener(tip);
        return true;
    } catch(e){
        return false;
    }
}

// ---------------------------------------------------------------- 行 / 段落

function newRow(){
    var row = null;
    try { row = MK(); } catch(e){ row = null; }
    if(nil(row)){
        try { row = new Packages.arc.scene.ui.layout.Table(); } catch(e2){ return null; }
    }
    try { row.margin(8); } catch(e3){ }
    try { row.left(); } catch(e4){ }
    return row;
}

function addRow(row){
    if(nil(row) || nil(T)) return;
    try {
        var cell = T.add(row);
        try { cell.width(ROW_W); } catch(e1){ }
        try { cell.left(); } catch(e2){ }
        try { cell.padTop(5); } catch(e3){ }
        try { cell.row(); } catch(e4){ }
    } catch(e){ }
}

// 段标题：主题色标题 + 一条主题色细线
function section(title){
    if(nil(T)) return;
    var cell = null;
    try { cell = T.add(txt(title)); } catch(e){ return; }
    cellColor(cell, themeColor());
    cellScale(cell, 1.05);
    try { cell.width(ROW_W); } catch(e1){ }
    try { cell.left(); } catch(e2){ }
    try { cell.padTop(14); cell.padBottom(2); } catch(e3){ }
    try { cell.row(); } catch(e4){ }
    var made = false;
    try {
        var d = Packages.arc.Core.atlas.find("white");
        if(!nil(d)){
            var ic = T.image(d);
            try { ic.growX(); ic.height(2); } catch(e5){ }
            try { ic.padTop(2); ic.padBottom(6); } catch(e6){ }
            cellColor(ic, themeColor());
            try { ic.row(); } catch(e7){ }
            made = true;
        }
    } catch(e8){
        made = false;
    }
    if(!made){
        try { T.row(); } catch(e9){ }
    }
}

// 灰色小字（说明 / 空列表提示）
function subLine(text){
    if(nil(T)) return;
    try {
        var cell = T.labelWrap(txt(text));
        try { cell.width(ROW_W - 16); } catch(e1){ }
        try { cell.left(); cell.padLeft(16); cell.padTop(1); } catch(e2){ }
        cellColor(cell, grayColor());
        cellScale(cell, 0.85);
        try { cell.row(); } catch(e3){ }
    } catch(e){ }
}

// 宽段落（顶部的说明文字）
function descLine(text){
    if(nil(T)) return;
    try {
        var cell = T.labelWrap(txt(text));
        try { cell.width(ROW_W); } catch(e1){ }
        try { cell.left(); cell.padTop(4); } catch(e2){ }
        cellColor(cell, grayColor());
        cellScale(cell, 0.9);
        try { cell.row(); } catch(e3){ }
    } catch(e){ }
}

// 名单里的小标题（在线玩家 / 观察名单 / 黑名单）
function miniHead(text){
    if(nil(T)) return;
    try {
        var cell = T.add(txt(text));
        try { cell.width(ROW_W); } catch(e1){ }
        try { cell.left(); cell.padTop(10); } catch(e2){ }
        cellColor(cell, emphColor());
        cellScale(cell, 0.95);
        try { cell.row(); } catch(e3){ }
    } catch(e){ }
}

// 行尾 info 图标（拿不到图标字体就安静跳过）
function infoIcon(row, text){
    if(nil(row)) return;
    try {
        var cell = row.image(Packages.mindustry.gen.Icon.infoCircle);
        try { cell.size(18); } catch(e1){ }
        try { cell.padLeft(6); cell.padRight(6); } catch(e2){ }
        try { cell.expandX(); cell.right(); } catch(e3){ }
        cellColor(cell, emphColor());
        var el = null;
        try { el = cell.get(); } catch(e4){ el = null; }
        if(!nil(el)) tipOn(el, text);
    } catch(e){ }
}

// ---------------------------------------------------------------- 读写设置

function save(key, value, what){
    try {
        API.set(key, value);
        try { API.changed(); } catch(e1){ }
        return true;
    } catch(e){
        notice(txt(what) + "失败：" + e);
        return false;
    }
}

function rebuild(){
    try { API.rebuild(); } catch(e){ notice("刷新界面失败：" + e); }
}

function cfg(){
    try {
        var c = API.cfg();
        if(!nil(c)) return c;
    } catch(e){ }
    return {};
}

function status(){
    try {
        var s = API.status();
        if(!nil(s)) return s;
    } catch(e){ }
    return {};
}

// 复选框一行；复制一份「已勾选」的 Cell 以便取到 CheckBox 本体
function checkRow(label, on, key, expl){
    var row = newRow();
    if(nil(row)) return null;
    var got = null;
    try {
        var cell = row.check(txt(label), on === true, act(function(b){
            save(key, truthy(b), "保存「" + txt(label) + "」");
        }, "保存「" + txt(label) + "」"));
        try { cell.left(); } catch(e1){ }
        try { got = cell.get(); } catch(e2){ got = null; }
    } catch(e){
        notice("界面创建失败（" + txt(label) + "）：" + e);
    }
    addRow(row);
    if(!nil(expl) && txt(expl) !== "") subLine(expl);
    return got;
}

// 数字设置一行：标签 + 输入框 + 单位
function numRow(label, value, key, min, max, suffix){
    var row = newRow();
    if(nil(row)) return;
    var lab = null;
    try {
        lab = row.add(txt(label));
        try { lab.width(LABEL_W); } catch(e1){ }
        try { lab.left(); } catch(e2){ }
        cellColor(lab, grayColor());
    } catch(e3){ }
    try {
        var fc = row.field(txt(value), act(function(s){
            var n = L.toInt(txt(s), 0);
            if(n < min || n > max) return;   // 越界/非法不写，等用户改对
            save(key, n, "保存「" + txt(label) + "」");
        }, "保存「" + txt(label) + "」"));
        try { fc.width(90); } catch(e4){ }
        try { fc.left(); } catch(e5){ }
    } catch(e6){
        notice("界面创建失败（" + txt(label) + "）：" + e6);
    }
    if(!nil(suffix) && txt(suffix) !== ""){
        try {
            var sc = row.add(txt(suffix));
            try { sc.left(); } catch(e7){ }
            cellColor(sc, grayColor());
        } catch(e8){ }
    }
    addRow(row);
}

// ---------------------------------------------------------------- 0. 标题

function buildTitle(st){
    var row = newRow();
    if(!nil(row)){
        try {
            var tc = row.add("Grief to Ban");
            try { tc.left(); } catch(e1){ }
            cellScale(tc, 1.6);
            try {
                var lbl = tc.get();
                actorColor(lbl, themeColor());
            } catch(e2){ }
        } catch(e3){ }
        try {
            var vc = row.add(" v" + CUR_VER);
            try { vc.left(); vc.padLeft(10); } catch(e4){ }
            cellColor(vc, grayColor());
        } catch(e5){ }
        addRow(row);
    }
    descLine("基于 uid 的黑名单：进黑名单的玩家直接转成旁观（队伍 0），不能再操作任何东西。");
    descLine("移出黑名单只有两条路 —— 把对方设为管理员（下次 tick 自动移出），或在下面的「名单管理」里手动移出。");
}

// ---------------------------------------------------------------- 1. 总开关

function buildMaster(c){
    section("总开关");
    checkRow("启用 Grief to Ban", c.enable === true, L.KEYS.enable,
        "关掉后本插件的检测与自动处置全部停跑，名单仍保留；再打开即时生效。");
}

// ---------------------------------------------------------------- 2. 游戏默认黑名单

function buildVanilla(c, st){
    section("游戏默认黑名单");
    checkRow("同时写进游戏自己的封禁列表（banPlayerID）", c.vanillaBan === true, L.KEYS.vanillaBan,
        "启用后黑名单写进游戏封禁列表，不再由本插件单独维护旁观；被原版封禁的玩家进服直接被拒。"
        + "关掉时只由本插件把名单里的人切成旁观（队伍 0）。");
    var n = 0;
    try { n = L.toInt(st.vanillaBanN, 0); } catch(e){ n = 0; }
    if(n > 0) subLine("当前有 " + n + " 个黑名单玩家同时被游戏封禁，可在下面名单里逐个「解除游戏封禁」。");
}

// ---------------------------------------------------------------- 3. 特定语言

function buildLangs(c){
    section("特定语言");
    descLine("按玩家的客户端语言（player.locale）命中；命中后按下面选的模式处理。");

    // 模式三选一
    var row = newRow();
    if(!nil(row)){
        var modes = [["off", "关"], ["ban", "直接拉黑"], ["watch", "列为观察对象"]];
        for(var i = 0; i < modes.length; i++){
            (function(code, label){
                var sel = (txt(c.langMode) === code);
                var text = (sel ? "● " : "") + label;
                var made = false;
                try {
                    var cell = row.button(text, act(function(){
                        save(L.KEYS.langMode, code, "切换语言模式");
                        rebuild();
                    }, "切换语言模式"));
                    try { cell.height(36); } catch(e1){ }
                    try { cell.padRight(6); } catch(e2){ }
                    if(sel) cellColor(cell, emphColor());
                    made = true;
                } catch(e3){ }
                if(!made){
                    try { row.add(text).padRight(6); } catch(e4){ }
                }
            })(modes[i][0], modes[i][1]);
        }
        addRow(row);
    }
    subLine("选「观察对象」时，下面的「成员」只指观察名单里的人：其他玩家一律不管，只有名单里的人才会被按行为规则处置。");

    // 语言 chips（每行 4 个，用 mk() 的子表排）
    var sel = [];
    try { sel = L.parseLangs(c.langs); } catch(e0){ sel = []; }
    var perRow = 4;
    var idx;
    for(idx = 0; idx < L.LANGS.length; idx += perRow){
        var crow = newRow();
        if(nil(crow)) break;
        for(var j = 0; j < perRow; j++){
            var k = idx + j;
            if(k >= L.LANGS.length) break;
            (function(code, label){
                var on = arrHas(sel, code);
                var text = (on ? "● " : "") + label;
                var made = false;
                try {
                    var cell = crow.button(text, act(function(){
                        var cur = [];
                        try { cur = L.parseLangs(cfg().langs); } catch(e1){ cur = []; }
                        var pos = arrIndex(cur, code);
                        if(pos >= 0) cur.splice(pos, 1);
                        else cur.push(code);
                        save(L.KEYS.langs, L.joinLangs(cur), "保存语言列表");
                        rebuild();
                    }, "切换语言 " + label));
                    try { cell.width(124); cell.height(30); } catch(e2){ }
                    try { cell.padRight(4); } catch(e3){ }
                    if(on) cellColor(cell, emphColor());
                    made = true;
                } catch(e4){ }
                if(!made){
                    try { crow.add(text).width(124).padRight(4); } catch(e5){ }
                }
            })(L.LANGS[k][0], L.LANGS[k][1]);
        }
        addRow(crow);
    }

    // 自定义（逗号分隔原始串兜底）
    var frow = newRow();
    if(!nil(frow)){
        try {
            var lab = frow.add("自定义");
            try { lab.width(100); } catch(e1){ }
            try { lab.left(); } catch(e2){ }
            cellColor(lab, grayColor());
        } catch(e3){ }
        try {
            var fc = frow.field(txt(c.langs), act(function(s){
                save(L.KEYS.langs, txt(s), "保存语言列表");
            }, "保存语言列表"));
            try { fc.width(300); } catch(e4){ }
            try { fc.left(); } catch(e5){ }
        } catch(e6){
            notice("界面创建失败（自定义语言）：" + e6);
        }
        addRow(frow);
    }
    subLine("逗号分隔，例如 zh_cn,en；上面点选的语言会自动同步到这个框里。");
}

// ---------------------------------------------------------------- 4. 行为黑名单

function setBehavior(key, on){
    var bh = {};
    try { bh = L.parseBehaviors(L.dumpBehaviors(cfg().bh)); } catch(e0){ bh = L.parseBehaviors(null); }
    bh[key] = on === true;
    save(L.KEYS.bh, L.dumpBehaviors(bh), "保存行为开关");
}

function behaviorRow(c, key, label, expl){
    var on = false;
    try { on = (c.bh && c.bh[key] === true); } catch(e0){ on = false; }
    var row = newRow();
    if(nil(row)) return;
    try {
        var cell = row.check(txt(label), on, act(function(b){
            setBehavior(key, truthy(b));
        }, "保存「" + txt(label) + "」"));
        try { cell.left(); } catch(e1){ }
    } catch(e){
        notice("界面创建失败（" + txt(label) + "）：" + e);
    }
    addRow(row);
    if(!nil(expl) && txt(expl) !== "") subLine(expl);
}

function buildBehaviors(c){
    section("行为黑名单");
    descLine("七项可以逐项开关；勾上的项在检测到后按每项下面写的方式处理（拉黑 = 转旁观并广播通告）。");

    // ① 短时间多次交互 / 指挥大量单位
    behaviorRow(c, "interact", "短时间多次交互 / 指挥大量单位",
        "拉黑 + 通告：同一玩家在窗口时间内超过次数阈值就判定为恶意操作。");
    numRow("次数阈值", c.thInteractCount, L.KEYS.thInteractCount, 3, 500, "次");
    numRow("窗口长度", c.thInteractWindow, L.KEYS.thInteractWindow, 2, 120, "秒");
    var cnt = 0, win = 0;
    try { cnt = L.toInt(c.thInteractCount, 0); } catch(e1){ cnt = 0; }
    try { win = L.toInt(c.thInteractWindow, 0); } catch(e2){ win = 0; }
    subLine("当前规则：" + win + " 秒内交互/指挥达到 " + cnt + " 次即处置。本版没有专门的「指挥大量单位」事件，"
        + "按建造、配置、控单位、指挥方块的事件数近似。");

    // ② 病毒逻辑
    behaviorRow(c, "virus", "放置病毒逻辑（config = @this）",
        "停用该逻辑方块 + 拉黑 + 通告：判据是 ucontrol build ... @this 自复制。");

    // ③ 钍堆离核心过近
    behaviorRow(c, "reactorNear", "钍堆离核心过近", "警告 + 通告：只提醒不处置，留给玩家自己搬走。");
    numRow("距离阈值", c.thReactorNear, L.KEYS.thReactorNear, 1, 200, "格");

    // ④ 钍堆在烧钍（热量会涨）
    behaviorRow(c, "reactorBoom", "钍堆在烧钍、没通冷冻液",
        "停用 + 拉黑 + 通告。把钍取空或通入冷冻液后自动恢复 —— 不再用「热量归零」当判据（钍还在时热量降下来就会再涨，会来回跳）。");

    // ⑤ 涡轮 / 火电里装着爆混
    behaviorRow(c, "blastGen", "涡轮 / 火电里装着爆混",
        "只停用，不清空爆混；同一个方块只提示与拉黑一次，玩家再打开就静默再停。");

    // ⑥ 附身单位 AFK
    behaviorRow(c, "afk", "附身单位 AFK（@shootx @shooty 不动）",
        "踢出 + 通告：附身单位在阈值时间内坐标没变化就判定为挂机。");
    numRow("AFK 阈值", c.afkMinutes, L.KEYS.afkMinutes, 1, 120, "分钟");

    // ⑦ 进服后第一个动作就是拆建筑
    behaviorRow(c, "firstBreak", "进服后的第一件事就是拆建筑",
        "拆除一开始就判（不用等拆完），当场把被拆的方块按原样放回去（方块、朝向、配置、血量、"
        + "里面的物品与液体）。只判「还没做过任何别的事」的人；先建方块、改配置、控单位或指挥过的都不算。"
        + "时间窗沿用上面「多次交互」那个秒数：进服很久以后才拆的不算第一件事。");
}

// ---------------------------------------------------------------- 5. votekick

function buildVotekick(c){
    section("/vote kick");
    checkRow("投票踢人期间把目标转为旁观", c.votekick === true, L.KEYS.votekick,
        "有人发起投票就把被投票的玩家切成队伍 0，投票结束（通过或否决）自动恢复原队伍。");
}

// ---------------------------------------------------------------- 6. 名单管理

function teamText(v){
    if(nil(v)) return "-";
    var s = txt(v);
    if(s === "" || s === "null") return "-";
    return s;
}

function playerRow(p, conf){
    var row = newRow();
    if(nil(row) || nil(p)) return;
    var uuid = txt(p.uuid);
    var inBl = false;
    try { inBl = (L.findIndex(conf.blacklist, uuid) >= 0); } catch(e0){ inBl = false; }

    var line = "";
    try {
        if(p.admin === true) line += "[accent]管理员[] ";
        line += "[white]" + L.safeName(p.name) + "[]";
        line += " [gray](" + L.shortId(uuid) + ") · " + L.langLabel(p.locale) + " · 队伍 " + teamText(p.team);
    } catch(e1){
        line = txt(p.name);
    }

    var lc = null;
    try { lc = row.labelWrap(line); } catch(e2){ lc = null; }
    if(!nil(lc)){
        try { lc.width(ROW_W - 220); } catch(e3){ }
        try { lc.left(); } catch(e4){ }
    } else {
        try { row.add(line).left(); } catch(e5){ }
    }

    // 「观察」
    var made = false;
    try {
        var wc = row.button("观察", act(function(){
            API.addWatch(uuid);
            rebuild();
        }, "加入观察名单"));
        try { wc.width(74); wc.height(32); } catch(e1){ }
        try { wc.padLeft(6); } catch(e2){ }
        made = true;
    } catch(e3){ }
    if(!made){
        try { row.add("[gray]观察").padLeft(6); } catch(e4){ }
    }

    // 「拉黑」/ 已在黑名单时「移出黑名单」
    if(inBl){
        try {
            var bc = row.button("移出黑名单", act(function(){
                API.removeBlacklist(uuid);
                rebuild();
            }, "移出黑名单"));
            try { bc.width(120); bc.height(32); } catch(e5){ }
            try { bc.padLeft(6); } catch(e6){ }
        } catch(e7){ }
    } else {
        try {
            var cc = row.button("拉黑", act(function(){
                API.addBlacklist(uuid, p.name, MANUAL_REASON);
                rebuild();
            }, "拉黑"));
            try { cc.width(74); cc.height(32); } catch(e8){ }
            try { cc.padLeft(6); } catch(e9){ }
        } catch(e10){ }
    }
    addRow(row);
}

function watchRow(e){
    var row = newRow();
    if(nil(row) || nil(e)) return;
    var line = "";
    try { line = L.watchLine(e); } catch(e0){ line = txt(e.uuid); }
    var lc = null;
    try { lc = row.labelWrap(line); } catch(e1){ lc = null; }
    if(!nil(lc)){
        try { lc.width(ROW_W - 110); } catch(e2){ }
        try { lc.left(); } catch(e3){ }
    } else {
        try { row.add(line).left(); } catch(e4){ }
    }
    try {
        var bc = row.button("移出", act(function(){
            API.removeWatch(txt(e.uuid));
            rebuild();
        }, "移出观察名单"));
        try { bc.width(80); bc.height(32); } catch(e5){ }
        try { bc.padLeft(6); } catch(e6){ }
    } catch(e7){ }
    addRow(row);
}

function blacklistRow(e, vanillaN){
    var row = newRow();
    if(nil(row) || nil(e)) return;
    var uuid = txt(e.uuid);
    var line = "";
    try { line = L.entryLine(e); } catch(e0){ line = uuid; }
    var lc = null;
    try { lc = row.labelWrap(line); } catch(e1){ lc = null; }
    var lw = (vanillaN > 0) ? (ROW_W - 250) : (ROW_W - 110);
    if(!nil(lc)){
        try { lc.width(lw); } catch(e2){ }
        try { lc.left(); } catch(e3){ }
    } else {
        try { row.add(line).left(); } catch(e4){ }
    }
    try {
        var bc = row.button("移出", act(function(){
            API.removeBlacklist(uuid);
            rebuild();
        }, "移出黑名单"));
        try { bc.width(80); bc.height(32); } catch(e5){ }
        try { bc.padLeft(6); } catch(e6){ }
    } catch(e7){ }
    if(vanillaN > 0){
        try {
            var uc = row.button("解除游戏封禁", act(function(){
                API.unbanVanilla(uuid);
                rebuild();
            }, "解除游戏封禁"));
            try { uc.width(120); uc.height(32); } catch(e8){ }
            try { uc.padLeft(6); } catch(e9){ }
        } catch(e10){ }
    }
    addRow(row);
}

function buildLists(c, st){
    section("名单管理");

    // 在线玩家
    var players = [];
    try { if(!nil(st.players)) players = st.players; } catch(e0){ players = []; }
    var pn = 0;
    try { pn = L.toInt(players.length, 0); } catch(e1){ pn = 0; }
    miniHead("在线玩家（" + pn + "）");
    if(pn === 0){
        subLine("当前没有玩家。");
    } else {
        var lim = pn > LIST_MAX ? LIST_MAX : pn;
        for(var i = 0; i < lim; i++) playerRow(players[i], c);
        if(pn > LIST_MAX) subLine("… 还有 " + (pn - LIST_MAX) + " 条");
    }

    // 观察名单
    var wl = [];
    try { if(!nil(c.watch)) wl = c.watch; } catch(e2){ wl = []; }
    var wn = 0;
    try { wn = L.toInt(wl.length, 0); } catch(e3){ wn = 0; }
    miniHead("观察名单（" + wn + "）");
    if(wn === 0){
        subLine("观察名单是空的。选「观察对象」模式时，只有这里的人会被按行为规则处置。");
    } else {
        var wlim = wn > LIST_MAX ? LIST_MAX : wn;
        for(var j = 0; j < wlim; j++) watchRow(wl[j]);
        if(wn > LIST_MAX) subLine("… 还有 " + (wn - LIST_MAX) + " 条");
    }

    // 黑名单
    var bl = [];
    try { if(!nil(c.blacklist)) bl = c.blacklist; } catch(e4){ bl = []; }
    var bn = 0;
    try { bn = L.toInt(bl.length, 0); } catch(e5){ bn = 0; }
    var vanillaN = 0;
    try { vanillaN = L.toInt(st.vanillaBanN, 0); } catch(e6){ vanillaN = 0; }
    miniHead("黑名单（" + bn + "）");
    if(bn === 0){
        subLine("黑名单是空的。");
    } else {
        var blim = bn > LIST_MAX ? LIST_MAX : bn;
        for(var k = 0; k < blim; k++) blacklistRow(bl[k], vanillaN);
        if(bn > LIST_MAX) subLine("… 还有 " + (bn - LIST_MAX) + " 条");
    }
    if(vanillaN > 0) subLine("其中 " + vanillaN + " 个同时被游戏默认封禁，可逐个「解除游戏封禁」。");
}

// ---------------------------------------------------------------- 7. 维护

function setUpdateText(s){
    var el = UPDATE_LBL;
    if(nil(el)) return;
    try { el.setText(txt(s)); } catch(e){ }
}

function updateText(res){
    if(nil(res)) return "检查失败：没有返回结果";
    try {
        if(res.error !== null && res.error !== undefined && txt(res.error) !== ""){
            return "检查失败：" + txt(res.error);
        }
        if(res.ok === false) return "检查失败：接口没有返回结果";
        var latest = txt(res.latest);
        if(latest === "" || !L.newerAvailable(CUR_VER, latest)) return "已是最新";
        var s = "发现新版本 v" + latest;
        if(txt(res.url) !== "") s += "（" + txt(res.url) + "）";
        return s;
    } catch(e){
        return "检查失败：" + e;
    }
}

function buildMaintenance(c){
    section("维护");

    var vrow = newRow();
    if(!nil(vrow)){
        var lab = null;
        try {
            lab = vrow.add("当前版本");
            try { lab.width(LABEL_W); } catch(e1){ }
            try { lab.left(); } catch(e2){ }
            cellColor(lab, grayColor());
        } catch(e3){ }
        try {
            var vc = vrow.add("v" + CUR_VER);
            try { vc.left(); vc.padLeft(6); } catch(e4){ }
            cellColor(vc, emphColor());
        } catch(e5){ }
        addRow(vrow);
    }

    checkRow("启动时自动检查更新", c.updateCheck === true, L.KEYS.updateCheck,
        "开着时进服后在后台静默检查一次；关掉只能手动点下面的按钮。");

    var urow = newRow();
    if(!nil(urow)){
        var made = false;
        try {
            var btn = urow.button("检查更新", act(function(){
                setUpdateText("检查中…");
                API.checkUpdate(function(res){
                    try { setUpdateText(updateText(res)); }
                    catch(e){ notice("显示更新结果失败：" + e); }
                });
            }, "检查更新"));
            try { btn.height(36); } catch(e1){ }
            try { btn.padRight(8); } catch(e2){ }
            made = true;
        } catch(e3){
            notice("界面创建失败（检查更新）：" + e3);
        }
        if(!made){
            try { urow.add("[gray]检查更新").padRight(8); } catch(e4){ }
        }
        var lc = null;
        try { lc = urow.labelWrap("未检查"); } catch(e5){ lc = null; }
        if(!nil(lc)){
            try { lc.width(ROW_W - 140); } catch(e6){ }
            try { lc.left(); } catch(e7){ }
            cellColor(lc, grayColor());
            try { UPDATE_LBL = lc.get(); } catch(e8){ UPDATE_LBL = null; }
        }
        addRow(urow);
    }
    subLine("检查更新失败只在这里显示原因，不会打断游戏；仓库地址填 GitHub 上的 owner/repo 页面。");

    var rrow = newRow();
    if(!nil(rrow)){
        try {
            var rl = rrow.add("仓库地址");
            try { rl.width(LABEL_W); } catch(e1){ }
            try { rl.left(); } catch(e2){ }
            cellColor(rl, grayColor());
        } catch(e3){ }
        try {
            var fc = rrow.field(txt(c.repo), act(function(s){
                save(L.KEYS.repo, txt(s), "保存仓库地址");
            }, "保存仓库地址"));
            try { fc.width(300); } catch(e4){ }
            try { fc.left(); } catch(e5){ }
        } catch(e6){
            notice("界面创建失败（仓库地址）：" + e6);
        }
        addRow(rrow);
    }

    // 诊断：出问题时把这里的文字/日志贴出来就能定位
    var drow = newRow();
    if(!nil(drow)){
        var b1 = null;
        try {
            b1 = drow.button("诊断信息", act(function(){
                try { notice(API.diag()); } catch(e){ notice("取诊断信息失败：" + e); }
            }, "诊断信息"));
            try { b1.height(34); } catch(e1){ }
            try { b1.padRight(8); } catch(e2){ }
        } catch(e3){ notice("界面创建失败（诊断信息）：" + e3); }
        var b2 = null;
        try {
            b2 = drow.button("写入自检", act(function(){
                try { notice(API.testWrite()); } catch(e){ notice("写入自检失败：" + e); }
            }, "写入自检"));
            try { b2.height(34); } catch(e4){ }
            try { b2.padRight(8); } catch(e5){ }
        } catch(e6){ }
        addRow(drow);
    }

    var lrow = newRow();
    if(!nil(lrow)){
        var b3 = null;
        try {
            b3 = lrow.button("查看日志", act(function(){
                try {
                    var t = API.logText();
                    if(txt(t) === "") notice("日志还是空的（没有扫描过）。");
                    else notice(t);
                } catch(e){ notice("读日志失败：" + e); }
            }, "查看日志"));
            try { b3.height(34); } catch(e1){ }
            try { b3.padRight(8); } catch(e2){ }
        } catch(e3){ }
        var b4 = null;
        try {
            b4 = lrow.button("清空日志", act(function(){
                try { notice(API.clearLog()); } catch(e){ notice("清空日志失败：" + e); }
            }, "清空日志"));
            try { b4.height(34); } catch(e4){ }
            try { b4.padRight(8); } catch(e5){ }
        } catch(e6){ }
        var lp = null;
        try { lp = lrow.labelWrap("log: " + txt(API.logPath())); } catch(e7){ lp = null; }
        if(!nil(lp)){
            try { lp.width(ROW_W - 220); } catch(e8){ }
            try { lp.left(); } catch(e9){ }
            cellColor(lp, grayColor());
        }
        addRow(lrow);
    }
    subLine("行为拦截没反应时先看「诊断信息」：里面有房主判定、扫描到的钍堆/逻辑数量、名单条数。");
}

// ---------------------------------------------------------------- 8. 外观（双色）

// 色块取不到就跳过（无头/atlas 未初始化）
function makeSwatch(row){
    try {
        var d = Packages.arc.Core.atlas.find("white");
        if(nil(d)) return null;
        var cell = row.image(d);
        try { cell.width(24); cell.height(24); } catch(e1){ }
        try { cell.padLeft(8); } catch(e2){ }
        var img = null;
        try { img = cell.get(); } catch(e3){ img = null; }
        return img;
    } catch(e){
        return null;
    }
}

function colorRow(label, key, curHex, defHint, expl){
    var row = newRow();
    if(nil(row)) return;
    var field = null;
    var swatch = null;

    var lc = null;
    try {
        lc = row.add(txt(label));
        try { lc.width(LABEL_W); } catch(e1){ }
        try { lc.left(); } catch(e2){ }
        cellColor(lc, grayColor());
    } catch(e3){ }

    try {
        var fc = row.field(txt(curHex), act(function(v){
            var h = hex6(v);
            // 输入框每敲一个键都会回调：没凑满 6 位十六进制就先不写，
            // 否则输入到一半就被判非法、把光标里的字回退掉，根本没法打字。
            if(h === null) return;
            save(key, h, "保存" + txt(label));
            var cc = colorOf(h);
            try { if(!nil(swatch) && !nil(cc)) swatch.setColor(cc); } catch(e1){ }
        }, "保存" + txt(label)));
        try { fc.width(100); } catch(e4){ }
        try { fc.left(); } catch(e5){ }
        try { field = fc.get(); } catch(e6){ field = null; }
    } catch(e7){
        notice("界面创建失败（" + txt(label) + "）：" + e7);
    }

    swatch = makeSwatch(row);
    var initColor = colorOf(curHex);
    if(nil(initColor)){
        if(key === L.KEYS.theme) initColor = themeColor();
        else initColor = emphColor();
    }
    try { if(!nil(swatch) && !nil(initColor)) swatch.setColor(initColor); } catch(e8){ }

    try {
        var bc = row.button("默认", act(function(){
            save(key, "", "恢复默认" + txt(label));
            try { if(!nil(field)) field.setText(""); } catch(e1){ }
            var dc = colorOf(defHint);
            try { if(!nil(swatch) && !nil(dc)) swatch.setColor(dc); } catch(e2){ }
            rebuild();
        }, "恢复默认" + txt(label)));
        try { bc.height(34); } catch(e3){ }
        try { bc.padLeft(8); } catch(e4){ }
    } catch(e5){ }

    infoIcon(row, expl);
    addRow(row);
}

function buildColors(c){
    section("外观");
    colorRow("主体色", L.KEYS.theme, txt(c.theme), DEF_THEME,
        "标题、分隔线、选中项用的颜色。写 6 位十六进制（例如 " + DEF_THEME + "），留空 = 用默认值。");
    colorRow("强调色", L.KEYS.emph, txt(c.emph), DEF_EMPH,
        "名单小标题、说明图标、选中标记用的颜色。写 6 位十六进制（例如 " + DEF_EMPH + "），留空 = 用默认值。");
    subLine("输入框填满 6 位十六进制才生效（例如 " + DEF_THEME + "，# 可省略）；色块显示当前颜色，"
        + "取不到图标资源时不显示色块。「默认」写回空串，回到插件内置配色。");
}

// ---------------------------------------------------------------- 入口

function build(t, mk, api){
    T = t;
    MK = mk;
    API = api;
    THEME = null;
    EMPH = null;
    GRAY = null;
    UPDATE_LBL = null;
    COLOR_CACHE = {};

    try { L = api.lib; } catch(eLib){ L = null; }
    if(nil(L)){
        // 没有逻辑层就只留一句提示，别让整个设置页炸掉
        try { t.add("[scarlet]gtb-lib.js 未加载，界面不可用。").left().row(); } catch(eTip){ }
        return;
    }

    var st = status();
    CUR_VER = "";
    try { CUR_VER = txt(st.version); } catch(e0){ CUR_VER = ""; }
    if(CUR_VER === ""){
        try { CUR_VER = txt(L.VERSION); } catch(e1){ CUR_VER = "?"; }
    }

    var c = cfg();

    try { t.defaults().pad(3).left(); } catch(e2){ }

    buildTitle(st);          // 0
    buildMaster(c);          // 1
    buildVanilla(c, st);     // 2
    buildLangs(c);           // 3
    buildBehaviors(c);       // 4
    buildVotekick(c);        // 5
    buildLists(c, st);       // 6
    buildMaintenance(c);     // 7
    buildColors(c);          // 8
}

module.exports = { build: build };
