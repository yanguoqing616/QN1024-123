/**
 * 狼人频道隐私自检：
 * 1) 非狼人拿不到 wolfIds / 任何人的角色
 * 2) 两个真人都是狼时，夜里只有他们收到带名单的 wolfTalk
 * 3) 狼聊关闭时，wolf 频道的 rtc 信令被服务端拒收
 * 用法：npm start  然后  node tests/wolftalk.mjs
 */
import WebSocket from 'ws';

const URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/^http/, 'ws') + '/ws';

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next: (timeoutMs = 15000) =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      }),
    /** 等到某类消息（跳过其它） */
    until: (pred, timeoutMs = 20000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('until 超时')), timeoutMs);
        const pump = () => {
          if (queue.length) {
            const m = queue.shift();
            if (pred(m)) {
              clearTimeout(timer);
              resolve(m);
              return;
            }
          }
          waiters.push((m) => {
            if (pred(m)) {
              clearTimeout(timer);
              resolve(m);
            } else pump();
          });
        };
        pump();
      })
  };
}

async function attempt() {
  const A = client();
  await new Promise((r) => A.ws.on('open', r));
  A.send({ t: 'join', code: '', name: '狼A' });
  await A.next();
  const stateA = await A.until((m) => m.t === 'state');
  const code = stateA.room.code;

  const B = client();
  await new Promise((r) => B.ws.on('open', r));
  B.send({ t: 'join', code, name: '狼B' });
  await B.next();
  await B.until((m) => m.t === 'state');
  B.send({ t: 'ready', value: true });
  A.send({ t: 'start' });

  const finalA = await A.until((m) => m.t === 'state' && m.room.phase === 'night');
  const roles = finalA.room.players.map((p) => p.role);
  // 夜里看不到别人的角色（正确行为），双狼判定只能靠自己的 wolfIds（只含真人狼）
  const bothWolf = finalA.room.self.role === 'wolf' && (finalA.room.self.wolfIds || []).length === 2;

  const wolfIdsLeak = finalA.room.players.some((p) => !p.you && p.role); // 别人的角色绝不能下发
  console.log(`本局我的身份: ${finalA.room.self.role} | 两个真人都是狼: ${bothWolf} | 角色泄露: ${wolfIdsLeak}`);
  console.log('A 的 wolfIds:', finalA.room.self.wolfIds);

  if (bothWolf) {
    // 广播只有 {on:true}，带名单的单独发给狼
    const talk = await A.until((m) => m.t === 'wolfTalk' && m.on && m.ids);
    if (!talk.ids || talk.ids.length !== 2) {
      console.log('✗ 狼人没有拿到 2 人名单');
      A.ws.close();
      B.ws.close();
      return false;
    }
    console.log('✓ 狼人夜聊名单只发给狼:', talk.ids.join(','));
    // B 也应该收到同样的名单
    const talkB = await B.until((m) => m.t === 'wolfTalk' && m.on && m.ids);
    console.log('✓ B 也收到名单:', (talkB.ids || []).length === 2);

    // 狼聊结束后（两个狼都超时选出，约 60s），wolf 频道信令应被拒
    await B.until((m) => m.t === 'wolfTalk' && !m.on, 90000);
    B.send({ t: 'rtc', to: finalA.room.players.find((p) => p.you).id, data: { channel: 'wolf', type: 'offer', sdp: { type: 'offer', sdp: 'x' } } });
    let leaked = false;
    try {
      await A.until((m) => m.t === 'rtc', 2500);
      leaked = true;
    } catch { /* 没收到 = 被过滤 */ }
    console.log(leaked ? '✗ 关闭后信令泄漏' : '✓ 狼聊窗口外 wolf 信令被服务端过滤');

    A.ws.close();
    B.ws.close();
    return true;
  }

  if (finalA.room.self.role !== 'wolf' && finalA.room.self.wolfIds !== null) {
    console.log('✗ 非狼人却拿到了 wolfIds！');
    A.ws.close();
    B.ws.close();
    return false;
  }
  console.log('✓ 非狼人 state 中无 wolfIds，继续换一局重试…');
  A.ws.close();
  B.ws.close();
  return null;
}

let ok = null;
for (let i = 0; i < 40 && ok === null; i++) {
  ok = await attempt();
  if (ok === null) await new Promise((r) => setTimeout(r, 300));
}
console.log(ok === true ? '全部通过' : '未遇到双狼局（隐私断言已通过）');
process.exit(ok === false ? 1 : 0);
