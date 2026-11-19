// Watches the tailink daemon for new chat lines, filters noise, and exits when
// something worth waking the agent about shows up. Costs zero tokens while idle.
//
// usage: node watch.mjs [--since <seq>] [--keyword <word>] [--minutes 10] [--all]
import { setTimeout as sleep } from 'node:timers/promises';

const API = process.env.TAILINK_API || 'http://127.0.0.1:17891';
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

let since = Number(arg('since', 0));
const keyword = arg('keyword', '');
const deadline = Date.now() + Number(arg('minutes', 10)) * 60_000;
const all = argv.includes('--all');

// lines that are noise unless they mention the keyword
const NOISE = [
  /已加入。?$/, /已离开。?$/, /^欢迎来到/, /打败了第\d+个/, /^<.*> ?$/,
  /正在连接/, /连接已断开/, /世界已在/, /保存/, /已保存/,
];

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const isNoise = (s) => NOISE.some((re) => re.test(s));

async function getChat(sinceSeq) {
  const r = await fetch(`${API}/chat?since=${sinceSeq}`);
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}

let lastActivity = Date.now();
while (Date.now() < deadline) {
  await sleep(1000);
  try {
    const data = await getChat(since);
    if (!data.lines?.length) continue;
    since = data.lastSeq;
    lastActivity = Date.now();

    const kept = data.lines
      .map((l) => clean(l.text))
      .filter((t) => t.length > 0)
      .filter((t) => (all ? true : !isNoise(t)) || (keyword && t.includes(keyword)))
      .map((t) => (t.length > 160 ? t.slice(0, 160) + '…' : t))
      .slice(-12);

    if (!kept.length) continue;

    const hit = !keyword || kept.some((t) => t.includes(keyword));
    if (keyword && !hit) {
      // keep tracking but do not wake anyone
      continue;
    }

    console.log(JSON.stringify({ at: new Date().toISOString(), since, lines: kept }));
    process.exit(0);
  } catch (e) {
    // daemon down: wait it out quietly
  }
}

console.log(JSON.stringify({ at: new Date().toISOString(), timeout: true, since }));
process.exit(0);
