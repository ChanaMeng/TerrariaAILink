import { sequence, selector, condition, action, SUCCESS, FAILURE } from './bt.mjs';
import { neutral } from './proto.mjs';

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
    };
    this.name = null;
    this.params = {};
    this.current = null;
  }

  set(name, params = {}) {
    const factory = this.factories[name];
    if (!factory) throw new Error(`unknown mode: ${name}`);
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
      mode: this.current?.status?.() ?? null,
    };
  }
}


