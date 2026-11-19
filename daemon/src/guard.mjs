// guard.mjs — 守护层（纯代码，每帧在 mode.tick() 之前检查）。
//
// 只做保命 / 止损，不做长期规划；规则本身不切组，由 ModeManager.tick() 执行切换。
// 每条规则都是独立函数：(ctx, now) => hit | null，规则无状态，方便单测。
//
// hit = { kind, reason, group, params?, details? }
//   group === null 表示“只发事件，不切组”（inventory_full）。
//
// 冷却由 evaluateGuards() 统一维护，触发一次必发 `guard` 事件。

const COOLDOWNS = {
  low_hp: 10_000,
  boss_seen: 5_000,
  dead: 3_000,
  inventory_full: 60_000,
};

/** kind -> 上次触发时间（Date.now 基准） */
const lastFired = new Map();

function managerName(ctx) {
  return ctx?.manager?.name ?? null;
}

function managerParams(ctx) {
  return ctx?.manager?.params ?? {};
}

function player(ctx) {
  return ctx?.world?.p ?? null;
}

function hpRatio(p) {
  if (!p || !Number.isFinite(p.mhp) || p.mhp <= 0) return 1;
  return p.hp / p.mhp;
}

function sameGroup(ctx, group) {
  return managerName(ctx) === group;
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

/** HP < 30% → survive。低血时不动正在做的事，交给 survive 跑路/回血。 */
export function ruleLowHp(ctx) {
  const p = player(ctx);
  if (!p || p.dead) return null;
  if (sameGroup(ctx, 'survive')) return null;
  if (!(p.hp < p.mhp * 0.3)) return null;
  return {
    kind: 'low_hp',
    reason: 'low_hp',
    group: 'survive',
    params: { reason: 'low_hp' },
    details: { hp: p.hp, mhp: p.mhp, ratio: hpRatio(p) },
  };
}

/** Boss 出现 → boss（autoBoss:false 可 veto）。低血 / 已在 survive 时不抢保命。 */
export function ruleBossSeen(ctx) {
  const w = ctx?.world;
  const boss = w?.boss?.() ?? null;
  if (!boss) return null;
  const p = player(ctx);
  if (p?.dead) return null;
  if (sameGroup(ctx, 'boss') || sameGroup(ctx, 'survive')) return null;
  if (managerParams(ctx).autoBoss === false) return null;
  if (p && hpRatio(p) < 0.3) return null;
  return {
    kind: 'boss_seen',
    reason: 'boss_seen',
    group: 'boss',
    params: { reason: 'boss_seen' },
    details: {
      boss: { id: boss.i, type: boss.ty, life: boss.lf, max: boss.lm },
    },
  };
}

/** 死亡 → idle，只发事件。不要自动重打 Boss。 */
export function ruleDead(ctx) {
  const p = player(ctx);
  if (!p || !p.dead) return null;
  return {
    kind: 'dead',
    reason: 'dead',
    group: 'idle',
    params: { reason: 'dead' },
    details: { x: p.x, y: p.y },
  };
}

/** 背包满 → 只发事件，不切组（回不回家是意志层的事）。 */
export function ruleInventoryFull(ctx) {
  const inv = ctx?.world?.state?.in;
  if (!Array.isArray(inv)) return null;
  const p = player(ctx);
  if (p?.dead) return null;
  const used = inv.filter((t) => Number(t) > 0).length;
  if (used < 50) return null;
  return {
    kind: 'inventory_full',
    reason: 'inventory_full',
    group: null,
    details: { used, slots: inv.length },
  };
}

// 顺序即优先级：死亡 > 低血 > Boss > 背包。
const RULES = [
  { kind: 'dead', check: ruleDead },
  { kind: 'low_hp', check: ruleLowHp },
  { kind: 'boss_seen', check: ruleBossSeen },
  { kind: 'inventory_full', check: ruleInventoryFull },
];

// ---------------------------------------------------------------------------
// 评估
// ---------------------------------------------------------------------------

/**
 * @returns {null | { group: string, params: object, reason: string }}
 */
export function evaluateGuards(ctx, now = Date.now()) {
  if (!ctx?.manager) return null;

  for (const { kind, check } of RULES) {
    const cooldown = COOLDOWNS[kind] ?? 0;
    const last = lastFired.get(kind);
    if (last != null && now - last < cooldown) continue;

    const hit = check(ctx, now);
    if (!hit) continue;

    lastFired.set(kind, now);
    const group = hit.group ?? null;
    ctx.event?.('guard', {
      kind: hit.kind,
      reason: hit.reason,
      group,
      params: hit.params ?? {},
      cooldownMs: cooldown,
      ...(hit.details ?? {}),
    });

    // 只记事件，不切组（背包满）。
    if (!group) return null;
    // 已经在目标组里：事件发过就够了，别每帧重新 set 把组重置。
    if (sameGroup(ctx, group)) return null;
    return { group, params: hit.params ?? {}, reason: hit.reason };
  }

  return null;
}

/** 冷却剩余毫秒（0 = 可用），给 status() 调试用。 */
export function guardStatus(now = Date.now()) {
  const out = {};
  for (const [kind, ms] of Object.entries(COOLDOWNS)) {
    const last = lastFired.get(kind);
    out[kind] = last == null ? 0 : Math.max(0, Math.ceil(last + ms - now));
  }
  return out;
}

/** 测试用：清空所有冷却。 */
export function resetGuards() {
  lastFired.clear();
}

export const GUARD_COOLDOWNS = COOLDOWNS;
