// autonomy.mjs — 自主循环（鲸白不在时的「值班小脑」）
//
// 职责：鲸白没下指令时，每 intervalMs（默认 1500ms）看一眼前线状态，
// 纯代码算分，选一个策略组，然后调 policy.applyPolicy(ctx, ..., 'autonomy') 切过去。
// 零 token、零游戏动作：本模块只「选组」，走/砍/打都由现有 modes.mjs 的组自己跑。
//
// ── 让位 / 夺回规则（明确版）────────────────────────────────────────────
// 1. 让位：ctx.policy.source 不是 autonomy / boot / decision_default 时，视为鲸白
//    手动指定过组，自主循环不抢：每次评估返回 { skipped: 'manual_policy' }，
//    status().enabled 仍为 true。boot 是启动默认、decision_default 是决策超时兜底，
//    都不是鲸白的手动指令，所以不触发让位。
// 2. 夺回（满足任一）：
//    a) policy.group === 'auto'：鲸白写 {"group":"auto"} 表示「交回给你」。
//       注意：当前 policy.applyPolicy 会拒绝未知组 'auto'，所以 main 接线时若支持
//       group:'auto'，需要让它落到 ctx.policy 上；本模块只认这个内存对象。
//    b) params.auto === true：手动 policy 里显式写 auto:true，立即交还。
//    c) 手动组真的跑完了：policy.at 之后出现该组的
//       goal_done / stuck / no_target / danger / timeout 事件，
//       且 params.auto !== false。
//    d) 兜底：手动组确认在跑过、随后 manager 已不在该组（被守护层换走或静默结束），
//       或者 10s 后 manager 仍不在该组，且 params.auto !== false。
//    params.auto === false 表示鲸白把组钉死：即使它结束也不夺回。
// 3. 守护层 / 别的组（survive、boss、build、fight、follow、release…）在跑时，
//    本模块一律不切，返回 { skipped: 'foreign_group' }，等它们结束回到 idle。
//
// ── 评分（候选只有 gather / explore / hold / idle）──────────────────────
// gather  = 55 × 背包空格率（占用 ≥ 50 格时收益 0） - 低血 / 贴脸 / Boss 惩罚
// explore = 45 × 无聊度（距上次 explore 的时间）× 新鲜度（离 origin 越近越值得去）
//           - 夜里（state.day === 0）35 - 低血/贴脸/Boss 惩罚
// hold    = 3 + 附近怪加成 + Boss 加成（永远低分，只在没别的事干时选）
// idle    = 1.5（保底；hold 进冷却后通常会输给它）
// 冷却中的组：score = score - |score| × 0.6（「降权 60%」，正分掉到 40%，负分更负）。
//
// 约束：切到一个组后至少待 minDwellMs（默认 6000）才允许再切；刚切走的组
// 8s 内不切回去（防抖）。守护层不受本模块约束，它比这里快。

import { applyPolicy } from './policy.mjs';

const PX = 16;

// ── 可调常数 ────────────────────────────────────────────────────────────
const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_MIN_DWELL_MS = 6000;
const DEFAULT_SWITCH_DEBOUNCE_MS = 8000;
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_COOLDOWN_DROP = 0.6;
const MANUAL_GRACE_MS = 10_000;

const INVENTORY_FULL = 50;       // 占用 50 格 = 背包满，gather 收益归零
const SCAN_TILES = 90;           // 和 world.hostiles 的默认扫描半径一致
const NEAR_HOSTILE_TILES = 5;    // 「贴脸」判定
const HOLD_ENGAGE_TILES = 20;    // hold 觉得「怪靠近了」的半径
const CRITICAL_HP = 0.3;         // 残血：完全不动手，交给守护层
const HURT_HP = 0.5;             // 半血：gather / explore 大幅降分

const GATHER_BASE = 55;
const GATHER_HURT_PENALTY = 30;
const GATHER_HOSTILE_PENALTY = 40;
const GATHER_BOSS_PENALTY = 40;

// fight：附近有敌对就上。挨打不还手是之前的真机问题——候选池里原本没有「打」。
const FIGHT_BASE = 65;
const FIGHT_NEAR_BONUS = 20;
const FIGHT_BOSS_BONUS = 15;
const FIGHT_TILES = 40;          // 40 格内的敌对就值得打

const EXPLORE_BASE = 45;
const EXPLORE_BOREDOM_MS = 180_000; // 3 分钟没探索 → 无聊度拉满
const EXPLORE_RANGE_TILES = 120;    // 离 origin 120 格外 → 新鲜度归零
const EXPLORE_NIGHT_PENALTY = 35;
const EXPLORE_HURT_PENALTY = 20;
const EXPLORE_HOSTILE_PENALTY = 35;
const EXPLORE_BOSS_PENALTY = 40;

const HOLD_BASE = 3;
const HOLD_BOSS_BONUS = 6;

const IDLE_SCORE = 1.5;

/** 本模块允许自己选的组；survive 不在里面（守护层说了算）。 */
export const AUTONOMY_GROUPS = ['fight', 'gather', 'explore', 'hold', 'idle'];

/** 这些 source 不是鲸白的手动指令：boot 是启动默认，decision_default 是超时兜底。 */
const NON_MANUAL_SOURCES = new Set(['autonomy', 'boot', 'decision_default']);

/** 触发冷却 / 视为「组结束」的事件。前四个是硬要求，timeout 是 explore 的真实退出。 */
const END_EVENTS = new Set(['goal_done', 'stuck', 'no_target', 'danger', 'timeout']);
const COOLDOWN_EVENTS = new Set(['goal_done', 'stuck', 'no_target', 'danger']);

const CANDIDATE_ORDER = ['fight', 'gather', 'explore', 'hold', 'idle'];

// ── 小工具 ──────────────────────────────────────────────────────────────

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 创建自主循环。
 *
 * @param {object} ctx daemon 的共享上下文（world / manager / events / event / policy…）
 * @param {object} [options]
 * @param {number} [options.intervalMs=1500]   低频评估周期
 * @param {number} [options.minDwellMs=6000]   切组后的最小停留
 * @param {number} [options.switchDebounceMs=8000] 刚离开的组多久内不切回
 * @param {number} [options.cooldownMs=60000]  组结束后的降权时长
 * @param {number} [options.cooldownDrop=0.6]  降权比例（0.6 = 降 60%）
 * @param {{x:number,y:number}} [options.origin] 探索原点（世界像素坐标，默认启动时玩家位置）
 * @returns {{ start:Function, stop:Function, tick:Function, status:Function }}
 */
export function createAutonomy(ctx = null, options = {}) {
  const opts = plainObject(options) ? options : {};

  const intervalMs = Math.max(50, finiteOr(opts.intervalMs, DEFAULT_INTERVAL_MS));
  const minDwellMs = Math.max(0, finiteOr(opts.minDwellMs, DEFAULT_MIN_DWELL_MS));
  const switchDebounceMs = Math.max(0, finiteOr(opts.switchDebounceMs, DEFAULT_SWITCH_DEBOUNCE_MS));
  const cooldownMs = Math.max(0, finiteOr(opts.cooldownMs, DEFAULT_COOLDOWN_MS));
  const cooldownDrop = clamp01(finiteOr(opts.cooldownDrop, DEFAULT_COOLDOWN_DROP));

  // 运行状态
  let timer = null;
  let running = false;
  let stopped = false;

  // 决策状态
  let lastAt = null;
  let lastPick = null;
  let lastReason = null;
  let lastSwitchAt = null;
  let lastSwitchFrom = null;
  let lastSwitchTo = null;
  let switches = 0;

  // 世界 / 记忆
  let origin = null;          // 世界像素坐标
  let lastExploreAt = null;   // 上次切进 explore 的时间
  let manualKey = null;       // 当前手动 policy 的身份，用于确认「它真的跑起来过」
  let manualConfirmed = false;

  // 事件与冷却
  const seenEvents = new WeakSet();
  let lastEventSeq = 0;
  const endedAt = new Map();      // group -> 最近一次结束事件时间
  const cooldownUntil = new Map(); // group -> 冷却结束时间

  // ── 防御式读世界 ──────────────────────────────────────────────────────

  function state() {
    try { return ctx?.world?.state ?? null; } catch { return null; }
  }

  function player() {
    try { return ctx?.world?.p ?? state()?.p ?? null; } catch { return null; }
  }

  function managerName() {
    try {
      const n = ctx?.manager?.name;
      return typeof n === 'string' ? n : null;
    } catch { return null; }
  }

  function hostiles(maxTiles = SCAN_TILES) {
    try {
      const fn = ctx?.world?.hostiles;
      if (typeof fn === 'function') {
        const list = fn.call(ctx.world, maxTiles);
        if (Array.isArray(list)) return list;
      }
    } catch { /* 假 world 没有这个方法，走下面的兜底 */ }

    const p = player();
    if (!p) return [];
    const st = state();
    const list = Array.isArray(st?.n) ? st.n : [];
    const lim = maxTiles * PX;
    return list.filter((n) => n && !n.fr && num(n.lf) > 0 && num(n.dm) > 0
      && Math.hypot(num(n.x) - num(p.x), num(n.y) - num(p.y)) <= lim);
  }

  function boss() {
    try {
      const fn = ctx?.world?.boss;
      if (typeof fn === 'function') {
        const b = fn.call(ctx.world);
        if (b) return b;
      }
    } catch { /* 兜底 */ }
    const list = Array.isArray(state()?.n) ? state().n : [];
    return list.find((n) => n && n.bo && num(n.lf) > 0) ?? null;
  }

  function usedSlots() {
    const inv = state()?.in;
    if (!Array.isArray(inv)) return null;
    let used = 0;
    for (const t of inv) if (Number(t) > 0) used += 1;
    return used;
  }

  function hpRatio(p) {
    const mhp = num(p?.mhp);
    const hp = num(p?.hp);
    if (!mhp || mhp <= 0) return 1;
    return Math.min(1, Math.max(0, hp / mhp));
  }

  function originPx() {
    if (origin) return origin;
    const given = opts.origin ?? opts.params?.origin ?? ctx?.origin;
    if (plainObject(given) && Number.isFinite(given.x) && Number.isFinite(given.y)) {
      origin = { x: given.x, y: given.y };
      return origin;
    }
    const p = player();
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      origin = { x: p.x, y: p.y };
    }
    return origin;
  }

  // ── 事件：冷却与「组结束」 ────────────────────────────────────────────

  function recordEvent(event, now) {
    const type = typeof event?.type === 'string' ? event.type : '';
    if (!type) return;
    const data = plainObject(event.data) ? event.data : {};
    const group = typeof data.group === 'string' ? data.group : null;
    if (!group) return;

    const at = finiteOr(event.at, now);
    if (!END_EVENTS.has(type)) return;

    endedAt.set(group, at);
    if (COOLDOWN_EVENTS.has(type)) {
      const until = at + cooldownMs;
      const prev = cooldownUntil.get(group) ?? 0;
      if (until > prev) cooldownUntil.set(group, until);
    }
  }

  /**
   * 扫描 ctx.events 里还没见过的事件。
   * main 的事件数组会 shift 旧条目，所以不能只用下标；带 seq 的用 seq，
   * 不带 seq 的用 WeakSet 去重。
   */
  function pollEvents(now) {
    const list = Array.isArray(ctx?.events) ? ctx.events : [];
    for (const event of list) {
      if (!plainObject(event)) continue;
      if (seenEvents.has(event)) continue;
      seenEvents.add(event);

      const seq = Number(event.seq);
      if (Number.isFinite(seq)) {
        if (seq <= lastEventSeq) continue;
        lastEventSeq = seq;
      }
      try { recordEvent(event, now); } catch { /* 一条坏事件不能拖垮循环 */ }
    }
  }

  // ── 手动 policy 的判断 ────────────────────────────────────────────────

  function currentPolicy() {
    try { return ctx?.policy ?? null; } catch { return null; }
  }

  function sourceOf(policy) {
    return typeof policy?.source === 'string' ? policy.source : '';
  }

  function isManualPolicy(policy) {
    if (!plainObject(policy)) return false;
    return !NON_MANUAL_SOURCES.has(sourceOf(policy));
  }

  function updateManual(policy, current) {
    const key = `${sourceOf(policy)}|${policy.group ?? ''}|${policy.at ?? ''}`;
    if (key !== manualKey) {
      manualKey = key;
      manualConfirmed = false;
    }
    if (current != null && current === policy.group) manualConfirmed = true;
  }

  /**
   * 鲸白把手动组交还给自主循环了吗？
   * 规则见文件头：auto / auto:true 立即交还；auto:false 永不交还；
   * 其余情况要等「组真的结束」或「确认跑过后组没了」。
   */
  function canReclaim(policy, current, now) {
    if (!isManualPolicy(policy)) return true;

    if (policy.group === 'auto') return true;

    const params = plainObject(policy.params) ? policy.params : {};
    if (params.auto === true) return true;
    if (params.auto === false) return false;

    // 没有 at 的 policy 当「刚写的」处理，只认 auto / 确认跑过之后再消失；
    // 不能拿 0 当时间戳，否则一上来就误判成 10s 前。
    const hasPolicyAt = Number.isFinite(policy.at);
    const policyAt = hasPolicyAt ? policy.at : 0;
    const endAt = endedAt.get(policy.group) ?? 0;
    if (endAt > 0 && (!hasPolicyAt || endAt >= policyAt)) return true;

    const left = current !== policy.group;
    if (left && manualConfirmed) return true;
    // 兜底：手动组可能被守护层换走 / 静默结束，10s 没见到它在跑就收回来。
    if (left && hasPolicyAt && now - policyAt >= MANUAL_GRACE_MS) return true;

    return false;
  }

  // ── 评分 ──────────────────────────────────────────────────────────────

  /** 冷却惩罚：正分降到 40%，负分更负（绝对值越大的组越该再等等）。 */
  function penalize(group, score, now) {
    const until = cooldownUntil.get(group) ?? 0;
    if (now >= until) {
      if (until) cooldownUntil.delete(group);
      return score;
    }
    return score - Math.abs(score) * cooldownDrop;
  }

  function nearestHostileTiles(list, p) {
    if (!p) return null;
    let best = null;
    for (const n of list) {
      if (!n) continue;
      const d = Math.hypot(num(n.x) - num(p.x), num(n.y) - num(p.y)) / PX;
      if (best == null || d < best) best = d;
    }
    return best;
  }

  function computeScores(now) {
    const p = player();
    const ratio = hpRatio(p);
    const used = usedSlots();
    const emptyRatio = used == null
      ? 0.5 // 背包还没上报：不假设满也不假设空，给个中间值
      : clamp01((INVENTORY_FULL - used) / INVENTORY_FULL);

    const enemies = hostiles(SCAN_TILES);
    const nearTiles = nearestHostileTiles(enemies, p);
    const nearHostile = nearTiles != null && nearTiles <= NEAR_HOSTILE_TILES;
    const hasBoss = !!boss();
    const night = state()?.day === 0; // mod：1=白天，0=夜晚

    if (lastExploreAt == null) lastExploreAt = now;
    const boredom = clamp01((now - lastExploreAt) / EXPLORE_BOREDOM_MS);

    const o = originPx();
    const distTiles = p && o ? Math.hypot(num(p.x) - o.x, num(p.y) - o.y) / PX : 0;
    const frontier = clamp01(1 - distTiles / EXPLORE_RANGE_TILES);

    // gather：背包越空越想干；低血/贴脸/Boss 都别去砍树。
    let gather = GATHER_BASE * emptyRatio;
    if (ratio < HURT_HP) gather -= GATHER_HURT_PENALTY;
    if (nearHostile) gather -= GATHER_HOSTILE_PENALTY;
    if (hasBoss) gather -= GATHER_BOSS_PENALTY;

    // explore：越久没探索越无聊；离 origin 越远越没新鲜感；夜里别乱跑。
    let explore = EXPLORE_BASE * (0.3 + 0.7 * boredom) * (0.4 + 0.6 * frontier);
    if (night) explore -= EXPLORE_NIGHT_PENALTY;
    if (ratio < HURT_HP) explore -= EXPLORE_HURT_PENALTY;
    if (nearHostile) explore -= EXPLORE_HOSTILE_PENALTY;
    if (hasBoss) explore -= EXPLORE_BOSS_PENALTY;

    // fight：40 格内有敌对、且血够就先打。贴脸加码；残血直接让位给守护。
    let fight = 0;
    const fightEnemies = hostiles(FIGHT_TILES);
    if (fightEnemies.length > 0 && ratio >= HURT_HP) fight = FIGHT_BASE;
    if (nearHostile) fight += FIGHT_NEAR_BONUS;
    if (hasBoss) fight += FIGHT_BOSS_BONUS;
    if (ratio < CRITICAL_HP) fight = -Infinity;

    // hold：永远低分；附近有怪才涨一点，没别的事干时才轮得到它。
    let hold = HOLD_BASE;
    if (nearTiles != null && nearTiles <= HOLD_ENGAGE_TILES) {
      hold += 8 * (1 - nearTiles / HOLD_ENGAGE_TILES);
      if (nearTiles <= NEAR_HOSTILE_TILES) hold += 2;
    }
    if (hasBoss) hold += HOLD_BOSS_BONUS;

    const scores = {
      fight: penalize('fight', fight, now),
      gather: penalize('gather', gather, now),
      explore: penalize('explore', explore, now),
      hold: penalize('hold', hold, now),
      idle: penalize('idle', IDLE_SCORE, now),
    };

    return {
      scores,
      detail: { ratio, used, emptyRatio, nearTiles, night, hasBoss, boredom, frontier, distTiles, enemies: fightEnemies.length },
    };
  }

  function reasonFor(group, detail) {
    if (group === 'fight') {
      if (detail.enemies > 0) return 'hostiles_near';
      return 'fallback';
    }
    if (group === 'gather') return detail.emptyRatio >= 0.8 ? 'inventory_empty' : 'inventory_space';
    if (group === 'explore') return detail.boredom >= 0.6 ? 'bored' : 'frontier';
    if (group === 'hold') {
      return detail.nearTiles != null && detail.nearTiles <= HOLD_ENGAGE_TILES
        ? 'hostiles_near'
        : 'fallback';
    }
    return detail.ratio < HURT_HP ? 'low_hp' : 'fallback';
  }

  // ── 评估 ──────────────────────────────────────────────────────────────

  function evaluate(now) {
    if (stopped) return { at: now, skipped: 'stopped' };

    pollEvents(now);
    lastAt = now;

    const manager = ctx?.manager ?? null;
    if (!manager) return { at: now, skipped: 'no_manager' };

    const current = managerName();
    const policy = currentPolicy();

    // 1) 让位 / 夺回
    let reclaiming = false;
    if (isManualPolicy(policy)) {
      updateManual(policy, current);
      if (!canReclaim(policy, current, now)) {
        return {
          at: now,
          pick: null,
          reason: null,
          applied: false,
          skipped: 'manual_policy',
          policyGroup: policy.group ?? null,
        };
      }
      reclaiming = true;
    }

    // 2) 世界状态不够就别动
    const st = state();
    if (st?.menu) return { at: now, skipped: 'menu' };
    const p = player();
    if (!p) return { at: now, skipped: 'no_state' };
    if (p.dead) return { at: now, skipped: 'dead' };

    // 3) 守护层 / 别的组正在跑：不抢。
    // 例外：主人刚写了 {"group":"auto"}，而当前是 release（松手）——
    // release 不是「别人在跑」，是「没人接管」，这时该由 autonomy 接手。
    const foreign = current != null && !AUTONOMY_GROUPS.includes(current);
    if (foreign && !(reclaiming && current === 'release')) {
      return { at: now, skipped: 'foreign_group', current };
    }

    // 4) 残血：交给守护层的 survive，不自己切走
    const ratio = hpRatio(p);
    if (ratio < CRITICAL_HP) {
      return { at: now, pick: null, reason: 'low_hp', applied: false, skipped: 'low_hp' };
    }

    // 5) 打分
    const { scores, detail } = computeScores(now);
    let picked = CANDIDATE_ORDER[0];
    for (const group of CANDIDATE_ORDER) {
      if (scores[group] > scores[picked]) picked = group;
    }
    const reason = reasonFor(picked, detail);
    lastPick = picked;
    lastReason = reason;

    const result = { at: now, pick: picked, reason, scores };

    // 6) 已经在这个组：不重复 set（每次 set 都会把组的计时器清零）
    if (picked === current) {
      if (reclaiming && current != null) {
        // 只是把手动组的控制权记到 autonomy 名下；idle 之类的重复 enter 无副作用
        const claimed = applyAuto(current, 'reclaim');
        return { ...result, applied: claimed, reclaimed: true };
      }
      return { ...result, applied: false };
    }

    // 7) 防抖：最小停留 + 不马上切回刚离开的组
    if (lastSwitchAt != null && now - lastSwitchAt < minDwellMs) {
      return { ...result, applied: false, skipped: 'min_dwell', minDwellMs };
    }
    if (lastSwitchAt != null && picked === lastSwitchFrom
      && now - lastSwitchAt < switchDebounceMs) {
      return { ...result, applied: false, skipped: 'debounce', switchDebounceMs };
    }

    // 8) 切
    const from = current;
    const applied = applyAuto(picked, reason);
    if (!applied) return { ...result, applied: false, skipped: 'apply_failed' };

    switches += 1;
    lastSwitchAt = now;
    lastSwitchFrom = from;
    lastSwitchTo = picked;
    if (picked === 'explore') lastExploreAt = now;

    try {
      ctx?.event?.('autonomy_switch', { from, to: picked, reason, scores });
    } catch { /* 事件总线坏了不影响已经切好的组 */ }

    return { ...result, applied: true };
  }

  function applyAuto(group, reason) {
    try {
      return applyPolicy(ctx, {
        group,
        params: {},
        reason: `autonomy:${reason}`,
      }, 'autonomy');
    } catch {
      return false;
    }
  }

  // ── 对外接口 ──────────────────────────────────────────────────────────

  /** 手动跑一次评估（测试用；没 start 也能跑，stop 之后不会）。 */
  function tick(now) {
    const at = finiteOr(now, Date.now());
    try {
      return evaluate(at);
    } catch (e) {
      // 自主循环是兜底件，任何意外都不能把 daemon 拖垮
      return { at, applied: false, skipped: 'error', error: String(e?.message ?? e) };
    }
  }

  /** 开始低频评估；立刻先评一次，免得启动后空等 1.5s。 */
  function start() {
    if (running) return status();
    stopped = false;
    running = true;
    tick(Date.now());

    if (!timer) {
      timer = setInterval(() => { tick(); }, intervalMs);
      timer.unref?.();
    }
    return status();
  }

  /** 停止评估并清掉 interval；之后 tick() 只会返回 skipped:'stopped'。 */
  function stop() {
    running = false;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return status();
  }

  function status() {
    const now = Date.now();
    const cooldowns = {};
    for (const group of AUTONOMY_GROUPS) {
      const until = cooldownUntil.get(group) ?? 0;
      const left = Math.max(0, Math.ceil(until - now));
      cooldowns[group] = left;
      if (!left && until) cooldownUntil.delete(group);
    }
    return {
      enabled: !stopped,
      running,
      intervalMs,
      lastPick,
      lastReason,
      lastAt,
      cooldowns,
      sinceLastSwitchMs: lastSwitchAt == null ? null : Math.max(0, now - lastSwitchAt),
      switches,
      lastSwitchTo,
    };
  }

  return { start, stop, tick, status };
}
