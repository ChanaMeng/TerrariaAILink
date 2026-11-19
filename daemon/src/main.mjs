import { ModClient } from './proto.mjs';
import { World } from './world.mjs';
import { createDodge } from './dodge.mjs';
import { ModeManager } from './modes.mjs';
import { createApi } from './server.mjs';

const world = new World();
const client = new ModClient();
const dodge = createDodge();

const events = [];
let seq = 0;

const ctx = {
  world,
  client,
  dodge,
  manager: null,
  events,
  seq: 0,
  event(type, data = {}) {
    const e = { seq: ++seq, at: Date.now(), type, data };
    events.push(e);
    if (events.length > 300) events.shift();
    ctx.seq = seq;
    console.log(`[event] ${type} ${JSON.stringify(data)}`);
  },
  log(msg) { console.log(`[tailink] ${msg}`); },
  snapshot() {
    const s = world.state;
    const p = s?.p;
    return {
      link: client.connected,
      ageMs: world.at ? Date.now() - world.at : null,
      tick: s?.tick ?? null,
      menu: !!s?.menu,
      mode: ctx.manager.status(),
      player: p ? {
        x: Math.round(p.x), y: Math.round(p.y),
        vx: Math.round(p.vx * 100) / 100, vy: Math.round(p.vy * 100) / 100,
        hp: p.hp, mhp: p.mhp, mana: p.mp, dead: !!p.dead, grounded: !!p.grd,
        item: p.it?.nm ?? null,
      } : null,
      boss: world.boss() ? { id: world.boss().i, type: world.boss().ty, life: world.boss().lf, max: world.boss().lm } : null,
      hostiles: world.hostiles().length,
      threats: world.threats().length,
      events: events.slice(-15),
      lastSeq: seq,
    };
  },
};

const manager = new ModeManager(ctx);
ctx.manager = manager;

client.on('state', (msg) => {
  world.onMessage(msg);
  manager.tick();
});

client.on('tiles', (msg) => world.onMessage(msg));

client.on('record', (msg) => {
  ctx.event('record_frames', { frames: msg.frames?.length ?? 0 });
  if (ctx.recordFile) {
    import('node:fs').then((fs) => fs.writeFileSync(ctx.recordFile, JSON.stringify(msg.frames)));
    ctx.recordFile = null;
  }
});

client.on('replay_done', () => {
  ctx.event('replay_done', {});
  if (manager.name === 'replay') manager.set('idle');
});

client.on('log', (msg) => console.log(`[mod] ${msg.msg}`));
client.on('spawned', (msg) => ctx.event('spawned', msg));
client.on('hello', (msg) => {
  ctx.log(`mod hello: ${msg.mod} v${msg.v} world=${msg.world || ''}`);
  ctx.event('hello', msg);
});
client.on('connect', () => ctx.event('link_up', {}));
client.on('disconnect', () => ctx.event('link_down', {}));

client.start();
createApi(ctx);
ctx.log('daemon up: mod=127.0.0.1:17890 api=127.0.0.1:17891');
manager.set('idle');


