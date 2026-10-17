'use strict';
// P3：把 rebuild-report 的「建议新增」补齐数据后入库
//   ① 过滤子设施（已有点位的子区域，如「大熊猫基地-月亮产房」）
//   ② 按高德 POI 取详情：id / 评分 / 营业时间 / 电话 / 照片 / 地址
//   ③ 类目映射 + 时长/标签/heat/远郊判定
//   ④ 文案（intro/reason）按 skills/travel-copy 规范由 LLM 生成，红线校验不过则用模板
// 用法：AMAP_BASE=… AMAP_KEY=… DEEPSEEK_KEY=… node scripts/add-spots.js [--apply] [--limit N]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const amap = require('./lib/amap.js');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > 0 ? Number(process.argv[i + 1]) : 99; })();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const THROTTLE_MS = 260;
const AI_URL = (process.env.AI_BASE_URL || 'https://new.fluapi.com/v1').replace(/\/$/, '') + '/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4.1-flash';
const LIVE = { 成都: 'chengdu', 北京: 'beijing', 上海: 'shanghai', 西安: 'xian', 重庆: 'chongqing', 杭州: 'hangzhou' };
const CENTERS = { chengdu: [104.0657, 30.6572], beijing: [116.3975, 39.9087], shanghai: [121.4737, 31.2304], xian: [108.9402, 34.3416], chongqing: [106.5516, 29.5630], hangzhou: [120.1551, 30.2741] };

const norm = s => String(s || '').replace(/[\s（）()·\-—／\/]/g, '');
function hav(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// 类目映射（沿用 biz-info 的口径）
function mapCat(type, name) {
  const t = String(type || '') + ' ' + String(name || '');
  if (/古镇|古街|老街|古城|古村/.test(t)) return '古镇';
  if (/博物馆|博物院|美术馆|纪念馆|科技馆|展览馆|陈列馆/.test(t)) return '博物馆';
  if (/乐园|主题乐园|水世界|海洋馆|水族馆|动物园|植物园|欢乐谷|亲子/.test(t)) return '亲子';
  if (/森林公园|湿地公园|地质公园/.test(t)) return '山水';
  if (/夜景|剧院|剧场|演出|灯光秀|夜游|观景厅|电视塔|明珠|中心大厦|金融中心|观光层/.test(t)) return '夜景';
  if (/古迹|遗址|寺|庙|宫|陵|塔|楼|故居|祠堂|关隘|城楼|会馆|书院/.test(t)) return '古迹';
  if (/公园|绿地|园林|花园/.test(t)) return '公园';
  if (/特色商业街|文化街区|历史文化街|街区|胡同|里弄|坊|老街/.test(t)) return '街区';
  if (/步行街|商圈|购物|商场|商业中心/.test(t)) return '商圈';
  if (/美食|小吃|餐饮/.test(t)) return '美食';
  if (/风景名胜|国家级景点|省级景点|景区|山水|山|湖|湿地|森林|峡谷|溶洞|瀑布|温泉/.test(t)) return '山水';
  return '街区';
}
const DUR = { 古镇: 180, 山水: 180, 亲子: 210, 古迹: 120, 博物馆: 120, 公园: 90, 街区: 90, 夜景: 90, 美食: 75, 演出: 120, 商圈: 60 };
const OK_TAGS = /^(国家级景点|省级景点|风景名胜|旅游景点|博物馆|公园|古镇|寺庙|古迹|遗址|山|湖|湿地|乐园|水族馆|动物园|植物园|剧场|特色商业街|文化街区|步行街)$/;

function cleanTags(p, level, suburb) {
  const segs = String(p.type || '').split(';').map(s => s.trim())
    .filter(s => OK_TAGS.test(s) && !/风景区|相关/.test(s));
  const tags = [...new Set(segs)].slice(0, 2);
  if (level === 'national') tags.push('国家级');
  else if (level === 'province') tags.push('省级');
  if (suburb) tags.push('远郊');
  return tags.slice(0, 3);
}

const BAD_TEXT = /[0-9０-９]|门票|票价|免费|元|公里|km|最|第一|必去|必打卡|绝绝子|YYDS|！/;
// 文案模板（LLM 不可用时的兜底；只陈述已知事实 + 克制的体验建议，遵守 travel-copy 红线）
// 每条句子都从「类目 / 城内城郊 / 建议时长 / 等级」推导，按名字哈希选变体避免同质
function pickVariant(name, arr) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 100000;
  return arr[h % arr.length];
}
function template(spot) {
  const full = spot.dur >= 180 ? '一整天' : spot.dur >= 120 ? '半天' : '一小时上下';
  const loc = spot.suburb ? '在城郊' : '在城内';
  const lv = spot.level === 'national' ? '国家级' : spot.level === 'province' ? '省级' : '';
  const INTRO = {
    古镇: ['古镇街区，' + loc + '，适合留' + full + '边走边吃。', '古镇，' + loc + '，慢走半天刚好。'],
    山水: ['自然山水，' + loc + '，排' + full + '。', lv ? lv + '景区，' + loc + '，适合' + full + '。' : '山水景区，' + loc + '，适合' + full + '。'],
    公园: ['城市公园，' + loc + '，走一圈' + full + '。'],
    古迹: [lv ? lv + '古迹，' + loc + '，看半天。' : '历史古迹，' + loc + '，看半天。'],
    博物馆: [lv ? lv + '博物馆，' + loc + '，看展两小时上下。' : '博物馆，' + loc + '，看展两小时上下。'],
    夜景: ['适合入夜再看的地标，' + loc + '。', '夜景地标，' + loc + '，留一小时上下。'],
    亲子: ['适合带娃的' + (lv ? lv + '景点' : '景点') + '，' + loc + '，排一整个上午。'],
    街区: ['街区，' + loc + '，边走边吃一两小时。'],
    美食: ['吃的街区，' + loc + '，饭点来。'],
    商圈: ['商圈，' + loc + '，顺路逛一小时。'],
    演出: ['演出场所，' + loc + '，按场次排。'],
  };
  const REASON = {
    古镇: ['留半天，把饭点安排在镇上', '傍晚进来，灯亮之后更好看', '早点到，街上还没什么人'],
    山水: ['赶早进山，中午前到主要观景点', '上午来，慢慢走', '天好再来，山上看得更远'],
    公园: ['清晨或傍晚来，走一圈就够', '顺路进来歇脚就好', '别赶正午，树荫里凉快'],
    古迹: ['上午来，人少光线也好', '避开正午，慢慢看', '先看主殿，再绕回廊'],
    博物馆: ['午后进馆，躲开一天里最热的时段', '开门就到，人少先看常设展', '留足两小时，别赶'],
    夜景: ['等灯亮之后再来', '傍晚先到附近，天黑再上去', '天没黑透的时候最好看'],
    亲子: ['带娃排一整个上午', '开门就到，午后孩子容易累', '先玩项目，最后买纪念品'],
    街区: ['傍晚进来，边走边吃', '从巷子深处往回走', '饭点前到，少排队'],
    美食: ['饭点提前半小时到', '两个人分着吃，多试几家', '早市比午市清静'],
    商圈: ['顺路逛一逛就好', '傍晚人多，早点来', '地下一层吃饭更方便'],
    演出: ['按开演时间倒排出发', '提前二十分钟入场', '散场后别急着走，人流动线慢'],
  };
  const intro = pickVariant(spot.name, INTRO[spot.cat] || INTRO.街区).slice(0, 45);
  const reason = pickVariant(spot.name + 'r', REASON[spot.cat] || REASON.街区).slice(0, 24);
  return { intro, reason };
}
// LLM 文案：逐条生成（推理模型批量容易超时），失败/红线不过则回退模板
async function llmCopy(list) {
  if (!process.env.DEEPSEEK_KEY) return {};
  const out = {};
  for (const sp of list) {
    const prompt = [
      '为下面这个景点写两段中文文案，严格遵守：',
      '- intro：25~45 字，客观描述「它是什么类型、在城内还是城郊、大概玩多久」，只能用给定事实；',
      '- reason：≤24 字，一句克制的体验建议（如「上午来，人少光线也好」）；',
      '- 禁止：阿拉伯数字、门票价格、开放时间、年份、「最/第一/必去」这类夸张词、感叹号、表情、网络腔；不编造历史典故与景点细节。',
      '只输出 JSON 对象：{"intro":"…","reason":"…"}，不要其它文字。',
      '',
      '景点：' + sp.name + '｜' + sp.city + sp.district + '｜类目 ' + sp.cat + '｜类型 ' + sp.typeShort + '｜评分 ' + (sp.rating == null ? '未知' : sp.rating) + '｜' + (sp.suburb ? '城郊' : '城内') + '｜建议游览 ' + sp.dur + ' 分钟',
    ].join('\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(AI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DEEPSEEK_KEY },
          body: JSON.stringify({ model: AI_MODEL, temperature: 0.6, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(45000),
        });
        const j = await res.json();
        const raw = ((j.choices && j.choices[0] && j.choices[0].message.content) || '').trim();
        const m = raw.match(/\{[\s\S]*?\}/);
        if (!m) { if (process.env.ADD_DEBUG) console.error('[llm] 无 JSON：' + sp.name + ' → ' + raw.slice(0, 80)); continue; }
        const obj = JSON.parse(m[0]);
        const intro = String(obj.intro || '').trim(), reason = String(obj.reason || '').trim();
        if (!intro || !reason || intro.length > 48 || reason.length > 26) { if (process.env.ADD_DEBUG) console.error('[llm] 长度不合：' + sp.name); continue; }
        if (BAD_TEXT.test(intro) || BAD_TEXT.test(reason)) { if (process.env.ADD_DEBUG) console.error('[llm] 红线：' + sp.name + ' → ' + intro + ' / ' + reason); continue; }
        out[sp.name] = { intro, reason };
        break;
      } catch (e) {
        if (process.env.ADD_DEBUG) console.error('[llm] ' + sp.name + ' 第' + (attempt + 1) + '次失败：' + e.message);
        await sleep(800);
      }
    }
    await sleep(200);
  }
  return out;
}

async function poiOf(name, city) {
  const j = await amap.get('/v3/place/text', { keywords: name, city, citylimit: 'true', extensions: 'all', offset: 8 }, { timeout: 12000 });
  const list = (j.pois || []).map(amap.normPoi).filter(p => p.coord[0]);
  const exact = list.find(p => norm(p.name) === norm(name));
  const near = list.find(p => norm(p.name).startsWith(norm(name)) || norm(name).startsWith(norm(p.name)));
  return exact || near || null;
}

async function run(city) {
  const file = LIVE[city];
  const libPath = path.join(ROOT, 'data', 'spots', file + '.json');
  const data = JSON.parse(fs.readFileSync(libPath, 'utf8'));
  const spots = data.spots || [];
  const repPath = path.join(ROOT, 'data', 'spots', file + '.rebuild-report.json');
  if (!fs.existsSync(repPath)) { console.log(city + ' 无 rebuild-report，跳过'); return; }
  const rep = JSON.parse(fs.readFileSync(repPath, 'utf8'));
  const existing = spots.map(s => norm(s.name));
  const [clng, clat] = CENTERS[file];
  const EXCLUDE = ['三圣花乡·花乡农居', '三圣花乡荷塘月色', '西安城墙安远门', '杭州西湖风景名胜区', '上海方塔园'];
  const picked = [];
  for (const cand of (rep.add || [])) {
    if (picked.length >= LIMIT) break;
    const cn = norm(cand.name);
    if (!cn) continue;
    if (EXCLUDE.includes(cand.name)) continue;
    if (existing.includes(cn)) continue;
    // 子设施过滤：名字以已有点位开头（大熊猫基地 + 月亮产房），或以子设施词结尾
    // 子设施/已有景点的变体：名字包含已有点位、带上位名、或带 - 子区域后缀
    if (existing.some(e => e.length >= 2 && (cn.includes(e) || e.includes(cn)))) continue;
    if (/[-－]/.test(cand.name)) continue;
    if (/(产房|馆区|园区|东区|西区|南区|北区|正门|侧门|售票|停车场|码头|观景台|观光厅|栈道|碑廊|雕像|入口|出口|城楼)$/.test(cand.name)) continue;
    const poi = await poiOf(cand.name, city);
    await sleep(THROTTLE_MS);
    if (!poi) { console.log('  ✗ ' + cand.name + '：高德未取到详情'); continue; }
    const dist = hav([clng, clat], poi.coord);
    const cat = mapCat(poi.type, poi.name);
    const suburb = dist > 25000;
    const id = 'n' + crypto.createHash('md5').update(city + ':' + norm(poi.name)).digest('hex').slice(0, 8);
    if (spots.some(s => s.id === id)) continue;
    picked.push({
      id, name: poi.name, city, district: (poi.district || poi.city || ''), typeShort: String(poi.type).split(';').pop(),
      cat, dur: DUR[cat] || 90, heat: cand.heat != null ? cand.heat : 7, rating: poi.rating, level: cand.level,
      coord: [+poi.coord[0].toFixed(6), +poi.coord[1].toFixed(6)], suburb,
      open: null, open_text: poi.openText || poi.openTime || '', tel: poi.tel || '', photo: poi.photo || '',
      amap_poi_id: poi.id, address: poi.address, type: poi.type,
    });
  }
  console.log(city + '：候选 ' + picked.length + ' 个（过滤后）');
  // 文案
  const copy = {};
  for (let i = 0; i < picked.length; i += 4) {
    const batch = picked.slice(i, i + 4);
    const got = await llmCopy(batch);
    Object.assign(copy, got);
    await sleep(300);
  }
  // 组装
  const today = new Date().toISOString().slice(0, 10);
  const newSpots = picked.map(p => {
    const c = copy[p.name] || template(p);
    // 营业时间解析（简单版：HH:MM-HH:MM 或 24 小时）
    let open = null;
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(p.open_text || '').trim());
    if (m) open = String(m[1]).padStart(2, '0') + ':' + m[2] + '-' + String(m[3]).padStart(2, '0') + ':' + m[4];
    else if (/24\s*小时/.test(p.open_text || '')) open = '00:00-23:59';
    return {
      id: p.id, name: p.name, cat: p.cat, tags: cleanTags({ type: p.type }, p.level, p.suburb),
      heat: p.heat, dur: p.dur, intro: c.intro, reason: c.reason, open, closed_mon: null,
      suburb: p.suburb, coord: p.coord, coord_src: 'amap', amap_poi_id: p.amap_poi_id,
      refreshed_at: today, verify_src: 'amap', verified_at: today,
      photo: p.photo, open_text: p.open_text || undefined, tel: p.tel || undefined,
      rating: p.rating == null ? undefined : p.rating, biz_src: 'amap', biz_at: today,
      added_at: today, added_reason: 'rebuild 建议新增（高德评分 ' + (p.rating == null ? '-' : p.rating) + '）',
    };
  });
  for (const s of newSpots) Object.keys(s).forEach(k => { if (s[k] === undefined) delete s[k]; });
  console.log('  文案来源：LLM ' + Object.keys(copy).length + ' / 模板 ' + (newSpots.length - Object.keys(copy).length));
  newSpots.forEach(s => console.log('  + ' + s.name + ' [' + s.cat + ' ' + s.dur + 'min' + (s.suburb ? ' 远郊' : '') + '] ' + (s.rating || '-') + '分 · ' + s.reason));
  if (APPLY) {
    data.spots = spots.concat(newSpots);
    data._meta.add_at = today;
    fs.writeFileSync(libPath, JSON.stringify(data, null, 2) + '\n');
    fs.writeFileSync(path.join(ROOT, 'data', 'spots', file + '.add-report.json'), JSON.stringify({ city, date: today, added: newSpots }, null, 2) + '\n');
    console.log('  ✅ 已入库：' + spots.length + ' → ' + data.spots.length);
  }
}

(async () => {
  if (!(process.env.AMAP_KEY || process.env.AMAP_WS_KEY)) { console.error('需要 AMAP_KEY'); process.exit(2); }
  const cities = Object.keys(LIVE);
  for (const c of cities) await run(c);
})().catch(e => { console.error(e); process.exit(1); });
