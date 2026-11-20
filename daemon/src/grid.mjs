// grid.mjs — 二维「能站 / 能走」栅格 + A* 寻路。
//
// 真机踩到的坑：
//   角色站在楼梯上（一行 1 格高的台阶），目标在右下方 3 格。
//   旧 gather / explore 只会「水平走 + 撞墙就跳」，结果在台阶边缘反复跳、8 秒 stuck。
//   Terraria 的 1 格台阶按方向键会自动抬上去，不需要 jump；乱跳反而盖掉了游戏自带的能力。
//
// 这一层只干两件事：
//   1. sync() 把 mod 推上来的瓦片块摊成 Map<"x,y", cell>，能回答「这格能不能站」；
//   2. findPath() 在这张图上跑 A*，只吐一串格子 —— 上层取 path[1] 当「下一格」，
//      执行层只按方向键，不自己发明走法。
//
// 坐标：全部是瓦片坐标 (tx, ty)；1 格 = 16px 的换算留给调用方（modes.mjs 里的 PX）。
// 站立约定：(tx, ty) 是「脚踩的那一格」，脚下 (tx, ty+1) 是地板。
//
// 数据来源只有 world.tiles（每格 5 字节：type LE16 / flags / liquid / liquidType，
// 和 world.tileAt 的解码方式、和 mod 端 BridgeServer.SendTiles 一致）。
// sync 不发网络请求；64×48 = 3072 格，由调用方按需调（目标变了 / 位移超过一格再调），
// 别每帧调。
//
// 未知格（没有块覆盖 / 块里解不出来）一律不能走 —— mine 模式已经踩过「null 当空气」的坑。

const TILE_BYTES = 5;            // 协议里每格 5 字节
const DEFAULT_MAX_CHUNKS = 40;   // 内部最多留 40 个块，超了按 s 淘汰最旧的
const DEFAULT_MAX_NODES = 4000;  // A* 单次展开上限：超了返回 null，别卡 tick
const DEFAULT_MAX_FALL = 4;      // 一次最多往下掉 4 格
const WALK_COST = 1;             // 水平走 1 格 / 上下 1 格台阶 / 下落 1 格
const JUMP_COST = 3;             // 跳 2~3 格高
const MAX_JUMP = 3;              // 跳的上限（格）

/** 工厂：和 modes/gather 一样只接收一个 options，内部持有状态。 */
export function createGrid(options = {}) {
  return new WalkGrid(options);
}

class WalkGrid {
  constructor(options = {}) {
    this.maxChunks = Math.max(1, Math.trunc(options.maxChunks ?? DEFAULT_MAX_CHUNKS));
    this.maxNodes = Math.max(1, Math.trunc(options.maxNodes ?? DEFAULT_MAX_NODES));
    this.maxFall = Math.max(1, Math.trunc(options.maxFall ?? DEFAULT_MAX_FALL));
    /** 合并后的格子表：'x,y' → { solid, platform, liquid, type } */
    this.cells = new Map();
    /** 已经吃进来的瓦片块：块 key → { key, x, y, w, h, s, at }，按 s 淘汰 */
    this.chunks = new Map();
    this.droppedCells = 0;   // 淘汰掉的格子数（只留着看，不进 stats 契约）
    this.syncCount = 0;
  }

  // -------------------------------------------------------------------------
  // 栅格刷新
  // -------------------------------------------------------------------------

  /**
   * 从 world.tiles 刷新内部栅格。只读缓存，不发请求。
   * 块按 s（world 的接收序号）升序写入，这样重叠区域是「最新的块胜出」，
   * 语义和 world.tileAt 一致。
   */
  sync(world) {
    const tiles = world?.tiles;
    if (!tiles || typeof tiles.values !== 'function') return this.stats();

    const blocks = [];
    for (const t of tiles.values()) {
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
      if (!Number.isFinite(t.w) || !Number.isFinite(t.h)) continue;
      if (t.w <= 0 || t.h <= 0) continue;
      blocks.push(t);
    }
    blocks.sort((a, b) => (a.s ?? 0) - (b.s ?? 0));

    let ingested = 0;
    for (const t of blocks) {
      const key = `${t.x},${t.y},${t.w},${t.h}`;
      const seen = this.chunks.get(key);
      // 同一份快照（s 没变）已经吃过了，跳过：别每次 sync 都把 3072 格重解一遍。
      if (seen && seen.s >= (t.s ?? 0)) continue;
      if (this._ingest(world, t)) ingested += 1;
    }

    if (ingested > 0) this.syncCount += 1;
    this._evict();
    return this.stats();
  }

  /** 吃一个瓦片块。返回 false = 这块根本解不出来（不记账，下次 sync 还能再试）。 */
  _ingest(world, block) {
    const x0 = Math.trunc(block.x);
    const y0 = Math.trunc(block.y);
    const w = Math.trunc(block.w);
    const h = Math.trunc(block.h);
    if (w <= 0 || h <= 0) return false;

    const key = `${x0},${y0},${w},${h}`;
    const data = block.data;
    const need = w * h * TILE_BYTES;

    if (data && typeof data !== 'string' && typeof data.length === 'number' && data.length >= need) {
      // 正常路径：自己按协议解（64×48 一趟 15360 字节），比逐格 world.tileAt 快得多。
      for (let row = 0; row < h; row++) {
        const ty = y0 + row;
        for (let col = 0; col < w; col++) {
          const i = (row * w + col) * TILE_BYTES;
          const flags = data[i + 2];
          this.cells.set(`${x0 + col},${ty}`, {
            type: data[i] | (data[i + 1] << 8),
            solid: (flags & 1) !== 0,
            platform: (flags & 2) !== 0,
            liquid: data[i + 3],
          });
        }
      }
    } else if (typeof world?.tileAt === 'function') {
      // 数据长度不对（协议改了 / 半包）：退回逐格调 tileAt，慢但不会写错格子。
      let any = false;
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const tx = x0 + col;
          const ty = y0 + row;
          const t = world.tileAt(tx, ty);
          if (!t) continue;
          any = true;
          this.cells.set(`${tx},${ty}`, {
            type: Number(t.type) || 0,
            solid: !!t.solid,
            platform: !!t.platform,
            liquid: Number(t.liquid) || 0,
          });
        }
      }
      if (!any) return false;   // 一格都没解出来：别把「全是未知」写成「全是空气」
    } else {
      return false;
    }

    this.chunks.set(key, { key, x: x0, y: y0, w, h, s: block.s ?? 0, at: Date.now() });
    return true;
  }

  /** 块数 > maxChunks：按 s 删最旧的；它独占的格子一起删（被新块覆盖的留着）。 */
  _evict() {
    while (this.chunks.size > this.maxChunks) {
      let oldest = null;
      for (const c of this.chunks.values()) {
        if (!oldest || c.s < oldest.s) oldest = c;
      }
      if (!oldest) break;
      this.chunks.delete(oldest.key);
      for (let row = 0; row < oldest.h; row++) {
        for (let col = 0; col < oldest.w; col++) {
          const x = oldest.x + col;
          const y = oldest.y + row;
          if (this._coveredByNewer(x, y, oldest.s)) continue;
          this.cells.delete(`${x},${y}`);
          this.droppedCells += 1;
        }
      }
    }
  }

  /** (x,y) 有没有被比 s 更新的块覆盖（决定淘汰旧块时这格该不该删）。 */
  _coveredByNewer(x, y, s) {
    for (const c of this.chunks.values()) {
      if (c.s <= s) continue;
      if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /** 原始格子（内部对象，别改）：{ solid, platform, liquid, type } | null。 */
  _raw(tx, ty) {
    return this.cells.get(`${tx},${ty}`) ?? null;
  }

  /** 对外查询：返回副本，调用方改了也不影响栅格。null = 未知（不是空气）。 */
  cell(tx, ty) {
    const c = this._raw(Math.trunc(Number(tx)), Math.trunc(Number(ty)));
    if (!c) return null;
    return { solid: c.solid, platform: c.platform, liquid: c.liquid, type: c.type };
  }

  /** 脚下这格能不能当踏板：(tx,ty) 是 solid 或 platform。未知 = false。 */
  foot(tx, ty) {
    const c = this._raw(tx, ty);
    return !!c && (c.solid || c.platform);
  }

  /** 空且已知 = 能穿过（跳 / 下落的中途格用）。未知不算能穿。 */
  _open(tx, ty) {
    const c = this._raw(tx, ty);
    return !!c && !c.solid;
  }

  /**
   * (tx,ty) 能不能站人。
   *   1. (tx,ty) 必须是空的（未知不行）；
   *   2. 脚下 (tx,ty+1) 是 solid / platform（这就是 foot）；
   *   3. 头顶 (tx,ty-1) 未知不行；实心只放行「1 格台阶的立面」——
   *      头顶那一格再往上是空的，说明这是矮台的边沿，游戏按方向键会把人自动抬上去
   *      （或者只用一小步跳）。整列都实心（1 格高的爬行洞）不放行：钻进去只会卡死。
   */
  standable(tx, ty) {
    const body = this._raw(tx, ty);
    if (!body || body.solid) return false;

    const foot = this._raw(tx, ty + 1);
    if (!foot || !(foot.solid || foot.platform)) return false;

    const head = this._raw(tx, ty - 1);
    if (!head) return false;              // 未知不能当空气
    if (!head.solid) return true;

    const above = this._raw(tx, ty - 2);  // 台阶立面上面得是空的
    return !!above && !above.solid;
  }

  // -------------------------------------------------------------------------
  // 寻路
  // -------------------------------------------------------------------------

  /**
   * A* 找一条从 (sx,sy) 到 (tx,ty) 的格子路径。
   *
   * 返回 [{x,y}, ...]：**含起点、含终点**；起点即终点时只有一格。
   * 找不到 / 超 maxNodes → null。
   *
   * opts:
   *   jump      默认 true；false = 不给 2~3 格高的跳（1 格台阶不算跳，永远能走）
   *   maxNodes  默认 4000（构造时可改）
   *   maxFall   默认 4（构造时可改）
   */
  findPath(sx, sy, tx, ty, opts = {}) {
    const start = { x: Math.trunc(Number(sx)), y: Math.trunc(Number(sy)) };
    const goal = { x: Math.trunc(Number(tx)), y: Math.trunc(Number(ty)) };
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) return null;
    if (!Number.isFinite(goal.x) || !Number.isFinite(goal.y)) return null;

    const startCell = this._raw(start.x, start.y);
    if (!startCell || startCell.solid) return null;   // 起点未知 / 在墙里
    // 约定：起点即终点 → 返回只含起点的一格路径（不是空数组）。
    if (start.x === goal.x && start.y === goal.y) return [{ x: start.x, y: start.y }];

    if (!this.standable(goal.x, goal.y)) return null;  // 站不住的格子不是「走到」的目标

    const jump = opts.jump !== false;
    const maxFall = Math.max(1, Math.trunc(opts.maxFall ?? this.maxFall));
    const maxNodes = Math.max(1, Math.trunc(opts.maxNodes ?? this.maxNodes));

    const gScore = new Map();
    const parent = new Map();
    const closed = new Set();
    const open = new MinHeap();
    const key = (x, y) => `${x},${y}`;
    // 启发式必须可采纳（不能高估），否则 A* 会给出「能到但不是最短」的路：
    //   - 每走一步横向最多 1 格、代价 ≥1 → 至少还要 |dx|；
    //   - 往上爬：台阶 1 格 1 代价、跳 3 格 3 代价，都是「一格一代价」→ 至少还要上升的格数；
    //   - 往下掉便宜（4 格只要 1 代价），所以不能拿 |dy| 当估计。
    // 取两者的较大值。
    const est = (x, y) => {
      const dx = Math.abs(x - goal.x);
      const up = y > goal.y ? y - goal.y : 0;
      return dx > up ? dx : up;
    };

    const startKey = key(start.x, start.y);
    gScore.set(startKey, 0);
    open.push({ x: start.x, y: start.y, f: est(start.x, start.y) });

    let nodes = 0;
    while (open.size > 0) {
      const cur = open.pop();
      const curKey = key(cur.x, cur.y);
      if (closed.has(curKey)) continue;
      closed.add(curKey);

      nodes += 1;
      if (nodes > maxNodes) return null;   // 上限：宁可放弃，也别卡住 tick
      if (cur.x === goal.x && cur.y === goal.y) {
        return this._trace(parent, start, goal);
      }

      const g = gScore.get(curKey) ?? Infinity;
      for (const step of this._steps(cur.x, cur.y, jump, maxFall)) {
        const sk = key(step.x, step.y);
        if (closed.has(sk)) continue;
        const ng = g + step.cost;
        if (ng >= (gScore.get(sk) ?? Infinity)) continue;
        gScore.set(sk, ng);
        parent.set(sk, { x: cur.x, y: cur.y });
        open.push({ x: step.x, y: step.y, f: ng + est(step.x, step.y) });
      }
    }
    return null;
  }

  /**
   * 邻域：只有水平 ±1，**不斜走**。
   *   1. 同层走一格（目标 standable）                      代价 1
   *   2. 上 1 格台阶（自动抬，不需要 jump）                代价 1
   *   3. 下落 1~4 格（中途每格都能穿过，落点 standable）   代价 1
   *   4. 跳 2~3 格高（opts.jump !== false）                代价 3
   */
  *_steps(x, y, jump, maxFall) {
    for (const dx of [-1, 1]) {
      const nx = x + dx;

      // 1) 同层
      if (this.standable(nx, y)) yield { x: nx, y, cost: WALK_COST, kind: 'walk' };

      // 2) 上 1 格台阶：Terraria 按方向键会自己抬上去，代价和走路一样
      if (this.standable(nx, y - 1)) yield { x: nx, y: y - 1, cost: WALK_COST, kind: 'step' };

      // 3) 下落：中途格必须都能穿过（未知也不行），落地格要 standable
      for (let d = 1; d <= maxFall; d++) {
        if (!this._open(nx, y + d - 1)) break;   // 这一格挡着，更下面的落点也去不了
        const ny = y + d;
        if (this.standable(nx, ny)) {
          yield { x: nx, y: ny, cost: WALK_COST, kind: 'fall' };
          break;   // 落到这块地板就停，再往下是别的节点的事
        }
      }

      // 4) 跳 2~3 格高：看「当前这一列」的头顶够不够升空（人先起来再横移）；
      //    目标列的下一格是不是实心不重要 —— 那正是要跳上去的台沿。
      if (jump) {
        for (let hh = 2; hh <= MAX_JUMP; hh++) {
          if (!this._open(x, y - hh + 1)) break;   // 头顶被堵，跳不了这么高
          if (!this._open(x, y - hh)) break;
          if (this.standable(nx, y - hh)) {
            yield { x: nx, y: y - hh, cost: JUMP_COST, kind: 'jump' };
          }
        }
      }
    }
  }

  /** 从 parent 表倒出路径（含起点、含终点）。 */
  _trace(parent, start, goal) {
    const out = [];
    let cur = { x: goal.x, y: goal.y };
    for (;;) {
      out.push({ x: cur.x, y: cur.y });
      if (cur.x === start.x && cur.y === start.y) break;
      const p = parent.get(`${cur.x},${cur.y}`);
      if (!p) break;   // 理论上不会发生；真发生了就给半条路，别死循环
      cur = p;
    }
    return out.reverse();
  }

  // -------------------------------------------------------------------------
  // 统计
  // -------------------------------------------------------------------------

  /** { cells, chunks, oldestChunkMs }：oldestChunkMs 是最旧那个块收进来的毫秒数。 */
  stats() {
    const now = Date.now();
    let oldest = 0;
    for (const c of this.chunks.values()) {
      const age = now - c.at;
      if (age > oldest) oldest = age;
    }
    return {
      cells: this.cells.size,
      chunks: this.chunks.size,
      oldestChunkMs: oldest,
    };
  }
}

/** 二叉小顶堆：A* 的 open 表。4000 个节点的量级，够用就行。 */
class MinHeap {
  constructor() {
    this.a = [];
  }

  get size() {
    return this.a.length;
  }

  push(node) {
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}
