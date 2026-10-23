import { Voice } from './voice.js';

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
  voice: null
};

/* =========================================================
   连接
   ========================================================= */
function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

function connect(code) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  S.ws = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ t: 'join', code: code || '', name: S.name, playerId: S.playerId }));
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
      localStorage.setItem('ww_pid', msg.playerId);
      history.replaceState(null, '', '?room=' + msg.code);
      setChip('已连接');
      break;

    case 'state':
      S.room = msg.room;
      S.reconnectCode = msg.room.code;
      render();
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
  connect('');
});

$('joinBtn').addEventListener('click', () => {
  if (!readName()) return;
  const code = $('codeInput').value.trim();
  if (!/^\d{4}$/.test(code)) {
    toast('房间号是 4 位数字');
    return;
  }
  connect(code);
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

  const inLobby = r.phase === 'lobby';
  $('entryScreen').classList.toggle('on', false);
  $('lobbyScreen').classList.toggle('on', inLobby);
  $('gameScreen').classList.toggle('on', !inLobby);
  document.body.classList.toggle('night', r.phase === 'night');

  $('roleBtn').hidden = !r.self || !r.self.role;
  if (r.self && r.self.role) $('roleBtn').textContent = roleName(r.self.role);

  if (inLobby) { setChip('等待开'); renderLobby(); }
  else renderGame();
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
          <div class="lobby-avatar">${p.isAI ? 'AI' : esc(p.name.slice(0, 1))}</div>
          <div class="lobby-name">${esc(p.name)}${p.you ? '（你）' : ''}
            <small>${p.isAI ? 'AI 补位' : '真人玩家'}${p.you && r.hostId === undefined ? '' : ''}</small>
          </div>
          <span class="tag ${p.ready ? 'ok' : ''}">${p.ready ? '已准备' : '未准备'}</span>
        </div>`);
    } else {
      rows.push(`
        <div class="lobby-row">
          <div class="lobby-avatar">·</div>
          <div class="lobby-name">空位<small>开局后由 AI 补上</small></div>
          <span class="tag ai">等待</span>
        </div>`);
    }
  }
  $('lobbyList').innerHTML = rows.join('');

  const key = `lobby:${r.self.ready}:${r.self.isHost}`;
  if (S.dockKey === key) return;
  S.dockKey = key;

  $('lobbyDock').innerHTML = `
    <button class="block-btn ${r.self.ready ? '' : 'primary'}" id="readyBtn">${r.self.ready ? '取消准备' : '我已准备就绪'}</button>
    <button class="block-btn ${r.self.isHost ? 'primary' : 'outline'}" id="startBtn">${r.self.isHost ? '开始游戏' : '等待房主开局'}</button>
    <p class="dock-note">${r.players.filter((p) => !p.isAI).length} 位真人 · 不足 6 人由 AI 补齐</p>
  `;

  $('readyBtn').addEventListener('click', () => send({ t: 'ready', value: !r.self.ready }));
  $('startBtn').addEventListener('click', () => {
    if (!r.self.isHost) {
      toast('等房主开局');
      return;
    }
    send({ t: 'start' });
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
    el.innerHTML = '<div class="seat-avatar"><span></span></div><div class="seat-name"></div>';
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
    if (pickable && p.alive && !p.you) cls.push('selectable');
    el.className = cls.join(' ');

    const avatar = el.firstElementChild;
    avatar.innerHTML = `<span>${p.you ? '我' : esc(p.name.slice(0, 1))}</span>` +
      (r.votesShown && p.votes > 0 ? `<span class="seat-votes">${p.votes}</span>` : '');
    el.lastElementChild.textContent = p.name;
  });

  if (r.phase === 'night') {
    setChip(`第 ${r.day} 夜`);
    setStage(`第 ${r.day} 夜`, '天黑请闭眼，别出声');
  } else if (r.phase === 'vote') {
    setChip(`第 ${r.day} 天 · 投票`);
    setStage(`第 ${r.day} 天`, '投票放逐一名玩家');
  } else if (r.phase === 'day') {
    setChip(`第 ${r.day} 天`);
    setStage(`第 ${r.day} 天`, r.self.alive ? '天亮了，轮流发言' : '观战中 · 你已出局');
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

  const key = [r.phase, S.turn ? S.turn.kind : '', S.turnSeq, r.speakingSeat, r.self.alive, r.self.role].join('|');
  if (!force && key === S.dockKey) return;
  S.dockKey = key;

  const dock = $('gameDock');
  const t = S.turn;

  if (t) {
    if (t.kind === 'speak' || t.kind === 'lastWords') return dockSpeak(t);
    if (t.kind === 'witchHeal') return dockWitchHeal(t);
    if (t.kind === 'witchPoison') return dockWitchPoison(t);
    if (t.kind === 'wolfPick') return dockWolf(t);
    return dockPick(t);
  }

  if (r.speakingSeat != null) {
    const p = r.players.find((x) => x.seat === r.speakingSeat);
    dock.innerHTML = `<div class="dock-hint">${p ? esc(p.name) + ' 正在发言…' : '正在发言…'}</div>`;
  } else if (r.phase === 'vote') {
    dock.innerHTML = '<div class="dock-hint">投票中，等待其他人…</div>';
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
  if (!s) {
    dock.innerHTML = '<div class="dock-hint">点选今晚要击杀的玩家</div>';
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

/* ---------------- 座位点击 ---------------- */
function onSeatClick(seat) {
  const t = S.turn;
  if (!t) return;
  if (!['wolfPick', 'seerPick', 'poisonPick', 'vote'].includes(t.kind)) return;
  if (seat === S.room.self.seat) return;
  const p = S.room.players[seat];
  if (!p || !p.alive) return;
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

/* 神经语音（服务端合成，音色接近真人） */
const NEURAL_KEY = 'ww_voice_engine';
S.voiceEngine = localStorage.getItem(NEURAL_KEY) === 'system' ? 'system' : 'neural';
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
  const dock = $('gameDock');
  el.style.bottom = ((dock ? dock.offsetHeight : 120) + 6) + 'px';
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, Math.min(16000, Math.max(5000, (text || '').length * 280)));
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
  showBubble(msg.name, msg.text, isMe ? '你的发言' : '发言');
  if (!isMe && shouldSpeak(msg.seat, msg.text)) speak(msg.text, { voice: msg.voice, kind: 'ai' });
  if ($('drawer').classList.contains('show')) renderLog();
}

function addLastWords(msg) {
  if (!S.room) return;
  const self = S.room.self;
  const isMe = !!(self && self.seat === msg.seat);
  showBubble(msg.name, msg.text, isMe ? '你的遗言' : '遗言');
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
        <div class="reveal-avatar">${p.you ? '我' : esc(p.name.slice(0, 1))}</div>
        <div class="reveal-info">
          <div class="reveal-name">${esc(p.name)}${p.you ? '（你）' : ''}${p.alive ? '' : ' · 已出局'}</div>
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
function renderVoiceMode() {
  const neural = S.voiceEngine === 'neural';
  voiceModeBtn.textContent = neural ? '语音：真人音色' : '语音：系统音色';
  voiceModeBtn.classList.toggle('is-system', !neural);
}
voiceModeBtn.addEventListener('click', () => {
  S.voiceEngine = S.voiceEngine === 'neural' ? 'system' : 'neural';
  localStorage.setItem(NEURAL_KEY, S.voiceEngine);
  neuralDown = false;
  neuralFails = 0;
  renderVoiceMode();
  if (S.voiceEngine === 'neural') {
    toast('已切换真人音色，先听一句');
    speak('我是今晚的主持人，游戏马上开始。', { voice: 'zh-CN-YunyangNeural' });
  } else {
    clearSpeechQueue();
    toast('已切换系统音色');
  }
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
