import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.mjs';
import { ModeManager } from '../src/modes.mjs';
import { resetGuards } from '../src/guard.mjs';

const BASE_P = {
  nm: 'Player', x: 1000, y: 600, vx: 0, vy: 0, w: 20, h: 42,
  hp: 100, mhp: 100, mp: 20, mmp: 20, air: 200, amax: 200, grd: 1, dir: 1,
  sl: 0, dead: 0, resp: 0, wing: 0, dash: 0, mnt: -1, use: 0,
  it: {
    ty: 0, nm: 'Iron Pickaxe', ut: 12, ua: 20, ar: 1, dm: 5, ss: 10, sh: 0,
    me: 1, rg: 0, mg: 0, sm: 0, pk: 40, ax: 0, hm: 0, am: 0, mc: 0, ch: 0, us: 1,
  },
};

function slime(over = {}) {
  return {
    i: 1, ty: 1, x: 1200, y: 600, vx: 0, vy: 0, w: 20, h: 20,
    lf: 40, lm: 40, bo: 0, fr: 0, dm: 7, ai: 1, rl: -1, a: [0, 0, 0, 0],
    ...over,
  };
}

function makeHarness({ p = {}, n = [], pr = [], inv = [], followTarget } = {}) {
  const world = new World();
  world.onMessage({
    t: 'state', tick: 1, tm: 1000, day: 1, bm: 0, ec: 0,
    p: { ...BASE_P, ...p },
    bf: [], n, pr, dr: [], hb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], in: inv,
  });

  const events = [];
  const frames = [];
  const ctx = {
    world,
    client: {
      input(frame) { frames.push(frame); },
      send() {},
    },
    dodge: { apply: (_world, frame) => frame },
    manager: null,
    followTarget,
    event(type, data) { events.push({ type, data }); },
    log() {},
  };
  const manager = new ModeManager(ctx);
  ctx.manager = manager;
  return { world, ctx, manager, events, frames };
}

function eventTypes(h) {
  return h.events.map((e) => e.type);
}

beforeEach(() => resetGuards());

test('ModeManager keeps the 8 existing modes and registers the new strategy groups', () => {
  const h = makeHarness();
  for (const name of [
    'idle', 'release', 'free', 'goto', 'combat', 'boss', 'build', 'replay',
    'survive', 'gather', 'explore', 'hold', 'fight', 'follow', 'home',
  ]) {
    assert.equal(typeof h.manager.factories[name], 'function', `missing factory: ${name}`);
  }
});

test('every new strategy group can enter + tick without throwing', () => {
  const groups = [
    ['survive', {}],
    ['gather', { dir: 'right' }],
    ['explore', { dir: 'left' }],
    ['hold', {}],
    ['fight', {}],
    ['follow', {}],
    ['home', {}],
  ];
  for (const [name, params] of groups) {
    const h = makeHarness();
    assert.doesNotThrow(() => h.manager.set(name, params), `enter ${name}`);
    assert.doesNotThrow(() => h.manager.tick(), `tick ${name}`);
    assert.doesNotThrow(() => h.manager.tick(), `second tick ${name}`);
  }
});

test('survive runs away from the nearest threat', () => {
  const h = makeHarness({ p: { hp: 40 }, n: [slime({ x: 1200 })] });
  h.manager.set('survive');
  const frame = h.manager.tick();
  assert.ok(frame, 'survive returns a frame');
  assert.equal(frame.left, true, 'threat is on the right → run left');
  assert.equal(frame.right, false);
  assert.equal(h.manager.name, 'survive');
});

test('survive exits to idle when hp > 60% and no threat', () => {
  const h = makeHarness({ p: { hp: 80 } });
  h.manager.set('survive');
  h.manager.tick();
  assert.equal(h.manager.name, 'idle');
  const done = h.events.find((e) => e.type === 'goal_done' && e.data.group === 'survive');
  assert.ok(done);
  assert.equal(done.data.reason, 'safe');
});

test('low_hp guard intercepts ModeManager.tick once, not every frame', () => {
  const h = makeHarness({ p: { hp: 20 } });
  h.manager.set('gather', { dir: 'right' });
  h.frames.length = 0;

  assert.equal(h.manager.tick(), null, 'guard frame sends no input');
  assert.equal(h.manager.name, 'survive');
  assert.equal(h.frames.length, 0);
  assert.ok(h.events.some((e) => e.type === 'guard' && e.data.kind === 'low_hp'));

  const frame = h.manager.tick();
  assert.ok(frame, 'next frame is owned by survive');
  assert.equal(h.manager.name, 'survive');
  assert.equal(h.frames.length, 1);
});

test('gather exits when the inventory changes', () => {
  const h = makeHarness({ inv: [0, 0, 0] });
  h.manager.set('gather', { dir: 'right', timeoutMs: 60_000 });
  h.manager.tick(); // 记下背包基线
  assert.equal(h.manager.name, 'gather');

  h.world.state.in = [1, 0, 0];
  h.manager.tick();
  assert.equal(h.manager.name, 'idle');
  const done = h.events.find((e) => e.type === 'goal_done' && e.data.group === 'gather');
  assert.ok(done);
  assert.equal(done.data.reason, 'inventory');
});

test('gather exits on nearby danger', () => {
  const h = makeHarness({ p: { hp: 80 }, n: [slime({ x: 1050, y: 600 })] });
  h.manager.set('gather', { dir: 'right', timeoutMs: 60_000 });
  h.manager.tick();
  assert.equal(h.manager.name, 'idle');
  const done = h.events.find((e) => e.type === 'goal_done' && e.data.group === 'gather');
  assert.equal(done.data.reason, 'danger');
});

test('gather does not panic at a slime while still at full hp', () => {
  const h = makeHarness({ p: { hp: 100 }, n: [slime({ x: 1050, y: 600 })] });
  h.manager.set('gather', { dir: 'left', timeoutMs: 60_000 });
  const frame = h.manager.tick();
  assert.equal(h.manager.name, 'gather');
  assert.equal(frame.left, true);
});

test('explore timeout emits timeout and returns to idle', () => {
  const h = makeHarness();
  h.manager.set('explore', { dir: 'right', timeoutMs: 0 });
  h.manager.tick();
  assert.equal(h.manager.name, 'idle');
  const timeout = h.events.find((e) => e.type === 'timeout');
  assert.ok(timeout);
  assert.equal(timeout.data.group, 'explore');
});

test('explore walks and jumps when blocked', () => {
  const h = makeHarness({ p: { x: 1000 } });
  h.manager.set('explore', { dir: 'right', timeoutMs: 60_000 });
  const frame = h.manager.tick();
  assert.equal(frame.right, true);

  h.manager.current.lastX = 1000;
  h.manager.current.progressAt = Date.now() - 1000;
  const blocked = h.manager.tick();
  assert.equal(blocked.jump, true);
});

test('hold waits 5s without a target before going idle', () => {
  const h = makeHarness();
  h.manager.set('hold', { noTargetMs: 5000 });
  h.manager.tick();
  assert.equal(h.manager.name, 'hold');

  h.manager.current.noTargetSince = Date.now() - 6000;
  h.manager.tick();
  assert.equal(h.manager.name, 'idle');
  assert.ok(h.events.some((e) => e.type === 'no_target' && e.data.group === 'hold'));
});

test('hold aims/uses at a target instead of approaching', () => {
  const h = makeHarness({ n: [slime({ x: 1030, y: 600 })] });
  h.manager.set('hold', {});
  const frame = h.manager.tick();
  assert.ok(Array.isArray(frame.aim), 'aims at target');
  assert.equal(frame.use, true, 'target is inside melee use range');
  assert.notEqual(frame.right, true, 'hold does not chase');
});

test('fight reuses combat target selection and retreats below 30% hp', () => {
  const h = makeHarness({ n: [slime({ x: 1200, y: 600 })] });
  h.manager.set('fight', {});
  const frame = h.manager.tick();
  assert.equal(frame.right, true, 'melee fight approaches a target outside weapon range');
  assert.equal(h.manager.name, 'fight');

  // 绕过守护层直接测 fight 自己的撤退线。
  h.world.state.p.hp = 20;
  h.manager.current.tick();
  assert.equal(h.manager.name, 'survive');
  assert.ok(h.events.some((e) => e.type === 'retreat' && e.data.group === 'fight'));
});

test('follow without player state reports unsupported and returns to idle', () => {
  const h = makeHarness();
  h.manager.set('follow');
  assert.equal(h.manager.name, 'idle');
  assert.ok(h.events.some((e) => e.type === 'follow_unsupported'));
  assert.doesNotThrow(() => h.manager.tick());
});

test('home reports unsupported and returns to idle', () => {
  const h = makeHarness();
  h.manager.set('home');
  assert.equal(h.manager.name, 'idle');
  assert.ok(h.events.some((e) => e.type === 'home_unsupported'));
  assert.doesNotThrow(() => h.manager.tick());
});

test('status exposes lastGroup and guard cooldowns', () => {
  const h = makeHarness();
  h.manager.set('idle');
  h.manager.set('gather', { dir: 'right' });
  const status = h.manager.status();
  assert.equal(status.name, 'gather');
  assert.equal(status.lastGroup, 'idle');
  assert.equal(typeof status.guards.low_hp, 'number');
  assert.equal(typeof status.guards.boss_seen, 'number');
});
