# Architecture

Three layers, one rule: **decisions are slow, reflexes are fast, and the mod only executes.**

```
agent / script          seconds      goals, building plans, target choice, chat
   | CLI / HTTP
client (Node)           60 Hz        behavior trees, dodge, aim, build steps
   | TCP NDJSON
mod (C#)                per tick     read world, write Player.control*, record/replay
```

## Modes

| Mode | Params | Behavior | Events |
| --- | --- | --- | --- |
| `idle` | - | stand still | - |
| `release` | - | stop sending input; the mod releases control after 15 ticks | `released` |
| `free` | `{keys:[left/right/up/down/jump/use/tile], ms, dodge?:false}` | raw minimal input | - |
| `goto` | `{x,y}` | walk to a tile, jump when blocked | `arrived`, `stuck` |
| `build` | `{plan:[{x,y,slot}], reach?:5, ticksPerTile?:6}` | place tiles in order; walk into reach; check HP; emit progress | `build_step`, `build_done`, `build_risk`, `stuck` |
| `combat` | `{range?:18, target?:id, slot?, melee?}` | behavior tree: pick target, move, aim with lead, use item | `no_target` |
| `boss` | `{boss?:id, ...}` | `combat` with a boss target and room for per-boss phase logic | - |
| `replay` | `{frames, loop?}` | send recorded frames to the mod, which plays them locally at 60 Hz | `replay_done` |

`/mode` always preempts the current mode (`exit()` runs first). The dodge servo lives **outside** the modes: while `allowDodge` is true it can override left/right/jump when projectiles get close. `free` disables it by default -- a manual step stays a manual step.

## Combat tree

```
Sequence(
  selectTarget,                    # boss first, else nearest hostile with damage > 0
  Selector(
    Sequence(dist > range, approach),
    Sequence(dist < range*0.45 && !boss, backOff),
    SUCCESS                        # hold
  ),
  aimAt,                           # target position + velocity * lead
  useItem                          # melee within 3.2 tiles, ranged within range
)
```

Dodge candidates (stand / left / right / jump / jump-left / jump-right) are simulated 36 frames ahead; each is scored by the closest distance between the player hitbox and any extrapolated projectile or hostile NPC. The best candidate is held for at least 6 frames to avoid jitter.

## Events

A ring buffer (last 300) exposed through `GET /events?since=<seq>`:
`link_up`, `link_down`, `hello`, `mode_change`, `arrived`, `stuck`, `build_step`, `build_done`,
`build_risk`, `no_target`, `replay_done`, `spawned`, `say`, `stop`, `released`.

Long tasks use events, not polling: start a build, do something else, read the tail later.

## Roadmap

1. **M1 bridge** - done: mod + client + in-game move/jump/use/say/goto.
2. **M2 calibration** - measure jump/acceleration/aim from real traces.
3. **M3 combat** - combat tree + dodge against live projectiles; per-weapon branches.
4. **M4 building** - tile verification, mining blockers, house blueprints.
5. **M5 pathfinding** - A* with jump edges; travel policy (fight / skip / bail).
6. **M6 bosses** - phase tables per boss (Eye of Cthulhu first).
7. **M7 multiplayer** - two clients, sync, chat.

## Boundaries

- Normal inputs only: `controlLeft/Right/Up/Down/Jump/UseItem/UseTile` + mouse position.
- tModLoader 1.4.4.9 only; vanilla 1.4.5 saves are not compatible.
- Localhost bridge, no auth: single-player and private co-op only.
