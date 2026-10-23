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

const OPENERS = ['我先说下我的看法。', '听了一圈，我说说判断。', '这轮我表个态。', '我理一下现在的局面。'];

const VILLAGER_REASONS = ['的观点我接不上', '的态度有点躲', '说得太含糊', '一直在跟票，没有自己的判断'];

const WOLF_ACCUSES = ['一直在划水，没有实质内容', '逻辑前后矛盾', '明显在带节奏', '发言太飘了'];

const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)];

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

/** AI 狼刀哪个：优先好人里被怀疑过的（顺着场上节奏走） */
export function aiWolfTarget(room, wolf) {
  const pool = room.alive().filter((p) => p.role !== 'wolf');
  if (!pool.length) return null;
  return weightedPick(pool, (p) => 1 + (room.accused[p.seat] || 0) * 1.5);
}

/** 狼队友给人类的建议理由 */
export function wolfSuggestionReason() {
  return pickOne(WOLF_REASONS);
}

export function wolfReplyAfterOverride() {
  return pickOne(WOLF_REPLIES);
}

/** AI 预言家查验：优先查没查过、发言多的人 */
export function aiSeerTarget(room, seer) {
  const pool = room.alive().filter(
    (p) => p !== seer && !seer.checks.some((c) => c.seat === p.seat)
  );
  const list = pool.length ? pool : room.alive().filter((p) => p !== seer);
  if (!list.length) return null;
  return weightedPick(list, (p) => 1 + (room.accused[p.seat] || 0));
}

/** AI 女巫用药 */
export function aiWitchChoice(room, witch) {
  const victim = room.wolfTarget;
  const firstNight = room.day <= 1;

  if (victim && victim.seat !== witch.seat && room.witch.heal && (firstNight || Math.random() < 0.5)) {
    return { choice: 'heal' };
  }
  if (!firstNight && room.witch.poison && Math.random() < 0.2) {
    const pool = room.alive().filter((p) => p !== witch);
    if (pool.length) return { choice: 'poison', target: pickOne(pool) };
  }
  return { choice: 'none' };
}

/** AI 白日发言 */
export function aiSpeech(room, player) {
  const others = room.alive().filter((p) => p !== player);
  if (!others.length) return '场上只剩我一个了，直接投票吧。';

  let target = null;
  if (player.role === 'seer' && player.checks.length) {
    const wolves = player.checks.filter((c) => c.isWolf && room.bySeat(c.seat).alive);
    if (wolves.length) target = room.bySeat(wolves[wolves.length - 1].seat);
  }

  if (!target) {
    let pool = others;
    if (player.role === 'wolf') {
      const goods = others.filter((p) => p.role !== 'wolf');
      if (goods.length) pool = goods;
    }
    target = weightedPick(pool, (p) => 1 + (room.accused[p.seat] || 0) * 1.5 + Math.random());
  }

  const parts = [pickOne(OPENERS)];

  if (player.role === 'seer' && player.checks.length) {
    const last = player.checks[player.checks.length - 1];
    const t = room.bySeat(last.seat);
    parts.push(`我是预言家，验的是 ${t.name}，${last.isWolf ? '他是狼人' : '他是好人'}。`);
    if (target) parts.push(`所以这轮我出 ${target.name}。`);
  } else if (player.role === 'wolf') {
    parts.push(`${target.name} ${pickOne(WOLF_ACCUSES)}，我怀疑他是狼。`);
    parts.push(pickOne(['这票我投他。', '建议先出他。', '我投他。']));
  } else {
    parts.push(`${target.name} ${pickOne(VILLAGER_REASONS)}，${pickOne(['我先投他', '这轮我跟票他', '我倾向出他'])}。`);
  }

  room.accused[target.seat] = (room.accused[target.seat] || 0) + 1;
  return parts.join('');
}

/** AI 投票 */
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
