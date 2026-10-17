'use strict';
// 模板文案 → AI 文案 批量升级（8 条/次调用；校验不过整批回退，再单条重试）
// 用法：DEEPSEEK_KEY=… node scripts/upgrade-copy.js <城市…|all> [--apply] [--limit N]
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const d0 = path.join(ROOT, 'data', 'spots');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-registry.json'), 'utf8'));
const BASE = { 成都:'chengdu',北京:'beijing',上海:'shanghai',西安:'xian',重庆:'chongqing',杭州:'hangzhou',大理:'dali',广州:'guangzhou',贵阳:'guiyang',合肥:'hefei',昆明:'kunming',拉萨:'lhasa',丽江:'lijiang',南京:'nanjing',宁波:'ningbo',绍兴:'shaoxing',苏州:'suzhou',温州:'wenzhou',无锡:'wuxi',香格里拉:'xianggelila',西双版纳:'xishuangbanna',扬州:'yangzhou' };
const FILE = Object.assign({}, BASE, Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, v.file])));
const AI_URL = (process.env.AI_BASE_URL || 'https://new.fluapi.com/v1').replace(/\/$/, '') + '/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4.1-flash';
const BATCH = Number(process.env.COPY_BATCH || 8);
const TEMPLATE = /^(自然山水|自然与人文景观|历史古迹|城市公园|博物馆，|适合入夜再看的地标|适合带娃的景点|街区，|吃的街区|商圈，|古镇街区)/;
const BAD = /[0-9０-９]|门票|票价|免费|元|公里|km|最|第一|必去|必打卡|绝绝子|YYDS|！|!|震撼|绝美|A级|景区是|一处|建议游览|建议安排/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 少样本范例：从已升级的 AI 文案里按类目挑 2 条（长度合格、无禁用词）
let EXAMPLES = null;
function buildExamples(cityFile) {
  if (EXAMPLES) return EXAMPLES;
  const pool = {};
  try {
    const d = JSON.parse(fs.readFileSync(path.join(d0, cityFile + '.json'), 'utf8'));
    for (const s of d.spots || []) {
      if (s.copy_src !== 'ai' || !s.intro || !s.reason) continue;
      if (s.intro.length < 25 || s.intro.length > 45 || BAD.test(s.intro) || BAD.test(s.reason)) continue;
      (pool[s.cat] = pool[s.cat] || []).push(s.intro + '｜' + s.reason);
    }
  } catch (e) {}
  EXAMPLES = pool;
  return EXAMPLES;
}
function validate(o) {
  if (!o || typeof o.intro !== 'string' || typeof o.reason !== 'string') return null;
  const intro = o.intro.trim(), reason = o.reason.trim();
  if (intro.length < 12 || intro.length > 45) return null;
  if (reason.length < 6 || reason.length > 24) return null;
  if (intro.startsWith(String(o.id ? '' : ''))) {}
  if (BAD.test(intro) || BAD.test(reason)) return null;
  if (/《[^》]*》/.test(intro)) return null;
  return { intro, reason };
}
async function callBatch(list) {
  const lines = list.map((s, i) => (i + 1) + '. id=' + s.id + '｜' + s.name + '｜' + s.cat + '｜' + (s.suburb ? '城郊' : '城内') + '｜建议游览 ' + s.dur + ' 分钟｜评分 ' + (s.rating || '-') + (s.a_level ? '｜' + s.a_level + ' 景区' : '')).join('\n');
  const ex = [];
  try {
    const pool = EXAMPLES || {};
    const cats = [...new Set(list.map(s => s.cat))];
    for (const c of cats) {
      const arr = (pool[c] || []).slice(0, 2);
      arr.forEach(t => ex.push('  [' + c + '] ' + t));
    }
  } catch (e) {}
  const prompt = ['为下列景点各写两段中文文案，严格遵守规则：',
    '- intro（25~45 字）：说清「这里是什么」——写它自身的特征（山水的形态、古迹的年代感、街区的格局、博物馆的馆藏气质），点一句它在城里还是城郊；只用给定事实，不编造典故、年份、票价、开放时间。',
    '- reason（8~24 字）：一条**具体可执行**的游览建议——到什么时辰来、先看哪一块、避开什么；不要复述游玩时长。',
    '- 严格禁止（出现即不合格）：阿拉伯数字、中文数字加「小时/分钟」、「A级」「几A」「景区是」「一处」「建议游览」「建议安排」、门票价格、「最/第一/必去/必打卡/绝美/震撼」、感叹号、表情、网络流行语。',
    '- 每段不要以景点名字开头（会显得机械）。',
    '- 同一批里各条的开头用词要有变化，不要套同一句式。',
    '- 参考类目写法：山水→写山势/水面/峡谷/森林的形态；古迹→写它留下的时间痕迹与格局；古镇街区→写巷道、桥、铺面的生活感；博物馆→写馆藏门类与看展方式；公园→写园中水面/林木/城墙的关系；夜景→写灯光与城市轮廓；亲子→写孩子能动手看什么。',
    '- 输出：JSON 数组，元素与输入顺序一致，字段 {"id":"…","intro":"…","reason":"…"}，不要输出其它文字。',
    ...(ex.length ? ['', '写作范例（模仿其句式与信息密度，不要照抄内容）：', ...ex] : []),
    '', '景点：', lines].join('\n');
  const r = await fetch(AI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DEEPSEEK_KEY },
    body: JSON.stringify({ model: AI_MODEL, temperature: 0.8, max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(120000) });
  const j = await r.json();
  const raw = ((j.choices && j.choices[0] && j.choices[0].message.content) || '').trim();
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no-json');
  const arr = JSON.parse(m[0]);
  const out = {};
  const heads = new Set();
  for (const o of arr) {
    const v = validate(o);
    if (!v || !o.id) continue;
    const head = v.intro.slice(0, 6);
    if (heads.has(head)) continue;      // 同批开头重复 → 丢弃，后续单条重试
    heads.add(head);
    out[o.id] = v;
  }
  return out;
}
async function upgradeOne(s) {
  const got = await callBatch([s]);
  return got[s.id] || null;
}
(async () => {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const limitIdx = args.indexOf('--limit');
  const LIMIT = limitIdx > 0 ? Number(args[limitIdx + 1]) : 99999;
  let targets = args.filter(a => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!targets.length || targets.includes('all')) targets = Object.keys(FILE);
  let done = 0, failed = 0, skipped = 0;
  for (const cn of targets) {
    const p = path.join(d0, FILE[cn] + '.json');
    if (!fs.existsSync(p)) { console.log('跳过（无库）：' + cn); continue; }
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const todo = d.spots.filter(s => !s.copy_src && TEMPLATE.test(String(s.intro || ''))).slice(0, LIMIT);
    if (!todo.length) { console.log(cn + '：无需升级'); continue; }
    console.log(cn + '：待升级 ' + todo.length + ' 条');
    buildExamples(FILE[cn]);
    let ok = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      let got = {};
      try { got = await callBatch(chunk); } catch (e) { got = {}; }
      for (const s of chunk) {
        let v = got[s.id] || null;
        for (let attempt = 0; !v && attempt < 3; attempt++) {
          await sleep(1200 + attempt * 800);
          try { v = await upgradeOne(s); } catch (e) {}
        }
        if (v) { if (APPLY) { s.intro = v.intro; s.reason = v.reason; s.copy_src = 'ai'; } ok++; done++; } else { failed++; console.log('  ✗ 失败：' + s.name); }
      }
      if (APPLY) fs.writeFileSync(p, JSON.stringify(d, null, 2));
      await sleep(400);
      console.log('  ' + Math.min(i + BATCH, todo.length) + '/' + todo.length + '（成功 ' + ok + '）');
    }
    if (APPLY) { d._meta = d._meta || {}; d._meta.copy_upgraded_at = new Date().toISOString().slice(0, 10); fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
  }
  console.log('\n完成：升级 ' + done + ' 条，失败 ' + failed + (APPLY ? '' : '（干跑）'));
})().catch(e => { console.error(e); process.exit(1); });