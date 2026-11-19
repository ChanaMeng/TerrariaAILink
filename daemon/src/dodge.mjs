
const ACCEL = 0.08;
const GRAVITY = 0.4;
const MAX_FALL = 10;
const JUMP_V = -7.0;

const CANDIDATES = [
  { name: 'still', left: false, right: false, jump: false },
  { name: 'left', left: true, right: false, jump: false },
  { name: 'right', left: false, right: true, jump: false },
  { name: 'jumpLeft', left: true, right: false, jump: true },
  { name: 'jumpRight', left: false, right: true, jump: true },
  { name: 'jump', left: false, right: false, jump: true },
];

function rectDist(px, py, cx, cy, hw, hh) {
  const dx = Math.max(Math.abs(px - cx) - hw, 0);
  const dy = Math.max(Math.abs(py - cy) - hh, 0);
  return Math.hypot(dx, dy);
}

function simulate(p, keys, threats, horizon) {
  let x = p.x;
  let y = p.y;
  let vx = p.vx;
  let vy = p.vy;
  let grounded = !!p.grd;
  const hw = Math.max(8, p.w / 2 - 2);
  const hh = Math.max(12, p.h / 2 - 2);
  const homeY = p.y;
  let minD = Infinity;

  for (let t = 0; t < horizon; t++) {
    const dir = keys.left ? -1 : keys.right ? 1 : 0;
    if (dir) {
      const cap = Math.max(3, Math.abs(p.vx));
      vx += dir * ACCEL;
      if (vx > cap) vx = cap;
      if (vx < -cap) vx = -cap;
    } else if (grounded) {
      vx *= 0.8;
      if (Math.abs(vx) < 0.05) vx = 0;
    }
    if (keys.jump && grounded) {
      vy = JUMP_V;
      grounded = false;
    }
    vy += GRAVITY;
    if (vy > MAX_FALL) vy = MAX_FALL;
    x += vx;
    y += vy;


    for (const th of threats) {
      const tx = th.x + th.vx * t;
      const ty = th.y + th.vy * t;
      const d = rectDist(tx, ty, x, y, hw, hh) - th.r;
      if (d < minD) minD = d;
    }
    if (minD < -200) break;
  }
  return minD;
}

export function createDodge() {
  let held = null;
  let holdUntil = 0;
  let holdDir = null;

  return {
    apply(world, frame, opts = {}) {
      const p = world.p;
      if (!p || p.dead) return frame;
      const threats = world.threats(opts.radius ?? 560);
      if (!threats.length) return frame;

      const current = { left: !!frame.left, right: !!frame.right, jump: !!frame.jump };
      const now = Date.now();
      const horizon = opts.horizon ?? 36;

      const scoreOf = (c) => simulate(p, c, threats, horizon);
      const riskNow = scoreOf(current);


      let best = null;
      let bestScore = -Infinity;
      for (const c of CANDIDATES) {
        let s = scoreOf(c);
        if (c.left === current.left && c.right === current.right) s += 4;
        if (s > bestScore) { bestScore = s; best = c; }
      }

      if (bestScore > 90 && riskNow > 60) {
        held = null;
        holdDir = null;
        return frame;
      }

      if (held && now < holdUntil) {
        const kept = CANDIDATES.find((c) => c.name === held);
        if (kept && scoreOf(kept) > 20) {
          best = kept;
        }
      }
      held = best.name;
      holdUntil = now + 100;

      const out = { ...frame, left: false, right: false, jump: false };
      out.left = best.left;
      out.right = best.right;
      out.jump = best.jump || !!frame.jump;
      holdDir = best.name;
      return out;
    },
  };
}


