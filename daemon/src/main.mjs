import { ModClient } from './proto.mjs';
import { World } from './world.mjs';
import { createDodge } from './dodge.mjs';
import { ModeManager } from './modes.mjs';
import { createApi } from './server.mjs';
import {
  applyPolicy, knownGroups, readPolicy, requestDecision, watchPolicy,
} from './policy.mjs';
import { createAutonomy } from './autonomy.mjs';

const world = new World();
const client = new ModClient();
const dodge = createDodge();

const events = [];
const chatLog = [];
let seq = 0;
let manager = null;

// 组退出 → 决策请求。这些事件在 tick 里发，真正写文件要等本帧结束（setImmediate）。
const DECISION_EVENTS = new Set(['goal_done', 'stuck', 'no_target', 'timeout']);
const DECISION_GROUPS = ['idle', 'gather', 'explore', 'build', 'hold', 'fight', 'boss', 'survive'];
const pendingDecisions = new Set();
let decisionTimer = null;

const ctx = {
  world,
  client,
  dodge,
  manager: null,
  events,
  chatLog,
  seq: 0,
  policy: null,      // 最后一次成功应用的 policy（内存）
  decision: null,    // 当前 decision 请求（内存；snapshot 不读文件）
  followTarget: null, // 协议还没有其他玩家坐标；follow 组靠这个接口
  briefFn: null,     // 动态 import ./brief.mjs 的 buildBrief；拿不到就是 null
  autonomy: null,    // 自主循环（没有鲸白指令时自己选组）
  event(type, data = {}) {
    const e = { seq: ++seq, at: Date.now(), type, data };
    events.push(e);
    if (events.length > 300) events.shift();
    ctx.seq = seq;
    console.log(`[event] ${type} ${JSON.stringify(data)}`);
    if (DECISION_EVENTS.has(type)) scheduleDecision(type, data);
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
      policy: ctx.policy ? {
        group: ctx.policy.group,
        params: ctx.policy.params,
        reason: ctx.policy.reason,
        source: ctx.policy.source,
        ageMs: Math.max(0, Date.now() - ctx.policy.at),
      } : null,
      decision: ctx.decision ? {
        seq: ctx.decision.seq,
        kind: ctx.decision.kind,
        at: ctx.decision.at,
        default: ctx.decision.default,
        options: ctx.decision.options,
        summary: ctx.decision.summary,
        expiresInMs: Math.max(0, (ctx.decision.expiresAt ?? 0) - Date.now()),
      } : null,
      autonomy: ctx.autonomy ? ctx.autonomy.status() : null,
      events: events.slice(-15),
      chat: chatLog.slice(-10),
      lastSeq: seq,
    };
  },
};

// ---------------------------------------------------------------------------
// 决策请求
// ---------------------------------------------------------------------------

function decisionOptions() {
  const known = new Set(knownGroups());
  return DECISION_GROUPS.filter((g) => known.has(g));
}

function defaultGroupFor(type, data = {}, options = []) {
  let g = 'idle';
  // 采集超时可以考虑继续；背包满/危险/被卡就回 idle 等人拍板。
  if (data.group === 'gather' && data.reason === 'timeout') g = 'gather';
  else if (data.group === 'explore' && type === 'timeout') g = 'explore';
  return options.includes(g) ? g : 'idle';
}

function summaryText(type, data = {}) {
  if (typeof ctx.briefFn === 'function') {
    try {
      const b = ctx.briefFn(ctx);
      if (typeof b === 'string' && b.trim()) return b.trim();
      if (b && typeof b === 'object') {
        const s = b.summary ?? b.text ?? b.brief;
        if (typeof s === 'string' && s.trim()) return s.trim();
        return JSON.stringify(b).slice(0, 800);
      }
    } catch { /* brief 是外挂件，坏了不能拖垮决策 */ }
  }
  const s = ctx.snapshot();
  return [
    s.player ? `hp ${s.player.hp}/${s.player.mhp}` : 'no player',
    `mode ${s.mode?.name ?? 'none'}`,
    `hostiles ${s.hostiles ?? 0}`,
    s.boss ? `boss ${s.boss.type} ${s.boss.life}/${s.boss.max}` : null,
    data.group ? `group ${data.group}` : null,
    data.reason ? `reason ${data.reason}` : null,
    type !== 'goal_done' ? `event ${type}` : null,
  ].filter(Boolean).join(' · ');
}

function armDecisionTimeout(decision) {
  clearTimeout(decisionTimer);
  if (!decision) return;
  const wait = Math.max(0, (decision.expiresAt ?? 0) - Date.now());
  decisionTimer = setTimeout(() => {
    decisionTimer = null;
    // 期间鲸白写回 policy 或来了新 decision 就不再用旧 default 覆盖。
    if (!ctx.decision || ctx.decision.seq !== decision.seq) return;
    ctx.event('decision_timeout', { seq: decision.seq, kind: decision.kind, group: decision.default });
    applyPolicy(ctx, {
      group: decision.default,
      params: { reason: 'decision_timeout' },
      reason: `decision_timeout:${decision.kind}`,
    }, 'decision_default');
  }, wait);
  decisionTimer.unref?.();
}

function scheduleDecision(type, data) {
  const key = `${type}:${data?.group ?? ''}`;
  if (pendingDecisions.has(key)) return;
  pendingDecisions.add(key);
  setImmediate(() => {
    pendingDecisions.delete(key);
    if (!manager || manager.name === 'release') return; // 手动 stop 时不打扰
    const options = decisionOptions();
    const decision = requestDecision(ctx, {
      kind: type,
      options,
      defaultGroup: defaultGroupFor(type, data, options),
      summary: summaryText(type, data),
    });
    if (decision) armDecisionTimeout(decision);
  });
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

manager = new ModeManager(ctx);
ctx.manager = manager;

// 自主循环：没有鲸白指令时自己选组（纯代码，零 token）。
const autonomy = createAutonomy(ctx);
ctx.autonomy = autonomy;

// brief.mjs 由另一个会话维护：能拿到就用，拿不到就 null。
try {
  const briefMod = await import('./brief.mjs');
  ctx.briefFn = typeof briefMod.buildBrief === 'function' ? briefMod.buildBrief : null;
} catch {
  ctx.briefFn = null;
}

client.on('state', (msg) => {
  world.onMessage(msg);
  const frame = manager.tick();
  // 诊断开关：TAILINK_DEBUG_FRAME=1 时把每帧输入打出来（默认关，不刷日志）。
  if (process.env.TAILINK_DEBUG_FRAME && frame) {
    console.log(`[frame] ${JSON.stringify(frame)}`);
  }
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
client.on('chat', (msg) => {
  // the game sends chat with inline tags; [n:Name] is a player name
  const raw = String(msg.text ?? '');
  const text = raw.replace(/\[n:([^\]]+)\]/g, '<$1>').replace(/\s+/g, ' ').trim();
  if (!text) return;
  ctx.chatSeq = (ctx.chatSeq || 0) + 1;
  chatLog.push({ seq: ctx.chatSeq, at: Date.now(), text });
  if (chatLog.length > 300) chatLog.shift();
  ctx.event('chat', { seq: ctx.chatSeq, text });
});
client.on('spawned', (msg) => ctx.event('spawned', msg));
client.on('hello', (msg) => {
  ctx.log(`mod hello: ${msg.mod} v${msg.v} world=${msg.world || ''}`);
  ctx.event('hello', msg);
});
client.on('connect', () => ctx.event('link_up', {}));
client.on('disconnect', () => ctx.event('link_down', {}));

// 先按 policy.json 起组；policy 非法/读不到就 idle。
applyPolicy(ctx, readPolicy() ?? { group: 'idle', params: {}, reason: 'boot' }, 'boot');
if (!manager.current) manager.set('idle');

// 鲸白写 policy.json → 200ms 内热加载。
// 同组同参数不重复 set，避免启动时把刚 boot 的组又重置一次。
watchPolicy((policy) => {
  // 鲸白写 {"group":"auto"}：把方向盘交还给自主循环。
  // 注意 normalizePolicy 会把 auto 当未知组并带 error，所以这里不看 error。
  if (policy && policy.group === 'auto') {
    ctx.policy = { group: 'auto', params: {}, reason: policy.reason ?? '', source: 'manual', at: Date.now() };
    ctx.event('autonomy_resume', { reason: policy.reason ?? '' });
    return;
  }
  if (!policy.error && manager.name === policy.group && ctx.policy && ctx.policy.group === policy.group
    && JSON.stringify(ctx.policy.params ?? {}) === JSON.stringify(policy.params ?? {})) {
    return;
  }
  if (applyPolicy(ctx, policy, 'file')) {
    clearTimeout(decisionTimer);
    decisionTimer = null;
  }
});

client.start();
createApi(ctx);
autonomy.start();
ctx.log('daemon up: mod=127.0.0.1:17890 api=127.0.0.1:17891');
