/**
 * 退出房间 + 房主转移 + 扩充词库 自检：
 * 1) 常见辱骂/低俗昵称应被拒（扩充词库后）
 * 2) 正常昵称放行
 * 3) 大厅房主退出 → 下一个序号的真人自动成为房主、座位重排
 * 用法：npm start 后  node tests/leavequit.mjs
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
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      }),
    until: (pred, timeoutMs = 12000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('until 超时')), timeoutMs);
        const pump = () => {
          if (queue.length) {
            const m = queue.shift();
            if (pred(m)) { clearTimeout(timer); resolve(m); return; }
          }
          waiters.push((m) => { if (pred(m)) { clearTimeout(timer); resolve(m); } else pump(); });
        };
        pump();
      })
  };
}

let failures = 0;
const check = (ok, label) => {
  console.log((ok ? '✓ ' : '✗ ') + label);
  if (!ok) failures++;
};

// 1) 扩充词库后的常见违禁昵称
for (const bad of ['傻逼', '草泥马', '你妈的', '卧槽', '操你妈', '婊子', '卖枪的', '冰毒贩子', '反党分子']) {
  const c = client();
  await new Promise((r) => c.ws.on('open', r));
  c.send({ t: 'join', code: '', name: bad });
  const msg = await c.until((m) => m.t === 'error' || m.t === 'joined', 6000);
  check(msg.t === 'error', `违规昵称「${bad}」被拒：${msg.msg || ''}`);
  c.ws.close();
}

// 2) 正常昵称放行
{
  const c = client();
  await new Promise((r) => c.ws.on('open', r));
  c.send({ t: 'join', code: '', name: '小红' });
  const msg = await c.until((m) => m.t === 'joined', 6000);
  check(!!msg.playerId, '正常昵称「小红」进入成功');
  c.ws.close();
}

// 3) 大厅房主退出 → 房主转移 + 座位重排
{
  const A = client();
  await new Promise((r) => A.ws.on('open', r));
  A.send({ t: 'join', code: '', name: '房主' });
  const joinedA = await A.until((m) => m.t === 'joined');
  const roomCode = joinedA.code;
  await A.until((m) => m.t === 'state');

  const B = client();
  await new Promise((r) => B.ws.on('open', r));
  B.send({ t: 'join', code: roomCode, name: '玩家B' });
  const joinedB = await B.until((m) => m.t === 'joined');
  const stateB0 = await B.until((m) => m.t === 'state');
  const bSeatBefore = stateB0.room.self.seat;

  // A（房主）退出
  A.send({ t: 'leave' });
  A.ws.close();

  // B 应收到新 state：自己是房主、座位号前移
  const stateB1 = await B.until((m) => m.t === 'state' && m.room.hostId === joinedB.playerId, 8000);
  const meAfter = stateB1.room.self;
  check(stateB1.room.hostId === joinedB.playerId, `房主退出后转移给 B（原 ${bSeatBefore} 号）`);
  check(meAfter.seat === 0, `B 座位号前移为 0 号（原 ${bSeatBefore} 号）：现 ${meAfter.seat} 号`);
  check(meAfter.isHost === true, 'B 成为新主持人（isHost=true）');
  B.ws.close();
}

console.log(failures === 0 ? '退出/房主转移/词库自检全部通过' : `有 ${failures} 处失败`);
process.exit(failures === 0 ? 0 : 1);
