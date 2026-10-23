/**
 * 神经语音合成（微软 Edge TTS，无需 API Key）
 *
 * 作用：把主持人和 AI 玩家的话变成接近真人的语音。
 * 特点：每个 AI 玩家固定一个音色，一局里 6 个人声音互不相同；
 *       不可用（无外网 / 被限流）时客户端自动回退到浏览器自带语音。
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

/** 主持人：男声播音腔，稳重清晰 */
export const HOST_VOICE = 'zh-CN-YunyangNeural';

/** AI 玩家音色池：一局 6 个座位正好各一个，男女老少都不同 */
export const PLAYER_VOICES = [
  'zh-CN-XiaoxiaoNeural', // 女 · 温柔
  'zh-CN-YunxiNeural', // 男 · 青年
  'zh-CN-XiaoyiNeural', // 女 · 活泼
  'zh-CN-YunjianNeural', // 男 · 沉稳
  'zh-CN-XiaochenNeural', // 女 · 知性
  'zh-CN-YunxiaNeural' // 男 · 少年
];

export function voiceForSeat(seat) {
  return PLAYER_VOICES[Math.abs(Number(seat) || 0) % PLAYER_VOICES.length];
}

const disabled = process.env.TTS_OFF === '1';
let ready = null; // null=未知, true/false=探测结果

const cache = new Map();
const CACHE_MAX = 400;

let chain = Promise.resolve();
function serial(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

function synthOnce(text, voice) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = lib();
  const fmt = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
  const tts = new MsEdgeTTS();

  return new Promise(async (resolve, reject) => {
    let settled = false;
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(buf);
    };
    const timer = setTimeout(() => done(new Error('tts timeout')), 6000);

    try {
      await tts.setMetadata(voice, fmt);
      const { audioStream } = tts.toStream(text);
      const chunks = [];
      audioStream.on('data', (c) => chunks.push(Buffer.from(c)));
      audioStream.on('end', () => done(null, Buffer.concat(chunks)));
      audioStream.on('error', (e) => done(e));
    } catch (err) {
      done(err);
    }
  });
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

  const key = voice + '|' + clean;
  if (cache.has(key)) return cache.get(key);

  const buf = await serial(async () => {
    if (cache.has(key)) return cache.get(key);
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await synthOnce(clean, voice);
        if (out && out.length > 400) {
          cache.set(key, out);
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
          return out;
        }
        lastError = new Error('tts empty');
      } catch (err) {
        lastError = err;
        // 429 限流：等一会儿再试一次
        if (/429/.test(String(err.message))) await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw lastError || new Error('tts failed');
  });

  return buf;
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
      await synthesize('主持人准备就绪。', HOST_VOICE);
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
