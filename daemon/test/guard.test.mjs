import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGuards, guardStatus, resetGuards,
  ruleBossSeen, ruleDead, ruleInventoryFull, ruleLowHp,
} from '../src/guard.mjs';

function makeCtx({
  p = {}, boss = null, inv = null, name = 'idle', params = {},
} = {}) {
  const events = [];
  const calls = [];
  const player = { hp: 100, mhp: 100, dead: 0, ...p };
  const world = {
    p: player,
    state: inv == null ? {} : { in: inv },
    boss: () => boss,
    hostiles: () => [],
    nearestHostile: () => null,
  };
  return {
    world,
    events,
    calls,
    manager: {
      name,
      params,
      set(next, nextParams) {
        calls.push({ name: next, params: nextParams });
        this.name = next;
        this.params = nextParams;
      },
    },
    event(type, data) { events.push({ type, data }); },
    log() {},
  };
}

beforeEach(() => resetGuards());

test('ruleLowHp is an independent, side-effect-free rule', () => {
  const ctx = makeCtx({ p: { hp: 20, mhp: 100 }, name: 'gather' });
  const hit = ruleLowHp(ctx);
  assert.equal(hit.kind, 'low_hp');
  assert.equal(hit.group, 'survive');
  assert.equal(ctx.events.length, 0);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ruleLowHp(makeCtx({ p: { hp: 20, mhp: 100 }, name: 'survive' })), null);
  assert.equal(ruleLowHp(makeCtx({ p: { hp: 40, mhp: 100 } })), null);
});

test('low_hp switches to survive and the 10s cooldown prevents flapping', () => {
  const ctx = makeCtx({ p: { hp: 20, mhp: 100 }, name: 'gather' });
  const t0 = 1_000_000;

  const first = evaluateGuards(ctx, t0);
  assert.deepEqual(first, { group: 'survive', params: { reason: 'low_hp' }, reason: 'low_hp' });
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].type, 'guard');
  assert.equal(ctx.events[0].data.kind, 'low_hp');
  assert.equal(ctx.events[0].data.hp, 20);
  assert.equal(ctx.calls.length, 0, 'guard only reports, ModeManager does the switch');

  assert.equal(evaluateGuards(ctx, t0 + 9_999), null);
  assert.equal(ctx.events.length, 1, 'cooldown suppresses repeat event');

  const again = evaluateGuards(ctx, t0 + 10_000);
  assert.equal(again.group, 'survive');
  assert.equal(ctx.events.length, 2);
});

test('boss_seen switches to boss and respects autoBoss:false', () => {
  const boss = { i: 7, ty: 50, lf: 100, lm: 100 };
  const ctx = makeCtx({ boss, name: 'idle' });
  const t0 = 2_000_000;

  const hit = evaluateGuards(ctx, t0);
  assert.equal(hit.group, 'boss');
  assert.equal(hit.reason, 'boss_seen');
  assert.equal(ctx.events.at(-1).data.kind, 'boss_seen');
  assert.equal(ctx.events.at(-1).data.boss.id, 7);

  resetGuards();
  const vetoed = makeCtx({ boss, name: 'idle', params: { autoBoss: false } });
  assert.equal(ruleBossSeen(vetoed), null);
  assert.equal(evaluateGuards(vetoed, t0), null);
  assert.equal(vetoed.events.length, 0);
});

test('boss_seen does not pull a dying player out of survive', () => {
  const boss = { i: 7, ty: 50, lf: 100, lm: 100 };
  assert.equal(ruleBossSeen(makeCtx({ boss, name: 'survive' })), null);
  assert.equal(ruleBossSeen(makeCtx({ boss, name: 'idle', p: { hp: 20, mhp: 100 } })), null);
});

test('inventory_full emits an event but never switches group', () => {
  const inv = [...Array(50).fill(1), 0, 0];
  const ctx = makeCtx({ inv, name: 'gather' });
  const t0 = 3_000_000;

  assert.equal(evaluateGuards(ctx, t0), null);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].data.kind, 'inventory_full');
  assert.equal(ctx.events[0].data.used, 50);

  assert.equal(evaluateGuards(ctx, t0 + 59_999), null);
  assert.equal(ctx.events.length, 1);
  assert.equal(evaluateGuards(ctx, t0 + 60_000), null);
  assert.equal(ctx.events.length, 2);

  assert.equal(ruleInventoryFull(makeCtx({ inv: [...Array(49).fill(1)] })), null);
});

test('dead returns idle, reports once per cooldown, and suppresses low_hp', () => {
  const ctx = makeCtx({ p: { hp: 0, mhp: 100, dead: 1 }, name: 'gather' });
  const t0 = 4_000_000;

  assert.deepEqual(evaluateGuards(ctx, t0), { group: 'idle', params: { reason: 'dead' }, reason: 'dead' });
  assert.equal(ctx.events.at(-1).data.kind, 'dead');

  // 冷却期间尸体不能被 low_hp 拖去 survive。
  assert.equal(evaluateGuards(ctx, t0 + 1_000), null);
  assert.equal(ctx.events.length, 1);

  // 已经在 idle：事件照发，但不再重复 set。
  ctx.manager.name = 'idle';
  assert.equal(evaluateGuards(ctx, t0 + 3_000), null);
  assert.equal(ctx.events.length, 2);
  assert.equal(ctx.events.at(-1).data.kind, 'dead');
});

test('guardStatus reports remaining cooldown per rule', () => {
  const ctx = makeCtx({ p: { hp: 20, mhp: 100 }, name: 'gather' });
  evaluateGuards(ctx, 5_000_000);
  const status = guardStatus(5_002_500);
  assert.equal(status.low_hp, 7_500);
  assert.equal(status.boss_seen, 0);
  assert.equal(status.dead, 0);
  assert.equal(status.inventory_full, 0);
});

test('ruleDead only fires for a dead player', () => {
  assert.equal(ruleDead(makeCtx()), null);
  const hit = ruleDead(makeCtx({ p: { dead: 1 } }));
  assert.equal(hit.kind, 'dead');
  assert.equal(hit.group, 'idle');
});
