import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.mjs';
import { buildBrief } from '../src/brief.mjs';

const GROUND = 600;

function makePlayer(over = {}) {
  return {
    nm: 'Player', x: 960, y: GROUND, vx: 0, vy: 0, w: 20, h: 42,
    hp: 100, mhp: 100, mp: 20, mmp: 20, grd: 1, dir: 1, dead: 0,
    it: { ty: 0, nm: 'Iron Pickaxe' },
    ...over,
  };
}

function makeNpc(over = {}) {
  return {
    i: 1, ty: 1, x: 1200, y: GROUND, vx: 0, vy: 0, w: 32, h: 24,
    lf: 40, lm: 40, bo: 0, fr: 0, dm: 7, nm: 'Slime',
    ...over,
  };
}

function makeCtx({ state, connected = true, manager = 'idle', events = [], chatLog = [], tileAt } = {}) {
  const world = new World();
  if (state) world.onMessage({ t: 'state', tick: 1, ...state });
  if (tileAt) world.tileAt = tileAt;
  return {
    world,
    client: { connected },
    manager: { status: () => ({ name: manager }) },
    events,
    chatLog,
  };
}

function assertClean(text) {
  assert.doesNotMatch(text, /undefined|NaN|\[object Object\]/);
}

function lineCount(text) {
  return text.split('\n').length;
}

test('安全：远处一只史莱姆，一屏话齐全', () => {
  const ctx = makeCtx({
    state: { p: makePlayer(), n: [makeNpc()], pr: [], hb: [] },
    events: [
      { seq: 1, at: 1000, type: 'link_up', data: {} },
      { seq: 2, at: 1001, type: 'mode_change', data: { name: 'idle' } },
      { seq: 3, at: 1002, type: 'build_done', data: { placed: 6 } },
    ],
    chatLog: [{ seq: 1, at: 1003, text: '<Jingbai> 你好' }],
  });
  const b = buildBrief(ctx);

  assert.equal(b.level, 'safe');
  assert.equal(b.data.link, true);
  assert.equal(b.data.group, 'idle');
  assert.deepEqual(
    { x: b.data.player.x, y: b.data.player.y, tx: b.data.player.tx, ty: b.data.player.ty },
    { x: 960, y: 600, tx: 60, ty: 37 },
  );
  assert.equal(b.data.player.hp, 100);
  assert.equal(b.data.player.item, 'Iron Pickaxe');
  assert.equal(b.data.player.grounded, true);
  assert.deepEqual(b.data.threats, [{ type: 'Slime', id: 1, distTiles: 15, hp: 40, max: 40 }]);
  assert.equal(b.data.boss, null);
  assert.equal(b.data.projectiles, 0);
  assert.deepEqual(b.data.tile, { under: 'unknown', head: 'unknown' });
  assert.deepEqual(b.data.events.map((e) => e.type), ['link_up', 'mode_change', 'build_done']);
  assert.deepEqual(b.data.chat, ['<Jingbai> 你好']);

  assert.ok(lineCount(b.text) >= 3 && lineCount(b.text) <= 8, b.text);
  assert.match(b.text, /鲸白 · 在线 · 组=idle/);
  assert.match(b.text, /位置 世界 \(960,600\) · 格 \(60,37\)/);
  assert.match(b.text, /生命 100\/100 · 魔力 20\/20 · 手持 Iron Pickaxe/);
  assert.match(b.text, /Slime 15 格 40\/40/);
  assert.match(b.text, /最近 link_up → mode_change\(idle\) → build_done/);
  assert.match(b.text, /聊天 <Jingbai> 你好/);
  assert.match(b.text, /结论 安全/);
  assertClean(b.text);
});

test('低血：hp=20 判 danger，不靠 mock 默认值', () => {
  const b = buildBrief(makeCtx({
    state: { p: makePlayer({ hp: 20 }), n: [], pr: [] },
  }));
  assert.equal(b.level, 'danger');
  assert.equal(b.data.level, 'danger');
  assert.match(b.text, /生命 20\/100/);
  assert.match(b.text, /结论 危险（血量 20%）/);
  assertClean(b.text);
});

test('warn：5 格内有敌对', () => {
  const b = buildBrief(makeCtx({
    state: { p: makePlayer(), n: [makeNpc({ x: 1020 })], pr: [] },
  }));
  assert.equal(b.level, 'warn');
  assert.equal(b.data.threats[0].distTiles, 3.8);
  assert.match(b.text, /结论 注意（Slime 4 格内）/);
  assertClean(b.text);
});

test('warn：5 格内有敌对弹幕', () => {
  const b = buildBrief(makeCtx({
    state: { p: makePlayer(), n: [], pr: [{ x: 1000, y: GROUND, w: 10, h: 10, ho: 1 }] },
  }));
  assert.equal(b.level, 'warn');
  assert.equal(b.data.projectiles, 1);
  assert.equal(b.data.threats.length, 0);
  assert.match(b.text, /威胁 附近没有敌人 · 弹幕 1/);
  assert.match(b.text, /结论 注意（弹幕 3 格内）/);
  assertClean(b.text);
});

test('Boss：单独一行，判 danger；威胁列表不重复算 Boss', () => {
  const boss = makeNpc({
    i: 9, ty: 50, nm: 'Eye of Cthulhu', x: 1280, bo: 1, lf: 1200, lm: 1400, dm: 0,
  });
  const b = buildBrief(makeCtx({
    state: {
      p: makePlayer(),
      n: [makeNpc(), boss],
      pr: [],
    },
    chatLog: [{ seq: 1, at: 1003, text: '<Jingbai> 它来了' }],
  }));
  assert.equal(b.level, 'danger');
  assert.equal(b.data.boss.type, 'Eye of Cthulhu');
  assert.equal(b.data.boss.life, 1200);
  assert.equal(b.data.boss.max, 1400);
  assert.equal(b.data.boss.distTiles, 20);
  assert.deepEqual(b.data.threats.map((t) => t.type), ['Slime']);
  assert.match(b.text, /Boss Eye of Cthulhu 1200\/1400 \(86%\) · 20 格外/);
  assert.match(b.text, /结论 危险（Boss Eye of Cthulhu）/);
  assert.ok(lineCount(b.text) <= 8, b.text);
  assertClean(b.text);
});

test('威胁按距离排序，data 最多 5 个，text 最多 3 个', () => {
  const npcs = [8, 9, 10, 11, 12, 13].map((tiles, i) => makeNpc({
    i: i + 1, ty: i + 1, nm: `Mob${i + 1}`, x: 960 + tiles * 16,
  }));
  const b = buildBrief(makeCtx({ state: { p: makePlayer(), n: npcs, pr: [] } }));
  assert.equal(b.data.threats.length, 5);
  assert.deepEqual(b.data.threats.map((t) => t.distTiles), [8, 9, 10, 11, 12]);
  assert.match(b.text, /Mob1 8 格/);
  assert.doesNotMatch(b.text, /Mob4/);
  assertClean(b.text);
});

test('瓦片：拿得到就写实体/空气，拿不到写 unknown', () => {
  const tileAt = (x, y) => {
    if (x === 60 && y === 38) return { type: 1, solid: true, platform: false, liquid: 0, liquidType: 0 };
    if (x === 60 && y === 35) return { type: 0, solid: false, platform: false, liquid: 0, liquidType: 0 };
    return null;
  };
  const b = buildBrief(makeCtx({
    state: { p: makePlayer(), n: [], pr: [] },
    tileAt,
  }));
  assert.deepEqual(b.data.tile, { under: 'solid', head: 'air' });
  assert.match(b.text, /脚下实体 · 地上/);
  assertClean(b.text);
});

test('未连接：没有 state 也不抛，输出「未连接」且没有脏字段', () => {
  const b = buildBrief(makeCtx({ connected: false }));
  assert.equal(b.level, 'safe');
  assert.equal(b.data.link, false);
  assert.equal(b.data.player, null);
  assert.equal(b.data.tile, null);
  assert.equal(b.data.boss, null);
  assert.deepEqual(b.data.threats, []);
  assert.equal(b.data.projectiles, 0);
  assert.match(b.text, /鲸白 · 未连接 · 组=idle/);
  assert.match(b.text, /世界坐标未知（未连接）/);
  assert.match(b.text, /结论 安全（未连接）/);
  assert.ok(lineCount(b.text) >= 3 && lineCount(b.text) <= 8, b.text);
  assertClean(b.text);
});

test('菜单中：不把菜单当成战场', () => {
  const b = buildBrief(makeCtx({ state: { menu: true, p: null, n: [], pr: [] } }));
  assert.equal(b.data.menu, true);
  assert.equal(b.level, 'safe');
  assert.match(b.text, /鲸白 · 菜单中 · 组=idle/);
  assert.match(b.text, /结论 安全（菜单中）/);
  assertClean(b.text);
});

test('已死亡：判 danger 并标注', () => {
  const b = buildBrief(makeCtx({
    state: { p: makePlayer({ hp: 0, dead: 1 }), n: [], pr: [] },
  }));
  assert.equal(b.level, 'danger');
  assert.match(b.text, /生命 0\/100（已死亡）/);
  assert.match(b.text, /结论 危险（已死亡）/);
  assertClean(b.text);
});
