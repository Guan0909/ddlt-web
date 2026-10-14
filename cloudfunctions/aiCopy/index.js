'use strict';
// aiCopy：DeepSeek 在线解释性文案（备用 GLM-4-Flash，OpenAI 兼容端点）
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
      temperature: 0.6,
      max_tokens: 300,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('AI HTTP ' + res.status);
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
}

// ① 路线叙事：输入是引擎已排好的结构化路线，输出 60~90 字总推荐语（硬上限 110 字；文体规范见 skills/narrative-copy）
async function narrative(body) {
  const r = body.route;
  if (!r || !r.dayPlans) return null;
  // 给 AI 的上下文全部来自引擎/景点库的事实：日标签、站点名与顺序、时段标签、是否远郊日
  const lib = Object.fromEntries((loadSpots(r.city) || []).map(s => [s.id, s]));
  const digest = r.dayPlans.map(d => {
    const stops = d.items.filter(i => i.type === 'stop');
    const names = stops.map(i => {
      const s = lib[i.id];
      const hint = s && (s.tags || []).find(t => /早去|赶早|夜景|晚上|夜场/.test(t));
      return hint ? `${i.name}（${hint}）` : i.name;
    }).join('、');
    const allSuburb = stops.length > 0 && stops.every(i => lib[i.id] && lib[i.id].suburb);
    return `D${d.day} ${d.label}${allSuburb ? '（远郊）' : ''}：${names}`;
  }).join('\n');
  const text = await chat(
    '你是「点定旅途」的旅行编辑，为已定行程写一段总推荐语，60~90 字，绝不超过 110 字。\n' +
    '红线：只描述输入里给定的事实（城市、天数、起点、线路名、站点名与顺序、括号里的时段标签、是否远郊日），' +
    '禁止编造景点、时间、价格、天气、班次；禁止表情符号与"必打卡/绝绝子"类网络腔，不用夸张最高级。\n' +
    '文体：编辑腔，克制；名词动词多于形容词；把判断藏进顺序安排（如"博物馆排在午后最热时"）；' +
    '两句以内说完，句读干净；多日行程写出节奏对比（如"城里慢、城外赶"、"白天馆、入夜灯"）；' +
    '遇到"早去/夜景"标签就落成具体的时辰安排。\n' +
    '样例一（成都三日）：城里两天慢慢逛：博物馆排在午后，茶社留给上午；第三天赶早去都江堰。三国、诗圣和熊猫，一个都没绕路。\n' +
    '样例二（杭州三日）：第一天沿湖慢走，把落日留给长桥；第二天进山里问茶，寺、溪、田都在一条线上；第三天赶早去湿地。湖与山，各占了合适的时辰。',
    `城市：${r.city}，天数：${r.days}，起点：${r.origin && r.origin.name}\n${digest}`,
    5000   // 叙事非阻塞（模板已先出），放宽到 5s；提取仍为默认 3s
  );
  if (!text) return null;
  const clean = text.replace(/\s+/g, '');
  return clean.length > 110 ? clean.slice(0, 109) + '…' : clean;   // 硬上限 110 字
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
