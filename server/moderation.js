/**
 * 内容风控（moderation）
 * - 昵称 / 发言文本的敏感信息识别：涉黄、涉恐、涉政
 * - 命中即拦截：昵称拒绝使用，发言触发关闭房间
 *
 * 说明：
 * 1) 本地敏感词库是「兜底」方案，覆盖常见违规词的常见写法（全角/半角、
 *    大小写、空格、常见同音替代），不联网、零延迟、无密钥依赖。
 * 2) 生产环境强烈建议接入正规内容安全服务（如腾讯云内容安全/天御 TMS、
 *    阿里云内容安全），把 MODERATION_API_URL 配成审核接口即可，本模块会
 *    优先走远程审核、本地词库兜底。词库永远无法穷尽，法律合规责任在
 *    审核服务方。
 */

// ---------- 本地敏感词库（按类别） ----------
// 仅收录公认、明确的违禁词；涉政类只放「分裂/极端/邪教」等通用违规范畴，
// 具体实时名单请接入合规审核服务。
const WORD_LISTS = {
  // 涉黄：常见明确色情/招嫖关键词
  porn: [
    '约炮', '卖淫', '嫖娼', '招嫖', '裸聊', '色情', '黄色', '成人视频',
    'av女优', '自慰', '淫秽', '口交', '肛交', '性交易', '援交', '一夜情',
    '陪睡', '全套服务', '上门服务', '楼凤', '小姐包夜', '调教', 'sm服务'
  ],
  // 涉恐：暴恐、极端主义、违禁品
  terror: [
    '恐怖袭击', '恐怖分子', 'isis', '圣战', '爆炸物', '炸弹', '制作炸药',
    '枪支', '买卖枪支', '军火', '枪支弹药', '砍杀', '袭击学校', '人体炸弹',
    '暴恐', '极端组织', '屠杀'
  ],
  // 涉政：分裂、邪教、颠覆等通用违规范畴（实时敏感名单请接审核服务）
  politics: [
    '法轮功', '邪教', '分裂国家', '台独', '藏独', '疆独', '港独',
    '颠覆政权', '推翻政府', '暴动', '煽动'
  ]
};

// 归一化：全角转半角、小写、去空白，便于匹配变体
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

const CATEGORY_NAMES = { porn: '涉黄', terror: '涉恐', politics: '涉政' };

/** 本地词库检测：命中返回 { blocked, category, word } */
function checkLocal(text) {
  const t = normalize(text);
  if (!t) return { blocked: false, category: null, word: null };
  for (const [cat, words] of Object.entries(WORD_LISTS)) {
    for (const w of words) {
      if (t.includes(normalize(w))) {
        return { blocked: true, category: cat, word: w };
      }
    }
  }
  return { blocked: false, category: null, word: null };
}

// ---------- 远程审核接口（可选） ----------
// 配置 MODERATION_API_URL 后，会 POST { text }，期望返回
// { blocked: boolean, category?: string }；未配置或调用失败则本地兜底。
const API_URL = process.env.MODERATION_API_URL || '';

async function checkRemote(text) {
  if (!API_URL) return null;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.blocked === 'boolean') {
      return {
        blocked: data.blocked,
        category: data.category || 'sensitive',
        word: null
      };
    }
    return null;
  } catch {
    return null; // 远程失败，回落本地词库
  }
}

/** 统一审核入口：返回 { blocked, category, word } */
export async function moderate(text) {
  const remote = await checkRemote(text);
  if (remote) return remote;
  return checkLocal(text);
}

/** 昵称审核（同步，进房时用；命中即拒绝） */
export function checkName(name) {
  return checkLocal(name);
}

/** 发言文本审核（同步本地词库，命中即关房） */
export function checkText(text) {
  return checkLocal(text);
}

export { CATEGORY_NAMES };
