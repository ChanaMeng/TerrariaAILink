// grid.test.mjs — 二维栅格 + A* 寻路的单测。
//
// 假 world 的搭法（参考 modes.test.mjs）：
//   - 用真的 World，喂真的 'tiles' 消息，让 grid.sync 走真实的解码路径；
//   - 再按题目要求用 Map 覆盖 world.tileAt（返回 null = 这一格没有数据 = 未知）。
// 「未知格」是靠**不发那块数据**造出来的，不是靠空气补位：
// 一个瓦片块覆盖整块矩形，块里的空格子解出来是空气（type 0），不是未知。
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.mjs';
import { createGrid } from '../src/grid.mjs';

const TILE_BYTES = 5;

// 图例：'.' 空气、'#' 实心、'=' 平台
const LEGEND = {
  '.': { type: 0, solid: false, platform: false, liquid: 0 },
  '#': { type: 1, solid: true, platform: false, liquid: 0 },
  '=': { type: 19, solid: false, platform: true, liquid: 0 },
};

/** 把 ASCII 地图编码成 mod 协议里的瓦片块（每格 5 字节，和 BridgeServer.SendTiles 一致）。 */
function encodeBlock(rows, x = 0, y = 0) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const buf = Buffer.alloc(w * h * TILE_BYTES);
  const cells = new Map();
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const ch = rows[row][col] ?? '.';
      const t = LEGEND[ch];
      assert.ok(t, `图例里没有这个字符: ${ch}`);
      const i = (row * w + col) * TILE_BYTES;
      buf[i] = t.type & 0xff;
      buf[i + 1] = (t.type >> 8) & 0xff;
      buf[i + 2] = (t.solid ? 1 : 0) | (t.platform ? 2 : 0);
      buf[i + 3] = t.liquid;
      buf[i + 4] = 0;
      cells.set(`${x + col},${y + row}`, {
        type: t.type,
        solid: t.solid,
        platform: t.platform,
        liquid: t.liquid,
      });
    }
  }
  const msg = { t: 'tiles', x, y, w, h, d: buf.toString('base64') };
  return { msg, cells };
}

/** 假 world：多块瓦片 + 用 Map 覆盖的 tileAt（顺手数一下有没有人调它）。 */
function makeWorld(blocks) {
  const world = new World();
  const cells = new Map();
  for (const b of blocks) {
    const { msg, cells: c } = encodeBlock(b.rows, b.x ?? 0, b.y ?? 0);
    world.onMessage(msg);
    for (const [k, v] of c) cells.set(k, v);
  }
  const calls = { n: 0 };
  world.tileAt = (tx, ty) => {
    calls.n += 1;
    return cells.get(`${tx},${ty}`) ?? null;
  };
  return { world, cells, calls };
}

/** 只画一块地图的简写：gridFrom(['..'], ...)。 */
function gridFrom(blocks, options = {}) {
  const h = makeWorld(blocks);
  const grid = createGrid(options);
  grid.sync(h.world);
  return { grid, ...h };
}

function gridFor(rows, options = {}) {
  return gridFrom([{ rows, x: options.x ?? 0, y: options.y ?? 0 }], options.grid ?? {});
}

// ---------------------------------------------------------------------------
// 栅格 / sync
// ---------------------------------------------------------------------------

test('sync 从 world.tiles 解码，且一格都不调 world.tileAt', () => {
  const { grid, calls } = gridFor(['.....', '.....', '#####']);
  assert.equal(calls.n, 0, 'sync 不该逐格调 world.tileAt');
  assert.deepEqual(grid.cell(1, 2), { solid: true, platform: false, liquid: 0, type: 1 });
  assert.deepEqual(grid.cell(1, 1), { solid: false, platform: false, liquid: 0, type: 0 });
  assert.equal(grid.cell(9, 9), null, '没有块覆盖 = 未知，不是空气');

  const s = grid.stats();
  assert.equal(s.cells, 15);
  assert.equal(s.chunks, 1);
  assert.ok(Number.isFinite(s.oldestChunkMs) && s.oldestChunkMs >= 0);
});

test('stats()：空栅格是 0 / 0 / 0', () => {
  assert.deepEqual(createGrid().stats(), { cells: 0, chunks: 0, oldestChunkMs: 0 });
});

test('standable：脚下实心、身体和头顶是空才算', () => {
  const { grid } = gridFor(['.....', '.....', '#####']);
  assert.equal(grid.standable(2, 1), true);
  assert.equal(grid.standable(2, 2), false, '实心格不能站');
  assert.equal(grid.standable(2, 0), false, '脚下是空气 → 站不住');
  assert.equal(grid.standable(9, 9), false, '未知格不能站');
});

test('平台算踏板', () => {
  const { grid } = gridFor(['...', '...', '===']);
  assert.deepEqual(grid.cell(1, 2), { solid: false, platform: true, liquid: 0, type: 19 });
  assert.equal(grid.standable(1, 1), true);
  assert.deepEqual(grid.findPath(0, 1, 2, 1), [
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
  ]);
});

test('头顶 1 格实心但再往上是空 = 台阶立面，能站；整列实心（爬行洞）不能站', () => {
  const lip = gridFor(['.....', '..#..', '.....', '#####']);
  assert.equal(lip.grid.standable(2, 2), true, '矮台边沿：头顶一格实心、再往上空 → 可站');

  const hole = gridFor(['#####', '#####', '.....', '#####']);
  assert.equal(hole.grid.standable(2, 2), false, '1 格高的爬行洞：钻进去只会卡死');
});

test('未知头顶：脚下有地板也不能站（不能假设头顶是空气）', () => {
  // 只发 y=1 / y=2 两行，y=0 没有数据 → 头顶未知
  const { grid, world } = gridFrom([{ rows: ['....', '####'], x: 0, y: 1 }]);
  assert.equal(grid.cell(1, 0), null);
  assert.equal(grid.foot(1, 2), true, '脚下是有地板的');
  assert.equal(grid.standable(1, 1), false, '头顶未知 → 不敢站');

  // 补一块空气盖住头顶，就变成可站（顺便测增量 sync）
  world.onMessage(encodeBlock(['....'], 0, 0).msg);
  grid.sync(world);
  assert.equal(grid.standable(1, 1), true);
});

test('sync 幂等：同一批块再 sync 不会重复解', () => {
  const { grid, world } = gridFor(['....', '####']);
  const before = grid.stats();
  grid.sync(world);
  grid.sync(world);
  const after = grid.stats();
  assert.equal(after.cells, before.cells);
  assert.equal(after.chunks, before.chunks);
});

test('同一块区域收到新快照：s 大的胜出（和 world.tileAt 一致）', () => {
  const world = new World();
  world.onMessage(encodeBlock(['###'], 0, 0).msg);   // s=1：实心
  world.onMessage(encodeBlock(['...'], 0, 0).msg);   // s=2：空气
  const grid = createGrid();
  grid.sync(world);
  assert.equal(grid.cell(1, 0).solid, false);
  assert.equal(grid.cell(1, 0).type, 0);
  assert.equal(grid.stats().chunks, 1, '同一个 rect 只留一条块记录');
});

test('块数 > 40：按 s 淘汰最旧的块和它的格子', () => {
  const world = new World();
  for (let i = 0; i < 41; i++) world.onMessage(encodeBlock(['#'], 0, i).msg);
  const grid = createGrid();
  grid.sync(world);

  const s = grid.stats();
  assert.equal(s.chunks, 40, '内部只留 40 个块');
  assert.equal(s.cells, 40);
  assert.equal(grid.cell(0, 0), null, 's 最小的第 1 个块被淘汰了');
  assert.deepEqual(grid.cell(0, 40), { solid: true, platform: false, liquid: 0, type: 1 });
});

// ---------------------------------------------------------------------------
// 寻路
// ---------------------------------------------------------------------------

test('平地：走到 5 格外的目标是直线，一格不多', () => {
  const { grid } = gridFor(['.....', '.....', '#####']);
  assert.deepEqual(grid.findPath(0, 1, 4, 1), [
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 },
  ]);
});

test('1 格台阶：按方向键自动抬，路径里不需要 jump', () => {
  // 低地地板在 y=3（x=0..2），高地地板在 y=2（x=3..5）
  const { grid } = gridFor(['......', '......', '...###', '###...']);
  const withJump = grid.findPath(0, 2, 5, 1);
  const noJump = grid.findPath(0, 2, 5, 1, { jump: false });

  const expected = [
    { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
    { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 },
  ];
  assert.deepEqual(withJump, expected);
  assert.deepEqual(noJump, withJump, '关掉 jump 还是同一条路 → 这级台阶没用到跳');
  for (let i = 1; i < withJump.length; i++) {
    const dy = withJump[i].y - withJump[i - 1].y;
    assert.ok(Math.abs(dy) <= 1, `第 ${i} 步不该跳 ${dy} 格`);
  }
  assert.ok(
    withJump.some((c, i) => i > 0 && c.y === withJump[i - 1].y - 1),
    '路径里要有抬上一格的那一步',
  );
});

test('2 格墙：jump:false 过不去，opts.jump:true 给一条跳上去的路', () => {
  const { grid } = gridFor(['......', '......', '...###', '...###', '######']);
  assert.equal(grid.findPath(0, 3, 5, 1, { jump: false }), null, '不许跳时绕不过去');

  const path = grid.findPath(0, 3, 5, 1);
  assert.ok(path, '允许跳时应该有路');
  assert.deepEqual(path, [
    { x: 0, y: 3 }, { x: 1, y: 3 }, { x: 2, y: 3 },
    { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 1 },
  ]);
});

test('下落：目标在下方 4 格、中间是空的 → 沿下落走，不用 jump', () => {
  // x=0..4 有地板 y=2，x=5 是个 4 格深的洞，底下 y=6 有地板
  const { grid } = gridFor(['......', '......', '#####.', '......', '......', '......', '######']);
  const expected = [{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 5 }, { x: 4, y: 5 }];

  assert.deepEqual(grid.findPath(2, 1, 4, 5), expected);
  assert.deepEqual(grid.findPath(2, 1, 4, 5, { jump: false }), expected, '下落不需要跳');
  assert.equal(grid.findPath(2, 1, 4, 5, { maxFall: 3 }), null, 'maxFall 压到 3 就落不下去');
});

test('未知格：cell 是 null、不能站、也不能被当成空气走过去', () => {
  // x=3 那一列没有任何块覆盖 → 全列未知，把左右两边隔开
  const { grid } = gridFrom([
    { rows: ['...', '...', '###'], x: 0, y: 0 },
    { rows: ['...', '...', '###'], x: 4, y: 0 },
  ]);
  assert.equal(grid.cell(3, 1), null);
  assert.equal(grid.standable(2, 1), true);
  assert.equal(grid.standable(3, 1), false, '未知格不能站');
  assert.deepEqual(grid.findPath(0, 1, 2, 1), [
    { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
  ], '左边自己能走');
  assert.equal(grid.findPath(0, 1, 6, 1), null, '一旦要跨过未知列就没路，不能说「大概是空气」');
});

test('maxNodes 超限：返回 null，不抛、不卡住', () => {
  const w = 100;
  const { grid } = gridFor(['.'.repeat(w), '.'.repeat(w), '#'.repeat(w)]);
  assert.equal(grid.findPath(0, 1, w - 1, 1, { maxNodes: 10 }), null);

  const full = grid.findPath(0, 1, w - 1, 1);   // 默认 4000，够用
  assert.equal(full.length, w);
  assert.equal(full[0].x, 0);
  assert.equal(full[full.length - 1].x, w - 1);

  assert.doesNotThrow(() => grid.findPath(0, 1, w - 1, 1, { maxNodes: 0 }));
});

test('起点即终点：返回只有一格 [{x,y}]（约定不是空数组）', () => {
  const { grid } = gridFor(['...', '...', '###']);
  assert.deepEqual(grid.findPath(2, 1, 2, 1), [{ x: 2, y: 1 }]);
});

test('目标不是能站的格子（墙里 / 未知）→ null', () => {
  const { grid } = gridFor(['...', '...', '###']);
  assert.equal(grid.findPath(0, 1, 1, 2), null, '实心的地板格不能当目标');
  assert.equal(grid.findPath(0, 1, 50, 1), null, '未知格不能当目标');
  assert.equal(grid.findPath(0, 1, 1, 0), null, '悬空的格子不能当目标');
});
