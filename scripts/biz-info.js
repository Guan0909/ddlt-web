'use strict';
// 景点库回填（权威源 = 高德 POI 详情/搜索，支持转发通道）：
//   ① POI 校准：候选重排 + 准入闸门，纠正「指向地铁站/公交站/售票处/店铺/展品」这类误关联
//   ② 营业信息：营业时间 open_time / opentime2、闭馆日、电话 tel、评分 rating、人均 cost、首图补全
//   ③ 名称对齐：候选是同一景点的官方全称时采纳高德名（记录改名）
// 用法：
//   AMAP_BASE=https://pass-api.ibtmap.com/a AMAP_KEY=<key> node scripts/biz-info.js [文件…] [--apply] [--all]
const fs = require('fs');
const path = require('path');
const amap = require('./lib/amap.js');

const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const THROTTLE_MS = 260;
const LIVE = ['chengdu', 'beijing', 'shanghai', 'xian', 'chongqing', 'hangzhou'];

const BAD_TYPE = /地铁站|公交车站|公交站|售票处|停车场|停车楼|入口|出口|检票|收费站|道路名|地名地址|公司|写字楼|便利店|ATM|餐厅|餐饮|快餐|小吃|咖啡|茶楼|酒家|饭店|商店|超市|银行|酒店|宾馆|民宿|加油站|充电站|充电桩|司机之家|码头|游船|客运站|集散中心|游客中心/;
const GOOD_TYPE = /风景名胜|博物馆|旅游景点|公园|古镇|寺|庙|教堂|纪念馆|美术馆|文化|乐园|景区|园林|故居|遗址/;
const OFFICIAL_SUFFIX = /^(景区|风景区|旅游区|博物馆|博物院|公园|古镇|古街|老街|寺|宫|陵|遗址|纪念馆|美术馆|大剧院|剧场|广场|步行街|商业街|街区)$/;
const HARD_BAD_NAME = /[-－](雕像|铺面房|售|停车场|入口|出口|大门|侧门|正门|地铁|公交|快艇|炮|飞机|展品|模型|店|铺|摊位|服务中心|售票|观景平台|观景台|步道|栈道|平台|码头)|(入口广场|小公园广场|观景台|剧场|小剧场|游船|酒吧|司机之家|充电站)$/;
// 店铺/专营店型：名字带「（…店）」或以「店/铺/铺面房/摊位」结尾 → 几乎肯定不是景点本体
const SHOP_NAME = /[（(][^）)]*店[）)]\s*$|(店|铺|铺面房|摊位|专柜|旗舰店)$/;
// 状态括注：装修中/暂停开放/不对外开放/停业 → 不是可游玩的场馆本体
const STATUS_PAREN = /[（(][^）)]*(装修|暂停开放|不对外开放|停业|闭馆|改造中|施工)[^）)]*[）)]/;
const SHOP_TYPE = /专卖店|零售|手机销售|餐饮相关|特色店铺|服装|鞋包|化妆品|珠宝|食品店/;
const QUALIFIED_SCORE = 55;
const MAX_COORD_MOVE_M = 2000;

const norm = s => String(s || '').replace(/[\s（）()·\-—／\/]/g, '');
const hasQualifier = s => /[·（(]/.test(String(s || ''));
// 检索变体：整名（去括注）+ 复合名分段（人民公园·鹤鸣茶社 → 鹤鸣茶社 / 人民公园）
// —— 高德官方名常与我们的复合名不同（孤山·西泠印社 → 中山公园-西泠印社社址），必须按分段名再搜
function nameQueries(name) {
  const base = String(name).replace(/[（(].*?[）)]/g, '').trim();
  const out = [base];
  if (/[·・]/.test(base)) {
    const parts = base.split(/[·・]/).map(s => s.trim()).filter(Boolean);
    for (const p of parts.reverse()) if (p !== base) out.push(p);
  }
  return [...new Set(out.filter(Boolean))];
}
const tailOf = name => {
  const parts = String(name).replace(/[（(].*?[）)]/g, '').split(/[·・]/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(name);
};

function hav(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function commonLen(a, b) {
  const A = norm(a), B = norm(b);
  let best = 0;
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
    let k = 0;
    while (A[i + k] && A[i + k] === B[j + k]) k++;
    if (k > best) best = k;
  }
  return best;
}

function parseOpenTime(bizExt) {
  const raw = String((bizExt && bizExt.open_time) || '').trim();
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw);
  if (m) {
    const hh = n => String(n).padStart(2, '0');
    return { open: hh(m[1]) + ':' + m[2] + '-' + hh(m[3]) + ':' + m[4], how: 'open_time' };
  }
  const txt = String((bizExt && bizExt.opentime2) || '') + ' ' + raw;
  if (/24\s*小时|全天开放|全天营业/.test(txt)) return { open: '00:00-23:59', how: '24h' };
  return { open: null, how: 'unparsed' };
}
function parseClosedMon(bizExt) {
  const txt = String((bizExt && bizExt.opentime2) || '') + ' ' + String((bizExt && bizExt.open_time) || '');
  if (/周[一二三四五六日天]\s*闭馆|每(周|星期)[一二三四五六日天]\s*闭馆|周[一二三四五六日天]\s*休息|周[一二三四五六日天]\s*不开放/.test(txt)) return true;
  if (/周一至周日|全年无休|每日开放|每天开放|全周开放/.test(txt)) return false;
  return null;
}

function score(poi, spot) {
  let s = 0;
  if (GOOD_TYPE.test(poi.type)) s += 40;
  if (BAD_TYPE.test(poi.type)) s -= 70;
  if (/国家级景点/.test(poi.type)) s += 18;
  else if (/省级景点/.test(poi.type)) s += 12;
  else if (/博物馆/.test(poi.type)) s += 6;
  if (/^1100/.test(String(poi.typecode || ''))) s += 6;
  if (poi.rating != null && poi.rating > 0) s += poi.rating * 10;
  if (poi.openTime || poi.openText) s += 6;
  if (poi.tel) s += 2;
  const cn = norm(spot.name), pn = norm(poi.name);
  if (cn === pn) s += 30;
  else if (pn.startsWith(cn) || cn.startsWith(pn)) {
    const extra = pn.length >= cn.length ? pn.slice(cn.length) : pn;
    s += OFFICIAL_SUFFIX.test(extra) ? 26 : 12;
  } else if (pn.includes(cn) || cn.includes(pn)) s += 12;
  else {
    const c = commonLen(spot.name, poi.name);
    s += c >= 3 ? 8 : -25;
  }
  if (spot.coord && poi.coord[0]) {
    const d = hav(spot.coord, poi.coord);
    s += d <= 200 ? 20 : d <= 600 ? 10 : d <= MAX_COORD_MOVE_M ? 0 : -35;
  }
  return s;
}

function acceptable(poi, spot, sc) {
  if (!poi || !poi.coord[0]) return false;
  if (BAD_TYPE.test(poi.type) || HARD_BAD_NAME.test(poi.name)) return false;
  // 带连字符的候选通常是子设施（华山风景名胜区-长空栈道 / 南京路步行街-雕像）：我们名字没连字符就不采信
  if (/[-－]/.test(poi.name) && !/[-－]/.test(spot.name)) return false;
  // 店铺型候选（YELLOW KORNER(成都远洋太古里店) / boomcup北京杨梅竹店 / 烟袋斜街铺面房）
  if (SHOP_NAME.test(poi.name) || SHOP_TYPE.test(poi.type)) return false;
  if (STATUS_PAREN.test(poi.name)) return false;
  if (sc < QUALIFIED_SCORE) return false;
  const cn = norm(spot.name), pn = norm(poi.name);
  if (hasQualifier(spot.name)) {
    // 复合名：整名或**尾段**命中即可（鹤鸣茶社 / 西泠印社 / 滨江大道）
    const tail = norm(tailOf(spot.name));
    return pn.includes(cn) || (tail.length >= 2 && (pn.includes(tail) || tail.includes(pn)));
  }
  return pn.includes(cn) || cn.includes(pn) || commonLen(spot.name, poi.name) >= 3;
}

async function candidates(spot, city) {
  const out = [];
  if (spot.amap_poi_id) {
    try {
      const j = await amap.get('/v3/place/detail', { id: spot.amap_poi_id, extensions: 'all' }, { timeout: 12000 });
      const p = (j.pois || [])[0];
      if (p) out.push(amap.normPoi(p));
    } catch (e) { /* 靠搜索 */ }
    await sleep(THROTTLE_MS);
  }
  for (const kw of nameQueries(spot.name)) {
    try {
      const j = await amap.get('/v3/place/text', { keywords: kw, city, citylimit: 'true', extensions: 'all', offset: 10 }, { timeout: 12000 });
      for (const p of (j.pois || [])) {
        const n = amap.normPoi(p);
        if (n.coord[0] && !out.some(x => x.id === n.id)) out.push(n);
      }
    } catch (e) { /* 只用 detail */ }
    await sleep(THROTTLE_MS);
  }
  // 市界外的景点（华山/乾陵）：citylimit=true 搜不到 → 全国兜底一次，只收「名字包含我们」的候选
  const cn = norm(spot.name);
  // 注意：城内的「青华山」这类近似名不能算命中，必须**以我们的名字开头**才算（否则华山永远搜不到）
  const needFallback = !out.some(p => GOOD_TYPE.test(p.type) && norm(p.name).startsWith(cn));
  if (process.env.BIZ_DEBUG) console.error('[dbg] ' + spot.name + ' 城内候选 ' + out.length + ' 需兜底=' + needFallback);
  if (needFallback) {
    try {
      const kw = spot.name.replace(/[（(].*?[）)]/g, '').trim();
      const j = await amap.get('/v3/place/text', { keywords: kw, citylimit: 'false', extensions: 'all', offset: 8 }, { timeout: 12000 });
      for (const p of (j.pois || [])) {
        const n = amap.normPoi(p);
        if (!n.coord[0] || out.some(x => x.id === n.id)) continue;
        if (!norm(n.name).includes(cn)) continue;
        if (spot.coord && n.coord[0] && hav(spot.coord, n.coord) > 150000) continue;   // 同名异地 >150km 排除
        out.push(n);
      }
    } catch (e) { /* 忽略 */ }
  }
  await sleep(THROTTLE_MS);
  return out;
}

async function run(file) {
  const abs = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const city = data._meta.city;
  const spots = data.spots || [];
  const stat = { total: spots.length, poiFixed: 0, renamed: 0, coordFixed: 0, openFilled: 0, closedMon: 0, tel: 0, rating: 0, photo: 0, noCand: 0, err: 0 };
  const log = [];
  let i = 0;
  const MISSING_ONLY = process.argv.includes('--missing-only');
  for (const spot of spots) {
    i++;
    if (MISSING_ONLY && typeof spot.rating === 'number' && spot.rating > 0) continue;   // 只补「拿不到评分」的点
    let cands = [];
    try { cands = await candidates(spot, city); }
    catch (e) { stat.err++; log.push({ id: spot.id, name: spot.name, why: String(e.message || e) }); continue; }
    const ranked = cands.map(p => ({ p, s: score(p, spot) })).sort((a, b) => b.s - a.s);
    const chosen = ranked.filter(x => acceptable(x.p, spot, x.s))[0];
    if (!chosen) {
      stat.noCand++;
      log.push({ id: spot.id, name: spot.name, why: '无合格候选（子设施/店铺/低分）', top: ranked.slice(0, 3).map(x => x.p.name + '(' + Math.round(x.s) + ')') });
      continue;
    }
    const best = chosen.p;
    const oldId = spot.amap_poi_id || '';
    const oldCoord = (spot.coord || []).slice();
    const drift = spot.coord && best.coord[0] ? hav(spot.coord, best.coord) : null;
    const entry = {
      id: spot.id, name: spot.name, pick: best.name, pickId: best.id, score: Math.round(chosen.s),
      type: best.type, rating: best.rating, tel: best.tel, openTime: best.openTime, openText: best.openText,
      oldId, drift_m: drift == null ? null : Math.round(drift),
    };
    if (APPLY) {
      const changes = {};
      if (best.id && best.id !== oldId) {
        if (oldId) stat.poiFixed++;
        spot.amap_poi_id = best.id;
        changes.poi = { from: oldId || null, to: best.id };
      }
      // POI 校准到位 = 这条点位的坐标/存在性已有高德依据：把 estimate 升级为 amap（否则永远算估算点）
      if (best.id && spot.coord_src !== 'amap') {
        spot.coord_src = 'amap';
        spot.verify_src = 'amap';
        spot.verified_at = new Date().toISOString().slice(0, 10);
      }
      if (best.coord[0] && drift != null && drift > 30 && drift <= MAX_COORD_MOVE_M) {
        spot.coord = [+best.coord[0].toFixed(6), +best.coord[1].toFixed(6)];
        changes.coord = { from: oldCoord, to: spot.coord, drift_m: Math.round(drift) };
        stat.coordFixed++;
      }
      const cn = norm(spot.name), pn = norm(best.name);
      if (hasQualifier(spot.name)) {
        // 复合名（孤山·西泠印社 / 人民公园·鹤鸣茶社）：按尾段命中即采信官方名（用户要求：名称与高德一致）
        const tail = norm(tailOf(spot.name));
        if (tail.length >= 2 && (pn.includes(tail) || pn === norm(tail)) && GOOD_TYPE.test(best.type)
            && !BAD_TYPE.test(best.type) && best.name.length <= 26) {
          changes.rename = { from: spot.name, to: best.name };
          spot.name = best.name;
          stat.renamed++;
        }
      } else if (pn !== cn && GOOD_TYPE.test(best.type) && !BAD_TYPE.test(best.type)
          && Math.abs(best.name.length - spot.name.length) <= 8) {
        const extra = pn.startsWith(cn) ? pn.slice(cn.length) : '';
        const official = (extra && OFFICIAL_SUFFIX.test(extra)) || (pn.includes(cn) && pn.length - cn.length <= 6);
        if (official) {
          changes.rename = { from: spot.name, to: best.name };
          spot.name = best.name;
          stat.renamed++;
        }
      }
      const oi = parseOpenTime({ open_time: best.openTime, opentime2: best.openText });
      if (oi.open) { spot.open = oi.open; stat.openFilled++; }
      if (best.openText || best.openTime) spot.open_text = best.openText || best.openTime;
      const cm = parseClosedMon({ opentime2: best.openText, open_time: best.openTime });
      if (cm !== null) { spot.closed_mon = cm; if (cm) stat.closedMon++; }
      if (best.tel && !spot.tel) { spot.tel = best.tel; stat.tel++; }
      if (best.rating != null) { spot.rating = best.rating; stat.rating++; }
      if (best.cost != null) spot.cost = best.cost;
      if (!spot.photo && best.photo) { spot.photo = best.photo; stat.photo++; }
      spot.biz_src = 'amap';
      spot.biz_at = new Date().toISOString().slice(0, 10);
      entry.changes = changes;
    }
    log.push(entry);
    if (i % 20 === 0) console.log('  ' + city + ' ' + i + '/' + spots.length + '…');
  }
  const date = new Date().toISOString().slice(0, 10);
  if (APPLY) {
    data._meta.biz_at = date;
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
    fs.writeFileSync(abs.replace(/\.json$/, '.biz-report.json'), JSON.stringify({ city, date, stat, log }, null, 2) + '\n');
    const fixed = log.filter(x => x.changes && x.changes.poi).slice(0, 8).map(x => x.name + '：' + (x.oldId || '无') + ' → ' + x.pick);
    console.log(city + '：' + stat.total + ' 点 · 换 POI ' + stat.poiFixed + ' · 改名 ' + stat.renamed + ' · 校坐标 ' + stat.coordFixed +
      ' · 营业时间 ' + stat.openFilled + ' · 周一闭馆 ' + stat.closedMon + ' · 电话 ' + stat.tel + ' · 评分 ' + stat.rating +
      ' · 补图 ' + stat.photo + ' · 无合格候选 ' + stat.noCand + ' · 错误 ' + stat.err);
    if (fixed.length) console.log('  典型换 POI：' + fixed.join('；'));
  } else {
    console.log(city + '（干跑）：' + spots.length + ' 点，前 8 例：');
    log.slice(0, 8).forEach(x => console.log('  ' + x.name + ' → ' + (x.pick || '(无合格候选)') + ' [' + String(x.type || '').split(';').pop() + '] 评分 ' + (x.rating == null ? '-' : x.rating) + ' 营业 ' + (x.openTime || x.openText || '-').slice(0, 22) + ' 漂移 ' + (x.drift_m == null ? '-' : x.drift_m + 'm')));
  }
}

module.exports = { candidates, score, acceptable };   // 调试/测试用

async function main() {
  if (!(process.env.AMAP_KEY || process.env.AMAP_WS_KEY)) { console.error('需要 AMAP_KEY（或 AMAP_WS_KEY）'); process.exit(2); }
  let files = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!files.length) {
    const all = fs.readdirSync(path.join(ROOT, 'data', 'spots')).filter(f => f.endsWith('.json') && !f.includes('report') && !f.includes('rebuild'));
    files = (ALL ? all : LIVE.map(c => c + '.json')).map(f => path.join(ROOT, 'data', 'spots', f));
  }
  for (const f of files) await run(f);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
