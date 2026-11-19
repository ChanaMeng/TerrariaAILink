// policy.mjs — 意志层 / daemon 之间的文件桥。
//
//   state/policy.json    鲸白写，daemon 热加载：{ group, params, reason }
//   state/decision.json  daemon 写，鲸白读：{ seq, at, kind, summary, options, default, expiresAt }
//
// 目录：TAILINK_STATE_DIR，默认 <repo>/daemon/state/。
// 写入一律「.tmp + rename」，避免读到半截 JSON。
// 这里没有 tick 依赖：读文件只发生在启动、watch 回调、决策请求（由 main 在 tick 之后调度）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModeManager } from './modes.mjs';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.resolve(SRC_DIR, '..');

export const DECISION_TTL_MS = 90_000;
export const REQUEST_THROTTLE_MS = 5_000;
const WATCH_MIN_MS = 20;

let decisionSeq = 0;
const lastRequestAt = new Map();

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function stateDir() {
  const env = process.env.TAILINK_STATE_DIR;
  return env ? path.resolve(env) : path.join(DAEMON_DIR, 'state');
}

export function statePaths() {
  const dir = stateDir();
  return {
    dir,
    policy: path.join(dir, 'policy.json'),
    decision: path.join(dir, 'decision.json'),
    decisionsLog: path.join(dir, 'decisions.log'),
  };
}

/** 已知组集合以 ModeManager.factories 为准，不另维护一份硬编码列表。 */
export function knownGroups() {
  return Object.keys(new ModeManager(null).factories);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { error: e.message };
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return { error: `invalid json: ${e.message}` };
  }
}

function atomicWrite(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

function normalizePolicy(raw) {
  if (raw == null) return null;
  if (!isPlainObject(raw)) return { error: 'policy must be an object' };
  if (raw.error) return raw;

  const group = typeof raw.group === 'string' ? raw.group : '';
  if (!group) return { error: 'missing group' };
  if (!knownGroups().includes(group)) return { error: `unknown group: ${group}`, group };

  return {
    group,
    params: isPlainObject(raw.params) ? raw.params : {},
    reason: raw.reason == null ? '' : String(raw.reason),
  };
}

/** @returns {null | { group, params, reason } | { error }} */
export function readPolicy() {
  const raw = readJson(statePaths().policy);
  return normalizePolicy(raw);
}

/**
 * 写 policy.json（原子写）。它不校验 group——校验留给 readPolicy/applyPolicy，
 * 这样测试和外部工具也能写一条非法 policy 验证拒绝路径。
 */
export function writePolicy(policy) {
  const out = {
    group: String(policy?.group ?? ''),
    params: isPlainObject(policy?.params) ? policy.params : {},
    reason: policy?.reason == null ? '' : String(policy.reason),
  };
  atomicWrite(statePaths().policy, JSON.stringify(out, null, 2) + '\n');
  return out;
}

/** @returns {null | object | { error }} */
export function readDecision() {
  const raw = readJson(statePaths().decision);
  if (raw == null) return null;
  if (!isPlainObject(raw)) return { error: 'decision must be an object' };
  return raw;
}

/** 写 decision.json；旧的一条追加到 decisions.log。 */
export function writeDecision(decision) {
  const paths = statePaths();
  const prev = readDecision();
  if (prev && !prev.error) {
    try {
      fs.appendFileSync(paths.decisionsLog, JSON.stringify(prev) + '\n');
    } catch { /* 日志写不了不影响当前决策 */ }
  }
  atomicWrite(paths.decision, JSON.stringify(decision, null, 2) + '\n');
  return decision;
}

/** 删掉当前 decision。返回是否真的删到了文件。 */
export function clearDecision() {
  try {
    fs.unlinkSync(statePaths().decision);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 决策请求
// ---------------------------------------------------------------------------

/**
 * 写一条决策请求，不阻塞、不等待。
 * 同一个 kind 在 5s 内只写一次。
 *
 * @returns {null | object} 被节流或写失败时返回 null
 */
export function requestDecision(ctx, {
  kind = 'goal',
  options = [],
  defaultGroup = 'idle',
  summary = '',
} = {}) {
  const now = Date.now();
  const key = String(kind);
  const last = lastRequestAt.get(key);
  if (last != null && now - last < REQUEST_THROTTLE_MS) return null;

  const known = knownGroups();
  const opts = [];
  for (const g of Array.isArray(options) ? options : []) {
    if (typeof g === 'string' && known.includes(g) && !opts.includes(g)) opts.push(g);
  }
  let def = known.includes(defaultGroup) ? defaultGroup : (opts[0] ?? 'idle');
  if (!opts.includes(def)) opts.unshift(def);

  // 跨重启也尽量单调：以前面留下的 decision.seq 为基线。
  const prev = readDecision();
  if (prev && !prev.error && Number.isFinite(prev.seq)) {
    decisionSeq = Math.max(decisionSeq, prev.seq);
  }
  decisionSeq += 1;

  const decision = {
    seq: decisionSeq,
    at: now,
    kind: key,
    summary: String(summary ?? ''),
    options: opts,
    default: def,
    expiresAt: now + DECISION_TTL_MS,
  };

  try {
    writeDecision(decision);
  } catch (e) {
    lastRequestAt.delete(key);
    ctx?.event?.('decision_error', { kind: key, error: e.message });
    return null;
  }

  lastRequestAt.set(key, now);
  if (ctx) ctx.decision = decision;
  return decision;
}

// ---------------------------------------------------------------------------
// 热加载
// ---------------------------------------------------------------------------

/**
 * 轮询 policy.json 的 mtime/size，变了就 cb(policy)。
 * 返回 stop()，会清掉 interval（测试必须能优雅停止）。
 */
export function watchPolicy(cb, intervalMs = 200) {
  const file = statePaths().policy;
  let lastKey = null;
  let stopped = false;

  const poll = () => {
    if (stopped) return;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      lastKey = null; // 删掉再建也能重新触发
      return;
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (key === lastKey) return;
    lastKey = key;

    let policy;
    try {
      policy = readPolicy();
    } catch (e) {
      policy = { error: e.message };
    }
    if (policy == null) return;

    try {
      const r = cb(policy);
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) {
      console.error(`[policy] watch callback failed: ${e.message}`);
    }
  };

  const ms = Math.max(WATCH_MIN_MS, Number(intervalMs) || 200);
  const timer = setInterval(poll, ms);
  timer.unref?.();

  return function stop() {
    stopped = true;
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

/**
 * 把 policy 应用到 ModeManager。
 * @returns {boolean} 是否真的切了组
 */
export function applyPolicy(ctx, policy, source = 'file') {
  if (!ctx?.manager) return false;

  if (!policy || policy.error) {
    ctx.event?.('policy_rejected', {
      source,
      error: policy?.error ?? 'empty policy',
      policy: policy ?? null,
    });
    return false;
  }

  const group = typeof policy.group === 'string' ? policy.group : '';
  if (!group || !knownGroups().includes(group) || !ctx.manager.factories?.[group]) {
    ctx.event?.('policy_rejected', {
      source,
      error: `unknown group: ${group || '(missing)'}`,
      policy,
    });
    return false;
  }

  const params = isPlainObject(policy.params) ? policy.params : {};
  const reason = policy.reason == null ? '' : String(policy.reason);

  try {
    ctx.manager.set(group, params);
  } catch (e) {
    ctx.event?.('policy_rejected', { source, error: e.message, policy });
    return false;
  }

  ctx.policy = { group, params, reason, source, at: Date.now() };
  ctx.decision = null; // policy 是决策的答案；旧请求不再挂心里
  ctx.event?.('policy_applied', { group, params, source, reason });
  return true;
}

/** 测试用：清空节流与 seq（不碰文件）。 */
export function resetPolicyState() {
  decisionSeq = 0;
  lastRequestAt.clear();
}
