import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from './game.js';
import { synthesize, HOST_VOICE, PLAYER_VOICES, probe, ensureReady, ttsReady, warmup } from './tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, tts: ttsReady() }));

// 神经语音：/tts?text=...&v=zh-CN-XiaoxiaoNeural
app.get('/tts', async (req, res) => {
  const ok = await ensureReady();
  if (!ok) {
    res.status(503).end('tts unavailable');
    return;
  }
  const text = String(req.query.text || '').slice(0, 200);
  const voice = PLAYER_VOICES.includes(req.query.v) || req.query.v === HOST_VOICE ? String(req.query.v) : HOST_VOICE;
  if (!text.trim()) {
    res.status(400).end('empty');
    return;
  }
  try {
    const buf = await synthesize(text, voice);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(buf);
  } catch (err) {
    res.status(503).end('tts failed');
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Room>} */
const rooms = new Map();

function newRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function reply(socket, msg) {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  let room = null;
  let player = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'join') {
      const name = String(msg.name || '').slice(0, 8);
      const playerId = msg.playerId ? String(msg.playerId) : null;
      let code = msg.code ? String(msg.code).trim() : '';

      if (code) {
        room = rooms.get(code) || null;
        if (!room) {
          reply(socket, { t: 'error', msg: '房间不存在或已结束' });
          return;
        }
      } else {
        code = newRoomCode();
        room = new Room(code);
        rooms.set(code, room);
      }

      let joined = room.join(socket, name, playerId, !!msg.spectate);
      // 房间满了或已经开局 → 自动转成观众，不影响人家打
      if (!joined && room.phase !== 'lobby') joined = room.addSpectator(socket, name);
      if (!joined && room.players.length >= 6) joined = room.addSpectator(socket, name);
      if (!joined) {
        reply(socket, { t: 'error', msg: '房间已满' });
        room = null;
        return;
      }
      player = joined;
      player.socket = socket;
      reply(socket, {
        t: 'joined',
        playerId: player.id,
        code: room.code,
        spectator: !!player.isSpectator
      });
      room.sync();

      if (player.isSpectator) return; // 观众不建语音连接

      const others = room.players.filter((p) => !p.isAI && p.id !== player.id).map((p) => p.id);
      reply(socket, { t: 'peers', peers: others });
      for (const p of room.players) {
        if (!p.isAI && p.id !== player.id) reply(p.socket, { t: 'peerJoin', id: player.id });
      }
      return;
    }

    if (!room || !player) {
      reply(socket, { t: 'error', msg: '请先加入房间' });
      return;
    }

    switch (msg.t) {
      case 'ready':
        if (!player.isSpectator) room.setReady(player, msg.value);
        break;

      case 'start': {
        if (player.isSpectator) break;
        const r = room.start(player, msg.voiceStyle);
        if (!r.ok) reply(socket, { t: 'error', msg: r.msg });
        break;
      }

      case 'rematch': {
        if (player.isSpectator) break;
        const r = room.rematch(player);
        if (!r.ok) reply(socket, { t: 'error', msg: r.msg });
        else room.sync();
        break;
      }

      case 'action':
        if (!player.isSpectator) room.submit(player, msg);
        break;

      case 'rtc': {
        let target = room.players.find((p) => p.id === msg.to);
        if (!target) target = room.spectators.find((s) => s.id === msg.to);
        if (!target || player.isSpectator) break;
        const channel = msg.data && msg.data.channel;
        if (channel === 'wolf') {
          // 狼人频道：狼↔狼在狼聊窗口内放行；狼→观众也放行（观战旁听密谈）
          const ok = target.isSpectator
            ? room.wolfTalk && player.alive && player.role === 'wolf'
            : room.canWolfTalk(player, target);
          if (!ok) break;
        } else if (target.isSpectator) {
          break; // 普通频道不接观众，观众只旁听狼聊
        }
        reply(target.socket, { t: 'rtc', from: player.id, data: msg.data });
        break;
      }

      case 'leave':
        room.leave(player);
        room.sync();
        player = null;
        room = null;
        break;

      default:
        break;
    }
  });

  socket.on('close', () => {
    if (!room || !player) return;
    room.leave(player);
    room.sync();
    for (const p of [...room.players, ...room.spectators]) {
      if (!p.isAI && p.id !== player.id) reply(p.socket, { t: 'peerLeave', id: player.id });
    }
    if (room.connectedHumans.length === 0) {
      setTimeout(() => {
        const live = rooms.get(room.code);
        if (live && live.connectedHumans.length === 0) {
          live.running = false;
          live.closeWolfTalk();
          rooms.delete(live.code);
        }
      }, 60000);
    }
  });

  socket.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((socket) => {
    if (!socket.isAlive) {
      socket.terminate();
      return;
    }
    socket.isAlive = false;
    socket.ping();
  });
}, 30000);

// 启动后后台预热：探测可用性 + 预先合成主持人固定台词
setTimeout(() => {
  warmup()
    .then(() => console.log('[tts] 神经语音就绪:', ttsReady()))
    .catch(() => {});
}, 300);

server.listen(PORT, () => {
  console.log(`狼人杀服务已启动: http://localhost:${PORT}`);
  probe().then((ok) => console.log(ok ? '[tts] 神经语音已就绪' : '[tts] 神经语音不可用，将回退浏览器语音'));
});
