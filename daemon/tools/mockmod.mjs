
const PORT = 17890;
const GROUND = 600;
let tick = 0;
let input = null;
let recFrames = null;

const p = {
  nm: 'Player', x: 960, y: GROUND, vx: 0, vy: 0, w: 20, h: 42,
  hp: 100, mhp: 100, mp: 20, mmp: 20, air: 200, amax: 200, grd: 1, dir: 1,
  sl: 0, dead: 0, resp: 0, wing: 0, dash: 0, mnt: -1, use: 0,
  it: { ty: 0, nm: 'Iron Pickaxe', ut: 12, ua: 20, ar: 1, dm: 5, ss: 0, sh: 0, me: 1, rg: 0, mg: 0, sm: 0, pk: 40, ax: 0, hm: 0, am: 0, mc: 0, ch: 0, us: 1 },
};

const npcs = [
  { i: 1, ty: 1, x: 1200, y: GROUND, vx: -0.3, vy: 0, w: 32, h: 24, lf: 40, lm: 40, bo: 0, fr: 0, dm: 7, ai: 1, rl: -1, a: [0, 0, 0, 0], nm: 'Slime' },
];
const projs = [];

setInterval(() => {
  tick++;
  if (input) {
    const acc = 0.08;
    if (input.l) { p.vx -= acc; p.dir = -1; }
    if (input.r) { p.vx += acc; p.dir = 1; }
    if (!input.l && !input.r && p.grd) p.vx *= 0.8;
    p.vx = Math.max(-4, Math.min(4, p.vx));
    if (input.j && p.grd) { p.vy = -7; p.grd = 0; }
  }
  p.vy += 0.4;
  if (p.vy > 10) p.vy = 10;
  p.x += p.vx;
  p.y += p.vy;
  if (p.y >= GROUND) { p.y = GROUND; p.vy = 0; p.grd = 1; } else p.grd = 0;

  s.vx = Math.abs(s.x - p.x) > 24 ? Math.sign(p.x - s.x) * 0.6 : 0;
  s.x += s.vx;
  s.y = GROUND;

  if (tick % 150 === 0) projs.push({ i: projs.length + 1, ty: 1, x: p.x + 260, y: p.y - 30, vx: -4, vy: 0, w: 10, h: 10, dm: 10, ho: 1, ow: 255, eu: 0, ai: 0 });
  for (const pr of projs) { pr.x += pr.vx; pr.y += pr.vy; }
  for (let i = projs.length - 1; i >= 0; i--) if (Math.abs(projs[i].x - p.x) > 700) projs.splice(i, 1);

  if (recFrames) recFrames.push([0, 0, 0, 0, 0, 0, 0, p.sl, 0, 0]);

  const state = {
    t: 'state', tick, tm: 1000, day: 1, bm: 0, ec: 0, hm: 0, iv: 0, mx: 8400, my: 2400,
    rec: recFrames ? 1 : 0, rep: 0,
    p,
    bf: [],
    n: npcs,
    pr: projs,
    dr: [],
    hb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  if (tick % 30 === 0) state.in = state.hb;
  send(state);
}, 16);

const server = net.createServer((sock) => {
  console.log('[mock] client connected');
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.t === 'in') input = { ...m, at: tick };
      else if (m.t === 'hello') sock.write(JSON.stringify({ t: 'hello', mod: 'MockMod', v: 1, port: PORT, world: 'MockWorld' }) + '\n');
      else if (m.t === 'cmd') {
        if (m.op === 'say') console.log('[mock] player says:', m.text);
        if (m.op === 'record') {
          if (m.on) recFrames = [];
          else if (recFrames) { sock.write(JSON.stringify({ t: 'record', frames: recFrames }) + '\n'); recFrames = null; }
        }
        if (m.op === 'replay') { console.log('[mock] replay', m.frames?.length ?? 0, 'frames'); setTimeout(() => sock.write('{"t":"replay_done"}\n'), 300); }
        if (m.op === 'tiles') {
          const { x, y, w, h } = m;
          const data = Buffer.alloc(w * h * 5);
          sock.write(JSON.stringify({ t: 'tiles', x, y, w, h, d: data.toString('base64') }) + '\n');
        }
      }
    }
  });
  sock.on('close', () => { console.log('[mock] client gone'); input = null; });
});

function send(obj) {
  for (const c of clients) { try { c.write(JSON.stringify(obj) + '\n'); } catch {} }
}
const clients = new Set();
server.on('connection', (s) => { clients.add(s); s.on('close', () => clients.delete(s)); });

server.listen(PORT, '127.0.0.1', () => console.log('[mock] listening 127.0.0.1:' + PORT));


