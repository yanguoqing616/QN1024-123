/**
 * 本地演示：开两个可见浏览器窗口，一个真人（自动操作）+ 4 个 AI 打一局
 * 用法：npm start  然后另开终端  node tests/demo.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SLOW = Number(process.env.SLOWMO || 80);

const browser = await chromium.launch({
  headless: false,
  slowMo: SLOW,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
});

const ctxA = await browser.newContext({ viewport: { width: 380, height: 780 } });
const ctxB = await browser.newContext({ viewport: { width: 380, height: 780 } });
const A = await ctxA.newPage();
const B = await ctxB.newPage();

for (const p of [A, B]) p.on('pageerror', (e) => console.log('页面错误:', String(e)));

await A.goto(BASE);
await A.fill('#nameInput', '阿伟');
await A.click('#createBtn');
await A.waitForSelector('#lobbyScreen.on');
const code = (await A.locator('#roomCode').textContent()).trim();
console.log(`房间号 ${code}，第二个人正在加入…`);

await B.goto(BASE);
await B.fill('#nameInput', '小圆');
await B.fill('#codeInput', code);
await B.click('#joinBtn');
await B.waitForSelector('#lobbyScreen.on');

await B.click('#readyBtn');
await A.waitForTimeout(400);
await A.click('#startBtn');
console.log('开局，开始自动演示…');

async function drive(page) {
  const roleOk = page.locator('.role-intro.show #roleIntroOk');
  if (await roleOk.count()) { await roleOk.click(); return; }
  const vconfirm = page.locator('#voteConfirmBtn:not([disabled])');
  if (await vconfirm.count()) { await vconfirm.click(); return; }
  const sheet = page.locator('.sheet-mask.show #sheet button[data-i]').first();
  if (await sheet.count()) { await sheet.click(); return; }
  for (const id of ['#noHealBtn', '#noPoisonBtn']) {
    const el = page.locator(id);
    if (await el.count()) { await el.click(); return; }
  }
  const agree = page.locator('#agreeBtn');
  if (await agree.count()) { await agree.click(); return; }
  const input = page.locator('#speakInput');
  if (await input.count()) {
    await input.fill('我觉得老陈发言有问题，这票我投他。');
    await page.click('#sendBtn');
    return;
  }
  const sel = page.locator('.seat.selectable').first();
  if (await sel.count()) { await sel.click(); return; }
}

let doneA = false;
let doneB = false;
for (let i = 0; i < 2400; i++) {
  if (!doneA) { await drive(A); doneA = (await A.locator('#result.show').count()) > 0; }
  if (!doneB) { await drive(B); doneB = (await B.locator('#result.show').count()) > 0; }
  if (doneA && doneB) break;
  await A.waitForTimeout(180);
}

console.log('本局结束，两个窗口会停在结算页，可以手动点「再来一局」继续玩。');
await A.waitForTimeout(1500);
if (!process.env.KEEP_OPEN) await browser.close();
