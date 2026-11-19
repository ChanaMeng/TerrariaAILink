# TerrariaAILink

[github.com/ChanaMeng/TerrariaAILink](https://github.com/ChanaMeng/TerrariaAILink)

A tModLoader mod and reference client that let **any external program drive a Terraria character with normal inputs at 60 Hz** -- for AI players, bots, automated testing, or replays.

- **Mod** (`TerrariaAILink/`): reads player / NPC / projectile / item / tile state, writes `Player.control*` flags and mouse aim, records and replays input frames. No teleporting, no velocity hacks: it presses the same buttons a human would.
- **Reference client** (`daemon/`): Node.js, no dependencies. 60 Hz loop, behavior-tree modes (`idle`, `free`, `goto`, `combat`, `build`, `replay`), dodge servo, local HTTP API + CLI.
- **Protocol** (`docs/protocol.md`): newline-delimited JSON over TCP. Write your own client in Python, Go, Rust -- anything that can hold a socket.

> Status: **experimental**. Tested against tModLoader `1.4.4.9` (2026.09 stable). Not compatible with vanilla Terraria `1.4.5`; tModLoader worlds and saves are separate.

## Version support

- **tModLoader 1.4.4.9 (2026.09 stable)** -- supported and tested.
- **Terraria 1.4.5.x** -- not yet. tModLoader's 1.4.5 port is still in development and has no stable release or ETA (as of November 2026). When tModLoader 1.4.5 stable ships, this mod can be rebuilt against it: the C# layer needs the upstream API migration, while the protocol, daemon, behavior trees, and dodge code stay unchanged.
- **Vanilla Terraria** -- never. This is a tModLoader mod, not a memory/overlay cheat.

## How it works

```
your agent / script          decisions, goals, chat
        |  CLI or HTTP (optional)
        v
reference client (Node)      60 Hz: behavior trees, dodge, aim, build steps
        |  TCP 127.0.0.1:17890, NDJSON
        v
tModLoader mod               reads state, writes controls, records/replays
```

The mod is deliberately dumb: one state line per tick, one input line per tick. All game sense lives in the client, so you can replace it without touching C#.

## Build

Requirements: tModLoader 1.4.4.9, .NET 8 SDK.

```powershell
git clone https://github.com/ChanaMeng/TerrariaAILink.git
cd TerrariaAILink

copy local.props.example local.props
# edit local.props -> TmlTargetsPath points at ...\tModLoader\tMLMod.targets
# or: set TML_DIR=C:\path\to\tModLoader

dotnet build TerrariaAILink\TerrariaAILink.csproj
```

The build drops `TerrariaAILink.tmod` into `Documents\My Games\Terraria\tModLoader\Mods`.

## Run

```powershell
# 1. enable TerrariaAILink in tModLoader, enter a world
# 2. start the reference client
cd daemon
node src/main.mjs

# 3. drive it
node src/cli.mjs status
node src/cli.mjs mode free "{\"keys\":[\"right\"],\"ms\":800}"
node src/cli.mjs goto 120 60
node src/cli.mjs attack 18
node src/cli.mjs say hello from the bot
node src/cli.mjs stop
```

Without the game, run the mock mod to exercise protocol and CLI:

```powershell
node tools/mockmod.mjs
node src/main.mjs
node src/cli.mjs status
```

## Multiplayer

TerrariaAILink is a tModLoader mod, so it follows tModLoader's rules:

- Everyone needs **tModLoader 1.4.4.9** (the free Steam app). Vanilla Terraria clients cannot join a tModLoader server.
- The mod is marked `side = Client`, so **your friends do not need it** -- they only need tModLoader. Install it on the machine that runs the AI.
- Host with **Multiplayer -> Host & Play**, then friends join from the Steam friends list.
- The AI can be the host player (the mod controls your character) or a second tModLoader instance on another machine.

## Security and fair play

- The bridge binds **127.0.0.1 only** and has no authentication. Any local process can control the player while the mod is loaded -- do not run untrusted software alongside it.
- Intended for **single-player and private co-op**. Do not use it on servers where automation is prohibited.

## License

MIT. See `LICENSE` and `NOTICE`. Inspired by [TerraBlind](https://github.com/Reisenbug/TerraBlind) (MIT); no TerraBlind source code is included.

---

## 中文速览

- `TerrariaAILink/` 是 tModLoader mod：每 tick 推一行状态、收一行输入，只写正常按键和鼠标，不传送、不改速度。
- `daemon/` 是 Node 参考客户端：60Hz 循环、行为树模式（空闲/手动/寻路/战斗/建造/回放）、闪避伺服、本地 HTTP + CLI。
- 协议是 127.0.0.1 上的行分隔 JSON，换成 Python/Go 客户端也行。
- 联机必须都用 tModLoader 1.4.4.9，mod 清单一致；原版 1.4.5 进不来。
- 仅限单机/私人联机；不要在禁止自动化的服务器上用。
