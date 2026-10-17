'use strict';
// 新城市建库器（按《景点库规则》docs/spot-library-rules.md 从零生成一座城市的景点库）
//  ① 行政区查中心点 → ② around 多关键词发现候选（weight 排序 + extensions=all，自带评分/营业时间/照片）
//  ③ 规则筛选（排除子设施/店铺/无评分/评分<4.0）→ ④ 类目配额配平 → ⑤ 文案（LLM，失败回退模板）
//  ⑥ 写 data/spots/<file>.json + 登记 data/city-registry.json + 自动 FAME 种子（data/fame.json）
// 用法：AMAP_BASE=… AMAP_KEY=… DEEPSEEK_KEY=… node scripts/build-city.js <城市> [--apply] [--no-llm]
const fs = require('fs');
const path = require('path');
const amap = require('./lib/amap.js');
const ROOT = path.join(__dirname, '..');
const SPOTS = path.join(ROOT, 'data', 'spots');

const PY = {
  黄山: 'huangshan', 厦门: 'xiamen', 福州: 'fuzhou', 泉州: 'quanzhou', 青岛: 'qingdao', 济南: 'jinan',
  威海: 'weihai', 烟台: 'yantai', 婺源: 'wuyuan', 深圳: 'shenzhen', 珠海: 'zhuhai', 桂林: 'guilin',
  北海: 'beihai', 三亚: 'sanya', 海口: 'haikou', 天津: 'tianjin', 大同: 'datong', 太原: 'taiyuan',
  呼和浩特: 'huhehaote', 武汉: 'wuhan', 长沙: 'changsha', 郑州: 'zhengzhou', 洛阳: 'luoyang',
  开封: 'kaifeng', 宜昌: 'yichang', 张家界: 'zhangjiajie', 凤凰: 'fenghuang', 兰州: 'lanzhou',
  西宁: 'xining', 敦煌: 'dunhuang', 张掖: 'zhangye', 乌鲁木齐: 'wulumuqi', 喀什: 'kashi',
  银川: 'yinchuan', 哈尔滨: 'haerbin', 长春: 'changchun', 沈阳: 'shenyang', 大连: 'dalian',
};
const BAD_TYPE = /地铁站|公交车站|公交站|售票处|停车场|停车楼|入口|出口|检票|收费站|道路名|地名地址|公司|写字楼|便利店|ATM|餐厅|餐饮|快餐|小吃|咖啡|茶楼|酒家|饭店|商店|超市|银行|酒店|宾馆|民宿|加油站|充电|司机之家|码头|游船|客运站|集散中心|游客中心|政府机关|住宅|公寓|小区|学校|医院/;
const SHOP_NAME = /[（(][^）)]*店[）)]\s*$|(店|铺|铺面房|摊位|专柜|旗舰店|商城|公寓|服务区|售楼处)$/;
const STATUS_PAREN = /[（(][^）)]*(装修|暂停开放|不对外开放|停业|闭馆|改造中|施工)[^）)]*[）)]/;
const PLACE_TYPE = /风景名胜|旅游景点|博物馆|博物院|纪念馆|美术馆|公园|古镇|古街|寺|庙|宫|陵|塔|遗址|故居|文化|乐园|景区|园林|湿地|湖泊|山|峡谷|溶洞|瀑布|温泉|广场|步行街|商业街|特色商业街/;
const DUR = { 古镇: 180, 山水: 180, 亲子: 210, 古迹: 120, 博物馆: 120, 公园: 90, 街区: 90, 夜景: 90, 美食: 75, 演出: 120, 商圈: 60 };
const GROUPS = {
  core: { cats: ['古迹', '博物馆', '山水', '古镇'], max: 34, min: 26 },
  night: { cats: ['夜景'], max: 8, min: 4 },
  family: { cats: ['亲子'], max: 7, min: 4 },
  street: { cats: ['街区'], max: 8, min: 0 },
  food: { cats: ['美食'], max: 4, min: 0 },
  park: { cats: ['公园'], max: 5, min: 0 },
  mall: { cats: ['商圈'], max: 2, min: 0 },
};
const norm = s => String(s || '').replace(/[\s（）()·\-—／\/]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AI_URL = (process.env.AI_BASE_URL || 'https://new.fluapi.com/v1').replace(/\/$/, '') + '/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4.1-flash';
const BAD_TEXT = /[0-9０-９]|门票|票价|免费|元|公里|km|最|第一|必去|必打卡|绝绝子|YYDS|！/;

function hav(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function mapCat(type, name) {
  const t = String(type || '') + ' ' + String(name || '');
  if (/古镇|古街|老街|古城|古村/.test(t)) return '古镇';
  if (/博物馆|博物院|美术馆|纪念馆|科技馆|展览馆|陈列馆/.test(t)) return '博物馆';
  if (/乐园|主题乐园|水世界|海洋馆|水族馆|动物园|欢乐谷/.test(t)) return '亲子';
  if (/植物园|园林|花园|绿地/.test(t)) return '公园';
  if (/夜景|剧院|剧场|演出|灯光秀|夜游|电视塔|观光厅/.test(t)) return '夜景';
  if (/美术馆|艺术中心|艺术馆|展览|陈列/.test(t)) return '博物馆';
  if (/炮台|古迹|遗址|寺|庙|宫|陵|塔|故居|祠堂|关隘|城楼|会馆|书院|石刻/.test(t)) return '古迹';
  if (/森林公园|湿地公园|地质公园/.test(t)) return '山水';
  if (/公园/.test(t)) return '公园';
  if (/特色商业街|文化街区|历史文化街|街区|胡同|里弄|坊/.test(t)) return '街区';
  if (/步行街|商圈|购物|商场|商业中心/.test(t)) return '商圈';
  if (/美食|小吃|餐饮/.test(t)) return '美食';
  if (/风景名胜|国家级景点|省级景点|景区|山水|山|湖|湿地|森林|峡谷|溶洞|瀑布|温泉/.test(t)) return '山水';
  return '街区';
}
function levelOf(type) {
  if (/国家级景点/.test(String(type))) return 'national';
  if (/省级景点/.test(String(type))) return 'province';
  if (/市级景点/.test(String(type))) return 'city';
  return null;
}
function scoreOf(rating, level) {
  const nr = typeof rating === 'number' && rating > 0 ? Math.max(0, Math.min(1, (rating - 3.5) / 1.5)) : null;
  const lv = level === 'national' ? 1 : level === 'province' ? 0.6 : level === 'city' ? 0.3 : 0;
  if (nr === null && !lv) return null;
  return 0.6 * (nr === null ? lv : nr) + 0.25 * lv;
}
const heatOf = s => (s === null ? null : Math.max(5, Math.min(10, Math.round(5 + 5 * s))));
const pickVariant = (name, arr) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 100000; return arr[h % arr.length]; };
function template(s) {
  const full = s.dur >= 180 ? '一整天' : s.dur >= 120 ? '半天' : '一小时上下';
  const loc = s.suburb ? '在城郊' : '在城内';
  const INTRO = {
    古镇: ['古镇街区，' + loc + '，适合留' + full + '边走边吃。'], 山水: ['自然山水，' + loc + '，排' + full + '。'],
    公园: ['城市公园，' + loc + '，走一圈' + full + '。'], 古迹: ['历史古迹，' + loc + '，看' + full + '。'],
    博物馆: ['博物馆，' + loc + '，看展两小时上下。'], 夜景: ['适合入夜再看的地标，' + loc + '。'],
    亲子: ['适合带娃的景点，' + loc + '，排一整个上午。'], 街区: ['街区，' + loc + '，边走边吃一两小时。'],
    美食: ['吃的街区，' + loc + '，饭点来。'], 商圈: ['商圈，' + loc + '，顺路逛一小时。'],
  };
  const REASON = {
    古镇: ['留半天，把饭点安排在镇上', '傍晚进来，灯亮之后更好看'], 山水: ['赶早进山，中午前到主要观景点', '上午来，慢慢走'],
    公园: ['清晨或傍晚来，走一圈就够', '顺路进来歇脚就好'], 古迹: ['上午来，人少光线也好', '避开正午，慢慢看'],
    博物馆: ['午后进馆，躲开一天里最热的时段', '开门就到，人少先看常设展'], 夜景: ['等灯亮之后再来', '傍晚先到附近，天黑再上去'],
    亲子: ['带娃排一整个上午', '开门就到，午后孩子容易累'], 街区: ['傍晚进来，边走边吃', '饭点前到，少排队'],
    美食: ['饭点提前半小时到', '两个人分着吃，多试几家'], 商圈: ['顺路逛一逛就好', '傍晚人多，早点来'],
  };
  return {
    intro: pickVariant(s.name, INTRO[s.cat] || INTRO.街区).slice(0, 45),
    reason: pickVariant(s.name + 'r', REASON[s.cat] || REASON.街区).slice(0, 24),
  };
}
async function llmCopy(s) {
  if (!process.env.DEEPSEEK_KEY) return null;
  const prompt = ['为下面这个景点写两段中文文案，严格遵守：',
    '- intro：25~45 字，客观描述它是什么类型、在城内还是城郊、大概玩多久，只能用给定事实；',
    '- reason：≤24 字，一句克制的体验建议；',
    '- 禁止：阿拉伯数字、门票价格、开放时间、年份、「最/第一/必去」这类夸张词、感叹号、表情、网络腔；不编造历史典故与细节。',
    '只输出 JSON 对象：{"intro":"…","reason":"…"}',
    '', '景点：' + s.name + '｜' + s.city + '｜类目 ' + s.cat + '｜' + (s.suburb ? '城郊' : '城内') + '｜建议游览 ' + s.dur + ' 分钟｜评分 ' + (s.rating || '-')].join('\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(AI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DEEPSEEK_KEY },
        body: JSON.stringify({ model: AI_MODEL, temperature: 0.7, max_tokens: 900, messages: [{ role: 'user', content: prompt }] }), signal: AbortSignal.timeout(50000) });
      const j = await r.json();
      const raw = ((j.choices && j.choices[0] && j.choices[0].message.content) || '').trim();
      const m = raw.match(/\{[\s\S]*?\}/);
      if (!m) continue;
      const o = JSON.parse(m[0]);
      const intro = String(o.intro || '').trim(), reason = String(o.reason || '').trim();
      if (!intro || !reason || intro.length > 45 || reason.length > 24) continue;
      if (BAD_TEXT.test(intro) || BAD_TEXT.test(reason)) continue;
      return { intro, reason };
    } catch (e) { await sleep(600); }
  }
  return null;
}
async function centerOf(city) {
  const j = await amap.get('/v3/config/district', { keywords: city, subdistrict: 0 });
  const d = (j.districts || [])[0];
  if (!d || !d.center) return null;
  return String(d.center).split(',').map(Number);
}
async function discover(city, center, round, keyword, radius, pages) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    let j;
    try { j = await amap.get('/v3/place/around', { location: center.join(','), radius, keywords: keyword, sortrule: 'weight', extensions: 'all', offset: 25, page }); }
    catch (e) { break; }
    const pois = j.pois || [];
    for (const p of pois) out.push(amap.normPoi(p));
    await sleep(220);
    if (pois.length < 25) break;
  }
  return out;
}
(async () => {
  const args = process.argv.slice(2);
  const city = args.find(a => !a.startsWith('--'));
  const APPLY = args.includes('--apply');
  const NO_LLM = args.includes('--no-llm');
  if (!city || !PY[city]) { console.error('用法：node scripts/build-city.js <城市> [--apply] [--no-llm]'); console.error('支持：' + Object.keys(PY).join('、')); process.exit(2); }
  const file = PY[city];
  const libPath = path.join(SPOTS, file + '.json');
  if (fs.existsSync(libPath)) { console.error('已存在 ' + path.basename(libPath) + '——已建库城市请用 scripts/pipeline.js 补全/审核'); process.exit(2); }
  const center = await centerOf(city);
  if (!center) { console.error('取不到城市中心点：' + city); process.exit(1); }
  console.log(city + ' 中心点 ' + center.join(','));
  const ROUNDS = [
    ['风景名胜', 50000, 3], ['博物馆', 30000, 2], ['公园', 30000, 2], ['古镇', 50000, 2],
    ['主题乐园', 40000, 2], ['文化街区', 25000, 2], ['美食街', 20000, 2], ['寺', 40000, 2], ['山', 50000, 2], ['湖', 50000, 2],
  ];
  const seen = new Map();
  for (const [kw, radius, pages] of ROUNDS) {
    const list = await discover(city, center, ROUNDS, kw, radius, pages);
    for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
    console.log('  ' + kw + '：累计候选 ' + seen.size);
  }
  // 规则筛选
  const cand = [];
  for (const p of seen.values()) {
    if (!p.coord[0]) continue;
    if (!PLACE_TYPE.test(p.type)) continue;
    if (BAD_TYPE.test(p.type) || SHOP_NAME.test(p.name) || STATUS_PAREN.test(p.name)) continue;
    if (/-/.test(p.name) || p.name.length > 24) continue;
    const rating = p.rating != null && p.rating > 0 ? p.rating : null;
    if (rating == null || rating < 4.0) continue;
    const level = levelOf(p.type);
    const sc = scoreOf(rating, level);
    if (sc == null) continue;
    const cat = mapCat(p.type, p.name);
    const dist = hav(center, p.coord);
    cand.push({
      name: p.name, coord: [+p.coord[0].toFixed(6), +p.coord[1].toFixed(6)], type: p.type, cat, rating, level,
      heat: heatOf(sc), dur: DUR[cat] || 90, suburb: dist > 25000, dist_m: Math.round(dist),
      amap_poi_id: p.id, openText: p.openText || '', openTime: p.openTime || '', tel: p.tel || '', photo: p.photo || '', city,
    });
  }
  // 去重（互相包含取高分）
  cand.sort((a, b) => b.rating - a.rating);
  const kept = [];
  for (const c of cand) {
    if (kept.some(k => norm(k.name).includes(norm(c.name)) || norm(c.name).includes(norm(k.name)))) continue;
    kept.push(c);
  }
  // 同一景区内的子点聚类（鼓浪屿风景名胜区 vs 鼓浪屿管风琴艺术中心）：1.5km 内且≥3 字前缀相同 → 只留高分
  const clustered = [];
  for (const c of kept) {
    const dup = clustered.find(k => {
      const d = hav(k.coord, c.coord);
      const a = norm(k.name), b = norm(c.name);
      let pre = 0; while (a[pre] && a[pre] === b[pre]) pre++;
      return d < 1500 && pre >= 3;
    });
    if (!dup) clustered.push(c);
  }
  kept.length = 0; kept.push(...clustered);
  // 配额配平
  const chosen = [];
  for (const [g, rule] of Object.entries(GROUPS)) {
    const list = kept.filter(c => rule.cats.includes(c.cat));
    chosen.push(...list.slice(0, rule.max));
  }
  // 远郊不足补：从剩余里挑评分最高的远郊点
  const far = kept.filter(c => c.suburb && !chosen.includes(c)).slice(0, Math.max(0, 4 - chosen.filter(c => c.suburb).length));
  chosen.push(...far);
  // 远郊补充后再按组裁剪，确保不超配额
  for (const [g, rule] of Object.entries(GROUPS)) {
    const inGroup = chosen.filter(x => rule.cats.includes(x.cat));
    if (inGroup.length > rule.max) {
      inGroup.sort((a, b) => (b.heat || 0) - (a.heat || 0) || b.rating - a.rating);
      for (const x of inGroup.slice(rule.max)) chosen.splice(chosen.indexOf(x), 1);
    }
  }
  chosen.sort((a, b) => b.heat - a.heat || b.rating - a.rating);
  console.log('\n候选 ' + seen.size + ' → 合规 ' + cand.length + ' → 去重 ' + kept.length + ' → 选入 ' + chosen.length);
  const byCat = {};
  for (const c of chosen) byCat[c.cat] = (byCat[c.cat] || 0) + 1;
  console.log('类目分布：' + Object.entries(byCat).map(([k, v]) => k + v).join(' '));
  // 文案
  let llm = 0, tpl = 0;
  for (const c of chosen) {
    const copy = NO_LLM ? null : await llmCopy(c);
    const text = copy || template(c);
    c.intro = text.intro; c.reason = text.reason;
    if (copy) llm++; else tpl++;
  }
  console.log('文案：LLM ' + llm + ' / 模板 ' + tpl);
  // 组装
  const today = new Date().toISOString().slice(0, 10);
  const spots = chosen.map((c, i) => {
    const normName = norm(c.name);
    const id = 's' + require('crypto').createHash('md5').update(file + ':' + normName).digest('hex').slice(0, 8);
    const s = {
      id, name: c.name, cat: c.cat,
      tags: [c.level === 'national' ? '国家级' : c.level === 'province' ? '省级' : null, c.suburb ? '远郊' : null].filter(Boolean).slice(0, 3),
      heat: c.heat, dur: c.dur, intro: c.intro, reason: c.reason,
      open: (() => { const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(c.openTime || '').trim()); if (m) return String(m[1]).padStart(2, '0') + ':' + m[2] + '-' + String(m[3]).padStart(2, '0') + ':' + m[4]; if (/24\s*小时/.test(c.openText || '')) return '00:00-23:59'; return null; })(),
      closed_mon: null,
      suburb: c.suburb, coord: c.coord, coord_src: 'amap', amap_poi_id: c.amap_poi_id,
      refreshed_at: today, verify_src: 'amap', verified_at: today,
      rating: c.rating, biz_src: 'amap', biz_at: today,
      added_at: today,
    };
    if (c.openText) s.open_text = c.openText;
    if (c.tel) s.tel = c.tel;
    if (c.photo) s.photo = c.photo;
    return s;
  });
  console.log('\n前 8 个：');
  spots.slice(0, 8).forEach(s => console.log('  ' + s.name + '（' + s.cat + '·' + (s.suburb ? '远郊' : '城内') + '·' + s.rating + '分·heat' + s.heat + '）｜' + s.intro));
  if (!APPLY) { console.log('\n（干跑，未写库；确认后加 --apply）'); return; }
  fs.writeFileSync(libPath, JSON.stringify({ _meta: { city, center, generated_at: today, source: 'amap', rule_version: '2026-10-17' }, spots }, null, 2) + '\n');
  // 注册表 + FAME 种子
  const regPath = path.join(ROOT, 'data', 'city-registry.json');
  const reg = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')) : {};
  reg[city] = { file, center };
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2) + '\n');
  const famePath = path.join(ROOT, 'data', 'fame.json');
  const fame = fs.existsSync(famePath) ? JSON.parse(fs.readFileSync(famePath, 'utf8')) : {};
  fame[city] = spots.filter(s => (s.tags || []).includes('国家级') && s.rating >= 4.6).map(s => s.name);
  fs.writeFileSync(famePath, JSON.stringify(fame, null, 2) + '\n');
  console.log('\n✅ 已建库：data/spots/' + file + '.json（' + spots.length + ' 点）｜注册表 + FAME 种子（' + fame[city].length + ' 个）已更新');
  console.log('下一步：node scripts/pipeline.js ' + city + ' --apply（审核校验）');
})().catch(e => { console.error(e); process.exit(1); });
