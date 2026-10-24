/**
 * 内容风控自检：
 * 1) 昵称：涉黄/涉恐/涉政 → 拒绝加入，返回 error
 * 2) 正常昵称正常进入
 * 3) 发言文本违规 → 房间被强制关闭（shutdown），玩家收到消息、房间失效
 * 用法：npm start  然后  node tests/moderation.mjs
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
    next: (timeoutMs = 8000) =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        const timer = setTimeout(() => reject(new Error('等待消息超时')), timeoutMs);
        waiters.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      }),
    until: (pred, timeoutMs = 12000) =>
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

let failures = 0;
function check(ok, label) {
  console.log((ok ? '✓ ' : '✗ ') + label);
  if (!ok) failures++;
}

// 1) 昵称风控：三类违规昵称都应被拒
for (const [bad, cat] of [
  ['约炮男神', '涉黄'],
  ['卖军火王', '涉恐'],
  ['台独分子', '涉政'],
  ['法轮功大法', '涉政']
]) {
  const c = client();
  await new Promise((r) => c.ws.on('open', r));
  c.send({ t: 'join', code: '', name: bad });
  const msg = await c.until((m) => m.t === 'error' || m.t === 'joined', 6000);
  check(msg.t === 'error' && /请更换|敏感|涉/.test(msg.msg || ''), `违规昵称「${bad}」被拒：${msg.msg || ''}`);
  c.ws.close();
}

// 2) 正常昵称进入
{
  const c = client();
  await new Promise((r) => c.ws.on('open', r));
  c.send({ t: 'join', code: '', name: '小明' });
  const msg = await c.until((m) => m.t === 'joined', 6000);
  check(!!msg.playerId, '正常昵称「小明」进入成功');
  c.ws.close();
}

// 3) 发言违规 → 关房
{
  const A = client();
  await new Promise((r) => A.ws.on('open', r));
  A.send({ t: 'join', code: '', name: '房主' });
  await A.next();
  const state = await A.until((m) => m.t === 'state');
  const code = state.room.code;

  const B = client();
  await new Promise((r) => B.ws.on('open', r));
  B.send({ t: 'join', code, name: '玩家B' });
  await B.next();
  await B.until((m) => m.t === 'state');
  B.send({ t: 'ready', value: true });
  A.send({ t: 'start' });

  // 等进入需要发言的阶段：轮到真人发言会下发 turn(speak)；或直接等待任意 turn
  let spoke = false;
  try {
    const turn = await B.until((m) => m.t === 'turn' && m.kind === 'speak', 180000);
    B.send({ t: 'action', kind: 'speak', text: '我要卖枪，搞一场恐怖袭击' });
    spoke = true;
    const shut = await B.until((m) => m.t === 'shutdown', 8000);
    check(!!shut.reason, `发言违规关房：${shut.reason || ''}`);

    // 房间已失效：新客户端无法再进
    const C = client();
    await new Promise((r) => C.ws.on('open', r));
    C.send({ t: 'join', code, name: '新人' });
    const err = await C.until((m) => m.t === 'error' || m.t === 'joined', 6000);
    check(err.t === 'error', '关房后房间失效，新人无法进入');
    C.ws.close();
  } catch (e) {
    check(false, '未进入发言阶段或关房未触发：' + e.message);
  }

  A.ws.close();
  B.ws.close();
}

console.log(failures === 0 ? '风控自检全部通过' : `风控自检有 ${failures} 处失败`);
process.exit(failures === 0 ? 0 : 1);
