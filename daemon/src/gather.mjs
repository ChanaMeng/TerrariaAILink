// gather.mjs — 采集策略组：认树 / 认矿，走近再挥，不再对着空气乱挥。
//
// 旧实现（modes.mjs 里的 GatherMode）只会朝一个方向走，边走边往前下方挥；
// 树在身后、矿在墙里时它既看不见也不会过去。这里拆成三步：
//   选目标（每 250ms 最多一次）→ 接近（>3 格）→ 采集（<=3 格 aim + use）。
//
// 故意不 import modes.mjs：主会话联调期间本文件只新增，不碰现有文件；
// 之后接工厂时再 import 这里的 createGatherMode 即可。
// 鸭子类型：{ name, allowDodge, enter, tick, exit, status }。
import { neutral } from './proto.mjs';

const PX = 16;              // 1 格 = 16px（和 modes.mjs 一致）
const SCAN_TILES = 24;      // 选目标半径（格），也是 2–24 格的上限
const MIN_TILES = 2;        // 比 2 格还近的格子不选：贴着身体，挥不到也没必要
const REACH_TILES = 3;      // 挥得到的距离（格）
const SELECT_MS = 250;      // 选目标的节流
const VERIFY_MS = 500;      // 回读目标格子的间隔
const TILES_MS = 3000;      // 没有目标时重新拉 tiles 的间隔
const JUMP_MS = 1500;       // 卡住多久跳一次
const STUCK_MS = 8000;      // 卡多久把控制权交回去
const STEP_PX = 6;          // 水平位移超过多少算「有进展」

// Terraria 1.4 tile IDs（1.4.4 待真机核对；只用于选目标，选错不会崩）
// 树：5 普通树、323 棕榈树、170 松树（雪地）。
// 矿：常见矿石的 tile ID 合集（来源是 1.4 的 tile ID 表，1.4.4 若改号/新增，
//     真机核对后在这里补；注释里的名字只作提示，不保证逐条对上）。
export const TREE_TYPES = new Set([5, /** Tree */ 323 /** PalmTree */, 170 /** PineTree */]);
export const ORE_TYPES = new Set([
  6, 7, 8, 9, // 基础矿石段（铁/铜/金/银）
  22, 23, 37, 58, // 魔矿 / 陨石 / 地狱石 / 黑曜石段
  107, 108, 111, // 钴 / 秘银 / 叶绿素段
  211, // 钯金段
  221, 222, 223, 224, 225, 226, 227, 228, // 困难模式矿石段
]);

/** 工厂：和其它策略组一样接收 (ctx, params)，返回鸭子类型 Mode。 */
export function createGatherMode(ctx, params = {}) {
  return new GatherMode(ctx, params);
}

class GatherMode {
  constructor(ctx, params = {}) {
    this.ctx = ctx;
    this.params = params;
    this.name = 'gather';
    this.allowDodge = true;
    this.dir = params.dir === 'left' ? 'left' : 'right';
    this.kind = params.kind === 'ore' ? 'ore' : 'tree';
    this.types = this.kind === 'ore' ? ORE_TYPES : TREE_TYPES;
    this.timeoutMs = params.timeoutMs ?? 90_000;
    this.startedAt = Date.now();
    this.finished = false;
    this.target = null;
    this.selectedAt = 0;
    this.tileCheckAt = 0;
    this.tilesAt = 0;
    this.lastX = null;
    this.progressAt = Date.now();
    this.jumpAt = 0;
    this.stuckJumped = false;
    this.invSig = null;
    this.items0 = null;
    this.hits = 0;
  }

  enter() {
    // params 在工厂创建后可能被改，这里统一以 enter 时的值为准。
    this.dir = this.params.dir === 'left' ? 'left' : 'right';
    this.kind = this.params.kind === 'ore' ? 'ore' : 'tree';
    this.types = this.kind === 'ore' ? ORE_TYPES : TREE_TYPES;
    this.timeoutMs = this.params.timeoutMs ?? 90_000;
    this.startedAt = Date.now();
    this.finished = false;
    this.target = null;
    this.selectedAt = 0;
    this.tileCheckAt = 0;
    this.hits = 0;
    this.jumpAt = 0;
    this.stuckJumped = false;
    this.lastX = this.ctx.world.p?.x ?? null;
    this.progressAt = Date.now();
    this.invSig = this.inventorySignature();
    this.items0 = this.usedSlots();
    // 玩家周围 64×48 格（左右各 32、上下各 24），够覆盖 24 格选目标半径。
    this.requestTiles();
  }

  requestTiles() {
    const p = this.ctx.world.p;
    const x = Math.floor((p?.x ?? 0) / PX) - 32;
    const y = Math.floor((p?.y ?? 0) / PX) - 24;
    try {
      this.ctx.client.send({ t: 'cmd', op: 'tiles', x, y, w: 64, h: 48 });
    } catch { /* 链路断了就等下一帧，不把整组带崩 */ }
    this.tilesAt = Date.now();
  }

  tileAt(tx, ty) {
    try {
      return this.ctx.world.tileAt?.(tx, ty) ?? null;
    } catch {
      return null;
    }
  }

  inventorySignature() {
    const inv = this.ctx.world.state?.in;
    return Array.isArray(inv) ? inv.join(',') : null;
  }

  usedSlots() {
    const inv = this.ctx.world.state?.in;
    return Array.isArray(inv) ? inv.filter((t) => Number(t) > 0).length : null;
  }

  /** 玩家到目标格中心的距离（格）。 */
  targetDist(p) {
    const t = this.target;
    if (!t) return Infinity;
    const dx = (t.tx + 0.5) * PX - p.x;
    const dy = (t.ty + 0.5) * PX - p.y;
    return Math.hypot(dx, dy) / PX;
  }

  /** 受伤且在 dangerTiles 格内有敌人（满血路过小怪不算危险）。 */
  nearestThreat() {
    const w = this.ctx.world;
    const p = w.p;
    if (!p || !(p.hp < p.mhp)) return null;
    try {
      return w.nearestHostile?.(this.params.dangerTiles ?? 5) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 在玩家周围 ±24 格里找最近的目标格。
   * 用窗口扫描 world.tileAt 而不是直接翻 world.tiles 缓存：缓存可能是旧区块，
   * 而且 tileAt 已经把多块 tile 数据按版本合并好了。49×49=2401 次/250ms 的调用量可接受。
   */
  findTarget(p) {
    const ptx = p.x / PX;
    const pty = p.y / PX;
    const cx = Math.floor(ptx);
    const cy = Math.floor(pty);
    let best = null;
    let bestD = Infinity;
    // 够不着的高度不要：树只找同一层附近（头顶 3 格到脚下 6 格），
    // 真机上会选到头顶 19 格的树、跳不上去白卡 8 秒。
    const upLimit = this.kind === 'ore' ? 6 : 3;
    const downLimit = this.kind === 'ore' ? 20 : 6;
    for (let dy = -upLimit; dy <= downLimit; dy++) {
      for (let dx = -SCAN_TILES; dx <= SCAN_TILES; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        const d = Math.hypot(tx + 0.5 - ptx, ty + 0.5 - pty);
        if (d < MIN_TILES || d > SCAN_TILES || d >= bestD) continue;
        const t = this.tileAt(tx, ty);
        if (!t || !this.types.has(Number(t.type))) continue;
        best = { tx, ty, type: Number(t.type), d };
        bestD = d;
      }
    }
    return best;
  }

  selectTarget(p, now) {
    this.selectedAt = now;
    this.target = this.findTarget(p);
    if (this.target) this.tileCheckAt = now;
  }

  /** 目标格变了（被挖掉 / 换成别的类型）就丢目标；已经贴脸挥过才记 gather_hit。 */
  checkTarget(p, now) {
    if (!this.target) return;
    if (now - this.tileCheckAt < VERIFY_MS) return;
    this.tileCheckAt = now;

    const cur = this.tileAt(this.target.tx, this.target.ty);
    const changed = !cur || Number(cur.type) === 0 || Number(cur.type) !== this.target.type;
    if (!changed) return;

    if (this.targetDist(p) <= REACH_TILES) {
      this.hits += 1;
      this.ctx.event('gather_hit', {
        group: 'gather',
        kind: this.kind,
        tx: this.target.tx,
        ty: this.target.ty,
        type: this.target.type,
      });
    }
    this.target = null;
    this.selectedAt = 0; // 下一帧立刻重选，别先朝 dir 白走一步
    // 树/矿被挖掉后周围缓存也旧了，顺手拉一次新 tiles。
    this.requestTiles();
  }

  /** 只按水平位移判定进展；原地上下跳不算走动了。 */
  trackProgress(p, now) {
    if (this.lastX == null) {
      this.lastX = p.x;
      this.progressAt = now;
      return;
    }
    if (Math.abs(p.x - this.lastX) >= STEP_PX) {
      this.lastX = p.x;
      this.progressAt = now;
      this.stuckJumped = false;
    }
  }

  /** 目标还在 3 格外：水平朝它走；在上方且不远就跳；卡 1.5s 也跳一下。 */
  approach(p, f, now) {
    const t = this.target;
    const cx = (t.tx + 0.5) * PX;
    const cy = (t.ty + 0.5) * PX;
    const dx = cx - p.x;
    if (Math.abs(dx) > 6) f[dx > 0 ? 'right' : 'left'] = true;

    // 目标在上方且水平不超过 6 格：起跳够它。
    if (p.grd && p.y - cy > PX && Math.abs(dx) < 6 * PX) f.jump = true;

    // 1.5s 没挪动：可能是矮台/坎，每 1.5s 跳一次试试（8s 还出不去就 stuck）。
    if (p.grd && now - this.progressAt >= JUMP_MS && now - this.jumpAt >= JUMP_MS) {
      f.jump = true;
      this.jumpAt = now;
    }
  }

  /** 目标在 3 格内：aim 目标格中心并 use。 */
  harvest(p, f, now) {
    const t = this.target;
    f.aim = [((t.tx + 0.5) * PX - p.x) / PX, ((t.ty + 0.5) * PX - p.y) / PX];
    f.use = true;
    // 站着挥也是进展：不刷新的话 8 秒后会被自己判成卡死。
    this.lastX = p.x;
    this.progressAt = now;
    this.stuckJumped = false;
  }

  finish(reason, extra = {}) {
    if (this.finished) return;
    this.finished = true;
    this.target = null;
    this.ctx.event('goal_done', {
      group: 'gather', reason, kind: this.kind, dir: this.dir, ...extra,
    });
    this.ctx.manager?.set?.('idle');
  }

  stuck(p, now) {
    if (this.finished) return;
    this.finished = true;
    const t = this.target;
    this.target = null;
    this.ctx.event('stuck', {
      group: 'gather',
      x: Math.round(p.x),
      y: Math.round(p.y),
      dir: this.dir,
      ms: now - this.progressAt,
      ...(t ? { tx: t.tx, ty: t.ty } : {}),
    });
    this.ctx.manager?.set?.('idle');
  }

  tick() {
    const w = this.ctx.world;
    const p = w.p;
    const now = Date.now();
    const f = neutral();
    if (!p || this.finished) return f;

    // 1) 超时兜底
    if (now - this.startedAt >= this.timeoutMs) {
      this.finish('timeout', { ms: now - this.startedAt });
      return f;
    }

    // 2) 危险：HP < 45% / Boss / 受伤且附近有敌人
    const boss = typeof w.boss === 'function' ? w.boss() : null;
    const threat = this.nearestThreat();
    const ratio = p.mhp > 0 ? p.hp / p.mhp : 1;
    if (ratio < (this.params.dangerHp ?? 0.45) || boss || threat) {
      this.finish('danger', {
        hp: p.hp,
        ...(threat ? { threat: threat.i ?? null } : {}),
        ...(boss ? { boss: boss.i ?? null } : {}),
      });
      return f;
    }

    // 3) 背包动了 = 采到东西，收工
    const sig = this.inventorySignature();
    if (sig != null) {
      if (this.invSig == null) {
        this.invSig = sig;
        this.items0 = this.usedSlots();
      } else if (sig !== this.invSig) {
        this.finish('inventory', { used: this.usedSlots(), before: this.items0 });
        return f;
      }
    }

    // 4) 目标是否还在 + 是否算「有进展」
    this.trackProgress(p, now);
    this.checkTarget(p, now);

    const inReach = !!this.target && this.targetDist(p) <= REACH_TILES;
    if (inReach) {
      this.progressAt = now;
      this.stuckJumped = false;
    }

    // 5) 8s 没进展：交还控制权（不写 goal_done，由决策层决定下一步）
    if (now - this.progressAt > STUCK_MS) {
      this.stuck(p, now);
      return f;
    }

    // 6) 每 250ms 最多选一次目标
    if (!this.target && now - this.selectedAt >= SELECT_MS) this.selectTarget(p, now);

    if (!this.target) {
      // 没目标：保留旧行为朝 dir 走；每 3 秒重拉一次 tiles 等新数据。
      f[this.dir] = true;
      if (now - this.tilesAt >= TILES_MS) this.requestTiles();
      return f;
    }

    // 7) 接近 or 采集
    if (this.targetDist(p) > REACH_TILES) this.approach(p, f, now);
    else this.harvest(p, f, now);
    return f;
  }

  exit() {
    this.finished = true;
    this.target = null;
  }

  status() {
    const now = Date.now();
    return {
      name: this.name,
      kind: this.kind,
      dir: this.dir,
      target: this.target
        ? { tx: this.target.tx, ty: this.target.ty, type: this.target.type }
        : null,
      hits: this.hits,
      leftMs: Math.max(0, this.startedAt + this.timeoutMs - now),
      used: this.usedSlots(),
    };
  }
}
