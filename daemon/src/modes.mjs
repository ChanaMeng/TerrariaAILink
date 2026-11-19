import { sequence, selector, condition, action, SUCCESS, FAILURE } from './bt.mjs';
import { neutral } from './proto.mjs';
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
    this.allowDodge = true;
    this.target = null;
    this.frame = neutral();

    this.moveTree = selector(
      sequence(condition(() => this.distPx() > this.range), action(() => this.approach())),
      sequence(condition(() => this.distPx() < this.range * 0.45 && !this.target?.bo), action(() => this.backOff())),
      action(() => SUCCESS),
    );

    this.tree = selector(
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
      this.ctx.event('no_target', {});
      this.ctx.manager.set('idle');
      return FAILURE;
    }
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

export class BuildMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'build'; }
  enter() {
    this.plan = this.params.plan || [];
    this.i = 0;
    this.reach = (this.params.reach ?? 5) * PX;
    this.useTicks = 0;
    this.retries = 0;
    this.hp = this.ctx.world.p?.hp ?? 100;
    this.lastCheck = 0;
    this.allowDodge = true;
    this.ctx.client.send({ t: 'cmd', op: 'tiles', x: Math.floor((this.ctx.world.p?.x ?? 0) / PX) - 30, y: Math.floor((this.ctx.world.p?.y ?? 0) / PX) - 20, w: 64, h: 48 });
  }

  currentStep() { return this.plan[this.i] ?? null; }

  tick() {
    const w = this.ctx.world;
    const p = w.p;
    const f = neutral();
    const step = this.currentStep();
    const now = Date.now();
    if (!step) {
      this.ctx.event('build_done', { placed: this.plan.length });
      this.ctx.manager.set('idle');
      return f;
    }

    if (now - this.lastCheck > 1000) {
      this.lastCheck = now;
      if (p.hp < this.hp - 30 || p.hp < (p.mhp ?? p.hp) * 0.45) {
        this.ctx.event('build_risk', { hp: p.hp, step: this.i });
        this.ctx.manager.set('idle');
        return f;
      }
      this.hp = Math.max(this.hp, p.hp);
    }

    const tx = step.x * PX + 8;
    const ty = step.y * PX + 8;
    const dx = tx - p.x;
    const dist = Math.hypot(dx, ty - p.y);

    if (dist > this.reach) {
      walkToward(f, p, tx, ty, 6);
      if (p.grd && Math.abs(p.vx) < 0.05) f.jump = true;
      return f;
    }

    f.aim = [(tx - p.x) / PX, (ty - p.y) / PX];
    f.use = true;
    if (step.slot != null) f.slot = step.slot;
    else if (this.params.slot != null) f.slot = this.params.slot;
    this.useTicks++;
    if (this.useTicks >= (this.params.ticksPerTile ?? 6)) {
      this.useTicks = 0;
      this.i++;
      this.retries = 0;
      this.ctx.event('build_step', { index: this.i, total: this.plan.length });
    }
    return f;
  }

  status() { return { name: this.name, index: this.i, total: this.plan.length, step: this.currentStep() }; }
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

/** 攒资源：朝一个方向走，同时朝前方脚下挥工具。 */
export class GatherMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'gather'; }

  enter() {
    this.dir = this.params.dir === 'left' ? 'left' : 'right';
    this.kind = this.params.kind === 'ore' ? 'ore' : 'tree';
    this.timeoutMs = this.params.timeoutMs ?? 60_000;
    this.startedAt = Date.now();
    this.allowDodge = true;
    const p = this.ctx.world.p;
    this.lastX = p?.x ?? null;
    this.progressAt = Date.now();
    this.stuckReported = false;
    this.finished = false;
    this.invSig = null;
    this.items0 = null;
  }

  inventorySignature() {
    const inv = this.ctx.world.state?.in;
    return Array.isArray(inv) ? inv.join(',') : null;
  }

  usedSlots() {
    const inv = this.ctx.world.state?.in;
    return Array.isArray(inv) ? inv.filter((t) => Number(t) > 0).length : null;
  }

  finish(reason, extra = {}) {
    if (this.finished) return;
    this.finished = true;
    this.ctx.event('goal_done', {
      group: 'gather', reason, kind: this.kind, dir: this.dir, ...extra,
    });
    this.ctx.manager.set('idle');
  }

  tick() {
    const w = this.ctx.world;
    const p = w.p;
    const now = Date.now();
    const f = neutral();
    if (!p || this.finished) return f;

    if (now - this.startedAt >= this.timeoutMs) {
      this.finish('timeout', { ms: now - this.startedAt });
      return f;
    }

    const hostile = w.nearestHostile(this.params.dangerTiles ?? 5);
    const boss = w.boss();
    const ratio = p.mhp > 0 ? p.hp / p.mhp : 1;
    // 满血时路过小怪不算危险；挨过打（<90%）且敌人还在附近才撤。
    const hurtNear = hostile && ratio < (this.params.dangerHpNear ?? 0.9);
    if (ratio < (this.params.dangerHp ?? 0.45) || boss || hurtNear) {
      this.finish('danger', hostile
        ? { threat: hostile.i, hp: p.hp, boss: boss?.i ?? null }
        : { hp: p.hp, boss: boss?.i ?? null });
      return f;
    }

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

    if (this.lastX == null) this.lastX = p.x;
    if (Math.abs(p.x - this.lastX) >= 6) {
      this.lastX = p.x;
      this.progressAt = now;
      this.stuckReported = false;
    } else if (p.grd && now - this.progressAt > 1500) {
      f.jump = true;
    }

    if (now - this.progressAt > 8000) {
      // 卡死不能永远钉在这。超时兜底还在，但这里提前把控制权交回。
      if (!this.stuckReported) {
        this.stuckReported = true;
        this.ctx.event('stuck', { group: 'gather', x: Math.round(p.x), y: Math.round(p.y), dir: this.dir });
      }
      this.finished = true;
      this.ctx.manager.set('idle');
      return f;
    }

    const sign = this.dir === 'left' ? -1 : 1;
    f[this.dir] = true;
    f.aim = [sign * 1.6, 1.1]; // 前方脚下
    f.use = true;
    return f;
  }

  status() {
    const now = Date.now();
    return {
      name: this.name,
      dir: this.dir,
      kind: this.kind,
      leftMs: Math.max(0, this.startedAt + this.timeoutMs - now),
      used: this.usedSlots(),
    };
  }
}

/** 开地图：朝一个方向走，撞墙就跳；超时写决策请求。 */
export class ExploreMode extends Mode {
  constructor(ctx, params) { super(ctx, params); this.name = 'explore'; }

  enter() {
    const p = this.ctx.world.p;
    this.dir = this.params.dir === 'left' || this.params.dir === 'right'
      ? this.params.dir
      : (p?.dir < 0 ? 'left' : 'right');
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

    const blocked = now - this.progressAt > 400;
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
      build: (c, p) => new BuildMode(c, p),
      replay: (c, p) => new ReplayMode(c, p),
      // 策略组
      survive: (c, p) => new SurviveMode(c, p),
      gather: (c, p) => new GatherMode(c, p),
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


