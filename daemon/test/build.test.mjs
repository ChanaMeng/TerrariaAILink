// build.test.mjs — createBuildMode 的单元测试。
//
// 这里自己搭一套最小假 ctx，不 import modes.mjs：
//   fake world：tileAt(tx, ty) 返回 { solid, type, liquid, platform }
//   fake client：input(frame) 时，如果 use 且 aim 指向计划格，就把它变成 solid（模拟放置成功）
//   fake manager：只负责 set('build' | 'idle') 和逐帧 tick

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildMode } from '../src/build.mjs';
import { neutral } from '../src/proto.mjs';

const PX = 16;

// 玩家站在 (1000, 600)，正好是瓦片 (62, 37) 的中心附近。
const BASE_P = {
  x: 1000, y: 600, vx: 0, vy: 0, w: 20, h: 42,
  hp: 100, mhp: 100, grd: 1, dead: 0,
  it: { ty: 1 }, // 手持方块 type=1
};

class FakeWorld {
  constructor({ p = {}, inventory = [] } = {}) {
    this.p = { ...BASE_P, ...p };
    this.state = { p: this.p, in: inventory, tick: 0 };
    this.grid = new Map();
  }

  tileAt(tx, ty) {
    return this.grid.get(`${tx},${ty}`) ?? {
      solid: false, type: 0, platform: false, liquid: 0, liquidType: 0,
    };
  }

  set(tx, ty, patch = {}) {
    this.grid.set(`${tx},${ty}`, {
      solid: false, type: 0, platform: false, liquid: 0, liquidType: 0,
      ...patch,
    });
  }

  get tick() { return this.state.tick; }
}

function makeClient(world, plan, { failKeys = [] } = {}) {
  const planKeys = new Set(plan.map((s) => `${s.x},${s.y}`));
  const fail = new Set(failKeys);
  return {
    sends: [],
    inputs: [],
    usedKeys: [], // 真正发过 use 的格子

    send(msg) { this.sends.push(msg); },

    input(frame) {
      this.inputs.push(frame);
      if (!frame?.use || !Array.isArray(frame.aim)) return;

      // aim 是相对玩家的「格」单位；换算回绝对瓦片坐标。
      const tx = Math.floor((world.p.x + frame.aim[0] * PX) / PX);
      const ty = Math.floor((world.p.y + frame.aim[1] * PX) / PX);
      const key = `${tx},${ty}`;
      this.usedKeys.push(key);

      // 计划内、且没被标记为「必失败」的格子：模拟服务器放置成功。
      if (planKeys.has(key) && !fail.has(key)) world.set(tx, ty, { solid: true, type: 1 });
    },
  };
}

function makeHarness({ plan = [], p = {}, inventory = [], tiles = [], failKeys = [], params = {} } = {}) {
  const world = new FakeWorld({ p, inventory });
  for (const t of tiles) world.set(t.x, t.y, t);

  const events = [];
  const client = makeClient(world, plan, { failKeys });

  const ctx = {
    world,
    client,
    manager: null,
    dodge: { apply: (_world, frame) => frame },
    event(type, data = {}) { events.push({ type, data }); },
    log() {},
  };

  const manager = {
    name: null,
    params: {},
    current: null,

    set(name, next = {}) {
      this.current?.exit?.();
      this.name = name;
      this.params = next;
      if (name === 'build') {
        this.current = createBuildMode(ctx, next);
        this.current.enter();
      } else {
        // idle 只需要一个不会炸的占位。
        this.current = { name, enter() {}, tick: () => neutral(), exit() {} };
      }
    },

    tick() {
      if (!this.current) return null;
      const frame = this.current.tick();
      world.state.tick++; // 模拟世界 tick 推进（placeAtWorldTick 用）
      if (frame) client.input(frame);
      return frame;
    },
  };
  ctx.manager = manager;
  manager.set('build', { plan, ...params });

  return {
    world, client, ctx, manager, events,
    step(n = 1) {
      let last = null;
      for (let i = 0; i < n; i++) last = manager.tick();
      return last;
    },
  };
}

function firstEvent(h, type) {
  return h.events.find((e) => e.type === type) ?? null;
}

function eventsOf(h, type) {
  return h.events.filter((e) => e.type === type);
}

test('已经 solid 的格子算「已存在」跳过，绝不 use', () => {
  const plan = [{ x: 63, y: 37 }];
  const h = makeHarness({ plan, tiles: [{ x: 63, y: 37, solid: true, type: 1 }] });

  h.step();

  const skip = firstEvent(h, 'build_skip');
  assert.ok(skip, '应该发 build_skip');
  assert.equal(skip.data.reason, 'exists');
  assert.equal(skip.data.x, 63);
  assert.equal(skip.data.y, 37);

  // 目标格已经有方块，不该再瞄准它 use。
  assert.equal(h.client.usedKeys.includes('63,37'), false);
  assert.equal(h.client.inputs.every((f) => !f.use), true);

  const done = firstEvent(h, 'build_done');
  assert.ok(done);
  assert.equal(done.data.placed, 0);
  assert.equal(done.data.existing, 1);
  assert.equal(done.data.skipped, 1);
  assert.equal(h.manager.name, 'idle');
});

test('正常放 3 格 → build_done，placed=3；enter 发一次 tiles 请求', () => {
  const plan = [{ x: 63, y: 37 }, { x: 64, y: 37 }, { x: 65, y: 37 }];
  const h = makeHarness({ plan });

  // enter 里发的 tiles 请求：plan 外扩 8 格（63..65, 37 单行）。
  const reqs = h.client.sends.filter((m) => m.t === 'cmd' && m.op === 'tiles');
  assert.equal(reqs.length, 1, '只发一次 tiles 请求');
  assert.deepEqual(
    { x: reqs[0].x, y: reqs[0].y, w: reqs[0].w, h: reqs[0].h },
    { x: 55, y: 29, w: 19, h: 17 },
  );

  h.step(30);

  const done = firstEvent(h, 'build_done');
  assert.ok(done, '应该完成');
  assert.equal(done.data.placed, 3);
  assert.equal(done.data.skipped, 0);
  assert.equal(done.data.processed, 3);
  assert.equal(eventsOf(h, 'build_step').length, 3);

  for (const s of plan) assert.ok(h.client.usedKeys.includes(`${s.x},${s.y}`), `应放 ${s.x},${s.y}`);
  for (const s of plan) assert.equal(h.world.tileAt(s.x, s.y).solid, true);
  assert.equal(h.manager.name, 'idle');
});

test('连续 3 次放置都失败 → build_fail + 跳过，不卡死', () => {
  const plan = [{ x: 63, y: 37 }];
  const h = makeHarness({ plan, failKeys: ['63,37'] });

  h.step(45);

  const fail = firstEvent(h, 'build_fail');
  assert.ok(fail, '应该发 build_fail');
  assert.equal(fail.data.x, 63);
  assert.equal(fail.data.y, 37);
  assert.equal(fail.data.reason, 'not_placed');
  assert.equal(fail.data.attempts, 3);
  assert.equal(fail.data.ticksPerAttempt, 10);

  const done = firstEvent(h, 'build_done');
  assert.ok(done, '失败后也要收尾，不能卡在第 1 格');
  assert.equal(done.data.placed, 0);
  assert.equal(done.data.failed, 1);
  assert.equal(done.data.skipped, 1);
  assert.equal(h.manager.name, 'idle');
  assert.ok(h.client.usedKeys.filter((k) => k === '63,37').length >= 3, '至少尝试了 3 次 use');
});

test('低血 40% → build_risk 并回到 idle，不放方块', () => {
  const plan = [{ x: 63, y: 37 }];
  const h = makeHarness({ plan, p: { hp: 40, mhp: 100 } });

  const frame = h.step();

  const risk = firstEvent(h, 'build_risk');
  assert.ok(risk, '应该发 build_risk');
  assert.equal(risk.data.reason, 'low_hp');
  assert.equal(risk.data.hp, 40);
  assert.equal(risk.data.ratio, 0.4);
  assert.equal(h.manager.name, 'idle');
  assert.equal(frame.use, false);
  assert.equal(h.client.usedKeys.length, 0);
  assert.equal(firstEvent(h, 'build_done'), null, '低血退出不是 build_done');
});

test('距离 > reach → 先移动（frame 有方向键），不 use', () => {
  const plan = [{ x: 72, y: 37 }]; // 中心 x=1160，距玩家 160px = 10 格 > reach 5
  const h = makeHarness({ plan });

  const frame = h.step();

  assert.equal(frame.right, true, '目标在右边，应该往右走');
  assert.equal(frame.left, false);
  assert.equal(frame.use, false, '够不着就不该 use');
  assert.equal(h.client.usedKeys.length, 0);
  assert.equal(h.manager.name, 'build');
  assert.equal(firstEvent(h, 'build_done'), null);
});

test('卡住 3 次仍够不着 → build_skip(reason=unreachable)，收尾到 idle', () => {
  const plan = [{ x: 72, y: 37 }];
  // stuckMs=0：每次 tick 都算一次卡住，省去在测试里等 1.2 秒。
  const h = makeHarness({ plan, params: { stuckMs: 0 } });

  h.step(8);

  const skip = firstEvent(h, 'build_skip');
  assert.ok(skip, '应该发 build_skip');
  assert.equal(skip.data.reason, 'unreachable');
  assert.equal(skip.data.x, 72);
  assert.equal(skip.data.stuck, 3);

  assert.ok(h.client.inputs.some((f) => f.left || f.right), '先尝试走位');
  assert.equal(h.client.usedKeys.length, 0, '够不着就不该 use');

  const done = firstEvent(h, 'build_done');
  assert.ok(done);
  assert.equal(done.data.placed, 0);
  assert.equal(done.data.skipped, 1);
  assert.equal(h.manager.name, 'idle');
});

test('plan 为空 → 直接 build_done，不炸', () => {
  const h = makeHarness({ plan: [] });
  h.step();

  const done = firstEvent(h, 'build_done');
  assert.ok(done);
  assert.equal(done.data.planned, 0);
  assert.equal(done.data.placed, 0);
  assert.equal(h.manager.name, 'idle');
});

test('树 / 液体 / 平台 → 重查 3 次后 build_skip(reason=blocked)，不 use', () => {
  const plan = [{ x: 63, y: 37 }];
  const h = makeHarness({
    plan,
    tiles: [{ x: 63, y: 37, type: 5 }], // 非 solid 但 type>0，模拟树 / 草
    params: { blockedRetryMs: 0 },
  });

  h.step(5);

  const skip = firstEvent(h, 'build_skip');
  assert.ok(skip);
  assert.equal(skip.data.reason, 'blocked');
  assert.equal(skip.data.tileType, 5);
  assert.equal(h.client.usedKeys.length, 0);

  const done = firstEvent(h, 'build_done');
  assert.ok(done);
  assert.equal(done.data.placed, 0);
  assert.equal(done.data.skipped, 1);
  assert.equal(h.manager.name, 'idle');
});

test('材料不对 → 只发一次 build_material，等不到就跳过，不拿错物品乱放', () => {
  const plan = [{ x: 63, y: 37 }];
  // 手持 ty=1，但要求 blockType=2；等 2 tick 上层没换 → 跳过这一格。
  const h = makeHarness({
    plan,
    p: { it: { ty: 1 } },
    params: { blockType: 2, materialWaitTicks: 2 },
  });

  h.step(10);

  const mats = eventsOf(h, 'build_material');
  assert.equal(mats.length, 1, '同一格只提醒一次');
  assert.equal(mats[0].data.expected, 2);
  assert.equal(mats[0].data.held, 1);

  const skip = firstEvent(h, 'build_skip');
  assert.ok(skip);
  assert.equal(skip.data.reason, 'material');
  assert.equal(h.client.usedKeys.length, 0, '材料不对时绝不能 use');

  const done = firstEvent(h, 'build_done');
  assert.ok(done);
  assert.equal(done.data.placed, 0);
  assert.equal(h.manager.name, 'idle');
});
