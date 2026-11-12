# 变更记录 · Grief to Ban

只记对外可见的变化。工程细节见 `out/takeover-20261024/` 下的报告。

## 0.1.8

用户 m11225：「设置标题栏下"基于uid的黑名单"uid后面错误换行了。简单修一下」

- **中文说明不再断出半截短行**：Arc 的折行（`GlyphLayout.getWrapIndex`）是往回找**空格**断行，
  中文段落里空格很少，于是「基于 uid 的黑名单：……」这种句子会被断成「基于 uid」+ 一长行，
  看起来像「uid 后面莫名换行」。现在说明文字在排版前先去掉紧贴中文的半角空格
  （`gtb-ui.js` 的 `cjkTighten`），整句没有任何断点，Arc 只能按字符宽度硬折行 —— 中文
  段落于是断在宽度边界上，不再出现极短的一行。
- 影响的只是**显示**：设置页里 `descLine` / `subLine` 两类说明文字都走这条路径，文案本身没删没改。

## 0.1.7

用户 m10997：「你放置的建筑不是原建筑，而是@air，而且应该检测拆除行为，而不是等完全拆除再拉黑」

- **放回去的终于是原建筑了**：以前挂的是「拆完」事件，那时候 `tile.block()` 已经是
  `ConstructBlock`（原方块被挪进 `ConstructBuild.previous`，而它的默认值正是 `Blocks.air`），
  于是放回去的是一个空壳构造块 —— 画面上就是一片空白（@air）。现在快照直接从
  `ConstructBlock` 里取：`previous` 是原方块，`prevBuild.get(0)` 是还带着物品与液体的旧建筑。
- **拆除「刚开始」就判，不再等拆完**：改挂 `BlockBuildBeginEvent(breaking = true)`
  （`Build.beginBreak` 把 tile 换成 ConstructBlock 之后、方块被移除之前触发）。判中就直接
  把 ConstructBlock 换回原方块 —— 等于当场撤销这次拆除；「拆完」事件只留作兜底
  （`instantDeconstruct` 的方块不触发 begin，以及 begin 时没能立刻放回的情况）。
- 联机时放回走 `Tile.setNet`（`Call.setTile`），只主机自己看得见的问题一并修掉；
  落不下去就退回 `setBlock`。

## 0.1.6

用户 m10864：「合并到交互多次的时间里吧沿用它们的时间。全部还原」

- **「第一个动作」加了时间窗**：不再无限期算下去，窗口直接沿用「多次交互」那条规则用的
  `th-interact-window`（默认 10 秒，同一个设置项，没有新增开关）。进服很久以后才拆一块自己
  放错的东西不会被当成第一件事；快速骚扰号（进来就拆、拆完就跑）仍然落在窗口里。
- **放回去时连库存一起还原**：拆除瞬间把建筑里的物品（`ItemModule`）与液体（`LiquidModule`）
  按 content 表逐项快照，放回时先 `clear()` 再逐项 `set()`。以前放回去的钍堆 / 容器是空的，
  现在里面的铀、钢、爆混、冷冻液都还在。

## 0.1.5

用户 m10703：「如果进游戏之后的第一个行为是拆除就 ban、通报，然后恢复建筑。」

- **进服第一件事就拆建筑 → 拉黑 + 全服通告 + 把建筑原样放回去**（新行为开关「进服后的第一件事
  就是拆建筑」，默认开，可在设置里关）。只判「进服后还没做过任何别的事」的人：先建方块、改配置、
  控单位、指挥方块过的都不算；管理员与观察模式下的非目标玩家不判。
- 判定用的是 `BlockBuildEndEvent(breaking = true)`（`ConstructBlock.deconstructFinish` 在
  `tile.remove()` **之前**触发，事件里带 `unit` 建造者），所以拆的那一刻还能读到原方块的
  种类 / 队伍 / 朝向 / 配置 / 血量。下一帧 `restoreTile()` 只在原位已经空了（`tile.block()` 是 air）
  时才放回去，避免盖掉别人刚铺的东西；配置（如逻辑代码、物品过滤）与血量比例一并恢复。
- 玩家加入时登记、离开/换图时清空；`firstPending()` 只对登记过且没做过别的事的人生效。

## 0.1.4

用户 m10511：「什么东西需要全图扫描啊，不能只在方块更新时扫描或者看看有没有原版API可供调用吗。」
把「发现有哪些方块」从每秒全图改成事件驱动 + 滚动兜底。

- **每秒不再遍历全图**。三处检查（钍堆热量 / 发电机里的爆混 / 自复制逻辑）盯的是**随时间变化的
  状态**，原版没有对应事件：`ConfigEvent` 只在玩家点配置时触发（`InputHandler.java:729`），
  物品进出、热量累积、逻辑代码被远程改都不发事件 ⇒ 检查只能轮询；但「有哪些方块」不该每秒找：
  世界载入 `seedWatch()` 播种一遍（一次性），之后 `BlockBuildEndEvent` 登记、
  `BlockDestroyEvent` 注销、`ConfigEvent` 补登记；另有每 tick 64 个的 `sweepWorld()`
  滚动兜底（≈30 秒滚完 8311 方块，单 tick <0.05 ms），兜住 world processor setblock、
  模组直接改世界、事件漏发这些没有事件的来源。
- 每秒真正被检查的方块：全图 8311 → 登记表里的 100~200 个。`gtb.scan` 与心跳行新增
  `watch=` / `sweep=`，`ms=` 现在是登记表那一轮的时间。
- 建造者表只给「会被处置的三类方块」记（以前所有方块都记，铺线久了只涨不消），
  拆方块时 `BlockDestroyEvent` 一并清掉。
- 自复制逻辑：代码被改干净会自动清掉「已处置」标记，同一块以后再被注入仍会报。

## 0.1.3

修用户报的「启用 Grief to Ban 之后地图编辑器加载很久、长时间未响应」，外加三条行为调整。

- **主线程每秒被白白烧掉 370 ms**（用户 m10300：造成卡顿的是 Grief to Ban）。v160 的
  `Groups.build` / `Groups.player` 是 `mindustry.entities.EntityGroup`，只有 size() / index(int) /
  each(...)，**没有 get(int)**；旧 `seqGet()` 先试 `seq.get(i)`，每个方块抛一次 Rhino
  TypeError 再被 catch 吞掉。真 v160 引擎实测：一次「引擎抛异常」**13.8–15.8 µs**（中位 14.87），
  而无异常的 `index(0)` 只要 0.36–0.46 µs —— 成本几乎全在 Rhino 构造异常对象（要调
  Building.toString()），跟方块多少无关。每秒 3 遍扫描 × 8311 个方块 ≈ 2.5 万次异常/s
  ⇒ **370.8 ms/s ≈ 37% 墙钟**，而且三遍还连在同一个 tick 里跑，真机就是「每秒一次约 370 ms
  的主线程整段停顿」。现在 `seqGet` 先走 `index(i)`，无异常取元素。
- **三遍全图扫描合成一遍**：以前 `scanReactors` / `scanGenerators` / `scanVirusQuick` 各自
  `for i < Groups.build.size()` + `seqGet`，一秒钟三遍全图、三倍异常。现在只有一个
  `scanWorld()` 走一遍 `Groups.build`，循环里直接 `arr.index(i)`，分别交给
  `stepReactor` / `stepGen` / `stepLogic`。同一工作量从约 371 ms/s 掉到约 3.3 ms/s。
  耗时挂到 `GTB_PERF.scan/worst/builds`，系统属性 `gtb.scan` 与心跳日志都带
  `ms= / worst= / builds=`，单轮 ≥40 ms 记一行 `scan slow`。
- **地图编辑器里完全不扫**：编辑器模式（`Vars.state.rules.editor`）下 tick 直接返回，
  `onBuildEnd` / `onConfig` 也早退 —— 编辑器里没有要处置的东西，但方块数可以上万，
  以前是边编辑边每秒卡一次。日志与心跳带 `editor=1`，世界加载行会写明是否进了编辑器。
- **设置不再一处一写盘**：以前每一处 `swrite()` 都调 `Core.settings.autosave()`（整份
  settings.bin，本机 287 KB），一次事件里改几处就在同一帧写几遍。现在同值不写、只标脏，
  tick 里最多每 1.5 s 冲一次，世界加载后立刻冲一次。
- **debug 日志不再逐行开关文件**：每行 open/write/close 改成内存缓冲，40 行或 500 ms 后
  一次落盘；「诊断信息 / 查看日志 / 导出」前强制冲刷。
- **钍堆恢复条件改了**（用户 m10061）：以前「热量掉到 0 就恢复」，但钍还在，恢复后热量
  又涨上来 ⇒ 停用、恢复、停用无限循环，每次都广播一次。现在只有**钍取空**或**通了冷冻液**
  才恢复（`reactorSafe()`），其它情况保持停用且不再重复提示（日志一行 `reactor held`）。
- **爆混机只停用、不清空**（用户 m10061）：以前 `b.items.set(blastCompound, 0)` 把玩家的
  爆混凭空删掉。现在只 `setEnabled(false)`，材料原样留着；同一台方块只提示与处置一次
  （`GTB_GENS` 记录），玩家再把它打开就静默再停；爆混被取走则清掉记录。
- **装爆混的人真的会被拉黑**（用户 m10061）：旧代码只给钍堆记建造者，发电机命中时只知道
  「方块有问题」不知道是谁建的。现在 `onBuildEnd` 对**所有方块**都记建造者，爆混机命中就
  拉黑建造者（在线走 `punish`，离线直接写名单）。一轮最多处置 6 个，其余下一秒继续，
  不会在一个 tick 里连发一堆封禁；管理员建的只广播「只停用，不拉黑」。
- **管理员真的被移出黑名单**（用户 m10076）：以前 `removeBlacklist()` 只删名单、不回队伍，
  人还停在队伍 0（旁观），看起来就像「切了管理员也没移出黑名单」。现在同时
  `restoreTeam()` 回到原队伍，广播与私聊都写明「已移出黑名单，并恢复到原来的队伍」。
- **ESC 菜单入口带图标**（用户 m10086）：`Grief to Ban` 按钮改用 `Icon.hammer`，
  取不到图标时退回纯文字按钮。
- 自检多了两条：`seqGet` 必须先走 `index()`；perf / editor 辅助函数存在。

## 0.1.2

- **自动更新在限流下也能用**：api.github.com 按 IP 限流（本机实测 403 rate limit exceeded），
  拿不到 latest release 时改读仓库 main 上的 mod.hjson 版本号（raw.githubusercontent 走 CDN，
  没有这层限制）。两条都失败才记一条日志，不提示、不报错。
- 自检多了两条：mod.hjson 版本号能解析出来、minGameVersion 不会被误当成 version。

## 0.1.1

修用户实测报的五件事。根因只有一条，但它让所有「全图扫描」静默空转。

- **根因：Groups.* 不是 arc 的 Seq**。v160 里 Groups.player / Groups.build 是
  mindustry.entities.EntityGroup，只有 size() / index(int) / each(...)，**没有 get(int)**。
  旧的 seqGet() 直接 seq.get(i)，抛异常被 catch 成 null ⇒ 每一次扫描都遍历到「零个对象」，
  而日志里一行错都没有。现在 seqGet 依次试 get(i) / index(i) / items[i]，
  并在自检里钉住「能取到元素」。
- **钍堆升温不拦**（用户：热量 >0 时没有拦截）：真机实证 heat 是 **0..1 的比例**
  （NuclearReactor.update 里 heat >= 0.999 就 kill()），旧文案把 0.32 说成「热量 0.32」。
  现在按百分比写（heat=48.3%），扫描周期 3 秒 → **1 秒**，
  并且只对「本来开着」的堆下手，不会每秒重复通告一次。
- **病毒逻辑没有禁用**：旧代码先看「建造者是否该处置」，不满足就直接 return，
  连停用都不做。现在**停用与处置解耦**：命中就 executor.load(空程序) + code = ""（
  不然重载存档又编译回去），然后才按需拉黑/通告。判定也不再要求 ConfigEvent 带 config。
- **黑名单没写入、但人已经被换队**：playerByUuid() 走 eachPlayer() 也吃了上面那条根因，
  在线玩家永远查不到 ⇒ 处置路径拿不到人；另外面板改完名单不重画，看起来像「没写进去」。
  现在 seqGet 修好、名单动作后主动 rebuild()，并且每条设置写入都 Core.settings.autosave()，
  写后立刻读回比对（不一致就记日志），自检里有一条「写进名单 → 从 settings 读回来 → 删掉」。
- **仓库名 + 自动更新**：默认仓库改为 https://github.com/EnernalIliary/Mindustry-GriefToBan ；
  进服 / 建房时自动查一次 releases/latest，有新版本就在聊天栏播一条；
  仓库还没有 Release（HTTP 404）时只记日志，不提示、不报错。
  本版已发到该仓库（Release v0.1.1），之后有新版本会在进服时提示。
- **ESC 菜单入口**：暂停 → Grief to Ban（Vars.ui.paused.shown 每次重挂一条按钮，
  因为 PausedDialog 每次打开都会 clearChildren() 重建）。
- **诊断（给下一次报 bug 用）**：数据目录下的 gtb-debug.log 记录 init / 每次扫描的计数 /
  停用了哪个钍堆、哪段逻辑；设置页「维护」段新增「诊断信息 / 写入自检 / 查看日志 / 清空日志」四个按钮。
  同时把内部扫描计数挂到系统属性 gtb.scan 上，方便在服务端控制台 js 里直接读。

验证：tests/grief-to-ban/run_gtb_tests.py（275 条 lib 断言）、
tests/grief-to-ban/run_server_probe.py（真引擎 31 条自检全绿，含黑名单落盘）、
真服务端端到端（放一颗 heat=0.5 的钍堆 → 3 秒后 enabled=false；放一段自复制逻辑 → 3 秒后 code 为空、instructions=0）。

## 0.1.0

首个版本。纯 JS + Rhino，无 Java 代码（`hidden: true`）。

- **黑名单（按 uid）**：名单内的玩家进服即被切成旁观（队伍 0，`Team.derelict`），
  期间不能建造、不能控单位；房主把他设为管理员会自动移出，或在设置页手动移出。
  `uid = player.uuid()`，与游戏自己的封禁同源，改名无效。
- **游戏默认黑名单（可选）**：打开后名单同时写进 Mindustry 自己的封禁列表
  （`admins.banPlayerID`），并且以游戏封禁列表为准（`refreshVanBan()` 每 3 秒缓存一次，
  `isBanned()` 两处都查）。
- **语言黑名单**：按 `player.locale` 匹配（`zh_CN` / `zh` 前缀都认），
  模式三选：关闭 / 直接拉黑 / 只列为观察对象。选观察时，下面所有「成员」只指观察名单里的人。
- **行为黑名单（六项，可逐项开关）**：
  1. 短时间内多次交互（方块配置 / 控单位 / 指挥，默认 10 秒 20 次）—— 拉黑 + 通告。
     新建方块不计入：正常铺产线 10 秒 20 块很常见，计入会误伤。
  2. 病毒逻辑（`ucontrol build … @this`，判据同 `rules/virus-logic.json`）——
     载入空程序停用该处理器 + 拉黑 + 通告；3 秒一轮的全图扫描兜住「模组后加载」的情况。
  3. 钍堆离核心过近（默认 30 格）—— 警告 + 通告（不拉黑）。
  4. 钍堆热量不为 0 —— `enabled = false` 停用（热量按 `ambientCooldownTime` 自然归零后自动恢复）
     + 拉黑 + 通告；热量归零后自动重新启用。
  5. 涡轮 / 火电 / 涡轮发电机里装爆混 —— 清空物品 + 停用 + 警告 + 通告。
  6. 附身单位长期不动（`aimX/aimY` 位移 < 0.5 像素，默认 3 分钟）—— 踢出 + 通告。
- **/vote kick 期间自动旁观**：`Vars.netServer.currentlyKicking` 出现目标时把他转队伍 0，
  投票结束（或取消 / 目标被踢）自动恢复原队伍并私聊告知。
- **设置界面**（`设置 → Grief to Ban`，锤子图标）：主体色 / 强调色可配，
  在线管理黑名单与观察名单（直接点在线玩家加入 / 移出），版本检查走 GitHub API
  （仓库地址可改，失败只提示）。
- **只在服务端 / 房主 / 单机生效**：`isAuthority()` 判断 `!net.active() || net.server()`，
  纯客户端连别人的服时不做任何处置，界面操作会提示「只有房主 / 服务端才能改」。

### 已知限制

- 「指挥大量单位」没有专门事件，按 `UnitControlEvent` / `BuildingCommandEvent` 计数近似。
- 停用方块走 `enabled` 字段（`BuildingComp` 里是包私有），有反射兜底；
  若两者都失败，钍堆只做热量清零、不保证停用。
- 单机（非房主）下游戏本身不跑 `netServer` 的连接流程，`PlayerJoin` 只在联机时有意义。