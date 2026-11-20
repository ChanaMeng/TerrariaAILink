// build.mjs — 可靠建造模式（鸭子类型 Mode，不继承 modes.mjs 的类，避免循环依赖）。
//
// 旧 BuildMode 的问题：不查格、不验格、不重试、够不着只会走、手持什么就 use 什么。
// 这里每格都走同一台状态机：
//
//   check（查格）──solid──> exists（跳过）
//        │
//        ├──树/水/平台──> 等 3 次重新查 ──> blocked（跳过）
//        │
//        └──空/未知──> move（走近）──够不着且卡住 3 次──> unreachable（跳过）
//                          │
//                          └──进入 reach──> 材料校验 ──不对且等不到上层换──> material（跳过）
//                                              │
//                                              └──place（use + 每 2 tick 回读）
//                                                     │
//                                                     ├──solid──> placed
//                                                     └──3 次 × 10 tick 仍未 solid──> failed
//
// 所有「跳过 / 失败 / 开始 / 完成 / 风险」都通过 ctx.event(type, data) 上报，
// 槽位切换交给上层（本模式只发 build_material，绝不自己换手持物品）。

import { neutral } from './proto.mjs';

const PX = 16;

const DEFAULTS = {
  reach: 5,              // 够得着的距离（格）
  stuckMs: 1200,         // 1.2s 没有位移算卡住
  moveFails: 3,          // 卡住 3 次还够不着就跳过
  attempts: 3,           // 每格最多尝试放置 3 次
  attemptTicks: 10,      // 每次尝试持续 10 tick
  verifyEvery: 2,        // 每 2 tick 回读一次目标格
  blockedChecks: 3,      // 树 / 液体 / 平台重查 3 次
  blockedRetryMs: 150,   // 两次重查之间的间隔
  materialWaitTicks: 90, // 材料不对时最多等 90 tick（给上层换物品）
  lowHpRatio: 0.45,      // 低于 45% 血量
  hpDrop: 25,            // 或 1 秒内掉 25 点
};

/** 玩家手持物品的 type；拿不到就是 null（未知，不拿它做材料校验）。 */
function heldType(p) {
  const ty = p?.it?.ty;
  return Number.isFinite(ty) ? ty : null;
}

/** 把上层给的 plan 规整成 { x, y } 瓦片坐标数组。 */
function normalizePlan(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const step of raw) {
    const x = Math.round(Number(step?.x));
    const y = Math.round(Number(step?.y));
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

export function createBuildMode(ctx, params = {}) {
  const p = params || {};
  const opt = (key) => (p[key] != null ? p[key] : DEFAULTS[key]);

  const mode = {
    name: 'build',
    allowDodge: true,

    // ---------------------------------------------------------------- enter
    enter() {
      this.ctx = ctx;
      this.params = p;
      this.plan = normalizePlan(p.plan);
      this.i = 0;               // 下一个要取的 plan 下标
      this.processed = 0;       // 已经处理完的格数
      this.placed = 0;
      this.skipped = 0;         // 所有非 placed 的格（含 exists / failed / material / unreachable / blocked）
      this.existing = 0;
      this.failed = 0;

      this.reachPx = opt('reach') * PX;
      this.stuckMs = opt('stuckMs');
      this.moveFails = opt('moveFails');
      this.attempts = opt('attempts');
      this.attemptTicks = opt('attemptTicks');
      this.verifyEvery = Math.max(1, opt('verifyEvery'));
      this.blockedChecks = opt('blockedChecks');
      this.blockedRetryMs = opt('blockedRetryMs');
      this.materialWaitTicks = opt('materialWaitTicks');
      this.lowHpRatio = opt('lowHpRatio');
      this.hpDrop = opt('hpDrop');

      this.slot = p.slot != null ? p.slot : null;
      this.lastSuccessTy = null; // 上一格成功时手持的 item type
      this.done = false;
      this.tile = null;
      this.tickCount = 0;

      const player = this.ctx.world?.p ?? null;
      this.lastHp = Number.isFinite(player?.hp) ? player.hp : null;
      this.hpAt = Date.now();

      this.requestTiles();
      this.tilesAt = Date.now();

      this.ctx.event('build_start', {
        total: this.plan.length,
        slot: this.slot,
        blockType: p.blockType ?? null,
        reach: opt('reach'),
        area: this.area,
      });
    },

    // 一次性的 tiles 请求：目标区外扩 8 格。world.tileAt 靠这份数据回读。
    requestTiles() {
      let x;
      let y;
      let w;
      let h;
      if (this.plan.length) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const s of this.plan) {
          if (s.x < minX) minX = s.x;
          if (s.y < minY) minY = s.y;
          if (s.x > maxX) maxX = s.x;
          if (s.y > maxY) maxY = s.y;
        }
        const pad = 8;
        x = minX - pad;
        y = minY - pad;
        w = (maxX - minX + 1) + pad * 2;
        h = (maxY - minY + 1) + pad * 2;
      } else {
        // plan 为空也给一小块玩家周围的图，状态里能看到世界。
        const player = this.ctx.world?.p;
        x = Math.floor((player?.x ?? 0) / PX) - 30;
        y = Math.floor((player?.y ?? 0) / PX) - 20;
        w = 64;
        h = 48;
      }
      this.area = { x, y, w, h };
      this.ctx.client.send({ t: 'cmd', op: 'tiles', x, y, w, h });
    },

    // ----------------------------------------------------------------- tick
    tick() {
      const f = neutral();
      if (this.done) return f;
      const w = this.ctx.world;
      const player = w?.p;
      if (!player) return f;

      this.tickCount++;
      const now = Date.now();

      // 低血优先于一切：先保命，再谈放方块。
      if (this.checkRisk(player, now)) return f;

      // 一帧内可能连续处理多个「已存在 / 立刻失败」的格；
      // 用 guard 兜底，防止状态机写错时把主循环卡死。
      for (let guard = 0; guard < 512; guard++) {
        if (!this.tile && !this.advance()) return f;
        const t = this.tile;
        if (!t) return f;

        // 1) 查格：已 solid → exists；树/水/平台 → 重试 3 次后 blocked。
        if (t.state === 'check') {
          const verdict = this.inspect(t);
          if (verdict === 'solid') {
            this.ctx.event('build_skip', { ...this.stepInfo(t), reason: 'exists', tileType: t.seen?.type ?? null });
            this.complete('exists');
            continue;
          }
          if (verdict === 'blocked') {
            t.blockedCount++;
            if (t.blockedCount >= this.blockedChecks) {
              this.ctx.event('build_skip', {
                ...this.stepInfo(t),
                reason: 'blocked',
                tileType: t.seen?.type ?? null,
                liquid: t.seen?.liquid ?? 0,
                platform: !!t.seen?.platform,
              });
              this.complete('blocked');
              continue;
            }
            // 数据可能是刚发 tiles 请求还没到；等一小会儿再查，别把好格子当树。
            t.state = 'check_wait';
            t.nextCheckAt = now + this.blockedRetryMs;
            return f;
          }
          // clear 或 unknown：当成可放，进入靠近阶段。
          t.state = 'move';
          t.move = { lastX: player.x, lastY: player.y, at: now, stuck: 0 };
          // 故意不 continue：同一 tick 内继续判断距离。
        }

        if (t.state === 'check_wait') {
          if (now < t.nextCheckAt) return f;
          t.state = 'check';
          continue;
        }

        // 2) 距离：不够就先走，卡住就跳，3 次还够不着就跳过。
        if (t.state === 'move') {
          const dist = this.distPx(player, t);
          if (dist <= this.reachPx) {
            t.state = 'place'; // 下一轮循环处理（同 tick 内可以开始放）
            continue;
          }
          this.walk(f, player, t, now);
          if (t.finished) continue;
          return f;
        }

        // 3) 材料 + 放置 + 回读验证。
        if (t.state === 'place') {
          this.placeStep(f, player, t);
          if (t.finished) continue;
          return f;
        }

        // 状态机脏了：本帧停手，不硬跑。
        return f;
      }
      return f;
    },

    // -------------------------------------------------------------- helpers
    advance() {
      if (this.i >= this.plan.length) {
        this.finish();
        return false;
      }
      const s = this.plan[this.i++];
      this.tile = {
        index: this.i,
        x: s.x,
        y: s.y,
        state: 'check',
        blockedCount: 0,
        nextCheckAt: 0,
        move: null,
        attempt: 0,
        attemptStartTick: 0,
        nextVerifyTick: 0,
        placeAtTick: 0,
        placeAtWorldTick: null,
        materialReported: false,
        materialUntil: 0,
        materialExpected: null,
        materialHeld: null,
        seen: null,
        finished: false,
      };
      return true;
    },

    stepInfo(t) {
      return { index: this.processed + 1, total: this.plan.length, x: t.x, y: t.y };
    },

    inspect(t) {
      const at = this.ctx.world.tileAt(t.x, t.y);
      if (!at) {
        t.seen = null;
        return 'unknown';
      }
      t.seen = at;
      if (at.solid) return 'solid';
      // 树、草、平台、液体都算「这格不能直接放」；按需求统一记 blocked。
      if ((at.type ?? 0) > 0 || at.platform || (at.liquid ?? 0) > 0) return 'blocked';
      return 'clear';
    },

    distPx(player, t) {
      return Math.hypot(t.x * PX + PX / 2 - player.x, t.y * PX + PX / 2 - player.y);
    },

    aimAt(f, player, t) {
      f.aim = [
        (t.x * PX + PX / 2 - player.x) / PX,
        (t.y * PX + PX / 2 - player.y) / PX,
      ];
    },

    walk(f, player, t, now) {
      const cx = t.x * PX + PX / 2;
      const cy = t.y * PX + PX / 2;
      const dx = cx - player.x;
      if (Math.abs(dx) > 6) f[dx > 0 ? 'right' : 'left'] = true;
      // 目标在上方：落地时跳；卡住时的跳跃在下面单独处理。
      if (cy < player.y - 32 && player.grd) f.jump = true;

      const m = t.move;
      const moved = Math.hypot(player.x - m.lastX, player.y - m.lastY);
      if (moved >= 4) {
        // 有位移 → 重新计时，防止一边走一边被判卡住。
        m.lastX = player.x;
        m.lastY = player.y;
        m.at = now;
      }
      if (now - m.at < this.stuckMs) return;

      // 1.2s 没动：记一次卡住，并跳一下试着越过台阶 / 障碍。
      m.stuck++;
      m.lastX = player.x;
      m.lastY = player.y;
      m.at = now;
      if (m.stuck >= this.moveFails) {
        const dist = Math.round(this.distPx(player, t));
        this.ctx.event('build_skip', {
          ...this.stepInfo(t),
          reason: 'unreachable',
          stuck: m.stuck,
          distance: dist,
          reachPx: Math.round(this.reachPx),
        });
        this.complete('unreachable');
        return;
      }
      f.jump = true;
    },

    // 材料闸门。返回 'ok' | 'wait' | 'skip'。
    // 检查频率比「每 5 格」更密：每次真正放置前都看一下，避免 5 格之间拿错还照放。
    // 但 build_material 事件只在第一次发现不一致时发一条，不刷屏、也不自己切槽。
    materialState(player, t) {
      const expected = p.blockType != null ? p.blockType : this.lastSuccessTy;
      if (expected == null) return 'ok'; // 第一格又没给 blockType：无从校验，只能用手持
      const held = heldType(player);
      if (held === expected) {
        t.materialReported = false;
        return 'ok';
      }

      t.materialExpected = expected;
      t.materialHeld = held;
      if (!t.materialReported) {
        t.materialReported = true;
        t.materialUntil = this.tickCount + this.materialWaitTicks;
        this.ctx.event('build_material', {
          ...this.stepInfo(t),
          expected,
          held,
          slot: this.slot,
          source: p.blockType != null ? 'blockType' : 'last_success',
          hint: '上层负责换物品 / 换槽；本模式不会自己切',
        });
      }
      if (this.tickCount >= t.materialUntil) return 'skip';
      return 'wait';
    },

    placeStep(f, player, t) {
      const mat = this.materialState(player, t);
      if (mat === 'wait') {
        // 材料不对：先瞄着，但绝不发 use（否则就是拿错物品乱放）。
        this.aimAt(f, player, t);
        return;
      }
      if (mat === 'skip') {
        this.ctx.event('build_skip', {
          ...this.stepInfo(t),
          reason: 'material',
          expected: t.materialExpected,
          held: t.materialHeld,
          waitedTicks: this.materialWaitTicks,
        });
        this.complete('material');
        return;
      }

      // 瓦片缓存是快照：自己刚放下去的方块要重新拉一次才看得见，
      // 否则真机上「墙明明补上了，build 还报 not_placed」。
      if (Date.now() - this.tilesAt > 1200) {
        this.tilesAt = Date.now();
        this.requestTiles();
      }

      if (t.attempt === 0) this.startAttempt(t);

      this.aimAt(f, player, t);
      f.use = true;
      if (this.slot != null) f.slot = this.slot;

      // 每 verifyEvery tick 回读一次；变成 solid 才算数。
      if (this.tickCount >= t.nextVerifyTick) {
        t.nextVerifyTick = this.tickCount + this.verifyEvery;
        const at = this.ctx.world.tileAt(t.x, t.y);
        if (at?.solid) {
          this.lastSuccessTy = heldType(player) ?? (p.blockType ?? null);
          this.complete('placed');
          return;
        }
      }

      // 一次尝试用满 attemptTicks 还没 solid：重试；3 次都失败就报 build_fail 并跳过。
      if (this.tickCount - t.attemptStartTick >= this.attemptTicks) {
        t.attempt++;
        if (t.attempt > this.attempts) {
          this.ctx.event('build_fail', {
            ...this.stepInfo(t),
            reason: 'not_placed',
            attempts: this.attempts,
            ticksPerAttempt: this.attemptTicks,
          });
          this.complete('failed');
          return;
        }
        this.tilesAt = 0; // 重试前强制刷新一次，别拿旧快照判「没放上」
        this.requestTiles();
        this.startAttempt(t);
      }
    },

    startAttempt(t) {
      t.attempt = t.attempt || 1;
      t.attemptStartTick = this.tickCount;
      t.nextVerifyTick = this.tickCount + this.verifyEvery;
      t.placeAtTick = this.tickCount;
      t.placeAtWorldTick = this.ctx.world?.tick ?? null;
    },

    complete(result) {
      const t = this.tile;
      if (!t || t.finished) return;
      t.finished = true;
      this.processed++;
      if (result === 'placed') {
        this.placed++;
      } else {
        this.skipped++; // skipped = 所有没放成的格（exists / blocked / unreachable / material / failed）
        if (result === 'exists') this.existing++;
        else if (result === 'failed') this.failed++;
      }
      this.ctx.event('build_step', {
        index: this.processed,
        total: this.plan.length,
        x: t.x,
        y: t.y,
        result,
        placed: this.placed,
        skipped: this.skipped,
      });
      this.tile = null;
      if (this.processed >= this.plan.length) this.finish();
    },

    finish() {
      if (this.done) return;
      this.done = true;
      this.ctx.event('build_done', {
        planned: this.plan.length,
        total: this.plan.length,
        placed: this.placed,
        skipped: this.skipped,
        existing: this.existing,
        failed: this.failed,
        processed: this.processed,
      });
      this.ctx.manager?.set?.('idle');
    },

    checkRisk(player, now) {
      const hp = Number(player?.hp);
      if (!Number.isFinite(hp)) return false;
      const mhp = Number(player?.mhp);
      const ratio = Number.isFinite(mhp) && mhp > 0 ? hp / mhp : 1;

      let reason = null;
      if (ratio < this.lowHpRatio) {
        reason = 'low_hp';
      } else {
        if (this.lastHp == null) {
          this.lastHp = hp;
          this.hpAt = now;
        }
        if (hp > this.lastHp) {
          // 回血了，重新开一个 1 秒窗口。
          this.lastHp = hp;
          this.hpAt = now;
        }
        if (now - this.hpAt >= 1000) {
          if (this.lastHp - hp >= this.hpDrop) reason = 'hp_drop';
          this.lastHp = hp;
          this.hpAt = now;
        }
      }
      if (!reason) return false;

      const t = this.tile;
      this.ctx.event('build_risk', {
        hp,
        mhp: Number.isFinite(mhp) ? mhp : null,
        ratio: Math.round(ratio * 1000) / 1000,
        drop: this.lastHp != null ? this.lastHp - hp : 0,
        reason,
        index: this.processed,
        x: t?.x ?? null,
        y: t?.y ?? null,
      });
      this.done = true; // 退出：不再发任何放置输入
      this.ctx.manager?.set?.('idle');
      return true;
    },

    // ---------------------------------------------------------------- exit
    exit() {
      this.tile = null;
    },

    status() {
      const t = this.tile;
      return {
        name: 'build',
        state: this.done ? 'done' : (t?.state ?? 'idle'),
        index: this.processed,
        total: this.plan?.length ?? 0,
        placed: this.placed ?? 0,
        skipped: this.skipped ?? 0,
        existing: this.existing ?? 0,
        failed: this.failed ?? 0,
        tile: t ? {
          x: t.x,
          y: t.y,
          attempt: t.attempt,
          blocked: t.blockedCount,
          stuck: t.move?.stuck ?? 0,
          placeAtTick: t.placeAtTick,
          placeAtWorldTick: t.placeAtWorldTick,
        } : null,
        slot: this.slot ?? null,
        expectedType: p.blockType != null ? p.blockType : (this.lastSuccessTy ?? null),
        heldType: heldType(this.ctx?.world?.p),
        done: !!this.done,
      };
    },
  };

  return mode;
}
