# 进度文档

> 更新规则：只记「变了什么」，不记流水账。每条带日期。做完的进「已完成」，没做完的留在「进行中/待办」。
> 最后更新：2026-11-20 01:15

## 当前里程碑

**M2 · 自主层**（核心已完成，mock 验证）：战况摘要 + 策略组 + 守护层 + 决策请求。下一步是自主循环与真机联调。

## 已完成

### M1 · 桥（2026-11-19）

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

### M2 · 自主层（2026-11-20，mock 验证，未真机）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 战况摘要 `brief` 2.0 | ✅ | 一屏中文 + `GET /brief` + `brief --json`；离线不抛栈；10 条单测 |
| 策略组注册表 | ✅ | `survive/gather/explore/hold/fight` 完整；`follow/home` 只留接口 |
| 守护层 | ✅ | `low_hp / boss_seen / dead / inventory_full`，带冷却，独立单测 |
| 决策请求 | ✅ | `state/policy.json` 200ms 热加载；`state/decision.json` + 90s 超时回落 default |
| 战斗回归 | ✅ | 修了 `CombatMode` 的 `selector→sequence` 错误：原来选完目标就短路，根本不走不打 |

### 工程

- 仓库 `ChanaMeng/TerrariaAILink`，MIT + NOTICE，去个人痕迹。
- 文档四件套：`design.md` / `dev.md` / `progress.md` / `test.md`（2026-11-20 建立）。
- 参考项目调研：TerraBlind、terrar.ai、TerraPlayerBot、`Yukiena1145/terraria-ai-pet`（Coopanion 桌宠世界插件）。
- `node --test`：44 条全绿（brief 10 + guard/policy/modes 34）。
- 修了 mock 两个启动 bug（缺 `net` 导入、`s` 未定义）和 daemon 崩溃后 socket ECONNRESET 拖死 mock 的问题。

## 进行中

| 项 | 下一步 | 阻塞 |
| --- | --- | --- |
| M2 真机验证 | 开双人档，按 `test.md` TC-20~25 打勾 | 需要主人起主客户端 |
| 自主循环 | 效用评分选组，零 token，鲸白不在时也不傻站 | 无 |

## 待办（按优先级）

1. **真机联调** —— mock 只能证明「不崩、会切组」，手感/伤害/危险阈值要真机。
2. **合成 / 门** —— 木门要工作台 + 6 木材；现在完全不能合成。
3. **建造可靠化** —— 放前查格、放后验格、失败重试、够不着自动贴近。
4. **自主循环** —— 效用评分选组（生存 > 采集 > 建造 > 探索），带冷却与新鲜度。
5. **原子动作** —— 找物品、搬格子、放墙、房屋检查（对照 `terraria-ai-pet` 的 26 个动作挑）。
6. **mod 加 `otherPlayers`** —— 推其他玩家坐标，`follow` 才能真的跟上主人。
7. **Boss** —— 克苏鲁之眼优先；阶段表 + 撤退线。
8. **NPC 住房** —— 门 + 椅 + 桌 + 火把 + 合法房屋检查。

## 已知限制（不是 bug，是还没做）

- `follow`：协议里没有其他玩家坐标，现在只会发 `follow_unsupported` 并回 idle。
- `home`：没有「家」的目标和蓝图，现在只会发 `home_unsupported`。
- `gather` 的 `kind:'tree'|'ore'` 只进事件/状态，不选树/矿、不换工具——仓库里没有 tile/物品映射。
- 没有抓钩字段，坠落守护未实现。
- `combat` 追不上目标时会一直朝它走（`fight` 有 6s 卡住退出，`combat` 没有）。

## 已知坑

- `-join` 有时停在「选择玩家」：要先点 `Jingbai` 才进世界。
- 中文别用 `Invoke-RestMethod` 发（编码变 `?`），走 `cli.mjs say`。
- **PowerShell 给原生命令传 JSON 会吞双引号**：`policy set` 用 `--file`，别直接内联 JSON。
- 记事本存的 JSON 带 BOM，CLI 已剥；别的工具不一定。
- 显卡：Steam 启动的 tModLoader 自带 `dotnet` 要单独设核显首选项，否则 `Could not create swapchain`。重装/升级 tML 后要重设。
- 双开同 Steam 账号：只走 Join via IP，别用好友邀请。
- 修 mod 后鲸白端要重启才生效（会掉线重连）。
- 主档**永远不要**启用 mod（17890 会抢）。

## 记忆指针（给记忆库用）

这个项目的**过程不写进记忆库**。记忆里只需要知道：

- 四份纸在哪：`E:\deepseekWorkspace\terraria\docs\`
- 交接页：`笔记/泰拉瑞亚-双人档-交接.md`
- 一句话：M1 已通，M2 核心（战况摘要/策略组/守护/决策）mock 已验证；下一步自主循环 + 真机。

日记里最多记一句「泰拉瑞亚 M2 落地：一屏战况、策略组、守护层、决策文件桥，mock 44 测试全绿」，不抄内容。
