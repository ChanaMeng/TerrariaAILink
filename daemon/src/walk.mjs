// walk.mjs — 把 grid 的 A* 路径翻译成「这一帧按哪个方向」。
//
// 分层：grid 说「从 A 到 B 走哪几格」，这里只负责「下一格在右边就按右」。
// 1 格台阶不按跳：Terraria 自己会抬上去；只有下一格明显更高才补跳。
//
// 目标格通常不能站（树、矿、要放方块的位置），所以先用 standNear 找旁边能站的格。

import { neutral } from './proto.mjs';

const PX = 16;

/** 玩家脚所在的格（p.y 是中心，脚在 p.y + h/2）。 */
export function feetOf(p) {
  const h = Number.isFinite(p?.h) ? p.h : 42;
  return {
    x: Math.floor(p.x / PX),
    y: Math.floor((p.y + h / 2 + 2) / PX),
  };
}

/** 在目标附近找一个能站的格（越近越好，不允许斜着找太远）。 */
export function standNear(grid, tx, ty, radius = 3) {
  if (!grid) return { x: tx, y: ty };
  if (grid.standable?.(tx, ty)) return { x: tx, y: ty };
  let best = null;
  let bestD = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!grid.standable?.(x, y)) continue;
      const d = Math.abs(dx) + Math.abs(dy);
      if (d < bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best ?? { x: tx, y: ty };
}

export function createWalker(ctx) {
  let path = null;
  let pathKey = '';
  let pathAt = 0;
  let gridAt = 0;

  return {
    /** 朝 (tx,ty) 走；返回这一帧的输入，没有路时返回 null。 */
    to(p, tx, ty, opts = {}) {
      if (!ctx.grid || !p) return null;
      const now = Date.now();

      // 地图按需刷新，别每帧 sync（sync 读的是瓦片快照）
      if (now - gridAt > (opts.gridMs ?? 400)) {
        try { ctx.grid.sync(ctx.world); } catch { /* 没数据就继续用旧图 */ }
        gridAt = now;
      }

      const feet = feetOf(p);
      const key = `${feet.x},${feet.y}>${tx},${ty}`;
      if (!path || key !== pathKey || now - pathAt > (opts.repathMs ?? 1500)) {
        try {
          path = ctx.grid.findPath(feet.x, feet.y, tx, ty, opts);
        } catch {
          path = null;
        }
        pathKey = key;
        pathAt = now;
      }

      // 没路：退化成「水平朝目标走」，至少别站着不动
      if (!path || path.length < 2) {
        const fr = neutral();
        const dx = tx * PX + 8 - p.x;
        if (Math.abs(dx) > 6) fr[dx > 0 ? 'right' : 'left'] = true;
        return fr;
      }

      // 玩家可能已经偏离路径：找路径里离脚最近的一格，从它的下一格走
      let idx = 0;
      let bestD = Infinity;
      for (let i = 0; i < path.length; i++) {
        const d = Math.abs(path[i].x - feet.x) + Math.abs(path[i].y - feet.y);
        if (d < bestD) { bestD = d; idx = i; }
      }
      const next = path[Math.min(idx + 1, path.length - 1)];

      const fr = neutral();
      const dx = next.x * PX + 8 - p.x;
      if (Math.abs(dx) > 4) fr[dx > 0 ? 'right' : 'left'] = true;
      // 下一格明显更高才跳；1 格台阶交给游戏自己抬
      if (next.y < feet.y - 0.35) fr.jump = true;
      return fr;
    },

    /** 路径是否已经到终点附近。 */
    arrived(p, tx, ty, tolTiles = 1.5) {
      const feet = feetOf(p);
      return Math.abs(feet.x - tx) <= tolTiles && Math.abs(feet.y - ty) <= 2;
    },

    status() {
      return { path: path?.length ?? 0, key: pathKey, ageMs: pathAt ? Date.now() - pathAt : null };
    },
  };
}
