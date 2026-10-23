import { chat, llmEnabled } from './llm.js';

const ROLE_LABEL = { wolf: '狼人', villager: '村民', seer: '预言家', witch: '女巫' };

const WOLF_REASONS = [
  '他白天带票最凶，留着迟早咬到我们',
  '他像个神职，先做掉安心',
  '他发言条理太清楚，威胁最大',
  '他一直在盘狼坑，别留到明天'
];

const WOLF_REPLIES = [
  '行，你定，我跟你。',
  '可以，我本来想刀另一个，但听你的。',
  '嗯，那就这么定。',
  '好，你说刀谁就刀谁。'
];

const OPENERS = [
  '我先说下我的看法。',
  '听了一圈，我理一下。',
  '这轮我表个态。',
  '我说说我的判断。',
  '刚才那轮我一直在听，现在说说。'
];

const FILLERS = ['说实话，', '我个人的感觉是，', '我不太确定，但', '有可能是我多想了，'];

const VILLAGER_REASONS = [
  '的观点我接不上',
  '的态度有点躲',
  '说得太含糊',
  '一直在跟票，没有自己的判断',
  '前后逻辑对不上'
];

const WOLF_ACCUSES = [
  '一直在划水，没有实质内容',
  '逻辑前后矛盾',
  '明显在带节奏',
  '发言太飘了',
  '总在挑事但不说结论'
];

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 把别人说过的话压成一句干净的短引用，避免引号套引号 */
function quote(text, max = 14) {
  const clean = String(text)
    .replace(/[「」“”"'‘’（）()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function weightedPick(arr, weightFn) {
  const weights = arr.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}

/* ---------------- 决策 ---------------- */

export function aiWolfTarget(room, wolf) {
  const pool = room.alive().filter((p) => p.role !== 'wolf');
  if (!pool.length) return null;
  return weightedPick(pool, (p) => 1 + (room.accused[p.seat] || 0) * 1.5);
}

export function wolfSuggestionReason() {
  return pickOne(WOLF_REASONS);
}

export function wolfReplyAfterOverride() {
  return pickOne(WOLF_REPLIES);
}

export function aiSeerTarget(room, seer) {
  const pool = room.alive().filter(
    (p) => p !== seer && !seer.checks.some((c) => c.seat === p.seat)
  );
  const list = pool.length ? pool : room.alive().filter((p) => p !== seer);
  if (!list.length) return null;
  return weightedPick(list, (p) => 1 + (room.accused[p.seat] || 0));
}

export function aiWitchChoice(room, witch) {
  const victim = room.wolfTarget;
  const firstNight = room.day <= 1;

  if (victim && victim.seat !== witch.seat && room.witch.heal && (firstNight || Math.random() < 0.5)) {
    return { choice: 'heal' };
  }
  if (!firstNight && room.witch.poison && Math.random() < 0.22) {
    const pool = room.alive().filter((p) => p !== witch);
    if (pool.length) return { choice: 'poison', target: pickOne(pool) };
  }
  return { choice: 'none' };
}

export function aiVote(room, voter) {
  const others = room.alive().filter((p) => p !== voter);
  if (!others.length) return null;

  if (voter.role === 'seer') {
    const wolves = voter.checks.filter((c) => c.isWolf && room.bySeat(c.seat).alive);
    if (wolves.length) return room.bySeat(wolves[wolves.length - 1].seat);
  }

  let pool = others;
  if (voter.role === 'wolf') {
    const goods = others.filter((p) => p.role !== 'wolf');
    if (goods.length) pool = goods;
  }
  return weightedPick(pool, (p) => 1 + (room.accused[p.seat] || 0) * 2 + Math.random() * 1.5);
}

/* ---------------- 发言 ---------------- */

function lastSpeakerLine(room, player) {
  const speeches = room.log.filter((l) => l.type === 'player' && l.name !== player.name);
  if (!speeches.length) return null;
  return speeches[speeches.length - 1];
}

function targetOf(room, player) {
  const others = room.alive().filter((p) => p !== player);
  if (!others.length) return null;

  if (player.role === 'seer' && player.checks.length) {
    const wolves = player.checks.filter((c) => c.isWolf && room.bySeat(c.seat).alive);
    if (wolves.length) return room.bySeat(wolves[wolves.length - 1].seat);
  }

  let pool = others;
  if (player.role === 'wolf') {
    const goods = others.filter((p) => p.role !== 'wolf');
    if (goods.length) pool = goods;
  }
  return weightedPick(pool, (p) => 1 + (room.accused[p.seat] || 0) * 1.5 + Math.random());
}

/** 本地话术引擎（未接大模型时使用，追求自然的口语感和前后呼应） */
function localSpeech(room, player) {
  const target = targetOf(room, player);
  if (!target) return '场上只剩我一个了，直接投票吧。';

  const prev = lastSpeakerLine(room, player);
  const parts = [];

  if (prev && Math.random() < 0.6) {
    // 只在对方的话足够"干净"时才引用，避免引号套引号
    const q = prev.text.includes('刚才') ? '' : quote(prev.text);
    parts.push(q ? `${prev.name}刚才说「${q}」，我不太认同。` : `${prev.name}刚才那段话，我不太认同。`);
  } else {
    parts.push(pickOne(OPENERS));
  }

  if (player.role === 'seer' && player.checks.length) {
    const last = player.checks[player.checks.length - 1];
    const t = room.bySeat(last.seat);
    const prefix = Math.random() < 0.5 ? '我直接说身份，' : '';
    parts.push(`${prefix}我是预言家，验的是 ${t.name}，${last.isWolf ? '他是狼' : '他是好人'}。`);
    parts.push(`所以这轮我出 ${target.name}。`);
  } else if (player.role === 'wolf') {
    const reason = pickOne(WOLF_ACCUSES);
    parts.push(`${target.name} 这轮${reason}，我第一个怀疑他。`);
    parts.push(pickOne(['这票我给他。', '建议先出他，明天再看。', '我跟票。']));
  } else {
    const reason = pickOne(VILLAGER_REASONS);
    const lead = Math.random() < 0.4 ? pickOne(FILLERS) : '';
    parts.push(`${lead}${target.name} ${reason}，我不太敢站他。`);
    parts.push(pickOne(['我先投他试试。', '这轮我跟一下。', '我倾向出他。']));
  }

  room.accused[target.seat] = (room.accused[target.seat] || 0) + 1;
  return parts.join('');
}

function historyText(room, limit = 10) {
  const lines = room.log.filter((l) => l.type === 'player').slice(-limit);
  if (!lines.length) return '（还没有人发过言）';
  return lines.map((l) => `${l.name}：${l.text}`).join('\n');
}

async function llmSpeech(room, player) {
  const alive = room.alive().map((p) => `${p.seat + 1}号${p.name}`);
  const known =
    player.role === 'seer' && player.checks.length
      ? player.checks
          .map((c) => `你验过 ${room.bySeat(c.seat).name} 是${c.isWolf ? '狼人' : '好人'}`)
          .join('；')
      : '';

  const system = [
    `你在玩中文狼人杀，你是「${ROLE_LABEL[player.role]}」，${player.seat + 1} 号位，名字叫${player.name}。`,
    '现在轮到你发言。要求：',
    '1) 像真人在语音里随口说话，1-2 句，不超过 60 字；',
    '2) 不要写“（笑）”“顿了顿”这类旁白，不要写自己的名字和角色标签，不要用引号包起来；',
    '3) 可以怀疑别人、表态要投谁，语气自然口语化；',
    player.role === 'wolf' ? '4) 你是狼人，要伪装成好人，可以带节奏，但绝不能承认自己是狼。' : '',
    player.role === 'seer' && known ? `4) 你可以报查验结果（${known}），也可以选择暂时不报。` : '',
    player.role === 'witch' ? '4) 不要透露你用过什么药。' : '',
    '只输出发言内容本身。'
  ].filter(Boolean).join('\n');

  const user = [
    `当前存活：${alive.join('、')}`,
    `之前的发言：\n${historyText(room)}`,
    '请发言。'
  ].join('\n\n');

  const text = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]);
  return text.replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/\n+/g, ' ').slice(0, 90);
}

export async function aiSpeech(room, player) {
  if (llmEnabled()) {
    try {
      const text = await llmSpeech(room, player);
      if (text && text.length >= 4) return text;
    } catch (err) {
      console.warn('[ai] 大模型发言失败，改用本地话术:', err.message);
    }
  }
  return localSpeech(room, player);
}

/* ---------------- 遗言 ---------------- */

export async function aiLastWords(room, player, reason) {
  if (llmEnabled()) {
    try {
      const system = `你在玩中文狼人杀，你是「${ROLE_LABEL[player.role]}」，刚被${reason === 'vote' ? '投票放逐' : '狼人杀害'}出局。请留一句遗言，不超过 40 字，口语化，可以指认怀疑对象、可以托付好人；狼人不要自曝身份。只输出遗言内容。`;
      const text = await chat([{ role: 'system', content: system }, { role: 'user', content: `存活玩家：${room.alive().map((p) => p.name).join('、')}` }], { maxTokens: 100 });
      const clean = text.replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/\n+/g, ' ').slice(0, 60);
      if (clean.length >= 4) return clean;
    } catch (err) {
      console.warn('[ai] 大模型遗言失败:', err.message);
    }
  }

  const speaker = player;
  const suspects = room.alive().filter((p) => p !== speaker);
  const target = suspects.length ? weightedPick(suspects, (p) => 1 + (room.accused[p.seat] || 0)) : null;

  if (player.role === 'seer' && player.checks.length) {
    const last = player.checks[player.checks.length - 1];
    return `我是预言家，验的 ${room.bySeat(last.seat).name} 是${last.isWolf ? '狼' : '好人'}，好人别投错人。`;
  }
  if (player.role === 'wolf') {
    return `${target ? target.name + ' 有问题，' : ''}我死了也认，好人后面别乱投。`;
  }
  if (player.role === 'witch') {
    return `我走了，好人自己看票型吧${target ? `，我怀疑 ${target.name}` : ''}。`;
  }
  return `${target ? `我怀疑 ${target.name}，` : ''}好人帮我出他。`;
}
