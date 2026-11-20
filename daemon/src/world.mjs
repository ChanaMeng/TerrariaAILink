export class World {
  constructor() {
    this.state = null;
    this.at = 0;
    this.tiles = new Map();
    this.lastTick = 0;
  }

  onMessage(msg) {
    if (msg.t === 'state') {
      this.state = msg;
      this.at = Date.now();
      this.lastTick = msg.tick ?? this.lastTick;
    } else if (msg.t === 'tiles') {
      const key = `${msg.x},${msg.y},${msg.w},${msg.h}`;
      this.seq = (this.seq || 0) + 1;
      this.tiles.set(key, { x: msg.x, y: msg.y, w: msg.w, h: msg.h, s: this.seq, data: Buffer.from(msg.d, 'base64') });
    }
  }

  get p() { return this.state?.p ?? null; }
  get tick() { return this.state?.tick ?? 0; }
  stale(ms = 500) { return Date.now() - this.at > ms; }

  npc(id) {
    return (this.state?.n ?? []).find((n) => n.i === id) ?? null;
  }

  hostiles(maxTiles = 90) {
    const p = this.p;
    if (!p) return [];
    const lim = maxTiles * 16;
    return (this.state?.n ?? []).filter((n) => !n.fr && n.lf > 0 && (n.dm ?? 0) > 0 && Math.hypot(n.x - p.x, n.y - p.y) <= lim);
  }

  nearestHostile(maxTiles = 90) {
    const p = this.p;
    let best = null;
    let bestD = Infinity;
    for (const n of this.hostiles(maxTiles)) {
      const d = Math.hypot(n.x - p.x, n.y - p.y) - (n.bo ? 400 : 0);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  boss() {
    return (this.state?.n ?? []).find((n) => n.bo && n.lf > 0) ?? null;
  }

  threats(radiusPx = 560) {
    const p = this.p;
    if (!p) return [];
    const out = [];
    const r2 = radiusPx * radiusPx;
    for (const pr of this.state?.pr ?? []) {
      if (!pr.ho) continue;
      const dx = pr.x - p.x, dy = pr.y - p.y;
      if (dx * dx + dy * dy > r2) continue;
      out.push({ x: pr.x, y: pr.y, vx: pr.vx * (pr.eu + 1), vy: pr.vy * (pr.eu + 1), r: Math.max(8, pr.w / 2) });
    }
    for (const n of this.state?.n ?? []) {
      if (n.fr || n.lf <= 0 || (n.dm ?? 0) <= 0) continue;
      // 普通怪不归闪避层管：闪避只躲弹幕和 Boss 的冲刺。
      // 近战怪交给战斗组走位——否则贴脸时闪避会把 left/right 清零，站着挨打。
      if (!n.bo) continue;
      const dx = n.x - p.x, dy = n.y - p.y;
      const contact = n.bo ? 90 : 45;
      if (dx * dx + dy * dy > contact * contact) continue;
      out.push({ x: n.x, y: n.y, vx: n.vx, vy: n.vy, r: Math.max(n.w, n.h) / 2 });
    }
    return out;
  }

  tileAt(tx, ty) {
    let best = null;
    for (const t of this.tiles.values()) {
      if (tx < t.x || ty < t.y || tx >= t.x + t.w || ty >= t.y + t.h) continue;
      if (!best || (t.s ?? 0) > (best.s ?? 0)) best = t;
    }
    if (!best) return null;
    const t = best;
    const i = ((ty - t.y) * t.w + (tx - t.x)) * 5;
    const type = t.data[i] | (t.data[i + 1] << 8);
    const flags = t.data[i + 2];
    return { type, solid: !!(flags & 1), platform: !!(flags & 2), liquid: t.data[i + 3], liquidType: t.data[i + 4] };
  }
}


