import {
  aiWolfTarget,
  aiSeerTarget,
  aiWitchChoice,
  aiSpeech,
  aiLastWords,
  aiVote,
  wolfSuggestionReason
} from './ai.js';
import { HOST_VOICE, voiceForSeat, normalizeStyle } from './tts.js';
import { checkText, CATEGORY_NAMES } from './moderation.js';

const TOTAL_SEATS = 6;
const AI_NAMES = ['阿岚', '小七', '老陈', '沐沐', '青禾', '阿泽'];

const T = {
  NIGHT: 25000,
  SPEECH: 30000,   // 每人发言 30 秒，到点主持人打断
  WOLF: 30000,     // 狼人夜聊 + 选刀
  VOTE: 30000,     // 投票
  LAST_WORDS: 30000
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 节奏系数：默认 1；测试时用 GAME_PACE=0.05 把整局压缩到几秒
const PACE = process.env.GAME_PACE != null ? Math.max(0, Number(process.env.GAME_PACE)) : 1;
const pace = (ms) => sleep(Math.round(ms * PACE));

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Room {
  constructor(code) {
    this.code = code;
    this.players = [];
    this.spectators = [];   // 观众：不占座、不参与、不下注，只旁观
    this.phase = 'lobby';
    this.day = 0;
    this.hostId = null;
    this.log = [];
    this.events = [];
    this.witch = { heal: true, poison: true };
    this.accused = {};
    this.waiters = new Map();
    this.winner = null;
    this.winReason = '';
    this.votesShown = false;
    this.speakingSeat = null;
    this.speak = null;        // { seat, name, total, deadline } 全员可见的发言倒计时
    this.voteProgress = null; // { done, total } 投票进度
    this.wolfTalk = false;    // 狼人语音频道是否打开
    this.running = false;
    this.closed = false;      // 因违规被强制关闭后置真，禁止再进入
    this.seq = 0;
    this.lastActive = Date.now();
  }

  /* ---------------- 成员管理 ---------------- */

  get humans() {
    return this.players.filter((p) => !p.isAI);
  }

  /** 房间里还连着的人（含观众），用于判断房间是否该回收 */
  get connectedHumans() {
    return [...this.humans, ...this.spectators].filter((p) => p.connected);
  }

  alive() {
    return this.players.filter((p) => p.alive);
  }

  bySeat(seat) {
    return this.players.find((p) => p.seat === seat) || null;
  }

  join(socket, name, playerId, spectate) {
    const existing = playerId
      ? this.players.find((p) => p.id === playerId && !p.isAI) ||
        this.spectators.find((p) => p.id === playerId)
      : null;
    if (existing) {
      existing.socket = socket;
      existing.connected = true;
      this.lastActive = Date.now();
      return existing;
    }
    // 观战：随时可以进，不占座、不参与
    if (spectate) return this.addSpectator(socket, name);
    if (this.phase !== 'lobby') return null;
    if (this.players.length >= TOTAL_SEATS) return null;

    const p = {
      id: `p${++this.seq}`,
      name: (name || '').slice(0, 8) || `玩家${this.players.length + 1}`,
      seat: this.players.length,
      isAI: false,
      alive: true,
      ready: false,
      role: null,
      checks: [],
      socket,
      connected: true
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.lastActive = Date.now();
    return p;
  }

  addSpectator(socket, name) {
    const s = {
      id: `s${++this.seq}`,
      name: (name || '').slice(0, 8) || `观众${this.spectators.length + 1}`,
      seat: -1,
      isAI: false,
      isSpectator: true,
      alive: false,
      ready: true,
      role: null,
      checks: [],
      socket,
      connected: true
    };
    this.spectators.push(s);
    this.lastActive = Date.now();
    return s;
  }

  leave(player) {
    if (!player) return;
    if (player.isSpectator) {
      this.spectators = this.spectators.filter((p) => p !== player);
      this.lastActive = Date.now();
      return;
    }
    // 未开始（大厅）或已结束：允许真正退出，移除座位；否则只标记断线
    if (this.phase === 'lobby' || this.phase === 'end') {
      this.players = this.players.filter((p) => p !== player);
      if (this.phase === 'lobby') {
        this.players.forEach((p, i) => { p.seat = i; }); // 大厅重排座位号
      }
      this.transferHost(player);
    } else {
      // 对局进行中：不能中途退出，只标记断线，游戏照常进行
      player.connected = false;
    }
  }

  /** 房主退出时，把房主身份交给下一个序号（最小座位号）的真人玩家 */
  transferHost(player) {
    if (this.hostId !== player.id) return;
    const next = this.humans[0];
    this.hostId = next ? next.id : null;
  }

  setReady(player, value) {
    player.ready = !!value;
    this.sync();
  }

  addAI() {
    const used = this.players.map((p) => p.name);
    const name = AI_NAMES.find((n) => !used.includes(n)) || `AI${this.players.length + 1}`;
    this.players.push({
      id: `ai${++this.seq}`,
      name,
      seat: this.players.length,
      isAI: true,
      alive: true,
      ready: true,
      role: null,
      checks: [],
      socket: null,
      connected: true
    });
  }

  /* ---------------- 消息 ---------------- */

  sendTo(player, msg) {
    if (player && player.socket && player.socket.readyState === 1) {
      player.socket.send(JSON.stringify(msg));
    }
  }

  broadcast(msg) {
    for (const p of this.players) this.sendTo(p, msg);
    for (const s of this.spectators) this.sendTo(s, msg);
  }

  sync() {
    for (const p of this.players) {
      if (p.isAI) continue;
      this.sendTo(p, { t: 'state', room: this.publicState(p) });
    }
    for (const s of this.spectators) {
      this.sendTo(s, { t: 'state', room: this.publicState(s) });
    }
  }

  publicState(viewer) {
    const spec = viewer && viewer.isSpectator ? viewer : null;
    const me = viewer && !viewer.isSpectator ? viewer : null;
    const revealAll = this.phase === 'end' || !!spec; // 结算翻牌 / 观众上帝视角
    return {
      code: this.code,
      phase: this.phase,
      day: this.day,
      hostId: this.hostId,
      winner: this.winner,
      winReason: this.winReason,
      speakingSeat: this.speakingSeat,
      votesShown: this.votesShown,
      speak: this.speak,
      vote: this.voteProgress,
      wolfTalk: this.wolfTalk,
      players: this.players.map((p) => ({
        id: p.id,
        seat: p.seat,
        name: p.name,
        isAI: p.isAI,
        alive: p.alive,
        ready: p.ready,
        connected: p.connected,
        votes: p.votes || 0,
        voice: p.voice || null,
        you: me ? p.id === me.id : false,
        role: me && p.id === me.id ? p.role : revealAll ? p.role : null
      })),
      spectators: this.spectators.map((s) => ({ id: s.id, name: s.name })),
      self: me
        ? {
            seat: me.seat,
            role: me.role,
            alive: me.alive,
            isHost: me.id === this.hostId,
            ready: me.ready,
            checks: me.checks,
            potions: me.role === 'witch' ? { ...this.witch } : null,
            mates:
              me.role === 'wolf'
                ? this.players
                    .filter((p) => p.role === 'wolf' && p.id !== me.id)
                    .map((p) => ({ seat: p.seat, name: p.name, alive: p.alive }))
                : null,
            // 语音频道需要 playerId，只发给狼人自己
            wolfIds:
              me.role === 'wolf'
                ? this.players.filter((p) => p.role === 'wolf' && !p.isAI).map((p) => p.id)
                : null
          }
        : spec
          ? {
              seat: -1,
              role: null,
              alive: false,
              isHost: false,
              ready: true,
              spectator: true,
              checks: [],
              potions: null,
              mates: null
            }
          : null,
      log: this.log.slice(-60),
      events: this.events
    };
  }

  logPush(type, text, name = '') {
    this.log.push({ type, text, name, day: this.day, at: Date.now() });
  }

  async host(text) {
    this.logPush('host', text);
    this.broadcast({ t: 'host', text, voice: HOST_VOICE });
    // 按字数留出朗读时间：约 240ms/字，最长 7.5 秒，最短 1.6 秒
    await pace(Math.min(7500, Math.max(1600, text.length * 240)));
  }

  /* ---------------- 全员可见的倒计时 ---------------- */

  startSpeakTimer(seat, ms) {
    const p = this.bySeat(seat);
    this.speak = {
      seat,
      name: p ? p.name : '',
      total: Math.round(ms / 1000),
      deadline: Date.now() + ms
    };
    this.broadcast({ t: 'speakTimer', ...this.speak });
  }

  clearSpeakTimer() {
    if (!this.speak) return;
    this.speak = null;
    this.broadcast({ t: 'speakTimer', seat: null });
  }

  /* ---------------- 狼人语音频道（只有狼听得到） ---------------- */

  wolfTalkIds() {
    return this.players.filter((p) => p.alive && p.role === 'wolf' && !p.isAI).map((p) => p.id);
  }

  openWolfTalk() {
    this.wolfTalk = true;
    this.broadcast({ t: 'wolfTalk', on: true }); // 只告诉大家"开了"，不给名单
    const ids = this.wolfTalkIds();
    for (const p of this.players) {
      if (!p.isAI && p.alive && p.role === 'wolf') {
        this.sendTo(p, { t: 'wolfTalk', on: true, ids }); // 名单只发给狼
      }
    }
    // 观众上帝视角：旁听狼人密谈（观众本来就看得见全部身份，名单直接给）
    const listenIds = this.players
      .filter((p) => p.alive && p.role === 'wolf' && !p.isAI)
      .map((p) => p.id);
    const watchers = this.spectators.map((s) => s.id);
    for (const s of this.spectators) {
      this.sendTo(s, { t: 'wolfTalk', on: true, listen: true, ids: listenIds });
    }
    // 狼人端拿到观众名单，把密谈音频也推一份给观众
    for (const p of this.players) {
      if (!p.isAI && p.alive && p.role === 'wolf') {
        this.sendTo(p, { t: 'wolfTalk', on: true, ids, listeners: watchers });
      }
    }
  }

  closeWolfTalk() {
    if (!this.wolfTalk) return;
    this.wolfTalk = false;
    this.broadcast({ t: 'wolfTalk', on: false, ids: [] });
  }

  /** 狼人之间的语音信令只在这段时间内放行 */
  canWolfTalk(a, b) {
    if (!this.wolfTalk) return false;
    if (!a || !b || a.isAI || b.isAI) return false;
    return a.alive && b.alive && a.role === 'wolf' && b.role === 'wolf';
  }

  /** 遗言：AI 用话术/大模型生成，真人用文字或语音输入 */
  async lastWordsFor(player, reason) {
    if (!player) return;
    await this.host(`请 ${player.name} 留遗言。`);

    let text = '';
    if (player.isAI) {
      this.startSpeakTimer(player.seat, T.LAST_WORDS);
      text = await aiLastWords(this, player, reason);
      await pace(500);
    } else {
      this.startSpeakTimer(player.seat, T.LAST_WORDS);
      const act = await this.ask(
        player,
        { kind: 'lastWords', hint: '留一句遗言', seconds: T.LAST_WORDS / 1000 },
        T.LAST_WORDS
      );
      text = act && act.text ? String(act.text).slice(0, 200) : '';
    }
    if (!text || !String(text).trim()) text = '（没有留下遗言）';

    this.logPush('player', text, player.name);
    this.broadcast({ t: 'lastWords', seat: player.seat, name: player.name, text, reason, voice: player.voice });
    await pace(Math.min(7000, Math.max(2000, text.length * 235)));
    this.clearSpeakTimer();
  }

  /* ---------------- 回合等待 ---------------- */

  waitAction(player, timeoutMs) {
    return new Promise((resolve) => {
      const key = 'act:' + player.id;
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(key, (val) => {
        clearTimeout(timer);
        this.waiters.delete(key);
        resolve(val);
      });
    });
  }

  submit(player, action) {
    // 发言/遗言文本风控：涉黄涉恐涉政 → 直接关闭房间
    if (action && action.text) {
      const m = checkText(String(action.text));
      if (m.blocked) {
        this.shutdown(`「${player.name}」的发言包含${CATEGORY_NAMES[m.category] || '敏感'}内容，房间已关闭`);
        return false;
      }
    }
    const waiter = this.waiters.get('act:' + player.id);
    if (!waiter) return false;
    waiter(action);
    return true;
  }

  /** 因违规强制关房：结束游戏、关闭狼聊、广播并标记房间失效 */
  shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.running = false;
    this.phase = 'end';
    this.winner = null;
    this.winReason = '';
    this.closeWolfTalk();
    this.broadcast({ t: 'shutdown', reason: reason || '房间已关闭' });
    this.sync();
  }

  async ask(player, prompt, timeoutMs) {
    if (!player || player.isAI) return null;
    this.sendTo(player, { t: 'turn', ...prompt, seconds: Math.round(timeoutMs / 1000) });
    const action = await this.waitAction(player, timeoutMs);
    this.sendTo(player, { t: 'turnEnd' });
    return action;
  }

  /* ---------------- 开局 ---------------- */

  start(player, voiceStyle) {
    if (this.phase !== 'lobby') return { ok: false, msg: '已经开局了' };
    if (this.hostId !== player.id) return { ok: false, msg: '只有房主能开局' };
    if (!this.humans.every((p) => p.ready || p.id === this.hostId)) {
      return { ok: false, msg: '还有人没准备' };
    }

    while (this.players.length < TOTAL_SEATS) this.addAI();

    // 音色风格由房主决定：dialect（默认，带东北话/陕西话）/ mandarin / system
    this.voiceStyle = normalizeStyle(voiceStyle || this.voiceStyle || 'dialect');

    const deck = shuffle(['wolf', 'wolf', 'villager', 'villager', 'seer', 'witch']);
    this.players.forEach((p, i) => {
      p.seat = i;
      p.role = deck[i];
      p.alive = true;
      p.checks = [];
      p.votes = 0;
      p.ready = true;
      p.voice = voiceForSeat(i, this.voiceStyle); // 每个座位一个固定音色，一局里 6 个人声音都不同
    });

    this.phase = 'night';
    this.day = 0;
    this.running = true;
    this.accused = {};
    this.events = [];
    this.log = [];
    this.witch = { heal: true, poison: true };
    this.winner = null;
    this.winReason = '';
    this.sync();
    this.broadcast({ t: 'begin' });
    setTimeout(() => this.loop(), 800);
    return { ok: true };
  }

  async loop() {
    try {
      while (this.running) {
        await this.night();
        if (!this.running) return;
        await this.dayPhase();
      }
    } catch (err) {
      console.error('[room] loop error', err);
    }
  }

  /* ---------------- 夜晚 ---------------- */

  async night() {
    this.phase = 'night';
    this.day += 1;
    this.wolfTarget = null;
    this.savedVictim = null;
    this.poisonTarget = null;
    this.votesShown = false;
    this.speakingSeat = null;
    this.speak = null;
    this.voteProgress = null;
    this.players.forEach((p) => { p.votes = 0; });
    this.changed();
    this.sync();

    await this.host('天黑请闭眼，所有人闭上眼睛，不要出声。');
    await pace(600);

    await this.wolvesTurn();
    await this.seerTurn();
    await this.witchTurn();

    await this.host('今晚的行动结束，所有人保持闭眼。');
  }

  changed() {
    this.lastActive = Date.now();
  }

  async wolvesTurn() {
    const wolves = this.players.filter((p) => p.alive && p.role === 'wolf');
    if (!wolves.length) return;

    await this.host('狼人请睁眼。');
    await this.host('请狼人商量一下，今晚要击杀谁。');
    await this.host('你们之间的商量只有狼人能听见，请小声讨论。');

    // 打开只有狼人能进的语音频道：狼人之间可以开口商量
    this.openWolfTalk();
    await pace(600);

    const aiWolf = wolves.find((p) => p.isAI && p.alive);
    const suggestion = aiWolf ? aiWolfTarget(this, aiWolf) : null;
    const reason = suggestion ? wolfSuggestionReason() : '';

    const picks = [];
    for (const wolf of wolves) {
      if (wolf.isAI) continue;
      const action = await this.ask(
        wolf,
        {
          kind: 'wolfPick',
          hint: '点选今晚要击杀的玩家',
          talk: this.wolfTalkIds().length > 1,
          suggest: suggestion
            ? { seat: suggestion.seat, name: suggestion.name, reason, mate: aiWolf.name }
            : null
        },
        T.WOLF
      );
      if (action && action.seat != null) {
        const target = this.bySeat(Number(action.seat));
        if (target && target.alive && target.role !== 'wolf') picks.push(target);
      }
    }

    this.closeWolfTalk();
    for (const wolf of wolves) {
      if (wolf.isAI && suggestion) picks.push(suggestion);
    }

    if (picks.length) {
      const counts = new Map();
      picks.forEach((p) => counts.set(p.seat, (counts.get(p.seat) || 0) + 1));
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const top = sorted[0];
      const tied = sorted.filter(([, c]) => c === top[1]);
      if (tied.length > 1) {
        // 平票：先手狼（座位最靠前的活着的狼）拍板
        const leader = wolves.slice().sort((a, b) => a.seat - b.seat)[0];
        const leaderPick = picks.find((p) => p.seat === leader.seat) || picks[0];
        this.wolfTarget = leaderPick || this.bySeat(top[0]);
      } else {
        this.wolfTarget = this.bySeat(top[0]);
      }
    }

    for (const wolf of wolves) {
      if (!wolf.isAI && this.wolfTarget) {
        this.logPush('sys', `狼队决定击杀 ${this.wolfTarget.name}`, wolf.name);
      }
    }
    await this.host('狼人请闭眼。');
  }

  async seerTurn() {
    const seer = this.players.find((p) => p.alive && p.role === 'seer');
    if (!seer) return;

    await this.host('预言家请睁眼。');
    await this.host('请选择一名玩家，查验他的身份。');

    if (seer.isAI) {
      const t = aiSeerTarget(this, seer);
      if (t) seer.checks.push({ seat: t.seat, isWolf: t.role === 'wolf' });
      await pace(900);
    } else {
      const action = await this.ask(seer, { kind: 'seerPick', hint: '点选要查验的玩家' }, T.NIGHT);
      let target = action && action.seat != null ? this.bySeat(Number(action.seat)) : null;
      if (!target || !target.alive || target === seer) {
        const pool = this.alive().filter((p) => p !== seer);
        target = pool[Math.floor(Math.random() * pool.length)] || null;
      }
      if (target) {
        const isWolf = target.role === 'wolf';
        seer.checks.push({ seat: target.seat, isWolf });
        this.sendTo(seer, { t: 'note', title: `查验结果：${target.name}`, text: isWolf ? '他是狼人。' : '他是好人。' });
        this.logPush('sys', `查验 ${target.name}：${isWolf ? '狼人' : '好人'}`, '预言家');
        await pace(2200);
      }
    }

    await this.host('预言家请闭眼。');
  }

  async witchTurn() {
    const witch = this.players.find((p) => p.alive && p.role === 'witch');
    if (!witch) return;

    const victim = this.wolfTarget;
    const canHeal = !!(victim && victim.seat !== witch.seat && this.witch.heal);

    await this.host('女巫请睁眼。');
    if (victim) {
      await this.host(`今晚被狼人袭击的是 ${victim.name}。`);
    } else {
      await this.host('今晚是平安夜，没有人被袭击。');
    }

    // 第一步：解药
    await this.host('你要使用解药吗？');
    if (witch.isAI) {
      const choice = aiWitchChoice(this, witch);
      if (choice.choice === 'heal' && canHeal) {
        this.witch.heal = false;
        this.savedVictim = victim;
      }
    } else {
      const healAct = await this.ask(
        witch,
        {
          kind: 'witchHeal',
          hint: '要使用解药吗？',
          info: {
            victim: victim ? victim.name : null,
            selfVictim: !!(victim && victim.seat === witch.seat),
            canHeal
          }
        },
        T.NIGHT
      );
      if (healAct && healAct.choice === 'heal' && canHeal) {
        this.witch.heal = false;
        this.savedVictim = victim;
        this.sendTo(witch, { t: 'note', title: '用药成功', text: `你用解药救下了 ${victim.name}。` });
      }
    }

    // 第二步：毒药
    await this.host('你要使用毒药吗？');
    if (witch.isAI) {
      if (this.witch.poison && !this.savedVictim && Math.random() < 0.22) {
        const pool = this.alive().filter((p) => p !== witch);
        if (pool.length) {
          this.witch.poison = false;
          this.poisonTarget = pool[Math.floor(Math.random() * pool.length)];
        }
      }
    } else {
      const poisonAct = await this.ask(
        witch,
        { kind: 'witchPoison', hint: '要使用毒药吗？', info: { canPoison: this.witch.poison } },
        T.NIGHT
      );
      if (poisonAct && poisonAct.choice === 'poison' && this.witch.poison) {
        const pick = await this.ask(witch, { kind: 'poisonPick', hint: '点选要毒死的玩家' }, T.NIGHT);
        if (pick && pick.seat != null) {
          const t = this.bySeat(Number(pick.seat));
          if (t && t.alive && t !== witch) {
            this.witch.poison = false;
            this.poisonTarget = t;
            this.sendTo(witch, { t: 'note', title: '用药成功', text: `你毒死了 ${t.name}。` });
          }
        }
      }
    }

    await this.host('女巫请闭眼。');
  }

  /* ---------------- 白天 ---------------- */

  async dayPhase() {
    this.phase = 'day';
    const deaths = [];
    if (this.wolfTarget && this.savedVictim !== this.wolfTarget) deaths.push(this.wolfTarget);
    if (this.poisonTarget && !deaths.includes(this.poisonTarget)) deaths.push(this.poisonTarget);

    deaths.forEach((p) => { p.alive = false; });
    this.nightDeaths = deaths;

    const notes = [];
    if (this.wolfTarget) notes.push(`狼人袭击了 ${this.wolfTarget.name}`);
    if (this.savedVictim) notes.push(`女巫用解药救下 ${this.savedVictim.name}`);
    if (this.poisonTarget) notes.push(`女巫毒杀了 ${this.poisonTarget.name}`);
    this.events.push({ day: this.day, text: notes.join('；') || '夜间无有效行动' });

    this.sync();

    await this.host(`第 ${this.day} 天，天亮了。`);
    if (!deaths.length) {
      await this.host('昨晚是平安夜，没有人死亡。');
    } else {
      await this.host(`昨晚 ${deaths.map((p) => p.name).join('、')} 死亡。`);
    }

    // 夜里的死者留遗言
    for (const dead of deaths) {
      await this.lastWordsFor(dead, 'night');
    }

    if (this.checkWin()) return;

    await this.host('请按顺序发言。');
    for (const p of this.speechOrder()) {
      if (!p.alive) continue;
      if (this.checkWin()) return;

      this.speakingSeat = p.seat;
      this.startSpeakTimer(p.seat, T.SPEECH); // 30 秒发言，所有端都能看到倒计时
      this.sync();

      if (p.isAI) {
        await pace(700);
        const text = await aiSpeech(this, p);
        this.logPush('player', text, p.name);
        this.broadcast({ t: 'speech', seat: p.seat, name: p.name, text, voice: p.voice });
        await pace(Math.min(9000, Math.max(2400, text.length * 240)));
      } else {
        const action = await this.ask(p, { kind: 'speak', hint: '轮到你发言' }, T.SPEECH);
        const text = action && action.text ? String(action.text).slice(0, 300) : '';
        const finalText = text || '（没有发言）';
        this.logPush('player', finalText, p.name);
        this.broadcast({ t: 'speech', seat: p.seat, name: p.name, text: finalText, voice: p.voice });
        await pace(Math.min(6000, Math.max(1500, finalText.length * 210)));
      }

      this.clearSpeakTimer();
      this.speakingSeat = null;
      this.sync();
    }

    await this.voteRound();
  }

  speechOrder() {
    const anchor = this.nightDeaths && this.nightDeaths.length ? this.nightDeaths[0].seat : -1;
    const order = [];
    for (let i = 1; i <= this.players.length; i++) {
      const p = this.players[(anchor + i + this.players.length) % this.players.length];
      if (p.alive) order.push(p);
    }
    return order;
  }

  /* ---------------- 投票 ---------------- */

  async voteRound() {
    this.phase = 'vote';
    this.votesShown = false;
    this.players.forEach((p) => { p.votes = 0; });
    this.sync();

    await this.host('发言结束，开始投票。');

    const tally = new Map();
    const record = [];
    const voters = this.alive();
    let done = 0;
    this.voteProgress = { done, total: voters.length };
    this.sync();

    for (const p of voters) {
      let cast = null; // 观战视角记录：目标描述
      if (p.isAI) {
        await pace(500);
        const t = aiVote(this, p);
        if (t) {
          tally.set(t.seat, (tally.get(t.seat) || 0) + 1);
          record.push(`${p.name} → ${t.name}`);
          cast = `${t.seat + 1}号 ${t.name}`;
        }
      } else {
        const action = await this.ask(p, { kind: 'vote', hint: '点选你要放逐的玩家' }, T.VOTE);
        if (action && action.seat != null) {
          const t = this.bySeat(Number(action.seat));
          if (t && t.alive && t !== p) {
            tally.set(t.seat, (tally.get(t.seat) || 0) + 1);
            record.push(`${p.name} → ${t.name}`);
            cast = `${t.seat + 1}号 ${t.name}`;
          }
        } else if (action) {
          cast = '弃票';
        }
      }
      done += 1;
      this.voteProgress = { done, total: voters.length };
      // 观战上帝视角：实时看到谁投给了谁
      if (this.spectators.length) {
        const line = { t: 'voteCast', from: `${p.seat + 1}号 ${p.name}`, to: cast || '未投' };
        for (const s of this.spectators) this.sendTo(s, line);
      }
      this.sync();
    }

    this.voteProgress = null;
    this.votesShown = true;
    this.players.forEach((p) => { p.votes = tally.get(p.seat) || 0; });
    this.sync();

    const entries = [...tally.entries()]
      .map(([seat, count]) => ({ p: this.bySeat(seat), count }))
      .sort((a, b) => b.count - a.count);

    if (!entries.length) {
      await this.host('全员弃票，本轮无人出局。');
      this.events.push({ day: this.day, text: '投票：全员弃票' });
    } else {
      const top = entries[0];
      const tied = entries.filter((e) => e.count === top.count);
      const detail = entries.map((e) => `${e.p.name} ${e.count} 票`).join('，');
      await this.host(`投票结果：${detail}。`);

      if (tied.length > 1) {
        await this.host('出现平票，本轮无人出局。');
        this.events.push({ day: this.day, text: `投票：${detail}，平票无人出局` });
      } else {
        await pace(300);
        top.p.alive = false;
        this.sync();
        await this.host(`${top.p.name} 被放逐出局。`);
        this.events.push({ day: this.day, text: `${top.p.name} 被投票放逐` });
        // 被投出局的人留遗言
        await this.lastWordsFor(top.p, 'vote');
      }
    }

    if (this.checkWin()) return;
    if (!this.running) return;

    await this.host('游戏继续，请准备进入下一夜。');
    await pace(400);
  }

  /* ---------------- 判定 ---------------- */

  checkWin() {
    if (this.phase === 'end') return true;
    const alive = this.alive();
    const wolves = alive.filter((p) => p.role === 'wolf').length;
    const gods = alive.filter((p) => p.role === 'seer' || p.role === 'witch').length;
    const villagers = alive.filter((p) => p.role === 'villager').length;

    if (wolves === 0) return this.finish('good');
    if (gods === 0 || villagers === 0) return this.finish('wolf');
    return false;
  }

  finish(winner) {
    this.running = false;
    this.phase = 'end';
    this.winner = winner;
    this.speakingSeat = null;
    this.votesShown = false;
    this.speak = null;
    this.voteProgress = null;
    this.closeWolfTalk();

    const alive = this.alive();
    const gods = alive.filter((p) => p.role === 'seer' || p.role === 'witch').length;
    this.winReason =
      winner === 'wolf'
        ? gods === 0
          ? '神职全部出局，狼人完成屠神。'
          : '村民全部出局，狼人完成屠民。'
        : '所有狼人都已出局，好人守住了村子。';

    this.logPush('host', winner === 'wolf' ? '狼人阵营胜利。' : '好人阵营胜利。');
    this.sync();
    this.broadcast({ t: 'over', winner, reason: this.winReason });
    return true;
  }

  /* ---------------- 再来一局 ---------------- */

  rematch(player) {
    if (this.phase !== 'end') return { ok: false, msg: '本局还没结束' };
    if (this.hostId !== player.id) return { ok: false, msg: '只有房主能开新局' };

    this.players = this.players.filter((p) => !p.isAI);
    this.players.forEach((p, i) => {
      p.seat = i;
      p.alive = true;
      p.role = null;
      p.checks = [];
      p.votes = 0;
      p.ready = false;
    });
    this.phase = 'lobby';
    this.day = 0;
    this.winner = null;
    this.winReason = '';
    this.events = [];
    this.log = [];
    this.witch = { heal: true, poison: true };
    this.accused = {};
    this.speak = null;
    this.voteProgress = null;
    this.wolfTalk = false;
    this.waiters.clear();
    this.sync();
    return { ok: true };
  }
}
