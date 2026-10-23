/**
 * 神经语音合成（微软 Edge TTS，无需 API Key）
 *
 * 目标：让主持人 / AI 玩家听起来像真人在说话，而不是"念稿机器人"。
 * 做法：
 *   1. 96kbps 高码率（48kbps 会发闷，像电话音，是"假"的主要来源之一）
 *   2. 每句话在 SSML 里微调语速和音高（±3% / ±2Hz），避免每条都一个腔调
 *   3. 每个座位固定一个音色，一局里 6 个人声音互不相同
 *   4. 某个音色合成失败（返回空音频）自动换备用音色，绝不退回机器人音
 *
 * 关闭方式：环境变量 TTS_OFF=1
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let edge = null;
function lib() {
  if (!edge) {
    try {
      edge = require('msedge-tts');
    } catch {
      edge = false;
    }
  }
  return edge;
}

/** 主持人：男声播音腔，普通话，稳重清晰 */
export const HOST_VOICE = 'zh-CN-YunyangNeural';

/**
 * 音色池：每个座位固定一把声音。
 * - dialect：默认，带方言（东北话 / 陕西话），一桌人听起来最像真人在开黑
 * - mandarin：全普通话，需要正式一点时用
 *
 * 只用实测能出声的音色。这套免费接口只开放了 14 个中文音色，
 * 方言只有 liaoning-Xiaobei（东北话）和 shaanxi-Xiaoni（陕西话）两个；
 * 河南、四川等音色调用会返回空音频（0 字节），所以不要写进来。
 */
export const VOICE_STYLES = {
  dialect: [
    { id: 'zh-CN-liaoning-XiaobeiNeural', label: '女 · 东北话' },
    { id: 'zh-CN-YunxiNeural', label: '男 · 青年' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', label: '女 · 陕西话' },
    { id: 'zh-CN-YunjianNeural', label: '男 · 沉稳' },
    { id: 'zh-CN-XiaoxiaoNeural', label: '女 · 温柔' },
    { id: 'zh-CN-YunxiaNeural', label: '男 · 少年' }
  ],
  mandarin: [
    { id: 'zh-CN-XiaoxiaoNeural', label: '女 · 温柔' },
    { id: 'zh-CN-YunxiNeural', label: '男 · 青年' },
    { id: 'zh-CN-XiaoyiNeural', label: '女 · 活泼' },
    { id: 'zh-CN-YunjianNeural', label: '男 · 沉稳' },
    { id: 'zh-CN-YunyangNeural', label: '男 · 播音' },
    { id: 'zh-CN-YunxiaNeural', label: '男 · 少年' }
  ]
};

/** 兼容旧引用：默认方言音色池 */
export const PLAYER_VOICES = VOICE_STYLES.dialect.map((v) => v.id);

export function normalizeStyle(style) {
  if (style === 'mandarin' || style === 'system') return style;
  return 'dialect';
}

export function voiceForSeat(seat, style = 'dialect') {
  const set = VOICE_STYLES[normalizeStyle(style)] || VOICE_STYLES.dialect;
  return set[Math.abs(Number(seat) || 0) % set.length].id;
}

/** 给前端展示用：这个风格下每个座位是什么声音 */
export function voiceTable(style = 'dialect') {
  const set = VOICE_STYLES[normalizeStyle(style)] || VOICE_STYLES.dialect;
  return set.map((v, i) => ({ seat: i, ...v }));
}

/** 兜底音色：某个音色失效时改用它，保证不会掉到系统机器人音 */
const BACKUP_VOICE = 'zh-CN-XiaoxiaoNeural';

/** 每个音色的基础语速/音高（百分比 / Hz），后面还会加一点随机抖动 */
const BASE = {
  'zh-CN-YunyangNeural': { rate: 6, pitch: 0 },
  'zh-CN-XiaoxiaoNeural': { rate: 10, pitch: 2 },
  'zh-CN-YunxiNeural': { rate: 8, pitch: 0 },
  'zh-CN-XiaoyiNeural': { rate: 12, pitch: 4 },
  'zh-CN-YunjianNeural': { rate: 3, pitch: -4 },
  'zh-CN-shaanxi-XiaoniNeural': { rate: 5, pitch: 1 },
  'zh-CN-liaoning-XiaobeiNeural': { rate: 9, pitch: 2 },
  'zh-CN-YunxiaNeural': { rate: 11, pitch: 3 }
};

const disabled = process.env.TTS_OFF === '1';
const FORMAT_KEY = 'AUDIO_24KHZ_96KBITRATE_MONO_MP3';
let ready = null; // null=未知, true/false=探测结果

const cache = new Map();
const CACHE_MAX = 500;
/** 合成失败过两次的音色，直接不再使用 */
const brokenVoices = new Map();

/** 简单稳定哈希：同一句话永远用同一组参数（这样缓存才有效） */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 给每句话算一组轻微起伏的语速/音高，避免"每句一个调" */
function prosodyFor(voice, text, salt = 0) {
  const base = BASE[voice] || { rate: 8, pitch: 0 };
  const h = hash(voice + '|' + text + '|' + salt);
  const rateJitter = (h % 7) - 3; // -3 ~ +3 %
  const pitchJitter = ((h >> 3) % 5) - 2; // -2 ~ +2 Hz
  const rate = Math.max(-20, Math.min(40, base.rate + rateJitter));
  const pitch = Math.max(-10, Math.min(10, base.pitch + pitchJitter));
  return {
    rate: (rate >= 0 ? '+' : '') + rate + '%',
    pitch: (pitch >= 0 ? '+' : '') + pitch + 'Hz'
  };
}

/** 合成队列：串行，避免一次性开太多连接被限流 */
let chain = Promise.resolve();
function serial(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

/** 复用连接：同一音色共享一个 MsEdgeTTS 实例，省掉每次握手 */
const instances = new Map();
function instanceFor(voice) {
  let tts = instances.get(voice);
  if (tts) return tts;
  const { MsEdgeTTS } = lib();
  tts = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 20000 });
  instances.set(voice, tts);
  return tts;
}

function resetInstance(voice) {
  const tts = instances.get(voice);
  if (!tts) return;
  try {
    tts.close();
  } catch {
    /* 忽略 */
  }
  instances.delete(voice);
}

async function synthOnce(text, voice) {
  const { OUTPUT_FORMAT } = lib();
  const tts = instanceFor(voice);
  const fmt = OUTPUT_FORMAT[FORMAT_KEY];

  const buf = await new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => done(new Error('tts timeout')), 12000);

    (async () => {
      try {
        if (!tts.__metaVoice || tts.__metaVoice !== voice) {
          await tts.setMetadata(voice, fmt);
          tts.__metaVoice = voice;
        }
        const { audioStream } = tts.toStream(text, prosodyFor(voice, text));
        const chunks = [];
        audioStream.on('data', (c) => chunks.push(Buffer.from(c)));
        audioStream.on('end', () => done(null, Buffer.concat(chunks)));
        audioStream.on('error', (e) => done(e));
      } catch (err) {
        done(err);
      }
    })();
  });

  if (!buf || buf.length < 800) {
    resetInstance(voice);
    throw new Error('tts empty');
  }
  return buf;
}

/**
 * 合成一段语音，返回 mp3 Buffer；不可用时抛错。
 * 相同文本 + 音色会命中内存缓存。
 */
export async function synthesize(text, voice = HOST_VOICE) {
  if (disabled) throw new Error('tts disabled');
  if (!lib()) throw new Error('tts lib missing');
  const clean = String(text || '').trim().slice(0, 200);
  if (!clean) throw new Error('empty text');

  const dead = brokenVoices.get(voice) || 0;
  const useVoice = dead >= 2 ? BACKUP_VOICE : voice;

  const key = useVoice + '|' + clean;
  if (cache.has(key)) return cache.get(key);

  return serial(async () => {
    if (cache.has(key)) return cache.get(key);
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = await synthOnce(clean, useVoice);
        cache.set(key, out);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return out;
      } catch (err) {
        lastError = err;
        if (/429/.test(String(err.message))) {
          await new Promise((r) => setTimeout(r, 700 + attempt * 500));
        }
      }
    }
    // 连续失败：这个音色以后改用备用音色，别每次都白等
    if (useVoice === voice) brokenVoices.set(voice, dead + 1);
    throw lastError || new Error('tts failed');
  });
}

/* ---------------- 可用性探测 ---------------- */
let probing = null;

async function doProbe() {
  if (disabled || !lib()) {
    ready = false;
    return false;
  }
  for (let i = 0; i < 3; i++) {
    try {
      await synthesize('主持人已经就位。', HOST_VOICE);
      ready = true;
      return true;
    } catch (err) {
      if (i === 2) {
        ready = false;
        console.warn('[tts] 神经语音不可用，客户端会回退浏览器语音:', err.message);
      } else {
        await new Promise((r) => setTimeout(r, 900));
      }
    }
  }
  return false;
}

/** 启动时探测一次，避免每句话都白等超时 */
export function probe() {
  if (!probing) probing = doProbe();
  return probing;
}

/** 探测还没结束时等它出结果，别让前几句话白丢 */
export async function ensureReady() {
  if (ready !== null) return ready;
  return probe();
}

export function ttsReady() {
  return ready === true;
}

/** 开场前把主持人固定台词先合成好，开局第一句就不用等 */
const WARM_LINES = [
  '天黑请闭眼，所有人闭上眼睛，不要出声。',
  '狼人请睁眼。',
  '请狼人商量一下，今晚要击杀谁。',
  '狼人请闭眼。',
  '预言家请睁眼。',
  '请选择一名玩家，查验他的身份。',
  '预言家请闭眼。',
  '女巫请睁眼。',
  '你要使用解药吗？',
  '你要使用毒药吗？',
  '女巫请闭眼。',
  '今晚的行动结束，所有人保持闭眼。',
  '天亮了。',
  '请按顺序发言。',
  '现在开始投票。',
  '投票结束。'
];

export async function warmup() {
  if (!(await ensureReady())) return;
  for (const line of WARM_LINES) {
    try {
      await synthesize(line, HOST_VOICE);
    } catch {
      /* 预热失败无所谓，真正用到时再合成 */
    }
  }
}
