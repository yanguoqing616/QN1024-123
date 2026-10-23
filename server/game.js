import {
  aiWolfTarget,
  aiSeerTarget,
  aiWitchChoice,
  aiSpeech,
  aiVote,
  wolfSuggestionReason
} from './ai.js';

const TOTAL_SEATS = 6;
const AI_NAMES = ['阿岚', '小七', '老陈', '沐沐', '青禾', '阿泽'];

const T = {
  NIGHT: 25000,
  SPEECH: 60000,
  VOTE: 30000
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    this.running = false;
    this.seq = 0;
    this.lastActive = Date.now();
  }

  /* ---------------- 成员管理 ---------------- */

  get humans() {
    return this.players.filter((p) => !p.isAI);
  }

  alive() {
    return this.players.filter((p) => p.alive);
  }

  bySeat(seat) {
    return this.players.find((p) => p.seat === seat) || null;
  }

  join(socket, name, playerId) {
    const existing = playerId ? this.players.find((p) => p.id === playerId && !p.isAI) : null;
    if (existing) {
      existing.socket = socket;
      existing.connected = true;
      this.lastActive = Date.now();
      return existing;
    }
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

  leave(player) {
    if (!player) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((p) => p !== player);
      this.players.forEach((p, i) => { p.seat = i; });
      if (this.hostId === player.id) {
        const next = this.humans[0];
        this.hostId = next ? next.id : null;
      }
    } else {
      player.connected = false;
    }
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
  }

  sync() {
    for (const p of this.players) {
      if (p.isAI) continue;
      this.sendTo(p, { t: 'state', room: this.publicState(p) });
    }
  }

  publicState(forPlayer) {
    const me = forPlayer || null;
    return {
      code: this.code,
      phase: this.phase,
      day: this.day,
      hostId: this.hostId,
      winner: this.winner,
      winReason: this.winReason,
      speakingSeat: this.speakingSeat,
      votesShown: this.votesShown,
      players: this.players.map((p) => ({
        id: p.id,
        seat: p.seat,
        name: p.name,
        isAI: p.isAI,
        alive: p.alive,
        ready: p.ready,
        connected: p.connected,
        votes: p.votes || 0,
        you: me ? p.id === me.id : false,
        role: me && (p.id === me.id || this.phase === 'end') ? p.role : null
      })),
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
                : null
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
    this.broadcast({ t: 'host', text });
    await sleep(Math.min(6000, Math.max(1400, text.length * 190)));
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
    const waiter = this.waiters.get('act:' + player.id);
    if (!waiter) return false;
    waiter(action);
    return true;
  }

  async ask(player, prompt, timeoutMs) {
    if (!player || player.isAI) return null;
    this.sendTo(player, { t: 'turn', ...prompt, seconds: Math.round(timeoutMs / 1000) });
    const action = await this.waitAction(player, timeoutMs);
    this.sendTo(player, { t: 'turnEnd' });
    return action;
  }

  /* ---------------- 开局 ---------------- */

  start(player) {
    if (this.phase !== 'lobby') return { ok: false, msg: '已经开局了' };
    if (this.hostId !== player.id) return { ok: false, msg: '只有房主能开局' };
    if (!this.humans.every((p) => p.ready || p.id === this.hostId)) {
      return { ok: false, msg: '还有人没准备' };
    }

    while (this.players.length < TOTAL_SEATS) this.addAI();

    const deck = shuffle(['wolf', 'wolf', 'villager', 'villager', 'seer', 'witch']);
    this.players.forEach((p, i) => {
      p.seat = i;
      p.role = deck[i];
      p.alive = true;
      p.checks = [];
      p.votes = 0;
      p.ready = true;
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
    this.players.forEach((p) => { p.votes = 0; });
    this.changed();
    this.sync();

    await this.host('天黑请闭眼。');

    await this.wolvesTurn();
    await this.seerTurn();
    await this.witchTurn();
  }

  changed() {
    this.lastActive = Date.now();
  }

  async wolvesTurn() {
    const wolves = this.players.filter((p) => p.alive && p.role === 'wolf');
    if (!wolves.length) return;

    await this.host('狼人请睁眼，商量今晚刀谁。');

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
          suggest: suggestion
            ? { seat: suggestion.seat, name: suggestion.name, reason, mate: aiWolf.name }
            : null
        },
        T.NIGHT
      );
      if (action && action.seat != null) {
        const target = this.bySeat(Number(action.seat));
        if (target && target.alive && target.role !== 'wolf') picks.push(target);
      }
    }

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

    if (seer.isAI) {
      const t = aiSeerTarget(this, seer);
      if (t) seer.checks.push({ seat: t.seat, isWolf: t.role === 'wolf' });
      await sleep(900);
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
        await sleep(2200);
      }
    }

    await this.host('预言家请闭眼。');
  }

  async witchTurn() {
    const witch = this.players.find((p) => p.alive && p.role === 'witch');
    if (!witch) return;

    await this.host('女巫请睁眼。');
    const victim = this.wolfTarget;

    if (witch.isAI) {
      const choice = aiWitchChoice(this, witch);
      if (choice.choice === 'heal' && victim) {
        this.witch.heal = false;
        this.savedVictim = victim;
      } else if (choice.choice === 'poison' && choice.target) {
        this.witch.poison = false;
        this.poisonTarget = choice.target;
      }
      await sleep(1000);
    } else {
      const canHeal = !!(victim && victim.seat !== witch.seat && this.witch.heal);
      const action = await this.ask(
        witch,
        {
          kind: 'witch',
          hint: '今晚要不要用药？',
          info: {
            victim: victim ? victim.name : null,
            selfVictim: !!(victim && victim.seat === witch.seat),
            canHeal,
            canPoison: this.witch.poison
          }
        },
        T.NIGHT
      );

      if (action && action.choice === 'heal' && canHeal) {
        this.witch.heal = false;
        this.savedVictim = victim;
        this.sendTo(witch, { t: 'note', title: '用药成功', text: `你用解药救下了 ${victim.name}。` });
      } else if (action && action.choice === 'poison' && this.witch.poison) {
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

    if (this.checkWin()) return;

    await this.host('请按顺序发言。');
    for (const p of this.speechOrder()) {
      if (!p.alive) continue;
      if (this.checkWin()) return;

      this.speakingSeat = p.seat;
      this.sync();

      if (p.isAI) {
        await sleep(700);
        const text = aiSpeech(this, p);
        this.logPush('player', text, p.name);
        this.broadcast({ t: 'speech', seat: p.seat, name: p.name, text });
        await sleep(Math.min(7000, Math.max(1800, text.length * 165)));
      } else {
        const action = await this.ask(p, { kind: 'speak', hint: '轮到你发言' }, T.SPEECH);
        const text = action && action.text ? String(action.text).slice(0, 300) : '';
        const finalText = text || '（没有发言）';
        this.logPush('player', finalText, p.name);
        this.broadcast({ t: 'speech', seat: p.seat, name: p.name, text: finalText });
        await sleep(500);
      }

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

    for (const p of this.alive()) {
      if (p.isAI) {
        await sleep(500);
        const t = aiVote(this, p);
        if (t) {
          tally.set(t.seat, (tally.get(t.seat) || 0) + 1);
          record.push(`${p.name} → ${t.name}`);
        }
      } else {
        const action = await this.ask(p, { kind: 'vote', hint: '点选你要放逐的玩家' }, T.VOTE);
        if (action && action.seat != null) {
          const t = this.bySeat(Number(action.seat));
          if (t && t.alive && t !== p) {
            tally.set(t.seat, (tally.get(t.seat) || 0) + 1);
            record.push(`${p.name} → ${t.name}`);
          }
        }
      }
    }

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
        await sleep(300);
        top.p.alive = false;
        this.sync();
        await this.host(`${top.p.name} 被放逐出局。`);
        this.events.push({ day: this.day, text: `${top.p.name} 被投票放逐` });
      }
    }

    if (this.checkWin()) return;
    if (!this.running) return;

    await this.host('游戏继续，请准备进入下一夜。');
    await sleep(400);
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
    this.waiters.clear();
    this.sync();
    return { ok: true };
  }
}
