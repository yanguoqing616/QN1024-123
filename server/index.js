import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
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

      const joined = room.join(socket, name, playerId);
      if (!joined) {
        reply(socket, { t: 'error', msg: room.phase === 'lobby' ? '房间已满' : '这局已经开始了' });
        room = null;
        return;
      }
      player = joined;
      player.socket = socket;
      reply(socket, { t: 'joined', playerId: player.id, code: room.code });
      room.sync();

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
        room.setReady(player, msg.value);
        break;

      case 'start': {
        const r = room.start(player);
        if (!r.ok) reply(socket, { t: 'error', msg: r.msg });
        break;
      }

      case 'rematch': {
        const r = room.rematch(player);
        if (!r.ok) reply(socket, { t: 'error', msg: r.msg });
        else room.sync();
        break;
      }

      case 'action':
        room.submit(player, msg);
        break;

      case 'rtc': {
        const target = room.players.find((p) => p.id === msg.to);
        if (target) reply(target.socket, { t: 'rtc', from: player.id, data: msg.data });
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
    for (const p of room.players) {
      if (!p.isAI && p.id !== player.id) reply(p.socket, { t: 'peerLeave', id: player.id });
    }
    if (room.humans.filter((p) => p.connected).length === 0) {
      setTimeout(() => {
        const live = rooms.get(room.code);
        if (live && live.humans.filter((p) => p.connected).length === 0) {
          live.running = false;
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

server.listen(PORT, () => {
  console.log(`狼人杀服务已启动: http://localhost:${PORT}`);
});
