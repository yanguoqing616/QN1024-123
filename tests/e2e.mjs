import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});

const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 } });
const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
const A = await ctxA.newPage();
const B = await ctxB.newPage();

const errors = [];
for (const p of [A, B]) p.on('pageerror', (e) => errors.push(String(e)));

await A.goto(BASE);
await A.fill('#nameInput', '阿伟');
await A.click('#createBtn');
await A.waitForSelector('#lobbyScreen.on', { timeout: 8000 });
const code = (await A.locator('#roomCode').textContent()).trim();
console.log('房间号:', code);

await B.goto(BASE);
await B.fill('#nameInput', '小圆');
await B.fill('#codeInput', code);
await B.click('#joinBtn');
await B.waitForSelector('#lobbyScreen.on', { timeout: 8000 });
await A.waitForTimeout(400);

await A.screenshot({ path: 'shots/e2e-lobby-a.png' });
console.log('大厅人数行:', await A.locator('.lobby-row').count());

await B.click('#readyBtn');
await A.waitForTimeout(300);
await A.click('#startBtn');
await A.waitForTimeout(2500);
console.log('A 进入对局:', await A.locator('#gameScreen.on').count(), 'B 进入对局:', await B.locator('#gameScreen.on').count());
await A.screenshot({ path: 'shots/e2e-game-a.png' });

// 双方都点连麦，验证 WebRTC 通
await A.click('#micBtn');
await B.click('#micBtn');
await A.waitForTimeout(1500);
const audioA = await A.evaluate(() => document.querySelectorAll('audio').length);
console.log('A 端远端音频元素:', audioA);

async function drive(page) {
  const sheet = page.locator('.sheet-mask.show #sheet button[data-i]').first();
  if (await sheet.count()) { await sheet.click(); return 'sheet'; }
  const noPotion = page.locator('#noPotionBtn');
  if (await noPotion.count()) { await noPotion.click(); return 'potion'; }
  const agree = page.locator('#agreeBtn');
  if (await agree.count()) { await agree.click(); return 'wolf'; }
  const speak = page.locator('#speakInput');
  if (await speak.count()) {
    await speak.fill('我怀疑老陈，这票投他。');
    await page.click('#sendBtn');
    return 'speak';
  }
  const sel = page.locator('.seat.selectable').first();
  if (await sel.count()) { await sel.click(); return 'pick'; }
  return null;
}

let done = { a: false, b: false };
const seen = new Set();
for (let i = 0; i < 2400; i++) {
  if (!done.a) { await drive(A); done.a = (await A.locator('#result.show').count()) > 0; }
  if (!done.b) { await drive(B); done.b = (await B.locator('#result.show').count()) > 0; }
  if (i % 40 === 0) {
    const label = await A.locator('#tableLabel').textContent().catch(() => '?');
    const host = await A.locator('#hostText').textContent().catch(() => '?');
    const key = label + ' | ' + host;
    if (!seen.has(key)) { seen.add(key); console.log(`[${i}] ${key}`); }
  }
  if (done.a && done.b) break;
  await A.waitForTimeout(150);
}

console.log('结算: A =', done.a, ' B =', done.b);
await A.screenshot({ path: 'shots/e2e-result-a.png' });
await B.screenshot({ path: 'shots/e2e-result-b.png' });

const revealA = await A.locator('.reveal-row').count();
const roles = await A.locator('.camp-badge').allTextContents();
console.log('A 看到身份行数:', revealA, '角色:', roles.join('/'));

// 再来一局
if (done.a) {
  await A.click('#rematchBtn');
  await A.waitForTimeout(800);
  console.log('重开回到大厅:', await A.locator('#lobbyScreen.on').count());
  await A.screenshot({ path: 'shots/e2e-rematch.png' });
}

console.log('页面错误:', errors.length ? errors.slice(0, 4) : '无');
await browser.close();
