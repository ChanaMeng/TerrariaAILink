# 开发文档 · TerrariaAILink

> 版本 v0.1（2026-11-20）。方向看 `design.md`，进度看 `progress.md`，测过什么看 `test.md`。
> 协议细节以 `protocol.md` 为准，架构图以 `architecture.md` 为准。

## 1. 仓库结构

```
terraria/
├─ TerrariaAILink/            tModLoader mod（C#，.NET 8）
│  ├─ src/
│  │  ├─ TerrariaAILinkMod.cs  Mod 入口：Load 时启动 BridgeServer
│  │  ├─ BridgeServer.cs       TCP 127.0.0.1:17890，NDJSON 收发
│  │  ├─ BridgeSystem.cs       每 tick 推送状态；消费动作队列
│  │  ├─ StateCapture.cs       玩家/NPC/弹幕/物品/瓦片 → JSON
│  │  ├─ ControlPlayer.cs      写 Player.control* 与鼠标瞄准
│  │  ├─ Chat.cs               发聊天（SendChatMessageFromClient）
│  │  └─ ChatTap.cs            读聊天（反射 chatMonitor，去重）
│  └─ build.txt                tModLoader 版本/作者元数据
├─ daemon/                    Node 客户端（无依赖）
│  ├─ src/
│  │  ├─ main.mjs             入口：组装 world/client/dodge/manager/api
│  │  ├─ proto.mjs            NDJSON 协议、端口、neutral() 帧
│  │  ├─ world.mjs            状态缓存、敌我查询、瓦片解码
│  │  ├─ modes.mjs            模式（= 策略组的执行体）与 ModeManager
│  │  ├─ bt.mjs               极小程序化行为树（sequence/selector/action）
│  │  ├─ dodge.mjs            弹幕外推 + 候选动作评分闪避
│  │  ├─ server.mjs           HTTP 127.0.0.1:17891（status/events/mode/cmd）
│  │  ├─ cli.mjs              命令行入口
│  │  └─ watch.mjs            守聊天（轮询，命中关键词才叫醒）
│  ├─ tools/mockmod.mjs       无游戏时的假 mod（联调协议用）
│  └─ package.json
├─ docs/                      本目录（四份纸 + 架构/协议）
├─ 启动鲸白.cmd              一键：等世界 → 起客户端 → 起 daemon
└─ start-whale.ps1           上面那个的 PowerShell 实现
```

## 2. 数据流

```
state（每 tick 上行）   mod --{t:"state",p,n,pr,it,...}--> daemon --(内存)--> mode.tick()
input（每 tick 下行）   daemon --{t:"input",...}--> mod --(control*)--> 角色
tiles（按需上行）       daemon 发 {t:"cmd",op:"tiles",...}，mod 回 {t:"tiles",d:base64}
chat（双向）            mod --{t:"chat"}--> daemon；daemon 发 {op:"say",...} --> mod
```

**关键约定：一 tick 一帧。** mod 推一行状态，daemon 回一行输入。没有积压、没有队列补帧。

## 3. 模块职责

| 文件 | 职责 | 改动风险 |
| --- | --- | --- |
| `modes.mjs` | 策略组的执行体；`ModeManager.set()` 换组 | 中：行为都在这里 |
| `world.mjs` | 状态索引；`boss()/hostiles()/tileAt()` | 低 |
| `dodge.mjs` | 弹幕闪避，独立的伺服层 | 高：碰它会晕 |
| `proto.mjs` | 协议与常量 | 低（改端口要两边同步） |
| `server.mjs` | 外部接口 | 低 |
| `StateCapture.cs` | 世界 → JSON | 中：字段一改，daemon 要跟 |
| `ControlPlayer.cs` | 输入 → 游戏 | 高：会直接毁操作手感 |

## 4. 运行

```powershell
# 无游戏联调（假状态）
node tools/mockmod.mjs
node src/main.mjs
node src/cli.mjs status

# 真机（主客户端已开世界）
node src/main.mjs            # 后台起，输出写 daemon.out.log
node src/cli.mjs brief
```

端口固定：游戏 `7777`、桥 `17890`、HTTP `17891`。三个都只绑 `127.0.0.1`。

## 5. 怎么加一个策略组

策略组 = 一个 `Mode` 子类 + 注册一行。**先想清楚退出条件**，没有退出条件的组会卡死。

```js
export class GatherMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'gather'; }
  enter() {
    this.allowDodge = true;
    this.target = null;
    this.since = Date.now();
  }
  tick() {
    const f = neutral();
    // 1. 选目标（最近的树/矿）
    // 2. 够不着 → 走近（复用 walkToward）
    // 3. 够了 → 瞄准 + use
    // 4. 背包满 / 超时 / 危险 → event + manager.set(...)
    return f;
  }
  status() { return { name: this.name, target: this.target?.id ?? null }; }
}

// ModeManager.factories 里加：
gather: (c, p) => new GatherMode(c, p),
```

验收：`node src/cli.mjs mode gather '{"kind":"tree"}'`，看 `events` 里有没有 `gather_done` / `gather_stuck`，以及角色是不是真在动。

## 6. 怎么加一个守护条件

守护层在 `ModeManager.tick()` 里、`mode.tick()` 之前插入（计划中，当前只有 dodge 这一个外部伺服）：

```js
// guard.mjs（待建）
export function applyGuards(ctx, frame) {
  const p = ctx.world.p;
  if (p && p.hp < p.mhp * 0.3 && ctx.manager.name !== 'survive') {
    ctx.event('guard', { kind: 'low_hp', hp: p.hp });
    ctx.manager.set('survive', { reason: 'low_hp' });
    return true; // 已接管，本帧不再跑原组
  }
  return false;
}
```

规矩：
- 守护只做保命/止损，不做长期规划
- 每个守护有**冷却**，防抖
- 触发必发事件（`guard`），鲸白读得到

## 7. 怎么加一个原子动作

原子动作走 `cmd`，不占模式：

```js
// server.mjs 的 handleCmd
if (op === 'craft') {
  client.send({ t: 'cmd', op: 'craft', item: body.item, count: body.count ?? 1 });
  return { ok: true };
}
```

mod 侧在 `BridgeSystem` 的 action 分发里加一个 case。**动作必须验证结果**：做了没、数量变没、失败原因，作为事件回到 daemon（对照 `build_step` 的做法）。

## 8. 约定

- **tick 里不许 await、不许网络、不许读大文件**。要异步的东西进事件队列。
- **每个组必须有退出条件**，并且退出要发事件。
- **一帧只发一行 input**；`null` 表示「这帧不由 daemon 管（release/menu）」，不是「发空帧」。
- **中文别走 PowerShell 的 REST**（编码会变 `?`），走 `cli.mjs say`。
- **不写绝对路径进仓库**（公开仓库），路径写在 `local.props` / 环境变量。
- **事件是给鲸白读的，日志是给人看的**，别混。

## 9. 调试速查

```powershell
node src/cli.mjs brief                 # 状态+聊天+事件，一条拿全
node src/cli.mjs state | ConvertFrom-Json | ConvertTo-Json -Depth 4
node src/cli.mjs grid 3188 309 16 12   # 看瓦片（#实心 .=空）
node src/cli.mjs chat 0                # 读全部聊天
node src/cli.mjs events 0              # 读全部事件
node src/cli.mjs say 内容
```

## 10. 版本与兼容

- tModLoader `1.4.4.9`（2026.09 stable）唯一支持。
- 原版 Terraria `1.4.5.x` 不兼容：`build.txt` / `TerrariaAILink.csproj` 引的是 tML 的 1.4.4.9 程序集。
- tML 升 1.4.5 时要改的是 C# 层 API；协议、daemon、行为树不用动。
