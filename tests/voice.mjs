/**
 * 语音链路验证
 *   1) 服务端是否给 6 个座位分配了互不相同的音色
 *   2) 浏览器端是否真的走了神经语音（而不是回退系统语音）
 *
 *   node tests/voice.mjs
 */
import WebSocket from 'ws';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const WS_BASE = BASE.replace(/^http/, 'ws');

/* ---------- 1. 座位音色 ---------- */
const voices = await new Promise((resolve) => {
  const ws = new WebSocket(`${WS_BASE}/ws`);
  const found = [];
  let started = false;
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', code: '', name: '音色探针' })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.t === 'joined') {
      ws.send(JSON.stringify({ t: 'ready', value: true }));
      setTimeout(() => ws.send(JSON.stringify({ t: 'start' })), 200);
    }
    if (msg.t === 'state' && msg.room.phase !== 'lobby') {
      if (!started) {
        started = true;
        msg.room.players.forEach((p) => found.push(p.voice));
        ws.close();
        resolve(found);
      }
    }
  });
  setTimeout(() => { try { ws.close(); } catch { /* 忽略 */ } resolve(found); }, 8000);
});

const uniq = new Set(voices.filter(Boolean));
console.log('座位音色:', voices.join(', '));
console.log(voices.length === 6 && uniq.size === 6 ? '✓ 6 个座位音色互不相同' : '✗ 音色分配异常');

/* ---------- 2. 浏览器播放 ---------- */
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));

await page.goto(BASE);
await page.fill('#nameInput', '音色测试');
await page.click('#createBtn');
await page.waitForSelector('#lobbyScreen.on', { timeout: 8000 });
await page.click('#readyBtn');
await page.click('#startBtn');
await page.waitForSelector('#gameScreen.on', { timeout: 8000 });

// 自动替真人玩家操作，让对局一直往前走（否则会卡在夜晚选人）
async function drive() {
  const sheet = page.locator('.sheet-mask.show #sheet button[data-i]').first();
  if (await sheet.count()) { await sheet.click(); return; }
  for (const id of ['#noHealBtn', '#noPoisonBtn', '#agreeBtn']) {
    const el = page.locator(id);
    if (await el.count()) { await el.click(); return; }
  }
  const speak = page.locator('#speakInput');
  if (await speak.count()) {
    await speak.fill('我怀疑旁边那位，这票给他。');
    await page.click('#sendBtn');
    return;
  }
  const sel = page.locator('.seat.selectable').first();
  if (await sel.count()) { await sel.click(); return; }
}

const until = Date.now() + Number(process.env.WAIT || 35000);
while (Date.now() < until) {
  await drive().catch(() => {});
  await page.waitForTimeout(200);
}
const stat = await page.evaluate(() => window.__voice);
console.log('播放统计:', stat);
console.log(stat.neural > 0 ? `✓ 神经语音播出 ${stat.neural} 句` : '✗ 没有走神经语音');
console.log(stat.system === 0 ? '✓ 没有回退系统语音' : `! 回退系统语音 ${stat.system} 句`);
console.log('页面错误:', errs.length ? errs.slice(0, 3) : '无');

await page.screenshot({ path: 'shots/voice-check.png' });
await browser.close();
process.exit(stat.neural > 0 && uniq.size === 6 ? 0 : 1);
