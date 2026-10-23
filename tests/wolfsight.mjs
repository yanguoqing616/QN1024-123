/**
 * 狼人视觉自检：狼人应该在圆桌上看到队友的「狼队友」徽标，好人看不到
 * 用法：npm start  然后  node tests/wolfsight.mjs
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

let result = null;
for (let i = 0; i < 12 && result === null; i++) {
  await A.goto(BASE);
  await A.fill('#nameInput', '阿伟');
  await A.click('#createBtn');
  await A.waitForSelector('#lobbyScreen.on', { timeout: 8000 });
  await A.click('#startBtn');
  await A.waitForSelector('.role-intro.show', { timeout: 8000 });
  const role = (await A.locator('#roleIntroName').textContent()).trim();
  await A.click('#roleIntroOk');
  await A.waitForTimeout(600);

  const chips = await A.locator('#seats .seat-role:not([hidden])').allTextContents();
  console.log(`第 ${i + 1} 局 · 我的身份 ${role} · 座位身份牌: ${chips.join('/') || '(无)'}`);

  if (role === '狼人') {
    const wolfMarks = chips.filter((c) => c === '狼人' || c === '狼队友').length;
    // 自己 1 个 + 至少 1 个队友徽标（若另一狼也是真人队友， mates 只含非自己的）
    result = wolfMarks >= 2;
    await A.screenshot({ path: 'shots/wolfsight.png' });
    console.log(result
      ? '✓ 狼人视角：自己 + 队友的狼人徽标都可见'
      : '✗ 狼人视角没看到队友徽标');
  } else {
    const wolfLeaks = chips.filter((c) => c === '狼人' || c === '狼队友').length;
    if (wolfLeaks > (role === '村民' ? 0 : 0)) {
      console.log(`✗ ${role}却看到了狼人徽标！`);
      result = false;
    }
  }
}
console.log(result === null ? '12 局内没抽到狼人（未发现泄露）' : result ? '通过' : '失败');
console.log('页面错误:', errors.length ? errors.slice(0, 3) : '无');
await browser.close();
process.exit(result === false ? 1 : 0);
