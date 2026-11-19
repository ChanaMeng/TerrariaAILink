import net from 'node:net';
import { EventEmitter } from 'node:events';

export const MOD_PORT = 17890;
export const API_PORT = 17891;

export function encodeInput(f) {
  const o = { t: 'in' };
  if (f.left) o.l = true;
  if (f.right) o.r = true;
  if (f.up) o.u = true;
  if (f.down) o.d = true;
  if (f.jump) o.j = true;
  if (f.use) o.use = true;
  if (f.tile) o.tile = true;
  if (f.slot != null) o.slot = f.slot;
  if (f.aim && Number.isFinite(f.aim[0]) && Number.isFinite(f.aim[1])) {
    o.ax = Math.round(f.aim[0] * 100) / 100;
    o.ay = Math.round(f.aim[1] * 100) / 100;
  }
  return o;
}

export function neutral() {
  return { left: false, right: false, up: false, down: false, jump: false, use: false, tile: false };
}

export class ModClient extends EventEmitter {
  constructor({ host = '127.0.0.1', port = MOD_PORT } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.sock = null;
    this.connected = false;
    this._retry = null;
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._retry);
    this.sock?.destroy();
  }

  _connect() {
    if (this._stopped) return;
    const s = net.createConnection({ host: this.host, port: this.port });
    this.sock = s;
    s.setNoDelay(true);
    s.setEncoding('utf8');
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._line(line);
      }
    });
    s.on('connect', () => {
      this.connected = true;
      this.emit('connect');
      this.send({ t: 'hello' });
    });
    s.on('close', () => {
      if (this.connected) this.emit('disconnect');
      this.connected = false;
      this.sock = null;
      if (!this._stopped) this._retry = setTimeout(() => this._connect(), 1000);
    });
    s.on('error', () => {});
  }

  _line(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    this.emit(msg.t || 'message', msg);
  }

  send(obj) {
    if (!this.connected || !this.sock) return false;
    try { this.sock.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  input(frame) {
    return this.send(encodeInput(frame));
  }
}


