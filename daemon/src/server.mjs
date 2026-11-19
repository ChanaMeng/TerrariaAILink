import http from 'node:http';
import { API_PORT } from './proto.mjs';

export function createApi(ctx) {
  const { world, client, manager } = ctx;

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        return ok(res, ctx.snapshot());
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        const since = Number(url.searchParams.get('since') ?? 0);
        return ok(res, { events: ctx.events.filter((e) => e.seq > since), lastSeq: ctx.seq });
      }
      if (req.method === 'GET' && url.pathname === '/tiles') {
        const x = Number(url.searchParams.get('x'));
        const y = Number(url.searchParams.get('y'));
        return ok(res, world.tileAt(x, y) ?? null);
      }
      if (req.method === 'GET' && url.pathname === '/chat') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const lines = ctx.chatLog.filter((l) => l.seq > since);
        return ok(res, { lines, lastSeq: ctx.chatSeq || 0 });
      }
      if (req.method === 'GET' && url.pathname === '/grid') {
        const x = Number(url.searchParams.get('x'));
        const y = Number(url.searchParams.get('y'));
        const w = Math.min(Number(url.searchParams.get('w') ?? 60), 120);
        const h = Math.min(Number(url.searchParams.get('h') ?? 40), 80);
        const rows = [];
        for (let j = 0; j < h; j++) {
          let row = '';
          for (let i = 0; i < w; i++) {
            const t = world.tileAt(x + i, y + j);
            if (!t) row += '?';
            else if (t.solid) row += '#';
            else if (t.platform) row += '=';
            else if (t.liquid > 0) row += '~';
            else row += '.';
          }
          rows.push(row);
        }
        return ok(res, { x, y, w, h, rows });
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        return ok(res, world.state ?? {});
      }
      if (req.method === 'POST' && url.pathname === '/mode') {
        const body = await readBody(req);
        const r = manager.set(body.name, body.params ?? {});
        return ok(res, r);
      }
      if (req.method === 'POST' && url.pathname === '/cmd') {
        const body = await readBody(req);
        return ok(res, handleCmd(body));
      }
      if (req.method === 'POST' && url.pathname === '/input') {
        const body = await readBody(req);
        client.input(body);
        return ok(res, { ok: true });
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  function handleCmd(body) {
    const op = body.op;
    if (op === 'say') {
      client.send({ t: 'cmd', op: 'say', text: String(body.text ?? '') });
      ctx.event('say', { text: body.text });
      return { ok: true };
    }
    if (op === 'stop') {
      client.send({ t: 'cmd', op: 'stop' });
      manager.set('idle');
      ctx.event('stop', {});
      return { ok: true };
    }
    if (op === 'record') {
      client.send({ t: 'cmd', op: 'record', on: !!body.on });
      ctx.event('record', { on: !!body.on });
      return { ok: true };
    }
    if (op === 'tiles') {
      client.send({ t: 'cmd', op: 'tiles', x: body.x, y: body.y, w: body.w, h: body.h });
      return { ok: true };
    }
    if (op === 'replay') {
      manager.set('replay', { frames: body.frames ?? [], loop: !!body.loop });
      return { ok: true };
    }
    if (op === 'swap') {
      client.send({ t: 'cmd', op: 'swap', a: body.a, b: body.b });
      ctx.event('swap', { a: body.a, b: body.b });
      return { ok: true };
    }
    if (op === 'clear') {
      client.send({ t: 'cmd', op: 'clear' });
      return { ok: true };
    }
    return { ok: true, forwarded: op };
  }

  server.listen(API_PORT, '127.0.0.1');
  return server;
}

function ok(res, obj) {
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => {
      data += d;
      if (data.length > 8_000_000) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}


