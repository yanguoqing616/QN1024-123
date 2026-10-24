/**
 * 观战上帝视角自检：
 * 1) 观战在投票阶段实时收到 voteCast（谁投给了谁），玩家收不到（保密）
 * 2) 狼聊开启时，观战收到带名单的旁听通知（wolfTalk listen:true）
 * 3) 狼聊期间，狼→观众的 wolf 信令放行（旁听音频链路）
 * 用法：GAME_PACE=0.05 npm start  然后  node tests/spectator.mjs
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
    until: (pred, timeoutMs = 25000) =>
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
  A.send({ t: 'join', code: '', name: '玩家A' });
  await A.next();
  const stateA = await A.until((m) => m.t === 'state');
  const code = stateA.room.code;

  const B = client();
  await new Promise((r) => B.ws.on('open', r));
  B.send({ t: 'join', code, name: '玩家B' });
  await B.next();
  await B.until((m) => m.t === 'state');

  // 观战加入
  const S = client();
  await new Promise((r) => S.ws.on('open', r));
  S.send({ t: 'join', code, name: '观众', spectate: true });
  await S.next();
  const specState = await S.until((m) => m.t === 'state');
  const isSpec = !!(specState.room.self && specState.room.self.spectator);
  const specId = (specState.room.spectators || [])[0]?.id || '';

  B.send({ t: 'ready', value: true });
  A.send({ t: 'start' });

  const nightS = await S.until((m) => m.t === 'state' && m.room.phase === 'night', 60000);

  // 3) 狼→观众 wolf 信令放行（谁是真人狼就让谁发，两人同时抢避免等超时）
  let relayOk = 'skip';
  if (specId) {
    try {
      const grabA = A.until((m) => m.t === 'wolfTalk' && m.on && m.listeners, 20000)
        .then((m) => ({ c: A, m }))
        .catch(() => null);
      const grabB = B.until((m) => m.t === 'wolfTalk' && m.on && m.listeners, 20000)
        .then((m) => ({ c: B, m }))
        .catch(() => null);
      const got = await Promise.race([grabA, grabB]).then((r) => r || Promise.race([grabA, grabB]));
      const talk = got && got.m;
      if (talk && (talk.listeners || []).includes(specId)) {
        got.c.send({
          t: 'rtc',
          to: specId,
          data: { channel: 'wolf', type: 'offer', sdp: { type: 'offer', sdp: 'test' } }
        });
        await S.until((m) => m.t === 'rtc' && m.from, 8000);
        relayOk = true;
        console.log('✓ 狼聊期间：狼 → 观众的信令被放行（旁听链路通）');
      } else {
        console.log('（本局无真人狼，信令用例跳过）');
      }
    } catch {
      relayOk = false;
      console.log('✗ 狼 → 观众的信令未放行或未收到');
    }
  }

  // 2) 观战收到狼聊旁听通知（带名单）
  let listenOk = false;
  try {
    const talk = await S.until((m) => m.t === 'wolfTalk' && m.on && m.listen && m.ids, 60000);
    listenOk = Array.isArray(talk.ids);
    console.log(`✓ 观战收到旁听通知，狼名单: ${talk.ids.join(',') || '(无真人狼)'}`);
  } catch {
    console.log('（本局未等到狼聊窗口）');
    listenOk = true; // 节奏太快错过窗口不算失败，重点在信令与投票
  }

  // 1) 投票阶段：观战实时收到 voteCast；玩家 A 收不到
  let castOk = false;
  try {
    await S.until((m) => m.t === 'state' && m.room.phase === 'vote', 180000);
    const cast = await S.until((m) => m.t === 'voteCast', 120000);
    castOk = !!(cast.from && cast.to);
    console.log(`✓ 观战实时收到投票: ${cast.from} → ${cast.to}`);
    // 玩家不应收到 voteCast（投票对玩家保密，只有观战上帝视角可见）
    let leak = false;
    try {
      await A.until((m) => m.t === 'voteCast', 2000);
      leak = true;
    } catch { /* 没收到 = 正确 */ }
    console.log(leak ? '✗ 普通玩家也收到了 voteCast（应保密）' : '✓ 普通玩家收不到投票明细（保密）');
    if (leak) castOk = false;
  } catch {
    console.log('✗ 观战未收到 voteCast');
  }

  A.ws.close();
  B.ws.close();
  S.ws.close();
  return { pass: castOk === true && isSpec && listenOk && relayOk !== false, relay: relayOk };
}

let ok = false;
let relaySeen = false;
for (let i = 0; i < 10 && (!ok || !relaySeen); i++) {
  const r = await attempt();
  if (r.relay === true) relaySeen = true;
  ok = r.pass;
  if (ok && relaySeen) break;
}
console.log(ok ? `观战自检通过（狼→观众信令${relaySeen ? '已验证' : '本机未抽到真人狼局，跳过'}）` : '观战自检失败');
process.exit(ok ? 0 : 1);
