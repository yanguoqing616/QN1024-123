/**
 * 可选的大模型接入层（OpenAI 兼容协议）
 * 配好下面三个环境变量就自动启用，没配则用本地话术引擎兜底，功能不受影响。
 *
 *   LLM_BASE_URL=https://api.deepseek.com/v1   （或七牛/通义/豆包等 OpenAI 兼容地址）
 *   LLM_API_KEY=sk-xxxx
 *   LLM_MODEL=deepseek-chat
 */
const BASE = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || '';

export function llmEnabled() {
  return Boolean(BASE && KEY && MODEL);
}

export async function chat(messages, { temperature = 0.95, maxTokens = 160, timeout = 9000 } = {}) {
  if (!llmEnabled()) throw new Error('llm disabled');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('llm http ' + res.status);
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  } finally {
    clearTimeout(timer);
  }
}
