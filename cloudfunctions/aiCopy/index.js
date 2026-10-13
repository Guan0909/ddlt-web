'use strict';
// aiCopy：GLM-4-Flash 在线解释性文案（备用 DeepSeek，OpenAI 兼容端点）
// 铁律：AI 只做解释层，不生成地点/坐标/时间/价格；3s 超时或无 Key 一律回退（fallback:true）；
// 提取类输出强制 spots 库白名单过滤，幻觉地名直接丢弃。

const store = require('./store');
const { parseBody, ok, fail } = require('./http');
const { loadSpots } = require('./routeKit');

const PROVIDER = process.env.AI_PROVIDER || 'deepseek';   // deepseek | glm
const ENDPOINTS = {
  glm: { url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', envKey: 'GLM_KEY' },
  deepseek: {
    url: process.env.AI_BASE_URL || 'https://api.deepseek.com/chat/completions',
    model: process.env.AI_MODEL || 'deepseek-chat',
    envKey: 'DEEPSEEK_KEY',
  },
};

async function chat(system, user, timeoutMs = 3000) {   // 红线：默认 3 秒超时回退
  const p = ENDPOINTS[PROVIDER];
  const key = process.env[p.envKey];
  if (!key) return null;
  const res = await fetch(p.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: p.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.7,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('AI HTTP ' + res.status);
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
}

// ① 路线叙事：输入是引擎已排好的结构化路线，输出 ≤60 字总推荐语
async function narrative(body) {
  const r = body.route;
  if (!r || !r.dayPlans) return null;
  const digest = r.dayPlans.map(d =>
    `D${d.day} ${d.label}：${d.items.filter(i => i.type === 'stop').map(i => i.name).join('、')}`
  ).join('\n');
  const text = await chat(
    '你是「点定旅途」的旅行编辑。根据给定的已定行程写一句总推荐语，≤60 字，编辑感、克制、不夸张，' +
    '只描述已给定的事实（城市、天数、站点、线路名），禁止编造景点、营业时间、价格、天气等任何新信息，禁止用表情符号。',
    `城市：${r.city}，天数：${r.days}，起点：${r.origin && r.origin.name}\n${digest}`,
    5000   // 叙事非阻塞（模板已先出），放宽到 5s；提取仍为默认 3s
  );
  if (!text) return null;
  return text.replace(/\s+/g, '').slice(0, 80);   // 超长硬截断
}

// ② 攻略文本提取：JSON schema 约束 + spots 库白名单过滤（输入限 500 字）
async function extract(body) {
  const spots = loadSpots(body.city);
  if (!spots) return { spotIds: [] };
  const text = String(body.text || '').slice(0, 500);
  if (!text.trim()) return { spotIds: [] };
  const whitelist = spots.map(s => s.name);
  const raw = await chat(
    '从用户粘贴的旅游攻略文本中提取景点/地点名称。只允许从给定白名单中选择，逐字返回白名单中的原始名称，' +
    '禁止创造白名单以外的任何名称。只输出 JSON：{"spots":["名称1","名称2"]}，没有匹配则输出 {"spots":[]}。',
    `白名单：${whitelist.join('、')}\n\n攻略文本：${text}`
  );
  if (!raw) return { spotIds: [] };
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw);
    const names = Array.isArray(parsed.spots) ? parsed.spots : [];
    const norm = s => String(s).replace(/\s+/g, '');
    const byNorm = new Map(spots.map(s => [norm(s.name), s.id]));
    const spotIds = [...new Set(names.map(n => byNorm.get(norm(n))).filter(Boolean))];
    return { spotIds };
  } catch (e) {
    return { spotIds: [] };
  }
}

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event) || {};
  try {
    if (body.kind === 'narrative') {
      const text = await narrative(body);
      return ok({ text, fallback: !text });
    }
    if (body.kind === 'extract') {
      const r = await extract(body);
      return ok({ ...r, fallback: false });
    }
    return fail('未知 kind');
  } catch (e) {
    return ok({ text: null, spotIds: [], fallback: true });   // 任何异常都回退，绝不阻塞主流程
  }
};
