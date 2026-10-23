/**
 * 服务端快速模拟：不开浏览器，直接把一局跑完。
 * 用途：验证夜晚播报顺序、AI 发言、遗言、胜负判定是否都能走到。
 *   npm run sim            （内部带 GAME_PACE=0.08，几秒跑完一局）
 *   GAME_PACE=1 node tests/sim.mjs   （按真实节奏跑）
 */
import { Room } from '../server/game.js';

const REAL_LLM = Boolean(process.env.LLM_API_KEY);

// 真人玩家的操作由脚本代答，避免真等倒计时
Room.prototype.ask = async function (player, prompt, timeoutMs) {
  this.sendTo(player, { t: 'turn', ...prompt, seconds: Math.round(timeoutMs / 1000) });
  await new Promise((r) => setTimeout(r, 10));
  const others = this.alive().filter((p) => p !== player);
  const pick = others[Math.floor(Math.random() * others.length)];
  let action = null;
  if (prompt.kind === 'speak' || prompt.kind === 'lastWords') action = { text: '我怀疑 3 号，他发言太飘。' };
  else if (prompt.kind === 'witchHeal') action = { choice: 'none' };
  else if (prompt.kind === 'witchPoison') action = { choice: 'none' };
  else if (pick) action = { seat: pick.seat };
  this.sendTo(player, { t: 'turnEnd' });
  return action;
};

const room = new Room('9999');
const events = [];
const origBroadcast = room.broadcast.bind(room);
room.broadcast = (msg) => {
  events.push(msg);
  origBroadcast(msg);
};

const human = room.join({ send() {}, readyState: 1 }, '测试君', null);
human.ready = true;
while (room.players.length < 6) room.addAI();

room.start(human);

const t0 = Date.now();
await new Promise((resolve) => {
  const iv = setInterval(() => {
    if (room.phase === 'end' || Date.now() - t0 > 120000) {
      clearInterval(iv);
      resolve();
    }
  }, 200);
});

const hosts = events.filter((m) => m.t === 'host').map((m) => m.text);
const speeches = events.filter((m) => m.t === 'speech');
const lastWords = events.filter((m) => m.t === 'lastWords');
const over = events.find((m) => m.t === 'over');

console.log('=== 主持人播报（前 24 条）===');
hosts.slice(0, 24).forEach((h, i) => console.log(String(i + 1).padStart(2), h));

console.log('\n=== 玩家发言 ===');
speeches.forEach((s) => console.log(`${s.name}（${s.seat + 1}号）：${s.text}`));

console.log('\n=== 遗言 ===');
lastWords.forEach((s) => console.log(`${s.name}（${s.reason === 'vote' ? '被票出' : '夜里死亡'}）：${s.text}`));

console.log('\n=== 结果 ===');
console.log(over ? `${over.winner} 胜 · ${over.reason}` : '未结束（超时）');
console.log('角色：', room.players.map((p) => `${p.name}:${p.role}${p.alive ? '' : '(出局)'}`).join(' '));

const checks = [
  ['夜晚有闭眼播报', hosts.some((h) => h.includes('天黑请闭眼'))],
  ['狼人睁眼播报', hosts.some((h) => h.includes('狼人请睁眼'))],
  ['预言家睁眼播报', hosts.some((h) => h.includes('预言家请睁眼'))],
  ['女巫睁眼播报', hosts.some((h) => h.includes('女巫请睁眼'))],
  ['女巫问解药', hosts.some((h) => h.includes('解药'))],
  ['女巫问毒药', hosts.some((h) => h.includes('毒药'))],
  ['AI 有发言', speeches.filter((s) => s.name !== '测试君').length >= 2],
  ['有遗言', lastWords.length >= 1],
  ['游戏分胜负', !!over],
  ['大模型' + (REAL_LLM ? '已接' : '未接（本地话术）'), true]
];

console.log('\n=== 自检 ===');
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}`);
}
process.exit(bad ? 1 : 0);
