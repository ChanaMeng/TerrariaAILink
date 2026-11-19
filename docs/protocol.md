# TerrariaAILink protocol v1

Transport: TCP `127.0.0.1:17890`, UTF-8, **one JSON object per line** (NDJSON). One client at a time.
The mod pushes one `state` line per game tick; the client replies with one `in` line per tick.
If no input arrives for 15 ticks (~250 ms), the mod releases control.

## mod → client

### hello
```json
{"t":"hello","mod":"TerrariaAILink","v":1,"port":17890,"world":""}
```

### state (one line per tick)
```json
{
  "t":"state","tick":123456,"tm":1234,"day":1,"bm":0,"ec":0,"hm":0,"iv":0,
  "mx":8400,"my":2400,"rec":0,"rep":0,
  "p":{
    "nm":"Player","x":1000.5,"y":600.25,"vx":0.5,"vy":0,"w":20,"h":42,
    "hp":100,"mhp":100,"mp":20,"mmp":20,"air":200,"amax":200,
    "grd":1,"dir":1,"sl":0,"dead":0,"resp":0,"wing":0,"dash":0,"mnt":-1,"use":0,
    "it":{"ty":0,"nm":"Iron Pickaxe","ut":12,"ua":20,"ar":1,"dm":5,"ss":0,"sh":0,
          "me":1,"rg":0,"mg":0,"sm":0,"pk":40,"ax":0,"hm":0,"am":0,"mc":0,"ch":0,"us":1}
  },
  "bf":[[1,300]],
  "n":[{"i":1,"ty":1,"x":1200,"y":600,"vx":-0.3,"vy":0,"w":32,"h":24,
        "lf":40,"lm":40,"bo":0,"fr":0,"dm":7,"ai":1,"rl":-1,"a":[0,0,0,0]}],
  "pr":[{"i":12,"ty":1,"x":1300,"y":570,"vx":-4,"vy":0,"w":10,"h":10,
         "dm":10,"ho":1,"ow":255,"eu":0,"ai":0}],
  "dr":[[5,2,1100,600,3]],
  "hb":[0,0,0,0,0,0,0,0,0,0],
  "in":[0,0]
}
```
- All coordinates are **pixels**; `x/y` is the center of the hitbox.
- `p.it`: held item. `ut/ua` use/animation ticks; `ss` shoot speed (px/tick); `pk/ax/hm` pick/axe/hammer power; `am` ammo ID.
- `n`: NPCs within 2400 px plus every boss (including parts, `rl` = realLife). `a` is `npc.ai[0..3]` — boss phases live there.
- `pr`: hostile projectiles within 2600 px plus your own. `eu` = extraUpdates; real velocity = `v * (eu+1)`.
- `dr`: item drops within 1200 px, max 60, `[id, itemType, x, y, stack]`.
- `hb`: 10 hotbar item types. `in`: full inventory, sent every 30 ticks.
- `bf`: buffs `[type, secondsLeft]`.

### tiles
```json
{"t":"tiles","x":100,"y":50,"w":64,"h":48,"d":"<base64>"}
```
`d` is 5 bytes per cell: `tileType u16 LE | flags u8 | liquidAmount u8 | liquidType u8`.
flags: bit0 solid, bit1 platform, bit2 actuated, bit3 half-block, bits4-5 slope.

### record (recording finished)
```json
{"t":"record","frames":[[0,1,0,0,0,0,0,0,0.5,-0.2]]}
```
Ten values per frame: `left,right,up,down,jump,use,tile,slot,aimDX,aimDY`; aim is relative to the player center in tiles.

### replay_done / log / pong
```json
{"t":"replay_done"}
{"t":"log","msg":"..."}
{"t":"pong"}
```

## client → mod

### in (one line per tick)
```json
{"t":"in","r":true,"j":true,"use":true,"slot":0,"ax":2.5,"ay":-0.5}
```
Missing fields are false. `ax/ay` are tile offsets from the player center; omit to leave the mouse alone.

### cmd
```json
{"t":"cmd","op":"say","text":"..."}
{"t":"cmd","op":"tiles","x":100,"y":50,"w":64,"h":48}
{"t":"cmd","op":"replay","frames":[],"loop":false}
{"t":"cmd","op":"record","on":true}
{"t":"cmd","op":"spawn","type":2,"dx":120,"dy":-40}
{"t":"cmd","op":"clear"}
{"t":"cmd","op":"stop"}
```
`replay` runs locally in the mod at 60 Hz, so recorded macros do not jitter with network timing.
`stop` clears live input, replay, and recording.
