import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.mjs';
import { ModeManager } from '../src/modes.mjs';
import { AUTONOMY_GROUPS, createAutonomy } from '../src/autonomy.mjs';

// ── 最小测试脚手架（照 modes.test.mjs 抄一份，不 import 它的内部）──────────

const BASE_P = {
  nm: 'Player', x: 1000, y: 600, vx: 0, vy: 0, w: 20, h: 42,
  hp: 100, mhp: 100, mp: 20, mmp: 20, air: 200, amax: 200, grd: 1, dir: 1,
  sl: 0, dead: 0, resp: 0, wing: 0, dash: 0, mnt: -1, use: 0,
  it: {
    ty: 0, nm: 'Iron Pickaxe', ut: 12, ua: 20, ar: 1, dm: 5, ss: 10, sh: 0,
    me: 1, rg: 0, mg: 0, sm: 0, pk: 40, ax: 0, hm: 0, am: 0, mc: 0, ch: 0, us: 1,
  },
};

function makeHarness({ p = {}, n = [], pr = [], inv = [], day = 1, menu = 0 } = {}) {
  const world = new World();
  world.onMessage({
    t: 'state', tick: 1, tm: 1000, day, bm: 0, ec: 0, menu,
    p: { ...BASE_P, ...p },
    bf: [], n, pr, dr: [], hb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], in: inv,
  });

  const events = [];
  const ctx = {
    world,
    client: { input() {}, send() {} },
    dodge: { apply: (_world, frame) => frame },
    manager: null,
    policy: null,
    events,
    event(type, data = {}) {
      events.push({ seq: events.length + 1, at: Date.now(), type, data });
    },
    log() {},
  };
  const manager = new ModeManager(ctx);
  ctx.manager = manager;
  manager.set('idle');
  return { world, ctx, manager, events };
}

function invUsed(count) {
  return Array.from({ length: 55 }, (_, i) => (i < count ? 1 : 0));
}

// ── 1. 基本评分 ─────────────────────────────────────────────────────────

test('空背包 + 满血 + 白天 → 选 gather', () => {
  const h = makeHarness({ inv: [] });
  const a = createAutonomy(h.ctx);
  const r = a.tick(Date.now());

  assert.equal(r.pick, 'gather');
  assert.equal(r.applied, true);
  assert.equal(h.manager.name, 'gather');
  assert.equal(h.ctx.policy.source, 'autonomy', '切组必须走 applyPolicy 的 autonomy 来源');
  assert.deepEqual(h.ctx.policy.group, 'gather');
  assert.equal(a.status().lastPick, 'gather');
  assert.equal(a.status().switches, 1);
});

test('背包占用 ≥ 50 格 → gather 收益归零，改选 explore', () => {
  const h = makeHarness({ inv: invUsed(55) });
  const a = createAutonomy(h.ctx);
  const r = a.tick(Date.now());

  assert.equal(r.scores.gather, 0, '背包满时 gather 收益必须是 0');
  assert.equal(r.pick, 'explore');
  assert.equal(h.manager.name, 'explore');
});

test('低血（<30%）→ 不选 gather/explore，也不切组，交给守护层', () => {
  const h = makeHarness({ p: { hp: 20 }, inv: [] });
  const a = createAutonomy(h.ctx);
  const r = a.tick(Date.now());

  assert.notEqual(r.pick, 'gather');
  assert.notEqual(r.pick, 'explore');
  assert.equal(r.skipped, 'low_hp');
  assert.equal(r.applied, false);
  assert.equal(h.manager.name, 'idle', '残血时自主循环不抢守护层的活');
});

test('夜里（day === 0）explore 分数低于白天', () => {
  const dayH = makeHarness({ inv: invUsed(30), day: 1 });
  const nightH = makeHarness({ inv: invUsed(30), day: 0 });
  const t0 = Date.now();
  const day = createAutonomy(dayH.ctx).tick(t0);
  const night = createAutonomy(nightH.ctx).tick(t0);

  assert.ok(night.scores.explore < day.scores.explore, '夜里探索收益应更低');
  assert.ok(night.scores.explore < 0, '夜里 explore 应该是明显负分');
  assert.notEqual(night.pick, 'explore');
});

// ── 2. 让位 / 夺回 ──────────────────────────────────────────────────────

test('鲸白手动 policy（source 非 autonomy）→ skipped manual_policy，enabled 仍 true', () => {
  const h = makeHarness({ inv: [] });
  h.manager.set('gather');
  h.ctx.policy = {
    group: 'gather', params: {}, reason: 'manual', source: 'file', at: Date.now(),
  };
  const a = createAutonomy(h.ctx);
  const r = a.tick(Date.now());

  assert.equal(r.skipped, 'manual_policy');
  assert.equal(r.applied, false);
  assert.equal(a.status().enabled, true);
  assert.equal(h.manager.name, 'gather', '手动组不能被自主循环抢走');
  assert.equal(h.ctx.policy.source, 'file');
  assert.equal(a.status().lastPick, null);
});

test('鲸白写 {"group":"auto"} → 交还控制权', () => {
  const h = makeHarness({ inv: [] });
  h.ctx.policy = {
    group: 'auto', params: {}, reason: 'hand back', source: 'file', at: Date.now(),
  };
  const a = createAutonomy(h.ctx);
  const r = a.tick(Date.now());

  assert.equal(r.skipped, undefined);
  assert.equal(r.applied, true);
  assert.equal(h.manager.name, 'gather');
  assert.equal(h.ctx.policy.source, 'autonomy');
});

test('params.auto:true 立即交还；params.auto:false 即使组结束也钉死', () => {
  const handback = makeHarness({ inv: [] });
  handback.ctx.policy = {
    group: 'gather', params: { auto: true }, source: 'file', at: Date.now(),
  };
  const a1 = createAutonomy(handback.ctx);
  assert.equal(a1.tick(Date.now()).applied, true);
  assert.equal(handback.manager.name, 'gather');

  const pinned = makeHarness({ inv: [] });
  pinned.ctx.policy = {
    group: 'gather', params: { auto: false }, source: 'file', at: Date.now() - 5000,
  };
  pinned.ctx.event('goal_done', { group: 'gather', reason: 'inventory' });
  const a2 = createAutonomy(pinned.ctx);
  const r = a2.tick(Date.now());
  assert.equal(r.skipped, 'manual_policy');
  assert.equal(pinned.manager.name, 'idle');
});

test('手动组正常结束（goal_done）且没写 auto:false → 自主循环夺回', () => {
  const h = makeHarness({ inv: [] });
  h.ctx.policy = {
    group: 'gather', params: {}, source: 'file', at: Date.now() - 1000,
  };
  h.ctx.event('goal_done', { group: 'gather', reason: 'timeout' });

  const a = createAutonomy(h.ctx);
  const r = a.tick(Date.now());

  assert.equal(r.applied, true);
  assert.equal(h.manager.name, 'gather');
  assert.equal(h.ctx.policy.source, 'autonomy');
});

// ── 3. 冷却 ────────────────────────────────────────────────────────────

test('刚结束的组 60s 内降权 60%，冷却过后恢复', () => {
  // 背包只剩 5 格：gather=5.5，白天 explore≈13.8，夜里 explore 是负分 → 夜里 gather 才最高。
  const h = makeHarness({ inv: invUsed(45), day: 0 });
  const a = createAutonomy(h.ctx);
  const t0 = Date.now();

  const first = a.tick(t0);
  assert.equal(first.pick, 'gather', '夜里 + 5 格空位，gather 应该最高');

  // 模拟 gather 自己结束（timeout / inventory / danger 都是 goal_done）。
  h.ctx.event('goal_done', { group: 'gather', reason: 'timeout' });
  h.manager.set('idle');

  const cooled = a.tick(t0 + 7000);
  assert.equal(cooled.pick, 'hold', 'gather 被降权后 hold 应该接管');
  assert.ok(cooled.scores.gather < cooled.scores.hold);
  assert.ok(a.status().cooldowns.gather > 0, 'status 里应看得到 gather 冷却');
  assert.equal(h.manager.name, 'hold');

  const expired = a.tick(t0 + 62_000);
  assert.equal(expired.pick, 'gather', '冷却过期后 gather 应恢复');
  assert.equal(h.manager.name, 'gather');
  assert.equal(a.status().cooldowns.gather, 0);
});

// ── 4. 最小停留 / 防抖 ─────────────────────────────────────────────────

test('切组后 6s 内不连续切，满 6s 才允许换组', () => {
  const h = makeHarness({ inv: [] });
  const a = createAutonomy(h.ctx);
  const t0 = Date.now();

  const first = a.tick(t0);
  assert.equal(first.pick, 'gather');
  assert.equal(h.manager.name, 'gather');

  // 背包塞满 → gather 归零，explore 变成最高分。
  h.world.state.in = invUsed(55);

  const tooSoon = a.tick(t0 + 2000);
  assert.equal(tooSoon.pick, 'explore');
  assert.equal(tooSoon.skipped, 'min_dwell');
  assert.equal(tooSoon.applied, false);
  assert.equal(h.manager.name, 'gather', '最小停留内不能换组');

  const later = a.tick(t0 + 7000);
  assert.equal(later.pick, 'explore');
  assert.equal(later.applied, true);
  assert.equal(h.manager.name, 'explore');
});

// ── 5. 启停 ────────────────────────────────────────────────────────────

test('stop() 清掉 interval，之后 tick 不再评估', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = makeHarness({ inv: [] });
  const a = createAutonomy(h.ctx, { intervalMs: 40 });

  a.start();
  assert.equal(a.status().enabled, true);
  assert.equal(a.status().running, true);
  assert.equal(h.manager.name, 'gather', 'start() 应该立刻评估一次');

  const before = a.status().lastAt;
  a.stop();
  a.stop(); // 幂等，重复 stop 不抛
  assert.equal(a.status().enabled, false);
  assert.equal(a.status().running, false);

  // 模拟时间过去：interval 已经被清掉，不应再有任何评估。
  t.mock.timers.tick(5000);
  assert.equal(a.status().lastAt, before);

  // 手动 tick 也拒绝。
  const r = a.tick(Date.now() + 60_000);
  assert.equal(r.skipped, 'stopped');
  assert.equal(h.manager.name, 'gather');
});

// ── 6. 绝不抛异常 ──────────────────────────────────────────────────────

test('空 ctx / 空 world / 无 p / 无 in / 无 day 都不抛异常', () => {
  assert.doesNotThrow(() => createAutonomy(null).tick(123));
  assert.equal(createAutonomy(null).tick(123).skipped, 'no_manager');

  const noManager = { events: [], event() {}, log() {} };
  const a1 = createAutonomy(noManager);
  assert.doesNotThrow(() => a1.tick(1));
  assert.equal(a1.tick(2).skipped, 'no_manager');
  assert.doesNotThrow(() => a1.status());

  // 有 manager、没有 world.state / player。
  const ctx2 = { world: {}, events: [], event() {}, log() {} };
  const manager2 = new ModeManager(ctx2);
  ctx2.manager = manager2;
  manager2.set('idle');
  const a2 = createAutonomy(ctx2);
  assert.doesNotThrow(() => a2.tick(1));
  assert.doesNotThrow(() => a2.start());
  a2.stop();

  // 有 player，但没有 in / day（mod 还没上报背包）。
  const ctx3 = {
    world: { state: { p: { ...BASE_P } } },
    events: [],
    event() {},
    log() {},
    client: { send() {} },
  };
  const manager3 = new ModeManager(ctx3);
  ctx3.manager = manager3;
  manager3.set('idle');
  const a3 = createAutonomy(ctx3);
  assert.doesNotThrow(() => a3.tick(1));
  assert.ok(AUTONOMY_GROUPS.includes(a3.status().lastPick), '未知背包也要能选出一个合法组');
  assert.doesNotThrow(() => a3.status());
});
