import { Voice } from './voice.js';
import { avatarSvg } from './avatar.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  ws: null,
  voice: null,
  playerId: localStorage.getItem('ww_pid') || null,
  name: localStorage.getItem('ww_name') || '',
  room: null,
  turn: null,
  turnSeq: 0,
  soundOn: true,
  intentionalClose: false,
  reconnectCode: null,
  dockKey: '',
  voice: null,
  spectate: false,
  spectator: false,
  votePick: null,
  wolfKey: ''
};

/* =========================================================
   连接
   ========================================================= */
function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

function connect(code, opts) {
  if (opts && opts.spectate != null) S.spectate = !!opts.spectate;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      t: 'join',
      code: code || '',
      name: S.name,
      playerId: S.playerId,
      spectate: !!S.spectate
    }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (S.intentionalClose) return;
    setChip('已断开');
    setTimeout(() => connect(S.reconnectCode), 1500);
  });
}

function onMessage(msg) {
  switch (msg.t) {
    case 'joined':
      S.playerId = msg.playerId;
      S.reconnectCode = msg.code;
      S.spectator = !!msg.spectator;
      localStorage.setItem('ww_pid', msg.playerId);
      history.replaceState(null, '', '?room=' + msg.code);
      setChip('已连接');
      if (msg.spectator) toast('以观战身份进入，可以看到所有人的身份');
      break;

    case 'state':
      S.room = msg.room;
      S.reconnectCode = msg.room.code;
      // 新一轮投票开始时，清空观战视角的实时票数记录
      if (msg.room.phase === 'vote' && S.lastPhase !== 'vote') S.voteCasts = [];
      S.lastPhase = msg.room.phase;
      render();
      renderSpeakTimer();
      applyWolfTalk();
      break;

    case 'speakTimer':
      if (S.room) {
        S.room.speak = msg.seat == null
          ? null
          : { seat: msg.seat, name: msg.name, total: msg.total, deadline: msg.deadline };
      }
      renderSpeakTimer();
      break;

    case 'wolfTalk':
      if (S.room) S.room.wolfTalk = !!msg.on;
      applyWolfTalk(msg.ids || null, msg.listeners || null);
      break;

    case 'voteCast':
      // 观战上帝视角：实时看到谁投给了谁
      if (!S.voteCasts) S.voteCasts = [];
      S.voteCasts.push({ from: msg.from, to: msg.to });
      renderDock(true);
      break;

    case 'host':
      sayHost(msg.text, msg.voice);
      break;

    case 'speech':
      addSpeech(msg);
      break;

    case 'lastWords':
      addLastWords(msg);
      break;

    case 'turn':
      S.turn = msg;
      S.turnSeq += 1;
      S.votePick = null;
      closeRoleIntro(); // 轮到自己操作，先把身份弹层让开
      render();
      break;

    case 'turnEnd':
      S.turn = null;
      render();
      break;

    case 'note':
      openSheet({
        title: msg.title || '提示',
        desc: msg.text || '',
        actions: [{ label: '知道了', value: 1, primary: true }]
      });
      break;

    case 'over':
      hideBubble();
      showResult();
      break;

    case 'begin':
      hideBubble();
      break;

    case 'error':
      toast(msg.msg || '操作失败');
      setChip('已连接');
      break;

    case 'peers':
      if (S.voice) S.voice.setPeers(msg.peers || []);
      break;

    case 'peerJoin':
      if (S.voice) S.voice.addPeer(msg.id, false);
      break;

    case 'peerLeave':
      if (S.voice) S.voice.removePeer(msg.id);
      break;

    case 'rtc':
      if (S.voice) S.voice.onSignal(msg.from, msg.data);
      break;

    default:
      break;
  }
}

/* =========================================================
   入口
   ========================================================= */
$('nameInput').value = S.name;
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('codeInput').value = urlRoom;

function readName() {
  const name = $('nameInput').value.trim().slice(0, 8);
  if (!name) {
    toast('先起个昵称吧');
    $('nameInput').focus();
    return null;
  }
  S.name = name;
  localStorage.setItem('ww_name', name);
  return name;
}

$('createBtn').addEventListener('click', () => {
  if (!readName()) return;
  connect('', { spectate: false });
});

$('joinBtn').addEventListener('click', () => {
  if (!readName()) return;
  const code = $('codeInput').value.trim();
  if (!/^\d{4}$/.test(code)) {
    toast('房间号是 4 位数字');
    return;
  }
  connect(code, { spectate: false });
});

$('watchBtn').addEventListener('click', () => {
  if (!readName()) return;
  const code = $('codeInput').value.trim();
  if (!/^\d{4}$/.test(code)) {
    toast('观战也要先填 4 位房间号');
    $('codeInput').focus();
    return;
  }
  connect(code, { spectate: true });
});

if (urlRoom && S.name) {
  connect(urlRoom);
}

/* =========================================================
   渲染
   ========================================================= */
function render() {
  const r = S.room;
  if (!r) return;

  const spec = !!(r.self && r.self.spectator);
  S.spectator = spec;
  const inLobby = r.phase === 'lobby';
  $('entryScreen').classList.toggle('on', false);
  $('lobbyScreen').classList.toggle('on', inLobby);
  $('gameScreen').classList.toggle('on', !inLobby);
  document.body.classList.toggle('night', r.phase === 'night');
  $('watchTag').hidden = !spec;

  $('roleBtn').hidden = spec || !r.self || !r.self.role;
  if (r.self && r.self.role) $('roleBtn').textContent = roleName(r.self.role);

  if (inLobby) { setChip(spec ? '观战中' : '等待开'); renderLobby(); }
  else renderGame();

  // 投票阶段 / 轮到点选目标时，收起上一轮发言气泡，别挡住要投的人和座位高亮
  const picking = S.turn && ['vote', 'wolfPick', 'seerPick', 'poisonPick'].includes(S.turn.kind);
  if (r.phase === 'vote' || picking) hideBubble();

  renderSpeakTimer();
  maybeRoleIntro();
}

function roleName(role) {
  return { wolf: '狼人', villager: '村民', seer: '预言家', witch: '女巫' }[role] || '';
}

function setChip(text) {
  $('dayChip').textContent = text;
}

function setStage(label, sub) {
  $('tableLabel').textContent = label;
  $('tableSub').textContent = sub;
}

/* ---------------- 房间 ---------------- */
function renderLobby() {
  const r = S.room;
  $('roomCode').textContent = r.code;

  const rows = [];
  for (let i = 0; i < 6; i++) {
    const p = r.players[i];
    if (p) {
      rows.push(`
        <div class="lobby-row ${p.you ? 'you' : ''}">
          <div class="lobby-avatar">${avatarSvg(p.seat, 40)}</div>
          <div class="lobby-name">${p.seat + 1}号 ${esc(p.name)}${p.you ? '（你）' : ''}
            <small>${p.isAI ? 'AI 补位' : '真人玩家'}${p.you && r.hostId === undefined ? '' : ''}</small>
          </div>
          <span class="tag ${p.ready ? 'ok' : ''}">${p.ready ? '已准备' : '未准备'}</span>
        </div>`);
    } else {
      rows.push(`
        <div class="lobby-row">
          <div class="lobby-avatar">·</div>
          <div class="lobby-name">${i + 1}号 空位<small>开局后由 AI 补上</small></div>
          <span class="tag ai">等待</span>
        </div>`);
    }
  }
  $('lobbyList').innerHTML = rows.join('');

  const key = `lobby:${r.self.ready}:${r.self.isHost}:${S.voiceStyle}:${S.spectator}:${(r.spectators || []).length}:${r.players.filter((p) => p.you).length}`;
  if (S.dockKey === key) return;
  S.dockKey = key;

  if (S.spectator) {
    $('lobbyDock').innerHTML = `
      <div class="dock-hint">你正在观战，房主开局后自动进入对局</div>
      <p class="dock-note">${r.players.filter((p) => !p.isAI).length} 位真人 · ${(r.spectators || []).length} 位观众 · 观战不占座位</p>`;
    return;
  }

  $('lobbyDock').innerHTML = `
    <button class="block-btn ${r.self.ready ? '' : 'primary'}" id="readyBtn">${r.self.ready ? '取消准备' : '我已准备就绪'}</button>
    <button class="block-btn ${r.self.isHost ? 'primary' : 'outline'}" id="startBtn">${r.self.isHost ? '开始游戏' : '等待房主开局'}</button>
    <p class="dock-note">${r.players.filter((p) => !p.isAI).length} 位真人 · ${(r.spectators || []).length} 位观众 · 不足 6 人由 AI 补齐</p>
    <p class="dock-note">语音：${S.voiceStyle === 'system' ? '系统音色' : S.voiceStyle === 'mandarin' ? '真人·普通话' : '真人·带方言（东北话 / 陕西话）'}</p>
  `;

  $('readyBtn').addEventListener('click', () => send({ t: 'ready', value: !r.self.ready }));
  $('startBtn').addEventListener('click', () => {
    if (!r.self.isHost) {
      toast('等房主开局');
      return;
    }
    send({ t: 'start', voiceStyle: S.voiceStyle === 'system' ? 'dialect' : S.voiceStyle });
  });
}

/* ---------------- 对局 ---------------- */
let seatEls = [];

function buildSeats(count) {
  $('seats').innerHTML = '';
  seatEls = [];
  for (let i = 0; i < count; i++) {
    const ang = (-90 + (i * 360) / count) * (Math.PI / 180);
    const el = document.createElement('div');
    el.className = 'seat';
    el.style.left = 50 + 40 * Math.cos(ang) + '%';
    el.style.top = 50 + 40 * Math.sin(ang) + '%';
    el.style.animationDelay = i * 45 + 'ms';
    el.innerHTML = `<div class="seat-avatar"></div><div class="seat-num">${i + 1}</div><div class="seat-role" hidden></div><div class="seat-name"></div>`;
    el.addEventListener('click', () => onSeatClick(i));
    $('seats').appendChild(el);
    seatEls.push(el);
  }
}

function renderGame() {
  const r = S.room;
  if (seatEls.length !== r.players.length) buildSeats(r.players.length);

  const turn = S.turn;
  const pickable = turn && ['wolfPick', 'seerPick', 'poisonPick', 'vote'].includes(turn.kind);

  r.players.forEach((p, i) => {
    const el = seatEls[i];
    const cls = ['seat'];
    if (p.you) cls.push('me');
    if (!p.alive) cls.push('dead');
    if (r.speakingSeat === p.seat) cls.push('speaking');
    if (pickable && p.alive && !p.you && !S.spectator) cls.push('selectable');
    if (S.votePick === p.seat) cls.push('picked');
    el.className = cls.join(' ');

    const avatar = el.querySelector('.seat-avatar');
    const votesHtml = r.votesShown && p.votes > 0 ? `<span class="seat-votes">${p.votes}</span>` : '';
    avatar.innerHTML = avatarSvg(p.seat, 55) +
      (p.isAI ? '<span class="ai-badge">AI</span>' : '') + votesHtml;

    // 身份牌：自己的一直挂着；狼人能看到狼队友的；观众 / 结算时全场可见
    const isWolfMate = !p.you &&
      r.self.role === 'wolf' &&
      (r.self.mates || []).some((m) => m.seat === p.seat);
    const roleEl = el.querySelector('.seat-role');
    const showRole = (!!p.role && (p.you || S.spectator || r.phase === 'end')) || isWolfMate;
    roleEl.hidden = !showRole;
    if (showRole) {
      roleEl.textContent = isWolfMate ? '狼队友' : roleName(p.role);
      roleEl.className = 'seat-role ' + (p.role === 'wolf' || isWolfMate ? 'wolf' : 'good');
    }

    el.querySelector('.seat-name').textContent = `${p.seat + 1}号 ${p.name}`;
  });

  if (r.phase === 'night') {
    setChip(`第 ${r.day} 夜`);
    setStage(`第 ${r.day} 夜`, S.spectator ? '观战中 · 天黑请闭眼' : '天黑请闭眼，别出声');
  } else if (r.phase === 'vote') {
    setChip(`第 ${r.day} 天 · 投票`);
    setStage(`第 ${r.day} 天`, '投票放逐一名玩家');
  } else if (r.phase === 'day') {
    setChip(`第 ${r.day} 天`);
    setStage(`第 ${r.day} 天`, S.spectator ? '观战中 · 轮流发言' : r.self.alive ? '天亮了，轮流发言' : '观战中 · 你已出局');
  } else if (r.phase === 'end') {
    setChip('本局结束');
    setStage('本局结束', '身份已公开');
  }

  renderDock();
}

/* ---------------- 底部操作 ---------------- */
function renderDock(force) {
  const r = S.room;
  if (!r || r.phase === 'lobby') return;

  const key = [
    r.phase,
    S.turn ? S.turn.kind : '',
    S.turnSeq,
    r.speakingSeat,
    r.self.alive,
    r.self.role,
    S.spectator,
    S.votePick,
    r.vote ? `${r.vote.done}/${r.vote.total}` : ''
  ].join('|');
  if (!force && key === S.dockKey) return;
  S.dockKey = key;

  const dock = $('gameDock');
  const t = S.turn;

  if (S.spectator) {
    let watching = '';
    if (r.speakingSeat != null) {
      const p = r.players.find((x) => x.seat === r.speakingSeat);
      watching = p ? `${p.seat + 1}号 ${esc(p.name)} 正在发言…` : '正在发言…';
    } else if (r.phase === 'end') {
      watching = '本局已结束，等房主开新局';
    } else if (r.phase === 'vote') {
      watching = `投票中…${r.vote ? ` 已投 ${r.vote.done}/${r.vote.total}` : ''}`;
    } else if (r.wolfTalk) {
      watching = '狼人正在密谈，你可以旁听';
    } else {
      watching = '你正在观战，不参与发言和投票';
    }
    // 实时票数流向（上帝视角）
    const casts = (S.voteCasts || []).slice(-6).map((c) =>
      `<div class="watch-cast">${esc(c.from)} → ${esc(c.to)}</div>`
    ).join('');
    dock.innerHTML = `
      <div class="watch-panel">
        <div class="watch-head"><span class="watch-dot"></span>观战中 · 上帝视角</div>
        <div class="watch-sub">${watching}</div>
        ${casts ? `<div class="watch-casts">${casts}</div>` : ''}
      </div>`;
    return;
  }

  if (t) {
    if (t.kind === 'speak' || t.kind === 'lastWords') return dockSpeak(t);
    if (t.kind === 'witchHeal') return dockWitchHeal(t);
    if (t.kind === 'witchPoison') return dockWitchPoison(t);
    if (t.kind === 'wolfPick') return dockWolf(t);
    if (t.kind === 'vote') return dockVote(t);
    return dockPick(t);
  }

  if (r.speakingSeat != null) {
    const p = r.players.find((x) => x.seat === r.speakingSeat);
    dock.innerHTML = `<div class="dock-hint">${p ? `${p.seat + 1}号 ${esc(p.name)} 正在发言…` : '正在发言…'}</div>`;
  } else if (r.phase === 'vote') {
    dock.innerHTML = `<div class="dock-hint">投票中，等待其他人…${r.vote ? ` 已投 ${r.vote.done}/${r.vote.total}` : ''}</div>`;
  } else if (r.phase === 'end') {
    dock.innerHTML = r.self.isHost
      ? `<button class="block-btn primary" id="againBtn">再来一局</button>`
      : '<div class="dock-hint">等房主开新局</div>';
    const btn = $('againBtn');
    if (btn) btn.addEventListener('click', () => send({ t: 'rematch' }));
  } else {
    dock.innerHTML = `<div class="dock-hint">${r.self.alive ? '等待下一步…' : '你已出局，继续观战'}</div>`;
  }
}

function dockPick(t) {
  const dock = $('gameDock');
  const skip = t.kind === 'vote' ? '<button class="block-btn" id="skipBtn">弃票</button>' : '';
  dock.innerHTML = `<div class="dock-hint">${esc(t.hint || '点选一名玩家')}</div>${skip}`;
  if (t.kind === 'vote') {
    $('skipBtn').addEventListener('click', () => {
      send({ t: 'action', kind: 'vote', seat: null });
      S.turn = null;
      renderDock(true);
    });
  }
}

function dockWolf(t) {
  const s = t.suggest;
  const dock = $('gameDock');
  const talkTip = t.talk
    ? '<div class="talk-tip">狼队频道已开，直接开口商量就行，只有狼队友听得到</div>'
    : '';
  if (!s) {
    dock.innerHTML = `<div class="dock-hint">点选今晚要击杀的玩家</div>${talkTip}`;
    return;
  }
  dock.innerHTML = `
    <div class="speak-box">
      <div class="speak-head"><span>狼队商议</span><span>${esc(s.mate || '队友')}</span></div>
      <div class="wolf-line">刀 ${esc(s.name)} 吧。${esc(s.reason || '')}</div>
      <div class="speak-actions">
        <button class="hold-btn" id="agreeBtn">同意</button>
        <button class="send-btn" id="changeBtn">换目标</button>
      </div>
      ${talkTip}
      <div class="speak-tip" id="wolfTip">同意就直接刀 ${esc(s.name)}，想换就点桌上的头像。</div>
    </div>`;
  $('agreeBtn').addEventListener('click', () => {
    send({ t: 'action', kind: 'wolfPick', seat: s.seat });
    S.turn = null;
    renderDock(true);
  });
  $('changeBtn').addEventListener('click', () => {
    $('wolfTip').textContent = '点圆桌上的玩家头像，改刀你想刀的人';
  });
}

function answer(kind, payload) {
  send({ t: 'action', kind, ...(payload || {}) });
  S.turn = null;
  renderDock(true);
}

function dockWitchHeal(t) {
  const info = t.info || {};
  const dock = $('gameDock');
  let desc = info.victim ? `今晚被袭击的是：${esc(info.victim)}` : '今晚没有人被袭击。';
  if (info.selfVictim) desc = '今晚被袭击的是你自己，女巫不能自救。';

  dock.innerHTML = `
    <div class="dock-hint">${desc}</div>
    ${info.canHeal ? `<button class="block-btn primary" id="healBtn">用解药救 ${esc(info.victim)}</button>` : ''}
    <button class="block-btn outline" id="noHealBtn">不用解药</button>`;

  const healBtn = $('healBtn');
  if (healBtn) healBtn.addEventListener('click', () => answer('witchHeal', { choice: 'heal' }));
  $('noHealBtn').addEventListener('click', () => answer('witchHeal', { choice: 'none' }));
}

function dockWitchPoison(t) {
  const info = t.info || {};
  const dock = $('gameDock');
  dock.innerHTML = `
    <div class="dock-hint">${info.canPoison ? '要使用毒药带走一个人吗？' : '你的毒药已经用过了。'}</div>
    ${info.canPoison ? '<button class="block-btn primary" id="poisonBtn">使用毒药</button>' : ''}
    <button class="block-btn outline" id="noPoisonBtn">不用毒药</button>`;

  const poisonBtn = $('poisonBtn');
  if (poisonBtn) poisonBtn.addEventListener('click', () => answer('witchPoison', { choice: 'poison' }));
  $('noPoisonBtn').addEventListener('click', () => answer('witchPoison', { choice: 'none' }));
}

/* ---------------- 语音发言 ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;

function stopRecognizer() {
  if (recognizer) {
    try { recognizer.stop(); } catch { /* ignore */ }
    recognizer = null;
  }
}

function dockSpeak(t) {
  const dock = $('gameDock');
  let left = t.seconds || 60;
  const isLast = t.kind === 'lastWords';
  const head = isLast ? '轮到你留遗言' : '轮到你发言';
  const placeholder = isLast
    ? '说一句遗言，指认你怀疑的人。也可以直接打字。'
    : '按住下方按钮说话，识别结果会写在这里；也可以直接打字。';

  dock.innerHTML = `
    <div class="speak-box">
      <div class="speak-head"><span>${head}</span><span id="speakTimer">${left}s</span></div>
      <textarea class="speak-input" id="speakInput" placeholder="${placeholder}"></textarea>
      <div class="speak-actions">
        <button class="hold-btn" id="holdBtn">按住说话</button>
        <button class="send-btn" id="sendBtn">${isLast ? '说完遗言' : '结束发言'}</button>
      </div>
      <div class="speak-tip" id="speakTip"></div>
    </div>`;

  const input = $('speakInput');
  const hold = $('holdBtn');
  const tip = $('speakTip');
  const timerEl = $('speakTimer');

  if (!SR) {
    hold.style.display = 'none';
    tip.textContent = '当前浏览器不支持语音识别，请直接打字。';
  } else {
    tip.textContent = '首次使用需允许麦克风，说完松开手指。';
    hold.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        recognizer = new SR();
        recognizer.lang = 'zh-CN';
        recognizer.continuous = true;
        recognizer.interimResults = true;
        const base = input.value;
        recognizer.onresult = (ev) => {
          let txt = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
          input.value = (base ? base + ' ' : '') + txt;
        };
        recognizer.onerror = (ev) => { tip.textContent = '识别失败（' + ev.error + '），可以改用打字。'; };
        recognizer.start();
        if (S.voice) S.voice.setTalking(true);
        hold.classList.add('recording');
        hold.textContent = '正在听…松开结束';
      } catch {
        tip.textContent = '无法启动语音识别，请打字。';
      }
    });
    const stop = () => {
      if (!hold.classList.contains('recording')) return;
      stopRecognizer();
      if (S.voice) S.voice.setTalking(false);
      hold.classList.remove('recording');
      hold.textContent = '按住说话';
    };
    hold.addEventListener('pointerup', stop);
    hold.addEventListener('pointercancel', stop);
    hold.addEventListener('pointerleave', stop);
  }

  $('sendBtn').addEventListener('click', () => {
    stopRecognizer();
    send({ t: 'action', kind: isLast ? 'lastWords' : 'speak', text: (input.value || '').trim() });
    S.turn = null;
    renderDock(true);
  });

  const iv = setInterval(() => {
    left -= 1;
    timerEl.textContent = Math.max(0, left) + 's';
    if (left <= 0) clearInterval(iv);
  }, 1000);
}

/* 投票：先选人、再确认，避免误点 */
function dockVote(t) {
  const r = S.room;
  const me = r.self;
  const targets = r.players.filter((p) => p.alive && p.seat !== me.seat);
  const cur = S.votePick;
  const curName = cur != null && r.players[cur] ? `${cur + 1}号 ${r.players[cur].name}` : '';
  const done = r.vote ? r.vote.done : 0;
  const total = r.vote ? r.vote.total : targets.length + 1;
  const dock = $('gameDock');

  dock.innerHTML = `
    <div class="vote-box">
      <div class="vote-head">
        <span>投票放逐</span>
        <span class="vote-progress">已投 ${done}/${total}</span>
      </div>
      <div class="vote-grid">
        ${targets.map((p) => `
          <button class="vote-item ${cur === p.seat ? 'sel' : ''}" data-seat="${p.seat}">
            <span class="vote-ava">${avatarSvg(p.seat, 38)}</span>
            <span class="vote-name">${p.seat + 1}号 ${esc(p.name)}</span>
          </button>`).join('')}
      </div>
      <div class="vote-actions">
        <button class="vote-btn ghost" id="skipBtn">弃票</button>
        <button class="vote-btn primary" id="voteConfirmBtn" ${cur == null ? 'disabled' : ''}>
          ${cur == null ? '先选一个人' : `确认投给 ${esc(curName)}`}
        </button>
      </div>
      <p class="vote-tip">点一下选中，再点「确认」才生效</p>
    </div>`;

  dock.querySelectorAll('.vote-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      S.votePick = Number(btn.dataset.seat);
      render();
    });
  });
  $('skipBtn').addEventListener('click', () => {
    send({ t: 'action', kind: 'vote', seat: null });
    S.turn = null;
    S.votePick = null;
    renderDock(true);
  });
  $('voteConfirmBtn').addEventListener('click', () => {
    if (S.votePick == null) return;
    send({ t: 'action', kind: 'vote', seat: S.votePick });
    S.turn = null;
    S.votePick = null;
    renderDock(true);
  });
}

/* ---------------- 发言倒计时（所有人可见） ---------------- */
let speakTick = null;
let speakKey = '';
let beepedKey = '';

function renderSpeakTimer() {
  const r = S.room;
  const sp = r && r.speak;
  const bar = $('speakTimerBar');
  if (!bar) return;
  if (!sp || sp.seat == null || r.phase === 'end') {
    bar.hidden = true;
    if (speakTick) { clearInterval(speakTick); speakTick = null; }
    return;
  }
  const total = (sp.total || 30) * 1000;
  const key = `${sp.seat}:${sp.deadline}`;
  if (key !== speakKey) {
    speakKey = key;
    bar.hidden = false;
    const p = r.players.find((x) => x.seat === sp.seat);
    const you = p && p.you;
    $('stName').textContent = `${you ? '你' : sp.name || `${sp.seat + 1}号`} 发言中`;
    bar.classList.toggle('mine', !!you);
  }
  const tick = () => {
    const left = Math.max(0, sp.deadline - Date.now());
    const sec = Math.ceil(left / 1000);
    $('stNum').textContent = sec + 's';
    $('stFill').style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    bar.classList.toggle('low', sec <= 5);
    if (left <= 0 && beepedKey !== key) {
      beepedKey = key;
      beep(); // 时间到的「滴」声
    }
  };
  tick();
  if (speakTick) clearInterval(speakTick);
  speakTick = setInterval(tick, 200);
}

let audioCtx = null;
function beep() {
  if (!S.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.5);
  } catch { /* 忽略 */ }
}

/* ---------------- 狼队语音频道 ---------------- */
function applyWolfTalk(ids, listeners) {
  const r = S.room;
  if (!r || !r.self) return;
  const on = !!r.wolfTalk;
  const key = on ? 'on:' + (ids || []).join(',') : 'off';

  // 观战：上帝视角，可以旁听狼人密谈（只听不说）
  if (S.spectator) {
    const bar = $('wolfBar');
    bar.hidden = !on;
    if (key === S.wolfKey) return;
    S.wolfKey = key;
    if (on) {
      bar.querySelector('span:last-child').textContent = '狼人正在密谈，你可以旁听（仅观战视角）';
      if (ids && ids.length) S.voice.setWolfListen(ids);
    } else {
      S.voice.setWolfMode(false);
    }
    return;
  }

  const isWolf = r.self.role === 'wolf' && r.self.alive;
  const list = ids || r.self.wolfIds || [];
  $('wolfBar').hidden = !(on && isWolf);

  if (key === S.wolfKey) return;
  S.wolfKey = key;

  if (on) {
    // 夜里所有人先把普通频道的麦关掉，狼人只在专用频道里说
    S.voice.setTalking(false);
    if (isWolf) {
      S.voice.setWolfMode(true, list, S.playerId, listeners || []).then((ok) => {
        S.voice.setWolfTalking(!!ok);
        if (!ok) toast('麦克风没打开，狼队频道听不到你，可以点选和打字');
      });
    } else {
      S.voice.setWolfMode(false);
    }
  } else {
    S.voice.setWolfMode(false);
    S.voice.setTalking(false);
  }
}

/* ---------------- 座位点击 ---------------- */
function onSeatClick(seat) {
  if (S.spectator) return;
  const t = S.turn;
  if (!t) return;
  if (!['wolfPick', 'seerPick', 'poisonPick', 'vote'].includes(t.kind)) return;
  if (seat === S.room.self.seat) return;
  const p = S.room.players[seat];
  if (!p || !p.alive) return;
  if (t.kind === 'vote') {
    S.votePick = seat; // 投票只选中，还要点一次确认
    render();
    return;
  }
  send({ t: 'action', kind: t.kind, seat });
  S.turn = null;
  renderDock(true);
}

/* =========================================================
   语音：优先神经语音（接近真人），失败回退系统语音
   ========================================================= */
let voiceList = [];
function refreshVoices() {
  if (window.speechSynthesis) voiceList = window.speechSynthesis.getVoices() || [];
}
if (window.speechSynthesis) {
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}

/** 系统语音只作为兜底：优先挑自然度高的中文音色 */
function zhVoice() {
  if (!voiceList.length) refreshVoices();
  const score = (v) => {
    let n = 0;
    if (/zh[-_]CN/i.test(v.lang)) n += 4;
    else if (/zh/i.test(v.lang)) n += 2;
    if (/natural|neural|premium|enhanced|online|siri/i.test(v.name)) n += 5;
    if (/xiaoxiao|xiaoyi|yunxi|yunyang|ting[- ]?ting|meijia|yaoyao|huihui|kangkang/i.test(v.name)) n += 3;
    if (/female|女/i.test(v.name)) n += 1;
    return n;
  };
  const cn = voiceList.filter((v) => /zh/i.test(v.lang));
  if (!cn.length) return null;
  return cn.sort((a, b) => score(b) - score(a))[0] || null;
}

/* 神经语音（服务端合成，音色接近真人）
   三档：dialect（默认，带东北话/陕西话）/ mandarin（全普通话）/ system（浏览器自带） */
const NEURAL_KEY = 'ww_voice_engine';
S.voiceStyle = (() => {
  const saved = localStorage.getItem(NEURAL_KEY);
  if (saved === 'system' || saved === 'mandarin' || saved === 'dialect') return saved;
  return 'dialect'; // 默认就是真人音色，且带方言
})();
S.voiceEngine = S.voiceStyle === 'system' ? 'system' : 'neural';
let neuralDown = false; // 连续失败后本轮不再尝试，直接走系统语音
window.__voice = { neural: 0, system: 0, fail: 0, log: [] }; // 调试计数：看过多少句各走了哪条通道
let neuralFails = 0;
let audioUnlocked = false;

/** 移动端自动播放限制：第一次点屏幕时先放一段静音，把音频通道“解锁” */
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const a = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=');
    a.volume = 0;
    a.play().catch(() => {});
  } catch { /* 忽略 */ }
}
document.addEventListener('pointerdown', unlockAudio, { once: true });

function ttsUrl(text, voice) {
  return `/tts?text=${encodeURIComponent(text)}&v=${encodeURIComponent(voice)}`;
}

/* 朗读队列：一句读完再读下一句，避免互相打断 */
const speechQueue = [];
let speechBusy = false;

function speak(text, opts) {
  return new Promise((resolve) => {
    if (!S.soundOn || !text) { resolve(); return; }
    if (speechQueue.length >= 6) {
      const dropped = speechQueue.shift();
      if (dropped) dropped.resolve();
    }
    const job = { text: String(text), opts: opts || {}, resolve, audio: null };
    // 队首且空闲时提前加载音频，减少句间空白
    if (!speechBusy && !speechQueue.length && canUseNeural(job)) {
      job.audio = new Audio(ttsUrl(job.text, job.opts.voice));
      job.audio.preload = 'auto';
    }
    speechQueue.push(job);
    pumpSpeech();
  });
}

function canUseNeural(job) {
  return S.soundOn && !neuralDown && S.voiceEngine === 'neural' && !!job.opts.voice;
}

function pumpSpeech() {
  if (speechBusy) return;
  const job = speechQueue.shift();
  if (!job) return;
  if (!S.soundOn) { job.resolve(); pumpSpeech(); return; }

  speechBusy = true;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    speechBusy = false;
    job.resolve();
    pumpSpeech();
  };

  // 当前句在播时，提前把下一句的音频下好，减少句间空白
  const nextJob = speechQueue[0];
  if (nextJob && !nextJob.audio && canUseNeural(nextJob)) {
    nextJob.audio = new Audio(ttsUrl(nextJob.text, nextJob.opts.voice));
    nextJob.audio.preload = 'auto';
  }

  if (canUseNeural(job)) {
    playNeural(job).then((ok) => {
      if (ok) {
        neuralFails = 0;
        done();
        return;
      }
      neuralFails += 1;
      if (neuralFails >= 3) neuralDown = true; // 网络不通就别再等了
      systemSpeak(job, done);
    });
    return;
  }
  systemSpeak(job, done);
}

/** 播神经语音；返回是否成功播放 */
function playNeural(job) {
  return new Promise((resolve) => {
    let audio = job.audio;
    if (!audio) {
      audio = new Audio(ttsUrl(job.text, job.opts.voice));
      audio.preload = 'auto';
    }
    let settled = false;
    let started = false; // 是否真的开始出声了

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      clearTimeout(endTimer);
      audio.onended = null;
      audio.onerror = null;
      audio.onplaying = null;
      // 已经开始播过，就算后面出错也不再走系统语音，避免同一句话念两遍
      const reallyOk = ok || started;
      if (!reallyOk) {
        try { audio.pause(); } catch { /* 忽略 */ }
      } else {
        window.__voice.neural += 1;
        window.__voice.log.push({ t: job.text, ch: 'neural', kind: job.opts.kind || 'host' });
      }
      resolve(reallyOk);
    };

    // 只有"迟迟没开始播"才算失败；开始播之后就一直等它播完
    const startTimer = setTimeout(() => finish(false), 12000);
    let endTimer = null;

    audio.onplaying = () => {
      started = true;
      clearTimeout(startTimer);
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : job.text.length * 0.25 + 2;
      // 播完之后再留一点余量，防止 onended 没触发导致队列卡住
      endTimer = setTimeout(() => finish(true), dur * 1000 + 2500);
    };
    audio.onended = () => finish(true);
    audio.onerror = () => { if (!started) window.__voice.fail += 1; finish(false); };

    audio.play().catch(() => finish(false));
  });
}

/** 系统自带语音（兜底）：按标点断句 + 句间停顿，听起来不那么机械 */
function systemSpeak(job, done) {
  if (!window.speechSynthesis) { done(); return; }
  window.__voice.system += 1;
  window.__voice.log.push({ t: job.text, ch: 'system', kind: job.opts.kind || 'host' });
  const text = job.text;
  const parts = text.match(/[^，。！？；、,.!?;]+[，。！？；、,.!?;]?/g) || [text];
  const segs = parts.map((x) => x.trim()).filter(Boolean);
  let i = 0;
  let guard = null;

  const next = () => {
    if (i >= segs.length) { clearTimeout(guard); done(); return; }
    const seg = segs[i++];
    try {
      const u = new SpeechSynthesisUtterance(seg);
      u.lang = 'zh-CN';
      u.rate = job.opts.rate != null ? job.opts.rate : 0.92;
      u.pitch = job.opts.pitch != null ? job.opts.pitch : 1;
      const v = zhVoice();
      if (v) u.voice = v;
      u.onend = () => {
        // 逗号短停、句号长停，模拟换气
        const gap = /[。！？!?]$/.test(seg) ? 260 + Math.random() * 160 : 90 + Math.random() * 90;
        setTimeout(next, gap);
      };
      u.onerror = () => next();
      window.speechSynthesis.speak(u);
    } catch {
      next();
    }
  };

  guard = setTimeout(done, Math.max(3200, text.length * 340 + 1800));
  next();
}

function clearSpeechQueue() {
  while (speechQueue.length) {
    const job = speechQueue.shift();
    job.resolve();
  }
  speechBusy = false;
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

async function sayHost(text, voice) {
  $('hostText').textContent = text;
  $('hostText').classList.remove('pulse');
  void $('hostText').offsetWidth;
  $('hostText').classList.add('pulse');
  $('hostDot').classList.add('speaking');
  await speak(text, { voice, kind: 'host' });
  $('hostDot').classList.remove('speaking');
}

/* ---------------- 发言气泡 ---------------- */
let bubbleTimer = null;
let lastSaidKey = '';
let lastSaidAt = 0;

/** 同一个人同一句话，5 秒内只念一遍 */
function shouldSpeak(seat, text) {
  const key = seat + '|' + text;
  const now = Date.now();
  if (key === lastSaidKey && now - lastSaidAt < 5000) return false;
  lastSaidKey = key;
  lastSaidAt = now;
  return true;
}

function showBubble(name, text, tag) {
  const el = $('bubble');
  if (!el) return;
  $('bubbleName').textContent = name || '';
  $('bubbleTag').textContent = tag || '发言';
  $('bubbleText').textContent = text || '';
  placeBubble();
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, Math.min(16000, Math.max(5000, (text || '').length * 280)));
}

/** 气泡始终贴在底部操作区上沿：dock 高度变化（如切到投票面板）时自动跟随 */
function placeBubble() {
  const el = $('bubble');
  const dock = $('gameDock');
  if (el && dock) el.style.bottom = (dock.offsetHeight + 6) + 'px';
}
if (window.ResizeObserver) {
  window.addEventListener('DOMContentLoaded', () => {
    const dock = $('gameDock');
    if (dock) new ResizeObserver(() => {
      const el = $('bubble');
      if (el && !el.hidden) placeBubble();
    }).observe(dock);
  });
}

function hideBubble() {
  const el = $('bubble');
  if (!el) return;
  el.classList.remove('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { el.hidden = true; }, 280);
}

function addSpeech(msg) {
  if (!S.room) return;
  const self = S.room.self;
  const isMe = !!(self && self.seat === msg.seat);
  showBubble(`${msg.seat + 1}号 ${msg.name}`, msg.text, isMe ? '你的发言' : '发言');
  if (!isMe && shouldSpeak(msg.seat, msg.text)) speak(msg.text, { voice: msg.voice, kind: 'ai' });
  if ($('drawer').classList.contains('show')) renderLog();
}

function addLastWords(msg) {
  if (!S.room) return;
  const self = S.room.self;
  const isMe = !!(self && self.seat === msg.seat);
  showBubble(`${msg.seat + 1}号 ${msg.name}`, msg.text, isMe ? '你的遗言' : '遗言');
  if (!isMe && shouldSpeak(msg.seat, msg.text)) speak(msg.text, { voice: msg.voice, kind: 'ai' });
  if ($('drawer').classList.contains('show')) renderLog();
}

/* =========================================================
   记录 / 弹层 / 提示
   ========================================================= */
function renderLog() {
  const log = (S.room && S.room.log) || [];
  $('drawerBody').innerHTML = log.map((item) => `
    <div class="log-item ${item.type}">
      <div class="log-meta">${item.day ? '第 ' + item.day + ' 天 · ' : ''}${esc(item.name || '主持人')}</div>
      <div class="log-text">${esc(item.text)}</div>
    </div>`).join('') || '<div class="dock-hint">还没有记录</div>';
  $('drawerBody').scrollTop = $('drawerBody').scrollHeight;
}

$('logBtn').addEventListener('click', () => {
  renderLog();
  $('drawer').classList.add('show');
});
$('drawerClose').addEventListener('click', () => $('drawer').classList.remove('show'));

let sheetResolve = null;
function openSheet({ title, desc, actions = [] }) {
  return new Promise((resolve) => {
    sheetResolve = resolve;
    $('sheet').innerHTML = `
      <div class="sheet-title">${esc(title)}</div>
      ${desc ? `<div class="sheet-desc">${esc(desc)}</div>` : ''}
      <div class="sheet-actions">
        ${actions.map((a, i) => `<button class="block-btn ${a.primary ? 'primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}
      </div>`;
    $('mask').classList.add('show');
    $('sheet').querySelectorAll('button[data-i]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = actions[Number(btn.dataset.i)];
        $('mask').classList.remove('show');
        const r = sheetResolve;
        sheetResolve = null;
        if (r) r(action ? action.value : null);
      });
    });
  });
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* =========================================================
   开局身份揭晓
   ========================================================= */
const ROLE_META = {
  wolf: { camp: '狼人阵营', cls: 'wolf', tip: '每晚和狼队友一起刀人，白天要装作好人。' },
  villager: { camp: '好人阵营', cls: 'good', tip: '没有技能，靠发言和投票把狼人投出去。' },
  seer: { camp: '好人阵营', cls: 'good', tip: '每晚可以查验一个人是好人还是狼人，结果会记在「身份」里。' },
  witch: { camp: '好人阵营', cls: 'good', tip: '一瓶解药、一瓶毒药，各只能用一次。' }
};

function roleIntroText(self) {
  const meta = ROLE_META[self.role] || {};
  const lines = [];
  if (meta.tip) lines.push(meta.tip);
  if (self.role === 'wolf' && self.mates && self.mates.length) {
    lines.push('狼队友：' + self.mates.map((m) => `${m.seat + 1}号 ${m.name}`).join('、'));
  }
  if (self.role === 'seer' && self.checks && self.checks.length) {
    lines.push(`已查验 ${self.checks.length} 人，详情见「身份」`);
  }
  if (self.role === 'witch' && self.potions) {
    lines.push(`解药：${self.potions.heal ? '可用' : '已用'}　毒药：${self.potions.poison ? '可用' : '已用'}`);
  }
  return lines.join('\n');
}

function openRoleIntro(self) {
  const meta = ROLE_META[self.role] || {};
  $('roleIntroName').textContent = roleName(self.role);
  $('roleIntroName').className = 'role-name ' + (meta.cls || '');
  $('roleIntroCamp').textContent = meta.camp || '';
  $('roleIntroCamp').className = 'role-camp ' + (meta.cls || 'good');
  $('roleIntroSeat').textContent = `第 ${self.seat + 1} 号位`;
  $('roleIntroTip').textContent = roleIntroText(self);
  $('roleIntro').classList.add('show');
  $('roleIntro').setAttribute('aria-hidden', 'false');
}

function closeRoleIntro() {
  const el = $('roleIntro');
  if (!el.classList.contains('show')) return;
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
}

/** 每局开局只弹一次：进入对局、拿到自己的身份那一刻 */
function maybeRoleIntro() {
  const r = S.room;
  if (!r || !r.self) return;
  if (r.phase === 'lobby') { S.roleIntroShown = false; return; }
  if (r.phase === 'end' || !r.self.role) return;
  if (S.roleIntroShown) return;
  S.roleIntroShown = true;
  openRoleIntro(r.self);
}

$('roleIntroOk').addEventListener('click', closeRoleIntro);
$('roleIntro').addEventListener('click', (e) => {
  if (e.target === $('roleIntro')) closeRoleIntro(); // 点空白处也能收起，别挡住操作
});

/* =========================================================
   身份卡 / 结算
   ========================================================= */
$('roleBtn').addEventListener('click', () => {
  const self = S.room && S.room.self;
  if (!self || !self.role) return;
  const tips = {
    wolf: '每晚和狼队友一起刀人，白天要装好人。',
    villager: '没有技能，靠发言和投票找出狼人。',
    seer: '每晚可以查验一个人的身份。',
    witch: '一瓶解药、一瓶毒药，各只能用一次。'
  };
  let desc = tips[self.role] || '';
  if (self.role === 'wolf' && self.mates) {
    desc += '\n狼队友：' + (self.mates.map((m) => `${m.name}（${m.alive ? '存活' : '出局'}）`).join('、') || '无');
  }
  if (self.role === 'seer' && self.checks && self.checks.length) {
    desc += '\n已查验：' + self.checks.map((c) => {
      const p = S.room.players[c.seat];
      return `${p ? p.name : c.seat}（${c.isWolf ? '狼' : '好人'}）`;
    }).join('、');
  }
  if (self.role === 'witch' && self.potions) {
    desc += `\n解药：${self.potions.heal ? '可用' : '已用'}　毒药：${self.potions.poison ? '可用' : '已用'}`;
  }
  openSheet({ title: `你是「${roleName(self.role)}」`, desc, actions: [{ label: '收起', value: 1, primary: true }] });
});

function showResult() {
  const r = S.room;
  if (!r) return;
  const winner = r.winner === 'wolf' ? '狼人胜利' : '好人胜利';

  const rows = r.players.map((p) => {
    const camp = p.role === 'wolf' ? 'wolf' : 'good';
    return `
      <div class="reveal-row">
        <div class="reveal-avatar">${avatarSvg(p.seat, 40)}</div>
        <div class="reveal-info">
          <div class="reveal-name">${p.seat + 1}号 ${esc(p.name)}${p.you ? '（你）' : ''}${p.alive ? '' : ' · 已出局'}</div>
          <div class="reveal-role">${p.isAI ? 'AI 玩家' : '真人玩家'}</div>
        </div>
        <div class="camp-badge camp-${camp}">${roleName(p.role)}</div>
      </div>`;
  }).join('');

  const events = (r.events || []).map((e) => `<div class="event-row"><b>第 ${e.day} 天</b> · ${esc(e.text)}</div>`).join('');

  $('result').innerHTML = `
    <div class="result-title">游戏结束</div>
    <div class="result-sub">${winner}　·　${esc(r.winReason || '')}</div>
    <div class="reveal-list">${rows}</div>
    <div class="events-title">本局大事记</div>
    ${events || '<div class="event-row">暂无记录</div>'}
    <div class="result-actions">
      ${r.self.isHost ? '<button class="block-btn primary" id="rematchBtn">再来一局</button>' : '<div class="dock-hint">等房主开新局</div>'}
      <button class="block-btn outline" id="reviewBtn">查看发言记录</button>
    </div>`;

  $('result').classList.add('show');

  const rematch = $('rematchBtn');
  if (rematch) {
    rematch.addEventListener('click', () => {
      send({ t: 'rematch' });
      $('result').classList.remove('show');
    });
  }
  $('reviewBtn').addEventListener('click', () => {
    renderLog();
    $('drawer').classList.add('show');
  });
}

/* =========================================================
   语音连麦
   ========================================================= */
S.voice = new Voice((msg) => send(msg));

$('micBtn').addEventListener('click', async () => {
  if (!S.voice.enabled) {
    const ok = await S.voice.enable();
    if (!ok) {
      toast('麦克风没打开，先用文字发言也完全可以');
      return;
    }
    $('micBtn').textContent = '连麦中';
    if (S.room) {
      S.voice.setPeers(S.room.players.filter((p) => !p.isAI && !p.you).map((p) => p.id || ''));
    }
    toast('已连麦，轮到你发言时会自动开麦');
  } else {
    S.voice.setTalking(false);
    $('micBtn').textContent = '连麦';
  }
});

/* =========================================================
   顶栏 / 邀请
   ========================================================= */
$('soundBtn').addEventListener('click', () => {
  S.soundOn = !S.soundOn;
  $('soundBtn').textContent = S.soundOn ? '语音开' : '语音关';
  if (!S.soundOn) clearSpeechQueue();
});

/* ---------------- 音色切换（入口页） ---------------- */
const voiceModeBtn = $('voiceModeBtn');
const VOICE_LABEL = {
  dialect: '语音：真人·带方言',
  mandarin: '语音：真人·普通话',
  system: '语音：系统音色'
};
const VOICE_PREVIEW = {
  dialect: { text: '嗯，我跟你们说，他这轮一直跟票，我瞅着不像好人。', voice: 'zh-CN-liaoning-XiaobeiNeural' },
  mandarin: { text: '我是今晚的主持人，游戏马上开始。', voice: 'zh-CN-YunyangNeural' }
};

function renderVoiceMode() {
  voiceModeBtn.textContent = VOICE_LABEL[S.voiceStyle] || VOICE_LABEL.dialect;
  voiceModeBtn.classList.toggle('is-system', S.voiceStyle === 'system');
}
voiceModeBtn.addEventListener('click', () => {
  const order = ['dialect', 'mandarin', 'system'];
  S.voiceStyle = order[(order.indexOf(S.voiceStyle) + 1) % order.length];
  S.voiceEngine = S.voiceStyle === 'system' ? 'system' : 'neural';
  localStorage.setItem(NEURAL_KEY, S.voiceStyle);
  neuralDown = false;
  neuralFails = 0;
  renderVoiceMode();
  clearSpeechQueue();
  if (S.voiceStyle === 'system') {
    toast('已切换系统音色（不带方言）');
    return;
  }
  const p = VOICE_PREVIEW[S.voiceStyle];
  toast(S.voiceStyle === 'dialect' ? '真人音色·东北话，先听一句' : '真人音色·普通话，先听一句');
  speak(p.text, { voice: p.voice, kind: 'host' });
});
renderVoiceMode();

$('copyBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${S.room.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('邀请链接已复制，发给朋友吧');
  } catch {
    toast(`房间号 ${S.room.code}，让朋友输入就能进`);
  }
});
