# 进度文档

> 更新规则：只记「变了什么」，不记流水账。每条带日期。做完的进「已完成」，没做完的留在「进行中/待办」。
> 最后更新：2026-11-20 23:20

## 当前里程碑

**M3 · 会走路、会自己决定**（进行中）：自主循环 ✅、二维栅格 + A* 寻路 ✅、挖格 ✅、gather 真机砍树 ✅。
下一步：build 接寻路、工具自动选、home、boss 阶段表。

## 已完成

### M1 · 桥（2026-11-19，真机）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| tModLoader mod 与 daemon 通信 | ✅ | `link_up`、每 tick state |
| 走 / 跳 / 挥剑 | ✅ | 实测位移 +143px、挥剑 |
| 说话（双向） | ✅ | `<Jingbai>` 显示在游戏聊天；主人说话 daemon 读得到 |
| `goto` 到指定格 | ✅ | `arrived` |
| `build` 按 plan 摆方块 | ✅ | 6×5 木壳，`build_done` |
| 双人档（Host & Play + -join） | ✅ | 两个客户端同世界 |
| 主人前台时鲸白也能动 | ✅ | `Main.hasFocus = true` 注入 |
| 一键启动 | ✅ | `启动鲸白.cmd` |

### M2 · 自主层（2026-11-20，真机）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 战况摘要 `brief` 2.0 | ✅ | 一屏中文 + `GET /brief` + `brief --json`；位置/血/手持/威胁/事件都对 |
| 策略组注册表 | ✅ | `survive/gather/explore/hold/fight/boss/build/mine`；`follow/home` 只留接口 |
| 守护层 | ✅ | `low_hp / boss_seen / dead / inventory_full`，带冷却 |
| 决策请求 | ✅ | `policy.json` 200ms 热加载；`decision.json` + 90s 超时回落 |
| 战斗 | ✅ | 修了 `selector→sequence`（原来选完目标就短路，从不移动/攻击） |

### M3 · 自主 + 寻路（2026-11-20，真机）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 自主循环 `autonomy` | ✅ | 无指令时按评分选 `fight/gather/explore/hold`；真机从 `release` 接管并切组 |
| 二维栅格 `grid` | ✅ | 416 行，17 条寻路单测；64×48 合成楼梯全通过 |
| 寻路执行 `walk` | ✅ | A* 路径 → 方向键；1 格台阶不跳，游戏自己抬 |
| 挖格 `mine` | ✅ | 真机挖通门洞；`null` 瓦片不再当「空」 |
| `gather` 真机 | ✅ | 找到树 → 寻路走过去 → 切斧头 → `hits: 1` |
| `build` 可靠化 | ✅ | 查格/验格/重试/刷新瓦片；真机 `placed:1, existing:2` |

## 进行中

| 项 | 下一步 | 阻塞 |
| --- | --- | --- |
| build 接寻路 | 用 `ctx.walker` 替换 `walkToward` | 无 |
| 工具自动选 | 背包 type → 斧/镐/方块 的映射表（现在要手动给 `params.slot`） | 无 |
| 真机回归 | 按 `test.md` 的 M3 用例逐条打勾 | 需要主人开世界 |

## 待办（按优先级）

1. **build 走位接寻路** —— 现在够不着时还是直线走
2. **工具自动选** —— 背包 item type → 斧/镐/方块/武器，别让鲸白拿镐砍树
3. **home** —— 补墙、安门、摆家具；依赖合成（C# `craft`）
4. **boss 阶段表** —— 克苏鲁之眼优先，带撤退线
5. **follow** —— 等 mod 推 `otherPlayers`（主人说最后做）
6. **合成 / 门** —— 工作台 + 木材，C# 侧 `craft` 命令
7. **原子动作** —— 找物品、搬格子、放墙、房屋检查（对照 `terraria-ai-pet`）

## 已知限制（不是 bug，是还没做）

- `follow`：协议里没有其他玩家坐标，现在只会发 `follow_unsupported` 并回 idle。
- `home`：没有「家」的目标和蓝图，现在只会发 `home_unsupported`。
- `gather` 的 `kind:'tree'|'ore'` 决定目标类型，但**工具不会自动切**（要 `params.slot`）。
- 没有抓钩字段，坠落守护未实现。
- `combat` 追不上目标时会一直朝它走（`fight` 有 6s 卡住退出，`combat` 没有）。

## 已知坑（真机踩过的）

- `-join` 有时停在「选择玩家」：要先点 `Jingbai` 才进世界。
- 中文别用 `Invoke-RestMethod` 发（编码变 `?`），走 `cli.mjs say`。
- **`idle` 不是松手**：它每帧发「全松开」，照样盖住主人的键盘；松手用 `release`（`cli stop` 已改）。
- **PowerShell 给原生命令传 JSON 会吞双引号**：`policy set` 用 `--file`。
- 记事本存的 JSON 带 BOM，CLI 已剥。
- **镐砍不动树**：树要斧头（`params.slot` 指到斧头格）。
- **瓦片缓存是快照**：自己放的/挖的格子要重新请求才看得见（`build`/`mine` 已加刷新）。
- **主档永远不要启用 mod**（17890 会抢）；真机联调时主档 `enabled.json` 必须是 `[]`。
- 显卡：Steam 启动的 tModLoader 自带 `dotnet` 要单独设核显首选项，否则 `Could not create swapchain`。
- 双开同 Steam 账号：只走 Join via IP，别用好友邀请。
- 修 mod 后鲸白端要重启才生效（会掉线重连）。

## 仓库卫生（2026-11-20）

`terraria-ai-profile/` 里的运行存档（`.plr`/`.tplr`/备份 zip/成就/上次模组/`.tmod`）**不再进 git**，只留配置（`config.json`、`enabled.json`、`input profiles.json`、`servers.dat`）。规则在根 `.gitignore`。

## 记忆指针（给记忆库用）

这个项目的**过程不写进记忆库**。记忆里只需要知道：

- 四份纸在哪：`E:\deepseekWorkspace\terraria\docs\`
- 交接页：`笔记/泰拉瑞亚-双人档-交接.md`
- 一句话：M1/M2 真机通过；M3 的自主循环、寻路、挖格、gather 砍树真机通过；下一步 build 接寻路 + home/boss。

日记里最多记一句「泰拉瑞亚 M3：会自己选活、会走 A*、会砍树了；存档不再进 git」。
