# 进度文档

> 更新规则：只记「变了什么」，不记流水账。每条带日期。做完的进「已完成」，没做完的留在「进行中/待办」。
> 最后更新：2026-11-20 00:40

## 当前里程碑

**M2 · 自主层**（进行中）：战况摘要 + 策略组注册表 + 守护层 → 自主循环 → 原子动作。

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

### 工程

- 仓库 `ChanaMeng/TerrariaAILink`，MIT + NOTICE，去个人痕迹。
- 文档四件套：`design.md` / `dev.md` / `progress.md` / `test.md`（2026-11-20 建立）。
- 参考项目调研：TerraBlind、terrar.ai、TerraPlayerBot、`Yukiena1145/terraria-ai-pet`（Coopanion 桌宠世界插件）。
- M2 战况摘要 `brief` 2.0：`buildBrief` 一屏战况 + `GET /brief` + `brief --json`；`node --test` 与 mock 联调通过（2026-11-20）。

## 进行中

| 项 | 下一步 | 阻塞 |
| --- | --- | --- |
| M2 自主层 | 先写 `brief` 战况摘要，再写 `policy` 注册表，再写 `guard` | 无 |
| 文档四件套 | 骨架已立；`test.md` 只有 M1 用例，M2 用例待补 | 无 |

## 待办（按优先级）

1. **合成 / 门** —— 木门要工作台 + 6 木材；现在完全不能合成。这是「房子能住人」的门槛。
2. **建造可靠化** —— 放前查格（别放树/水里）、放后验格、失败重试、够不着自动贴近。
3. **战况摘要** —— `brief` 从字段变「一屏话」：血、威胁、背包关键物、当前目标、最近失败。
4. **策略组注册表** —— `follow/gather/build/explore/fight/boss/home/survive`，带参数与退出条件。
5. **守护层** —— 低血、卡住、Boss、坠落、背包满。纯代码，不阻塞。
6. **自主循环** —— 效用评分选组，零 token。
7. **原子动作** —— 找物品、搬格子、放墙、房屋检查（对照 `terraria-ai-pet` 的 26 个动作挑）。
8. **Boss** —— 克苏鲁之眼优先；要有撤退线，不硬送。
9. **NPC 住房** —— 门 + 椅 + 桌 + 火把 + 合法房屋检查。

## 已知坑

- `-join` 有时停在「选择玩家」：要先点 `Jingbai` 才进世界。
- 中文别用 `Invoke-RestMethod` 发（编码变 `?`），走 `cli.mjs say`。
- 显卡：Steam 启动的 tModLoader 自带 `dotnet` 要单独设核显首选项，否则 `Could not create swapchain`。重装/升级 tML 后要重设。
- 双开同 Steam 账号：只走 Join via IP，别用好友邀请。
- 修 mod 后鲸白端要重启才生效（会掉线重连）。
- 主档**永远不要**启用 mod（17890 会抢）。

## 记忆指针（给记忆库用）

这个项目的**过程不写进记忆库**。记忆里只需要知道：

- 四份纸在哪：`E:\deepseekWorkspace\terraria\docs\`
- 交接页：`笔记/泰拉瑞亚-双人档-交接.md`
- 一句话：M1 已通，M2 自主层在做（战况摘要 → 策略组 → 守护 → 自主循环）。

日记里最多记一句「今天给泰拉瑞亚立了文档四件套，方向改成自主层」，不抄内容。
