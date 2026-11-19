#!/usr/bin/env node
//   whale status
//   whale mv left 0.5
//   whale goto 120 60
//   whale attack 18
//   whale build plan.json
//   whale stop
import fs from 'node:fs';

const API = process.env.TAILINK_API || 'http://127.0.0.1:17891';
const [cmd, ...rest] = process.argv.slice(2);

async function get(path) {
  const r = await fetch(API + path);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

function out(o) { console.log(JSON.stringify(o)); }

try {
  switch (cmd) {
    case 'status': out(await get('/status')); break;
    case 'events': out(await get('/events?since=' + (rest[0] ?? 0))); break;
    case 'state': out(await get('/state')); break;
    case 'mode': {
      const name = rest[0];
      const params = rest[1] ? JSON.parse(rest[1]) : {};
      out(await post('/mode', { name, params }));
      break;
    }
    case 'mv': {
      const key = rest[0];
      const sec = Number(rest[1] ?? 0.5);
      if (!['left', 'right', 'up', 'down', 'jump'].includes(key)) throw new Error('key: left|right|up|down|jump');
      out(await post('/mode', { name: 'free', params: { keys: [key], ms: sec * 1000 } }));
      break;
    }
    case 'goto':
      out(await post('/mode', { name: 'goto', params: { x: Number(rest[0]), y: Number(rest[1] ?? 0) } }));
      break;
    case 'attack':
      out(await post('/mode', { name: 'combat', params: { range: Number(rest[0] ?? 18) } }));
      break;
    case 'boss':
      out(await post('/mode', { name: 'boss', params: rest[0] ? { boss: Number(rest[0]) } : {} }));
      break;
    case 'build': {
      const raw = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
      const plan = Array.isArray(raw) ? raw : raw.plan;
      out(await post('/mode', { name: 'build', params: { ...(raw.plan ? raw : {}), plan } }));
      break;
    }
    case 'say':
      out(await post('/cmd', { op: 'say', text: rest.join(' ') }));
      break;
    case 'chat':
      out(await get('/chat?since=' + (rest[0] ?? 0)));
      break;
    case 'brief': {
      const st = await get('/status');
      const chat = await get('/chat?since=0');
      const ev = await get('/events?since=0');
      out({
        link: st.link,
        mode: st.mode?.name ?? null,
        player: st.player,
        hostiles: st.hostiles,
        boss: st.boss,
        chat: (chat.lines ?? []).slice(-5).map((l) => l.text),
        events: (ev.events ?? []).slice(-6).map((e) => e.type),
        lastSeq: st.lastSeq,
        chatSeq: chat.lastSeq,
      });
      break;
    }
    case 'stop':
      out(await post('/mode', { name: 'release', params: {} }));
      break;
    case 'spawn':
      out(await post('/cmd', {
        op: 'spawn',
        type: Number(rest[0] ?? 1),
        dx: Number(rest[1] ?? 200),
        dy: Number(rest[2] ?? -40),
      }));
      break;
    case 'clear':
      out(await post('/cmd', { op: 'clear' }));
      break;
    case 'tiles': {
      const [x, y, w, h] = rest.map(Number);
      out(await post('/cmd', { op: 'tiles', x, y, w: w || 64, h: h || 48 }));
      break;
    }
    default:
      console.log('tailink <status|mode|mv|goto|attack|boss|build|say|stop|tiles|events|state>');
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}


