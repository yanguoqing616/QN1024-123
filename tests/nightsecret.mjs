/**
 * 夜间「谁被袭击」信息隔离自检
 *
 * 规则：
 *   1) 狼人 / 女巫 —— 能看到被袭击者的明文姓名
 *   2) 平民 / 预言家 —— 只能看到打码版（如 阿岚 → 阿＊）
 *   3) 观众 —— 上帝视角，看明文
 *   4) 结算翻牌后 —— 所有人看明文
 * 同时校验「记录抽屉」和「夜间大事记」不会绕过主持人台词泄露明文。
 * 用法：node tests/nightsecret.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TEST_PORT || 3117;
const GAME_PACE = 0.05; // 真人客户端不会自动操作，全靠服务端超时推进，节奏要压得够快

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), GAME_PACE: String(GAME_PACE), TTS_OFF: '1' },
  stdio: 'ignore'
});
await new Promise((r) => setTimeout(r, 1500));

const URL = `ws://localhost:${PORT}/ws`;

function client(label) {
  const ws = new WebSocket(URL);
  const all = [];       // 收到的全部消息
  const waiters = [];
  const queue = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    all.push(msg);
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return {
    label,
    ws,
    all,
    send: (m) => ws.send(JSON.stringify(m)),
    until: (pred, timeoutMs = 40000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('until 超时')), timeoutMs);
        const pump = () => {
          if (queue.length) {
            const m = queue.shift();
            if (pred(m)) { clearTimeout(timer); resolve(m); return; }
          }
          waiters.push((m) => {
            if (pred(m)) { clearTimeout(timer); resolve(m); } else pump();
          });
        };
        pump();
      })
  };
}

const NAMES = ['甲一', '乙二', '丙三'];

async function attempt(round) {
  // 3 个真人进同一房间，剩下的由 AI 补齐
  const clients = [];
  for (let i = 0; i < 3; i++) {
    const c = client(NAMES[i]);
    await new Promise((r) => c.ws.on('open', r));
    c.send({ t: 'join', code: '', name: NAMES[i] });
    await c.until((m) => m.t === 'joined');
    clients.push(c);
  }
  const first = clients[0];
  const state = await first.until((m) => m.t === 'state');
  const code = state.room.code;
  for (let i = 1; i < clients.length; i++) {
    clients[i].send({ t: 'join', code, name: NAMES[i] });
    await clients[i].until((m) => m.t === 'state');
    clients[i].send({ t: 'ready', value: true });
  }
  first.send({ t: 'start' });

  // 跑到天亮为止（夜里女巫回合会播报被袭击者）
  try {
    await Promise.all(clients.map((c) =>
      c.until((m) => m.t === 'host' && /天亮/.test(m.text || ''), 90000)
    ));
  } catch {
    console.log('  第' + round + '局：没等到天亮，跳过');
    clients.forEach((c) => c.ws.close());
    return null;
  }

  const allNames = new Set();
  for (const c of clients) {
    const st = [...c.all].reverse().find((m) => m.t === 'state' && m.room);
    if (st) st.room.players.forEach((p) => allNames.add(p.name));
  }

  let checked = 0;
  const problems = [];
  for (const c of clients) {
    const st = [...c.all].reverse().find((m) => m.t === 'state' && m.room && m.room.self);
    const role = st.room.self.role;
    const roleLabel = { wolf: '狼人', witch: '女巫', seer: '预言家', villager: '平民' }[role] || role;

    // 主持人播报里的「袭击」台词
    const lines = c.all.filter((m) => m.t === 'host' && /袭击/.test(m.text || '') && !/平安夜/.test(m.text || ''));
    if (!lines.length) continue;
    const line = lines[0].text;
    const masked = line.includes('*');
    const plainHit = [...allNames].find((n) => line.includes(n));

    checked += 1;
    const shouldSee = role === 'wolf' || role === 'witch';
    console.log(`  ${roleLabel.padEnd(3)} ${c.label}：${line}`);

    if (shouldSee && masked) problems.push(`${roleLabel} 本该看明文，却收到打码：${line}`);
    if (shouldSee && !plainHit) problems.push(`${roleLabel} 本该看到明文姓名：${line}`);
    if (!shouldSee && !masked) problems.push(`${roleLabel} 不该看到明文，却收到：${line}`);
    if (!shouldSee && plainHit) problems.push(`${roleLabel} 台词里出现了明文姓名「${plainHit}」：${line}`);

    // 记录抽屉 + 大事记也不能泄露
    for (const item of st.room.log || []) {
      if (!/袭击/.test(item.text || '')) continue;
      const leak = !shouldSee && [...allNames].find((n) => item.text.includes(n));
      if (leak) problems.push(`${roleLabel} 的「记录抽屉」泄露明文「${leak}」：${item.text}`);
    }
    for (const ev of st.room.events || []) {
      if (!/袭击/.test(ev.text || '')) continue;
      const leak = !shouldSee && [...allNames].find((n) => ev.text.includes(n));
      if (leak) problems.push(`${roleLabel} 的「夜间大事记」泄露明文「${leak}」：${ev.text}`);
    }
  }

  clients.forEach((c) => c.ws.close());
  if (problems.length) {
    console.log('  ✗ 发现问题:');
    problems.forEach((p) => console.log('    - ' + p));
    return false;
  }
  return checked > 0 ? true : null;
}

console.log('夜间信息隔离自检（起独立服务 Port ' + PORT + '）…\n');
let ok = null;
for (let i = 1; i <= 8 && ok !== true && ok !== false; i++) {
  const r = await attempt(i);
  if (r === true) ok = true;
  else if (r === false) ok = false;
  await new Promise((r2) => setTimeout(r2, 400));
}

server.kill();
console.log('\n' + (ok === true ? '✅ 全部通过：明文只对狼人和女巫可见，其他身份看到的都是打码' : ok === false ? '❌ 存在信息泄露' : '⚠️ 本轮没跑到有袭击人的夜晚，请重跑'));
process.exit(ok === false ? 1 : 0);
