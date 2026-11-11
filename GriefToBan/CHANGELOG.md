# 变更记录 · Grief to Ban

只记对外可见的变化。工程细节见 `out/takeover-20261024/` 下的报告。

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
