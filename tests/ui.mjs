/**
 * 新功能 UI 自检：拟人头像 / 身份牌 / 发言倒计时 / 投票面板 / 观战视角
 * 用法：npm start  然后  node tests/ui.mjs
 */
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

// 1) 房主开局
await A.goto(BASE);
await A.fill('#nameInput', '阿伟');
await A.click('#createBtn');
await A.waitForSelector('#lobbyScreen.on', { timeout: 8000 });
const code = (await A.locator('#roomCode').textContent()).trim();
await A.click('#startBtn');
await A.waitForSelector('.role-intro.show', { timeout: 8000 });
const myRole = (await A.locator('#roleIntroName').textContent()).trim();
await A.click('#roleIntroOk');
await A.waitForTimeout(700);

// 2) 座位头像 + 自己的身份牌
const avatars = await A.locator('#seats .seat-avatar svg').count();
const roleChips = await A.locator('#seats .seat-role:not([hidden])').allTextContents();
console.log(`房间 ${code} · 我的身份 ${myRole}`);
console.log('座位拟人头像数:', avatars, '| 可见身份牌:', roleChips.join('/'));
await A.screenshot({ path: 'shots/ui-seats.png' });

// 3) 观众视角
await B.goto(BASE);
await B.fill('#nameInput', '看客');
await B.fill('#codeInput', code);
await B.click('#watchBtn');
await B.waitForSelector('#gameScreen.on', { timeout: 8000 });
await B.waitForTimeout(800);
const watchTag = await B.locator('#watchTag').isVisible();
const allRoles = await B.locator('#seats .seat-role:not([hidden])').allTextContents();
const watchPanel = (await B.locator('.watch-panel').textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
console.log('观众标签可见:', watchTag, '| 上帝视角可见身份:', allRoles.join('/'));
console.log('观众面板:', watchPanel);
await B.screenshot({ path: 'shots/ui-spectator.png' });

// 4) 跟着往下走，直到出现发言倒计时 / 投票面板
let sawTimer = false;
let sawVote = false;
for (let i = 0; i < 1200; i++) {
  // 自己回合的兜底操作
  const sheet = A.locator('.sheet-mask.show #sheet button[data-i]').first();
  if (await sheet.count()) await sheet.click().catch(() => {});
  const noHeal = A.locator('#noHealBtn');
  if (await noHeal.count()) await noHeal.click().catch(() => {});
  const noPoison = A.locator('#noPoisonBtn');
  if (await noPoison.count()) await noPoison.click().catch(() => {});
  const agree = A.locator('#agreeBtn');
  if (await agree.count()) await agree.click().catch(() => {});
  const pick = A.locator('.seat.selectable').first();
  if (await pick.count()) await pick.click().catch(() => {});

  if (!sawTimer && await A.locator('#speakTimerBar:not([hidden])').count()) {
    sawTimer = true;
    const name = (await A.locator('#stName').textContent()).trim();
    const num = (await A.locator('#stNum').textContent()).trim();
    console.log(`倒计时条出现: ${name} / ${num}`);
    await A.screenshot({ path: 'shots/ui-timer.png' });
  }
  if (!sawVote && await A.locator('.vote-box').count()) {
    sawVote = true;
    const head = (await A.locator('.vote-head').textContent()).replace(/\s+/g, ' ').trim();
    const items = await A.locator('.vote-item').count();
    const confirmDisabled = await A.locator('#voteConfirmBtn').isDisabled();
    console.log(`投票面板: ${head} | 候选人 ${items} | 未选人时确认按钮禁用 ${confirmDisabled}`);
    await A.locator('.vote-item').first().click();
    await A.waitForTimeout(200);
    const label = (await A.locator('#voteConfirmBtn').textContent()).trim();
    const pickedClass = await A.locator('.seat.picked').count();
    console.log('选中后确认按钮文案:', label, '| 桌上高亮座位数:', pickedClass);
    await A.screenshot({ path: 'shots/ui-vote.png' });
    await A.locator('#voteConfirmBtn').click();
    await A.waitForTimeout(300);
  }
  if (sawTimer && sawVote) break;
  await A.waitForTimeout(200);
}

console.log('倒计时条:', sawTimer, '| 投票面板:', sawVote);
console.log('页面错误:', errors.length ? errors.slice(0, 4) : '无');
await browser.close();
