// 战况摘要（brief 2.0）：把 mod 每 tick 上报的状态，翻成一屏中文 + 一份机器可读数据。
// 只读：不向 mod 发请求、不改状态；瓦片取不到就写「未知」，不猜。

const PX = 16;
const NEAR_TILES = 5;      // 5 格内算贴脸
const SCAN_TILES = 90;     // 和 world.hostiles 的默认扫描半径一致
const MAX_THREATS = 5;     // data.threats 最多 5 个
const TEXT_THREATS = 3;    // text 里最多列 3 个

const LEVEL_TEXT = { safe: '安全', warn: '注意', danger: '危险' };

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v, fallback = '') {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function oneLine(v, max = 40) {
  const s = str(v).replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function toTiles(d) {
  return Math.round((d / PX) * 10) / 10;
}

function showTiles(t) {
  return Math.round(t);
}

function tileClass(t) {
  if (!t) return 'unknown';
  if (t.solid || t.platform) return 'solid'; // 平台能站，归到实体
  if (num(t.liquid) > 0) return 'liquid';
  return 'air';
}

function tileText(cls) {
  if (cls === 'solid') return '实体';
  if (cls === 'air') return '空气';
  if (cls === 'liquid') return '液体';
  return '未知';
}

function npcLabel(n) {
  // 名字缺失时退回类型 id，绝不让 undefined 漏进文案
  return str(n?.nm) || `#${num(n?.ty)}`;
}

function eventLabel(e) {
  const type = str(e?.type, '事件');
  const d = e?.data && typeof e.data === 'object' ? e.data : {};
  if (type === 'mode_change') {
    const name = str(d.name);
    return name ? `mode_change(${name})` : type;
  }
  if (type === 'build_step' && Number.isFinite(d.index)) {
    const total = Number.isFinite(d.total) ? d.total : '?';
    return `build_step(${d.index}/${total})`;
  }
  return type;
}

function recentEvents(events) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e.type === 'string')
    .slice(-10);
  const labels = [];
  for (const e of list) {
    const label = eventLabel(e);
    const last = labels[labels.length - 1];
    if (last && last.label === label) last.count += 1;
    else labels.push({ label, count: 1 });
  }
  return labels.slice(-4).map((l) => (l.count > 1 ? `${l.label}×${l.count}` : l.label)).join(' → ');
}

export function buildBrief(ctx = {}) {
  const world = ctx.world ?? null;
  const state = world?.state ?? null;
  const p = state?.p ?? null;
  const npcs = Array.isArray(state?.n) ? state.n : [];
  const prs = Array.isArray(state?.pr) ? state.pr : [];

  const link = !!ctx.client?.connected;
  const menu = !!state?.menu;
  const now = Date.now();
  const ageMs = world?.at ? Math.max(0, now - world.at) : null;

  let group = null;
  try { group = ctx.manager?.status?.()?.name ?? null; } catch { group = null; }

  const px = p ? num(p.x) : 0;
  const py = p ? num(p.y) : 0;
  const tx = p ? Math.floor(px / PX) : 0;
  const ty = p ? Math.floor(py / PX) : 0;

  const player = p ? {
    name: str(p.nm, '鲸白'),
    x: Math.round(px),
    y: Math.round(py),
    tx,
    ty,
    hp: num(p.hp),
    mhp: num(p.mhp),
    mp: num(p.mp),
    mmp: num(p.mmp),
    grounded: !!p.grd,
    dead: !!p.dead,
    item: str(p.it?.nm) || null,
  } : null;

  // 活着的敌对 NPC，按距离排序；Boss 在下面单独拎出来
  const threatsRaw = [];
  if (p) {
    for (const n of npcs) {
      if (!n || n.fr || num(n.lf) <= 0 || num(n.dm) <= 0) continue;
      const d = Math.hypot(num(n.x) - px, num(n.y) - py);
      if (d > SCAN_TILES * PX) continue;
      threatsRaw.push({ n, d });
    }
    threatsRaw.sort((a, b) => a.d - b.d);
  }

  const threats = threatsRaw
    .filter((t) => !t.n.bo)
    .slice(0, MAX_THREATS)
    .map((t) => ({
      type: npcLabel(t.n),
      id: num(t.n.ty),
      distTiles: toTiles(t.d),
      hp: num(t.n.lf),
      max: num(t.n.lm),
    }));

  // Boss 不筛 90 格：mod 会把全图 Boss 都发过来，远处也算危险
  let bossRaw = null;
  if (p) {
    for (const n of npcs) {
      if (!n || !n.bo || num(n.lf) <= 0) continue;
      const d = Math.hypot(num(n.x) - px, num(n.y) - py);
      if (!bossRaw || d < bossRaw.d) bossRaw = { n, d };
    }
  }
  const boss = bossRaw ? {
    type: npcLabel(bossRaw.n),
    id: num(bossRaw.n.ty),
    life: num(bossRaw.n.lf),
    max: num(bossRaw.n.lm),
    distTiles: toTiles(bossRaw.d),
  } : null;

  // 敌对弹幕（ho=1 才是打你的；自己的弹幕不算）
  let projectiles = 0;
  let nearProjectile = null;
  if (p) {
    for (const pr of prs) {
      if (!pr || !pr.ho) continue;
      projectiles += 1;
      const d = Math.hypot(num(pr.x) - px, num(pr.y) - py);
      if (!nearProjectile || d < nearProjectile.d) nearProjectile = { pr, d };
    }
  }

  const nearHostile = threatsRaw.find((t) => !t.n.bo && t.d <= NEAR_TILES * PX) ?? null;
  const closeProjectile = nearProjectile && nearProjectile.d <= NEAR_TILES * PX ? nearProjectile : null;

  // 脚下 / 头顶瓦片：拿不到就是 unknown，不编
  let tile = null;
  if (p) {
    let under = null;
    let head = null;
    try { under = world.tileAt?.(tx, ty + 1) ?? null; } catch { under = null; }
    try { head = world.tileAt?.(tx, ty - 2) ?? null; } catch { head = null; }
    tile = { under: tileClass(under), head: tileClass(head) };
  }

  // 判级：HP < 30% 或 Boss → danger；5 格内有敌对或弹幕 → warn；其余 safe
  const hpRatio = player && player.mhp > 0 ? player.hp / player.mhp : 1;
  const lowHp = !!player && player.mhp > 0 && hpRatio < 0.3;
  let level = 'safe';
  if (player && (player.dead || lowHp || boss)) level = 'danger';
  else if (nearHostile || closeProjectile) level = 'warn';

  const reason = [];
  if (level === 'danger') {
    if (player?.dead) reason.push('已死亡');
    else if (lowHp) reason.push(`血量 ${Math.round(hpRatio * 100)}%`);
    if (boss) reason.push(`Boss ${boss.type}`);
  } else if (level === 'warn') {
    if (nearHostile) reason.push(`${npcLabel(nearHostile.n)} ${showTiles(toTiles(nearHostile.d))} 格内`);
    if (closeProjectile) reason.push(`弹幕 ${showTiles(toTiles(closeProjectile.d))} 格内`);
  } else if (!link) {
    reason.push('未连接');
  } else if (menu) {
    reason.push('菜单中');
  } else if (!player) {
    reason.push('还没收到状态');
  }

  const chat = (Array.isArray(ctx.chatLog) ? ctx.chatLog : [])
    .map((l) => oneLine(l?.text, 120))
    .filter(Boolean)
    .slice(-3);

  const lines = [];
  let header = `鲸白 · ${link ? (menu ? '菜单中' : '在线') : '未连接'} · 组=${group ?? '未知'}`;
  if (link && ageMs != null && ageMs > 2000) {
    header += `（数据 ${Math.round(ageMs / 1000)} 秒前）`;
  }
  lines.push(header);

  if (player) {
    const where = player.dead ? '倒地' : player.grounded ? '地上' : '空中';
    lines.push(`位置 世界 (${player.x},${player.y}) · 格 (${player.tx},${player.ty}) · 脚下${tileText(tile?.under ?? 'unknown')} · ${where}`);
  } else {
    lines.push(`位置 世界坐标未知（${link ? '等待游戏上报' : '未连接'}）`);
  }

  if (player) {
    const held = player.item ? `手持 ${player.item}` : '手持 空手';
    const deadTag = player.dead ? '（已死亡）' : '';
    lines.push(`生命 ${player.hp}/${player.mhp}${deadTag} · 魔力 ${player.mp}/${player.mmp} · ${held}`);
  } else {
    lines.push('生命 未知 · 魔力 未知 · 手持 未知');
  }

  if (!player) {
    lines.push(`威胁 未知 · 弹幕 ${projectiles}`);
  } else if (threats.length === 0) {
    lines.push(`威胁 附近没有敌人 · 弹幕 ${projectiles}`);
  } else {
    const list = threats.slice(0, TEXT_THREATS).map((t) => {
      const life = t.max > 0 ? `${t.hp}/${t.max}` : `${t.hp}`;
      return `${t.type} ${showTiles(t.distTiles)} 格 ${life}`;
    }).join(' · ');
    lines.push(`威胁 ${list} · 弹幕 ${projectiles}`);
  }

  if (boss) {
    const pct = boss.max > 0 ? ` (${Math.round((boss.life / boss.max) * 100)}%)` : '';
    lines.push(`Boss ${boss.type} ${boss.life}/${boss.max}${pct} · ${showTiles(boss.distTiles)} 格外`);
  }

  const recent = recentEvents(ctx.events);
  lines.push(`最近 ${recent || '暂无事件'}`);

  if (chat.length) {
    const said = chat.slice(-2).map((t) => oneLine(t, 36)).join(' / ');
    lines.push(`聊天 ${said}`);
  }

  lines.push(`结论 ${LEVEL_TEXT[level]}${reason.length ? `（${reason.join(' · ')}）` : ''}`);

  const data = {
    link,
    menu,
    group,
    player,
    threats,
    boss,
    projectiles,
    level,
    events: (Array.isArray(ctx.events) ? ctx.events : [])
      .filter((e) => e && typeof e.type === 'string')
      .slice(-8)
      .map((e) => ({ type: e.type, at: num(e.at) })),
    chat,
    tile,
    tick: Number.isFinite(state?.tick) ? state.tick : null,
    ageMs,
  };

  return { text: lines.join('\n'), data, level };
}
