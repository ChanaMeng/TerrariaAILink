// gather.test.mjs — 新 GatherMode 的单测：认树、走近、对准、被挖掉后重选、退出条件。
// 用法和 modes.test.mjs 一样：真 World + 假 ctx；唯一的区别是 world.tileAt
// 被一张 Map 覆盖，这样不用真的收到 tiles 二进制数据也能构造地形。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.mjs';
import { createGatherMode, TREE_TYPES, ORE_TYPES } from '../src/gather.mjs';

const BASE_P = {
  nm: 'Player', x: 1000, y: 600, vx: 0, vy: 0, w: 20, h: 42,
  hp: 100, mhp: 100, mp: 20, mmp: 20, air: 200, amax: 200, grd: 1, dir: 1,
  sl: 0, dead: 0, resp: 0, wing: 0, dash: 0, mnt: -1, use: 0,
  it: {
    ty: 0, nm: 'Iron Pickaxe', ut: 12, ua: 20, ar: 1, dm: 5, ss: 10, sh: 0,
    me: 1, rg: 0, mg: 0, sm: 0, pk: 40, ax: 0, hm: 0, am: 0, mc: 0, ch: 0, us: 1,
  },
};

/** 一个 tileAt 返回值；测试只关心 type，solid 等给默认值。 */
function tile(type) {
  return { type, solid: false, platform: false, liquid: 0, liquidType: 0 };
}

/** `[key, tile]`，方便直接 new Map([...])。 */
function at(tx, ty, type) {
  return [`${tx},${ty}`, tile(type)];
}

function makeHarness({ p = {}, n = [], inv = [], tiles = new Map(), params = {} } = {}) {
  const world = new World();
  world.onMessage({
    t: 'state', tick: 1, tm: 1000, day: 1, bm: 0, ec: 0,
    p: { ...BASE_P, ...p },
    bf: [], n, pr: [], dr: [], hb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], in: inv,
  });

  // 覆盖 tileAt：给定 Map 之外的格子一律空气。
  const map = new Map(tiles);
  world.tileAt = (tx, ty) => map.get(`${tx},${ty}`) ?? null;

  const events = [];
  const sends = [];
  const manager = {
    name: 'gather',
    sets: [],
    set(name) { this.name = name; this.sets.push(name); },
  };
  const ctx = {
    world,
    client: {
      send(cmd) { sends.push(cmd); },
      input() {},
    },
    manager,
    event(type, data) { events.push({ type, data }); },
    log() {},
  };

  const mode = createGatherMode(ctx, { dir: 'right', ...params });
  mode.enter();
  return { world, map, ctx, manager, mode, events, sends };
}

function slime(over = {}) {
  return {
    i: 1, ty: 1, x: 1200, y: 600, vx: 0, vy: 0, w: 20, h: 20,
    lf: 40, lm: 40, bo: 0, fr: 0, dm: 7, ai: 1, rl: -1, a: [0, 0, 0, 0],
    ...over,
  };
}

function findEvent(h, type) {
  return h.events.find((e) => e.type === type) ?? null;
}

// 玩家 (1000,600) = 格子 (62,37)；格心相对玩家的距离（格）= 格心像素差 / 16。

test('附近有树：朝树走，而不是朝 dir 走', () => {
  const h = makeHarness({ tiles: new Map([at(67, 37, 5)]), params: { dir: 'left' } });
  const frame = h.mode.tick();

  assert.equal(h.mode.target?.tx, 67, '选到右侧那棵树');
  assert.equal(frame.right, true, '树在右边 → 往右走');
  assert.equal(frame.left, false, '不能还按 dir=left 走');
  assert.equal(frame.use, false, '还没到 3 格，先别挥');
});

test('走到 3 格内：aim 指向树格中心 + use', () => {
  const h = makeHarness({ tiles: new Map([at(64, 37, 5)]) });
  const frame = h.mode.tick();

  assert.equal(frame.use, true, '2 格内应该出手');
  assert.ok(Array.isArray(frame.aim), '应该给出瞄准方向');
  assert.equal(frame.aim[0], 2, '树在右边 2 格');
  assert.equal(frame.aim[1], 0, '树和玩家同高');
  assert.notEqual(frame.right, true, '采集时不该继续横冲');
});

test('树被挖掉：发 gather_hit，并立刻重选下一个目标', () => {
  const h = makeHarness({
    tiles: new Map([at(64, 37, 5), at(58, 37, 5)]),
    params: { dir: 'right' },
  });
  h.mode.tick();
  assert.equal(h.mode.target?.tx, 64);

  h.map.delete('64,37');
  h.mode.tileCheckAt = Date.now() - 600; // 模拟 500ms 回读窗口到了
  const frame = h.mode.tick();

  const hit = findEvent(h, 'gather_hit');
  assert.ok(hit, '贴脸挖没的格子要发 gather_hit');
  assert.equal(hit.data.tx, 64);
  assert.equal(hit.data.group, 'gather');
  assert.equal(h.mode.target?.tx, 58, '同一帧重选到左边 4 格外的树');
  assert.equal(frame.left, true, '新目标在左边 → 走过去');
  assert.equal(frame.use, false);
});

test('没有树：朝 dir 走，并且每 3 秒重拉一次 tiles', () => {
  const h = makeHarness({ params: { dir: 'left' } });

  assert.deepEqual(h.sends[0], { t: 'cmd', op: 'tiles', x: 30, y: 13, w: 64, h: 48 });
  assert.equal(h.mode.tilesAt > 0, true);

  const frame = h.mode.tick();
  assert.equal(frame.left, true, '没目标就按 dir 走');
  assert.equal(h.mode.target, null);

  h.mode.tilesAt = Date.now() - 3100;
  h.mode.tick();
  const tilesRequests = h.sends.filter((s) => s.op === 'tiles');
  assert.equal(tilesRequests.length, 2, '3 秒到了要重新请求');
});

test('低血：goal_done(danger) 并回 idle', () => {
  const h = makeHarness({ p: { hp: 40, mhp: 100 } });
  h.mode.tick();

  const done = findEvent(h, 'goal_done');
  assert.ok(done);
  assert.equal(done.data.group, 'gather');
  assert.equal(done.data.reason, 'danger');
  assert.equal(h.mode.finished, true);
  assert.deepEqual(h.manager.sets, ['idle']);
});

test('受伤且 5 格内有敌人：goal_done(danger)', () => {
  const h = makeHarness({ p: { hp: 80, mhp: 100 }, n: [slime({ x: 1040 })] });
  h.mode.tick();

  const done = findEvent(h, 'goal_done');
  assert.ok(done);
  assert.equal(done.data.reason, 'danger');
  assert.equal(done.data.threat, 1, '事件里带上威胁 id');
});

test('Boss 出现：立刻 goal_done(danger)，不留在原地采', () => {
  const h = makeHarness({ p: { hp: 100 }, n: [slime({ i: 7, x: 4000, bo: 1 })] });
  h.mode.tick();

  const done = findEvent(h, 'goal_done');
  assert.ok(done);
  assert.equal(done.data.reason, 'danger');
  assert.equal(done.data.boss, 7);
});

test('超时：goal_done(timeout) 并回 idle', () => {
  const h = makeHarness({ params: { timeoutMs: 0 } });
  h.mode.tick();

  const done = findEvent(h, 'goal_done');
  assert.ok(done);
  assert.equal(done.data.reason, 'timeout');
  assert.deepEqual(h.manager.sets, ['idle']);
});

test('8 秒没进展：发 stuck 并交出控制权', () => {
  const h = makeHarness({ params: { dir: 'right' } });
  h.mode.tick(); // 先正常走一帧，记下基线
  assert.equal(h.mode.finished, false);

  h.mode.progressAt = Date.now() - 8100; // 玩家一帧都没动
  h.mode.tick();

  const stuck = findEvent(h, 'stuck');
  assert.ok(stuck, '8 秒没进展必须报 stuck');
  assert.equal(stuck.data.group, 'gather');
  assert.equal(stuck.data.dir, 'right');
  assert.equal(h.mode.finished, true);
  assert.deepEqual(h.manager.sets, ['idle']);
});

test('卡住 1.5 秒会跳一下，但还不到 8 秒不退出', () => {
  const h = makeHarness({ tiles: new Map([at(67, 37, 5)]) });
  h.mode.tick();

  h.mode.progressAt = Date.now() - 1600;
  const frame = h.mode.tick();
  assert.equal(frame.jump, true, '卡 1.5 秒尝试起跳');
  assert.equal(h.mode.finished, false, '还没到 8 秒，继续干活');
});

test('kind=ore 只认矿，不认脚边的树', () => {
  const h = makeHarness({
    tiles: new Map([at(64, 37, 5), at(67, 37, 6)]),
    params: { kind: 'ore' },
  });
  const frame = h.mode.tick();

  assert.equal(h.mode.target?.tx, 67, '必须跳过 2 格外的树，选 5 格外的矿');
  assert.equal(frame.right, true);
  assert.equal(h.mode.kind, 'ore');
});

test('导出树/矿类型表，方便真机核对后修改', () => {
  assert.equal(typeof createGatherMode, 'function');
  assert.deepEqual([...TREE_TYPES], [5, 323, 170]);
  assert.equal(ORE_TYPES.size, 20);
  assert.ok(ORE_TYPES.has(6) && ORE_TYPES.has(228));
});
