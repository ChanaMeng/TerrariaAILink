import { sequence, selector, condition, action, SUCCESS, FAILURE } from './bt.mjs';
import { neutral } from './proto.mjs';
import { createBuildMode } from './build.mjs';
import { createGatherMode } from './gather.mjs';
import { evaluateGuards, guardStatus } from './guard.mjs';

const PX = 16;

function walkToward(frame, p, tx, ty, deadzone = 10) {
  const dx = tx - p.x;
  if (Math.abs(dx) > deadzone) frame[dx > 0 ? 'right' : 'left'] = true;
  if (ty < p.y - 32 && p.grd && Math.abs(dx) < 48) frame.jump = true;
  return frame;
}

export class Mode {
  constructor(ctx, params) {
    this.ctx = ctx;
    this.params = params || {};
    this.name = 'mode';
    this.startedAt = Date.now();
    this.allowDodge = true;
  }
  enter() {}
  tick() { return neutral(); }
  exit() {}
  status() { return { name: this.name }; }
}

export class IdleMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'idle'; }
  tick() { return neutral(); }
}

export class ReleaseMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'release'; this.release = true; }
  enter() {
    this.ctx.client.send({ t: 'cmd', op: 'stop' });
    this.ctx.event('released', {});
  }
  tick() { return null; }
}

export class FreeMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'free'; }
  enter() {
    this.keys = new Set(this.params.keys || []);
    this.until = Date.now() + (this.params.ms ?? 500);
  }
  tick() {
    const now = Date.now();
    if (now >= this.until) {
      this.ctx.manager.set('idle');
      return neutral();
    }
    const f = neutral();
    for (const k of this.keys) if (k in f) f[k] = true;
    if (this.params.slot != null) f.slot = this.params.slot;
    return f;
  }
  status() { return { name: this.name, keys: [...this.keys], leftMs: Math.max(0, this.until - Date.now()) }; }
}

export class GotoMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'goto'; }
  enter() {
    this.tx = this.params.x * PX + 8;
    this.ty = this.params.y * PX + 8;
    this.stuckSince = 0;
    this.lastX = null;
    this.allowDodge = this.params.dodge !== false;
  }
  tick() {
    const p = this.ctx.world.p;
    const f = neutral();
    const dx = this.tx - p.x;
    if (Math.abs(dx) < 12) {
      this.ctx.event('arrived', { x: this.params.x, y: this.params.y });
      this.ctx.manager.set('idle');
      return f;
    }
    walkToward(f, p, this.tx, this.ty, 8);

    if (p.grd && Math.abs(p.vx) < 0.05 && Math.abs(dx) > 20) {
      if (!this.stuckSince) this.stuckSince = Date.now();
      f.jump = true;
      if (Date.now() - this.stuckSince > 3000) {
        this.ctx.event('stuck', { x: p.x, y: p.y });
        this.ctx.manager.set('idle');
      }
    } else {
      this.stuckSince = 0;
    }
    return f;
  }
  status() { return { name: this.name, x: this.params.x, y: this.params.y }; }
}

export class CombatMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'combat'; }

  enter() {
    this.range = (this.params.range ?? 18) * PX;
    this.targetId = this.params.target ?? null;
    this.aimLead = this.params.lead !== false;
    // 近战贴脸时闪避层会把左右清零（站着躲），打怪反而打不出走位；要躲就显式开。
    this.allowDodge = this.params.dodge !== false;
    this.target = null;
    this.frame = neutral();
    this.enteredAt = Date.now();
    this.wasEmpty = false;

    this.moveTree = selector(
      sequence(condition(() => this.distPx() > this.range), action(() => this.approach())),
      sequence(condition(() => this.distPx() < this.range * 0.45 && !this.target?.bo), action(() => this.backOff())),
      action(() => SUCCESS),
    );

    // 注意这里是 sequence 不是 selector：战斗是「选目标 → 走位 → 瞄准 → 出手」
    // 四步依次执行，selector 遇到第一个 SUCCESS 就会短路（选完目标就结束，永远不打）。
    this.tree = sequence(
      action(() => this.selectTarget()),
      action(() => this.moveTree.tick(this.ctx)),
      action(() => this.aimAt()),
      action(() => this.useItem()),
    );
  }

  pickTarget() {
    const w = this.ctx.world;
    if (this.targetId != null) {
      const n = w.npc(this.targetId);
      if (n && n.lf > 0 && !n.fr) return n;
    }
    return w.boss() ?? w.nearestHostile(this.params.scan ?? 90);
  }

  selectTarget() {
    this.target = this.pickTarget();
    if (!this.target) {
      // 刚切进战斗组时，这一帧的状态可能还是切组之前的（或还没收到第一帧）。
      // 给它一个宽限期，别当场放弃——真机上这就是「切了战斗却站着不动」。
      if (Date.now() - this.enteredAt < (this.params.graceMs ?? 1200)) return FAILURE;
      if (!this.wasEmpty) {
        this.wasEmpty = true;
        this.ctx.event('no_target', {});
        this.ctx.manager.set('idle');
      }
      return FAILURE;
    }
    this.wasEmpty = false;
    return SUCCESS;
  }

  distPx() {
    const p = this.ctx.world.p;
    return Math.hypot(this.target.x - p.x, this.target.y - p.y);
  }

  approach() {
    const p = this.ctx.world.p;
    this.frame[this.target.x > p.x ? 'right' : 'left'] = true;
    if (this.target.y < p.y - 32) this.frame.jump = true;
    return SUCCESS;
  }

  backOff() {
    const p = this.ctx.world.p;
    this.frame[this.target.x > p.x ? 'left' : 'right'] = true;
    return SUCCESS;
  }

  aimAt() {
    if (this.params.aim === false) return SUCCESS; // 调试/近战贴脸时可以不写鼠标
    const p = this.ctx.world.p;
    const dist = this.distPx();
    let lead = 0;
    if (this.aimLead) {
      const spd = Math.max(6, p.it?.ss ?? 10);
      lead = Math.min(40, dist / spd);
    }
    const ax = this.target.x + this.target.vx * lead;
    const ay = this.target.y + this.target.vy * lead;
    this.frame.aim = [(ax - p.x) / PX, (ay - p.y) / PX];
    if (this.params.slot != null) this.frame.slot = this.params.slot;
    return SUCCESS;
  }

  useItem() {
    const p = this.ctx.world.p;
    const melee = this.params.melee ?? (p.it?.me && !p.it?.sh);
    const useRange = melee ? 3.2 * PX : this.range;
    if (this.distPx() <= useRange) this.frame.use = true;
    return SUCCESS;
  }

  tick() {
    this.frame = neutral();
    // 没有目标时先选；选不到就本帧停手（selectTarget 已经发 no_target 并切 idle）。
    // 不在树里硬跑：selector 遇到 FAILURE 会继续走 moveTree，而那时 target 是 null。
    if (!this.target && !this.selectTarget()) return this.frame;
    this.tree.tick({ now: Date.now(), world: this.ctx.world });
    return this.frame;
  }

  status() {
    return {
      name: this.name,
      target: this.target ? { id: this.target.i, type: this.target.ty, hp: this.target.lf, boss: !!this.target.bo } : null,
      range: this.range,
    };
  }
}

export class BossMode extends CombatMode {
  constructor(ctx, params) { super(ctx, params); this.name = 'boss'; }
  enter() {
    super.enter();
    this.bossId = this.params.boss ?? null;
  }
  pickTarget() {
    const w = this.ctx.world;
    if (this.bossId != null) {
      const n = w.npc(this.bossId);
      if (n && n.lf > 0) return n;
    }
    return w.boss() ?? w.nearestHostile(120);
  }
}

/**
 * 挖一格（门洞、矿脉、清障）。走正常输入：切镐 → 瞄准 → 按住左键 → 回读瓦片。
 * 这是第一个「原子动作」型策略组：目标是一格，不是一段行为。
 */
export class MineMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'mine'; }

  enter() {
    this.tx = Math.round(Number(this.params.x));
    this.ty = Math.round(Number(this.params.y));
    this.slot = this.params.slot ?? null;
    this.reach = (this.params.reach ?? 4.5) * PX;
    this.timeoutMs = this.params.timeoutMs ?? 20_000;
    this.startedAt = Date.now();
    this.allowDodge = this.params.dodge === true;
    this.done = false;
    this.tilesAt = 0;
    this.lastX = null;
    this.progressAt = Date.now();
    this.requestTiles();
    this.ctx.event('mine_start', { x: this.tx, y: this.ty, slot: this.slot });
  }

  requestTiles() {
    const pad = 6;
    this.ctx.client.send({
      t: 'cmd', op: 'tiles',
      x: this.tx - pad, y: this.ty - pad, w: pad * 2 + 1, h: pad * 2 + 1,
    });
    this.tilesAt = Date.now();
  }

  finish(type, extra = {}) {
    if (this.done) return;
    this.done = true;
    this.ctx.event(type, { group: 'mine', x: this.tx, y: this.ty, ...extra });
    this.ctx.manager.set('idle');
  }

  tick() {
    const w = this.ctx.world;
    const p = w.p;
    const f = neutral();
    const now = Date.now();
    if (!p || this.done) return f;

    if (now - this.startedAt > this.timeoutMs) {
      this.finish('mine_fail', { reason: 'timeout' });
      return f;
    }

    // 瓦片是快照：自己挖掉的格子要重新拉一次才看得见。
    if (now - this.tilesAt > 1200) this.requestTiles();

    const t = w.tileAt(this.tx, this.ty);
    // tileAt 返回 null = 这块瓦片数据还没回来，不等于「空气」。
    // 之前第一帧就判 empty 直接退出，真机上等于什么也没挖。
    if (!t) {
      if (now - this.startedAt > 2500) this.finish('mine_fail', { reason: 'no_tiles' });
      return f;
    }
    if (!t.solid) {
      this.finish('mine_done', { reason: 'empty' });
      return f;
    }

    const tx = this.tx * PX + 8;
    const ty = this.ty * PX + 8;
    const dist = Math.hypot(tx - p.x, ty - p.y);
    if (this.lastX == null) this.lastX = p.x;
    if (Math.abs(p.x - this.lastX) >= 6) {
      this.lastX = p.x;
      this.progressAt = now;
    }
    if (dist > this.reach) {
      walkToward(f, p, tx, ty, 6);
      // 只有「真的被挡住一段时间」才跳，别一站着就蹦。
      if (p.grd && Date.now() - this.progressAt > 700) f.jump = true;
      return f;
    }

    f.aim = [(tx - p.x) / PX, (ty - p.y) / PX];
    f.use = true;
    if (this.slot != null) f.slot = this.slot;
    return f;
  }

  status() {
    return { name: this.name, x: this.tx, y: this.ty, done: this.done };
  }
}

export class ReplayMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'replay'; }
  enter() {
    this.allowDodge = false;
    this.ctx.client.send({
      t: 'cmd', op: 'replay', frames: this.params.frames || [], loop: !!this.params.loop,
    });
    this.ctx.event('replay_start', { frames: (this.params.frames || []).length, loop: !!this.params.loop });
  }
  tick() { return neutral(); }
}

// ---------------------------------------------------------------------------
// 策略组（M2）
// ---------------------------------------------------------------------------

/** 活着：离最近威胁最远的水平方向跑；没威胁就站着回血。 */
export class SurviveMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'survive'; }

  enter() {
    this.allowDodge = true;
    this.exitHp = this.params.exitHp ?? 0.6;
    this.returnTo = this.params.returnTo === 'hold' ? 'hold' : 'idle';
    const p = this.ctx.world.p;
    this.lastX = p?.x ?? null;
    this.progressAt = Date.now();
    this.jumpAt = 0;
    this.stuckAt = 0;
    this.stuckReported = false;
    this.threat = null;
  }

  nearestThreat() {
    const w = this.ctx.world;
    const p = w.p;
    if (!p) return null;
    const scan = this.params.scan ?? 90;
    let best = w.nearestHostile(scan);
    const boss = w.boss();
    if (boss) {
      const bd = Math.hypot(boss.x - p.x, boss.y - p.y);
      const bestD = best ? Math.hypot(best.x - p.x, best.y - p.y) : Infinity;
      if (bd <= scan * PX && bd < bestD) best = boss;
    }
    return best ?? null;
  }

  tick() {
    const w = this.ctx.world;
    const p = w.p;
    const now = Date.now();
    const f = neutral();
    if (!p) return f;

    const threat = this.nearestThreat();
    this.threat = threat;
    const ratio = p.mhp > 0 ? p.hp / p.mhp : 1;
    if (ratio > this.exitHp && !threat) {
      this.ctx.event('goal_done', { group: 'survive', reason: 'safe', hp: p.hp, mhp: p.mhp });
      this.ctx.manager.set(this.returnTo);
      return f;
    }

    if (!threat) {
      // 没威胁：站住回血。乱动反而打断回血。
      this.lastX = p.x;
      this.progressAt = now;
      this.stuckAt = 0;
      this.stuckReported = false;
      return f;
    }

    f[threat.x > p.x ? 'left' : 'right'] = true;

    const moved = this.lastX == null ? Infinity : Math.abs(p.x - this.lastX);
    if (moved >= 10) {
      this.lastX = p.x;
      this.progressAt = now;
      this.stuckAt = 0;
      this.stuckReported = false;
    } else if (p.grd) {
      // 被墙 / 坑挡住：跳；还是出不去就记一次事件，但继续跑（保命优先）。
      if (now - this.progressAt > 500 && now - this.jumpAt > 350) {
        f.jump = true;
        this.jumpAt = now;
      }
      if (now - this.progressAt > 3000) {
        if (!this.stuckAt) this.stuckAt = now;
        if (!this.stuckReported && now - this.stuckAt > 5000) {
          this.stuckReported = true;
          this.ctx.event('stuck', {
            group: 'survive', x: Math.round(p.x), y: Math.round(p.y), threat: threat.i ?? null,
          });
        }
      }
    }
    return f;
  }

  status() {
    return {
      name: this.name,
      hp: this.ctx.world.p?.hp ?? null,
      threat: this.threat ? { id: this.threat.i ?? null, x: Math.round(this.threat.x) } : null,
      returnTo: this.returnTo,
    };
  }
}

export class ExploreMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'explore'; }

  enter() {
    const p = this.ctx.world.p;
    // 上次探索如果卡死，这次换相反方向：否则 autonomy 会一直把人往同一条死路里送。
    const last = this.ctx.lastExplore;
    const reverse = last && last.stuck && Date.now() - last.at < 60_000;
    if (this.params.dir === 'left' || this.params.dir === 'right') {
      this.dir = this.params.dir;
    } else if (reverse) {
      this.dir = last.dir === 'right' ? 'left' : 'right';
    } else if (last && Date.now() - last.at < 60_000) {
      this.dir = last.dir; // 刚超时但没卡住：继续同方向
    } else {
      this.dir = p?.dir < 0 ? 'left' : 'right';
    }
    this.timeoutMs = this.params.timeoutMs ?? 45_000;
    this.startedAt = Date.now();
    this.startX = p?.x ?? null;
    this.allowDodge = true;
    this.lastX = p?.x ?? null;
    this.progressAt = Date.now();
    this.jumpAt = 0;
    this.stuckReported = false;
    this.finished = false;
  }

  finish(type, extra = {}) {
    if (this.finished) return;
    this.finished = true;
    // 记住方向 + 是否卡死，下一次 enter 决定是否掉头。
    this.ctx.lastExplore = { dir: this.dir, at: Date.now(), stuck: type === 'stuck' };
    this.ctx.event(type, { group: 'explore', dir: this.dir, ...extra });
    this.ctx.manager.set('idle');
  }

  tick() {
    const w = this.ctx.world;
    const p = w.p;
    const now = Date.now();
    const f = neutral();
    if (!p || this.finished) return f;

    if (now - this.startedAt >= this.timeoutMs) {
      const distance = this.startX == null ? 0 : Math.round(Math.abs(p.x - this.startX));
      this.finish('timeout', { distance, ms: now - this.startedAt });
      return f;
    }

    if (this.lastX == null) this.lastX = p.x;
    if (Math.abs(p.x - this.lastX) >= 6) {
      this.lastX = p.x;
      this.progressAt = now;
      this.stuckReported = false;
    }

    // 400ms 太短：Terraria 的 1 格台阶按方向会自动抬上去，
    // 等它抬完再决定要不要跳，否则在楼梯上一路乱蹦。
    const blocked = now - this.progressAt > 900;
    f[this.dir] = true;
    if (p.grd && blocked && now - this.jumpAt > 300) {
      f.jump = true;
      this.jumpAt = now;
    }

    if (now - this.progressAt > 8000) {
      if (!this.stuckReported) {
        this.stuckReported = true;
        this.ctx.event('stuck', { group: 'explore', x: Math.round(p.x), y: Math.round(p.y), dir: this.dir });
      }
      this.finished = true;
      this.ctx.manager.set('idle');
    }
    return f;
  }

  status() {
    const p = this.ctx.world.p;
    return {
      name: this.name,
      dir: this.dir,
      distance: p && this.startX != null ? Math.round(Math.abs(p.x - this.startX)) : null,
      leftMs: Math.max(0, this.startedAt + this.timeoutMs - Date.now()),
    };
  }
}

/** 守点：不追人，目标进射程才打；5s 没目标回 idle。 */
export class HoldMode extends CombatMode {
  constructor(ctx, params) { super(ctx, params); this.name = 'hold'; }

  enter() {
    this.noTargetMs = this.params.noTargetMs ?? 5000;
    this.noTargetSince = 0;
    this.reportedNoTarget = false;
    super.enter();
    this.range = (this.params.range ?? 18) * PX;
  }

  selectTarget() {
    this.target = this.pickTarget();
    if (!this.target) {
      if (!this.noTargetSince) this.noTargetSince = Date.now();
      return FAILURE;
    }
    this.noTargetSince = 0;
    return SUCCESS;
  }

  tick() {
    const p = this.ctx.world.p;
    const f = neutral();
    if (!p) return f;
    this.frame = f;

    if (this.selectTarget() !== SUCCESS) {
      const now = Date.now();
      if (this.noTargetSince && !this.reportedNoTarget && now - this.noTargetSince >= this.noTargetMs) {
        this.reportedNoTarget = true;
        this.ctx.event('no_target', { group: 'hold', waitedMs: now - this.noTargetSince });
        this.ctx.manager.set('idle');
      }
      return f;
    }

    // 原地：只有怪贴脸才退，不主动追。
    if (this.distPx() < 3 * PX && !this.target?.bo) this.backOff();
    this.aimAt();
    this.useItem();
    return f;
  }
}

/** 清场：复用 CombatMode 的选目标/走位/瞄准/攻击，加一条撤退线。 */
export class FightMode extends CombatMode {
  constructor(ctx, params) { super(ctx, params); this.name = 'fight'; }

  enter() {
    super.enter();
    this.retreatHp = this.params.retreatHp ?? 0.3;
    this.retreated = false;
    const p = this.ctx.world.p;
    this.lastX = p?.x ?? null;
    this.progressAt = Date.now();
    this.stuckReported = false;
  }

  tick() {
    const w = this.ctx.world;
    const p = w.p;
    const now = Date.now();
    const f = neutral();
    if (!p) return f;

    const ratio = p.mhp > 0 ? p.hp / p.mhp : 1;
    if (ratio < this.retreatHp) {
      if (!this.retreated) {
        this.retreated = true;
        this.ctx.event('retreat', { group: 'fight', hp: p.hp, mhp: p.mhp });
        this.ctx.manager.set('survive', { reason: 'fight_retreat' });
      }
      return f;
    }

    this.frame = f;
    if (this.selectTarget() !== SUCCESS) return f;

    const dist = this.distPx();
    const melee = this.params.melee ?? (p.it?.me && !p.it?.sh);
    const engage = melee ? 3.2 * PX : this.range;
    const approaching = dist > engage;
    if (approaching) this.approach();
    else if (dist < engage * 0.45 && !this.target?.bo) this.backOff();

    if (approaching) {
      // 追不到就跳；长时间顶着墙没进展就退出，别原地挥空气。
      if (this.lastX == null || Math.abs(p.x - this.lastX) >= 6) {
        this.lastX = p.x;
        this.progressAt = now;
        this.stuckReported = false;
      } else if (p.grd && now - this.progressAt > 900) {
        f.jump = true;
        if (now - this.progressAt > 6000 && !this.stuckReported) {
          this.stuckReported = true;
          this.ctx.event('stuck', { group: 'fight', x: Math.round(p.x), y: Math.round(p.y) });
          this.ctx.manager.set('idle');
          return f;
        }
      }
    } else {
      this.lastX = p.x;
      this.progressAt = now;
    }

    this.aimAt();
    this.useItem();
    return f;
  }
}

/**
 * 跟随主人 —— 目前只是接口。
 * 协议的 state 里没有其他玩家坐标；等 mod 推了 otherPlayers（或类似字段）之后，
 * main 才能把 ctx.followTarget 填上。在那之前 enter() 会直接报告不支持并回 idle。
 */
export class FollowMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'follow'; }

  enter() {
    this.allowDodge = true;
    this.unsupported = false;
    if (!this.ctx.followTarget) this.reportUnsupported();
  }

  reportUnsupported() {
    if (this.unsupported) return;
    this.unsupported = true;
    this.ctx.event('follow_unsupported', {
      reason: 'no_other_players',
      need: 'mod must push other players (x, y) and main must set ctx.followTarget',
    });
    this.ctx.manager.set('idle');
  }

  tick() {
    const target = this.ctx.followTarget;
    if (!target || !Number.isFinite(target.x)) {
      this.reportUnsupported();
      return neutral();
    }
    const p = this.ctx.world.p;
    if (!p) return neutral();
    const f = neutral();
    const keep = (this.params.keepTiles ?? 6) * PX;
    const dx = target.x - p.x;
    if (Math.abs(dx) > keep) f[dx > 0 ? 'right' : 'left'] = true;
    if (Number.isFinite(target.y) && target.y < p.y - 48 && p.grd) f.jump = true;
    return f;
  }

  status() {
    const t = this.ctx.followTarget ?? null;
    return { name: this.name, supported: !!t, target: t ? { x: Math.round(t.x), y: Math.round(t.y) } : null };
  }
}

/**
 * 守家 —— 目前只是接口。
 * 需要意志层给出「家在哪、要补哪一格」；现在没有这个目标，硬跑只会乱放方块。
 */
export class HomeMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'home'; }

  enter() {
    this.ctx.event('home_unsupported', {
      reason: 'no_home_goal',
      need: 'blueprint / house check from the will layer',
    });
    this.ctx.manager.set('idle');
  }

  tick() { return neutral(); }
}

export class ModeManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.factories = {
      idle: (c, p) => new IdleMode(c, p),
      release: (c, p) => new ReleaseMode(c, p),
      free: (c, p) => new FreeMode(c, p),
      goto: (c, p) => new GotoMode(c, p),
      combat: (c, p) => new CombatMode(c, p),
      boss: (c, p) => new BossMode(c, p),
      build: (c, p) => createBuildMode(c, p),
      mine: (c, p) => new MineMode(c, p),
      replay: (c, p) => new ReplayMode(c, p),
      // 策略组
      survive: (c, p) => new SurviveMode(c, p),
      gather: (c, p) => createGatherMode(c, p),
      explore: (c, p) => new ExploreMode(c, p),
      hold: (c, p) => new HoldMode(c, p),
      fight: (c, p) => new FightMode(c, p),
      follow: (c, p) => new FollowMode(c, p),
      home: (c, p) => new HomeMode(c, p),
    };
    this.name = null;
    this.params = {};
    this.current = null;
    this.lastGroup = null;
  }

  set(name, params = {}) {
    const factory = this.factories[name];
    if (!factory) throw new Error(`unknown mode: ${name}`);
    const prev = this.name;
    if (prev && prev !== name) this.lastGroup = prev;
    try { this.current?.exit?.(); } catch (e) { this.ctx.log(`exit ${name}: ${e.message}`); }
    this.name = name;
    this.params = params;
    this.current = factory(this.ctx, params);
    this.ctx.event('mode_change', { name, params });
    try { this.current.enter(); } catch (e) { this.ctx.log(`enter ${name}: ${e.message}`); }
    return this.status();
  }

  tick() {
    const w = this.ctx.world;
    if (!this.current) this.set('idle');
    if (this.current?.release) return null;
    if (w.state?.menu) return null;
    if (!w.p || w.stale(500)) {
      this.ctx.client.input(neutral());
      return null;
    }

    // 守护层优先：命中后本帧不发输入，让新组下一帧接管。
    const guard = evaluateGuards(this.ctx);
    if (guard) {
      this.set(guard.group, guard.params);
      return null;
    }

    const p = w.p;
    let frame = this.current.tick();
    if (frame === null || frame === undefined) return null;
    if (this.current.allowDodge !== false) frame = this.ctx.dodge.apply(w, frame);
    this.ctx.client.input(frame);
    return frame;
  }

  status() {
    return {
      name: this.name,
      params: this.params,
      since: this.current?.startedAt ?? null,
      lastGroup: this.lastGroup,
      guards: guardStatus(),
      mode: this.current?.status?.() ?? null,
    };
  }
}


