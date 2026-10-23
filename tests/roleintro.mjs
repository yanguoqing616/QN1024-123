/**
 * 身份弹窗自检：开局必须弹出「你当前的用户身份是：XXX」，且带阵营 / 座位 / 技能说明
 * 用法：npm start  然后  node tests/roleintro.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const A = await ctx.newPage();
const errors = [];
A.on('pageerror', (e) => errors.push(String(e)));

await A.goto(BASE);
await A.fill('#nameInput', '阿伟');
await A.click('#createBtn');
await A.waitForSelector('#lobbyScreen.on', { timeout: 8000 });

const code = (await A.locator('#roomCode').textContent()).trim();
await A.click('#startBtn');

await A.waitForSelector('.role-intro.show', { timeout: 8000 });
await A.waitForTimeout(450); // 等淡入动画结束再截图
const kicker = (await A.locator('.role-kicker').textContent()).trim();
const role = (await A.locator('#roleIntroName').textContent()).trim();
const camp = (await A.locator('#roleIntroCamp').textContent()).trim();
const seat = (await A.locator('#roleIntroSeat').textContent()).trim();
const tip = (await A.locator('#roleIntroTip').textContent()).trim();
await A.screenshot({ path: 'shots/role-intro.png' });
console.log(`房间 ${code} → 弹窗文案: ${kicker}：${role} | ${camp} | ${seat}`);
console.log('技能说明:', tip.replace(/\n/g, ' / '));

await A.click('#roleIntroOk');
await A.waitForTimeout(300);
console.log('点「知道了」后仍显示:', await A.locator('.role-intro.show').count());

// 身份按钮仍可随时复查
await A.click('#roleBtn');
await A.waitForTimeout(300);
const sheetTitle = await A.locator('.sheet-mask.show .sheet-title').textContent().catch(() => '');
console.log('身份按钮复查:', sheetTitle || '(无)');
await A.screenshot({ path: 'shots/role-intro-card.png' });

console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无');
await browser.close();
