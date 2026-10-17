'use strict';
// 全库「与高德对齐 + 信息补齐」：逐点取高德实体，校正名称/坐标/评分，补齐营业时间/电话/地址/区县/多图/人均/可订票
// 用法：AMAP_BASE=… AMAP_KEY=… node scripts/verify-enrich.js [--apply] [--city 成都] [--limit N]
const fs = require('fs');
const path = require('path');
const amap = require('./lib/amap.js');
const ROOT = path.join(__dirname, '..');
const d0 = path.join(ROOT, 'data', 'spots');
const APPLY = process.argv.includes('--apply');
const cityIdx = process.argv.indexOf('--city');
const ONLY = cityIdx > 0 ? process.argv[cityIdx + 1] : null;
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > 0 ? Number(process.argv[limitIdx + 1]) : 99999;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const THROTTLE_MS = Number(process.env.ENRICH_THROTTLE_MS || 200);   // 官方版 QPS 限制
const today = new Date().toISOString().slice(0, 10);
const norm = s => String(s || '').replace(/[\s（）()·\-—／\/]/g, '');
const BAD_TYPE = /地铁站|公交车站|公交站|售票处|停车场|停车楼|入口|出口|检票|收费站|道路名|地名地址|公司|写字楼|便利店|ATM|餐厅|餐饮|快餐|小吃|咖啡|茶楼|酒家|饭店|商店|超市|银行|酒店|宾馆|民宿|加油站|充电|司机之家|码头|游船|客运站|集散中心|游客中心|政府机关|住宅|公寓|小区|学校|医院/;
const SHOP_NAME = /[（(][^）)]*店[）)]\s*$|(店|铺|铺面房|摊位|专柜|旗舰店|商城|公寓|服务区)$/;
const STATUS_PAREN = /[（(][^）)]*(装修|暂停开放|不对外开放|停业|闭馆|改造中|施工)[^）)]*[）)]/;
const OFFICIAL_SUFFIX = /^(景区|风景区|旅游区|旅游度假区|国家公园|博物馆|博物院|公园|古镇|古街|老街|寺|宫|陵|塔|遗址|纪念馆|美术馆|大剧院|剧场|广场|步行街|商业街|街区|文化宫|园林|植物园|动物园|海洋公园|世界|中心|观景台|瀑布|峡谷|湖|山|岛|海滩|浴场|大峡谷)$/;
const LEVEL_LIKE = /国家级景点/;
function hav(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function heatOf(rating, type) {
  const nr = Math.max(0, Math.min(1, (rating - 3.5) / 1.5));
  const lv = LEVEL_LIKE.test(String(type || '')); const bonus = lv ? 0.25 : 0;
  return Math.max(5, Math.min(10, Math.round(5 + 5 * (0.6 * nr + bonus))));
}
function parseOpen(openTime, openText) {
  const raw = String(openTime || '').trim();
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw);
  if (m) return String(m[1]).padStart(2, '0') + ':' + m[2] + '-' + String(m[3]).padStart(2, '0') + ':' + m[4];
  if (/24\s*小时|全天/.test(String(openText || '') + raw)) return '00:00-23:59';
  return null;
}
function parseClosed(bizExt) {
  const txt = String(bizExt && bizExt.opentime2 || '') + ' ' + String(bizExt && bizExt.open_time || '');
  if (/周[一二三四五六日天]\s*闭馆|每(周|星期)[一二三四五六日天]\s*闭馆|周[一二三四五六日天]\s*休息|周[一二三四五六日天]\s*不开放/.test(txt)) return true;
  if (/周一至周日|全年无休|每日开放|每天开放|全周开放/.test(txt)) return false;
  return null;
}
function nameAcceptable(poiName, spotName) {
  const pn = norm(poiName), sn = norm(spotName);
  if (pn === sn) return true;
  const hasQual = /[·（(]/.test(spotName);
  if (hasQual) return pn.includes(sn);
  if (BAD_TYPE.test('') ) return false;
  if (/[-－]/.test(poiName) && !/[-－]/.test(spotName)) return false;
  const extra = pn.startsWith(sn) ? pn.slice(sn.length) : '';
  const officialSuffix = extra && OFFICIAL_SUFFIX.test(extra);
  if (officialSuffix) return true;
  if (pn.includes(sn) && pn.length - sn.length <= 6) return true;
  return false;
}
async function resolvePoi(spot, city) {
  if (spot.amap_poi_id) {
    try {
      const j = await amap.get('/v3/place/detail', { id: spot.amap_poi_id, extensions: 'all' }, { timeout: 12000 });
      const raw = (j.pois || [])[0];
      if (raw) { const p = amap.normPoi(raw); p.bizExt = raw.biz_ext || {}; p.adcode = raw.adcode; p.childtype = raw.childtype; p.address = raw.address || '';
        p.keytag = raw.keytag || ''; p.entrLocation = raw.entr_location || ''; p.naviPoiid = raw.navi_poiid || '';
        p.businessArea = raw.business_area || ''; p.children = raw.children || []; p.importance = raw.importance || [];
        p.website = raw.website || ''; p.photosAll = (raw.photos || []).map(x => x.url).filter(Boolean).slice(0, 3);
        return p; }
    } catch (e) {}
    await sleep(80);
  }
  const tries = [
    { keywords: spot.name, city, citylimit: 'true', extensions: 'all', offset: 8 },
    { keywords: spot.name, citylimit: 'false', extensions: 'all', offset: 8 },
  ];
  for (const params of tries) {
    try {
      const j = await amap.get('/v3/place/text', params, { timeout: 12000 });
      const list = (j.pois || []).map(p => { const n = amap.normPoi(p); n.bizExt = p.biz_ext || {}; n.adcode = p.adcode; n.address = p.address || '';
        n.keytag = p.keytag || ''; n.entrLocation = p.entr_location || ''; n.naviPoiid = p.navi_poiid || '';
        n.businessArea = p.business_area || ''; n.children = p.children || []; n.importance = p.importance || [];
        n.website = p.website || ''; n.photosAll = (p.photos || []).map(x => x.url).filter(Boolean).slice(0, 3);
        return n; }).filter(x => x.coord[0]);
      const ok = list.filter(p => !BAD_TYPE.test(p.type) && !SHOP_NAME.test(p.name) && !STATUS_PAREN.test(p.name));
      const best = ok.find(p => norm(p.name) === norm(spot.name)) || ok.find(p => nameAcceptable(p.name, spot.name)) || ok[0];
      if (best) return best;
    } catch (e) {}
    await sleep(THROTTLE_MS);
  }
  return null;
}
(async () => {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-registry.json'), 'utf8'));
  const FILE = {};
  for (const [cn, v] of Object.entries(reg)) FILE[cn] = v.file;
  Object.assign(FILE, { 成都:'chengdu',北京:'beijing',上海:'shanghai',西安:'xian',重庆:'chongqing',杭州:'hangzhou',大理:'dali',广州:'guangzhou',贵阳:'guiyang',合肥:'hefei',昆明:'kunming',拉萨:'lhasa',丽江:'lijiang',南京:'nanjing',宁波:'ningbo',绍兴:'shaoxing',苏州:'suzhou',温州:'wenzhou',无锡:'wuxi',香格里拉:'xianggelila',西双版纳:'xishuangbanna',扬州:'yangzhou' });
  const report = { date: today, cities: [] };
  let grand = { spots: 0, checked: 0, renamed: 0, ratingUpd: 0, openUpd: 0, telUpd: 0, addrUpd: 0, photoUpd: 0, coordFixed: 0, noPoi: 0 };
  for (const [cn, file] of Object.entries(FILE)) {
    if (ONLY && cn !== ONLY) continue;
    const libPath = path.join(d0, file + '.json');
    if (!fs.existsSync(libPath)) continue;
    const d = JSON.parse(fs.readFileSync(libPath, 'utf8'));
    const spots = d.spots || [];
    const stat = { city: cn, spots: spots.length, checked: 0, renamed: [], ratingUpd: [], openUpd: 0, telUpd: 0, addrUpd: 0, photoUpd: 0, coordFixed: [], noPoi: [] };
    let count = 0;
    for (const s of spots) {
      if (count++ >= LIMIT) break;
      const poi = await resolvePoi(s, cn);
      await sleep(THROTTLE_MS);
      if (!poi) { stat.noPoi.push(s.name); continue; }
      stat.checked++;
      // ① 名称对齐（只向上采信官方全称）
      if (poi.name && norm(poi.name) !== norm(s.name) && !s.name_locked) {
        if (!SHOP_NAME.test(poi.name) && !STATUS_PAREN.test(poi.name) && nameAcceptable(poi.name, s.name)) {
          stat.renamed.push({ id: s.id, from: s.name, to: poi.name });
          if (APPLY) s.name = poi.name;
        }
      }
      // ② 坐标（漂移 >50m 且 ≤2km 才校正，且 POI 类型可信）
      const drift = hav(s.coord, poi.coord);
      if (drift > 50 && drift <= 2000 && !BAD_TYPE.test(poi.type)) {
        stat.coordFixed.push({ id: s.id, name: s.name, drift_m: Math.round(drift) });
        if (APPLY) { s.coord = [+poi.coord[0].toFixed(6), +poi.coord[1].toFixed(6)]; s.amap_poi_id = poi.id; s.coord_src = 'amap'; }
      }
      // ③ 评分 + heat
      if (poi.rating != null && poi.rating > 0 && poi.rating !== s.rating) {
        stat.ratingUpd.push({ id: s.id, name: s.name, from: s.rating, to: poi.rating });
        if (APPLY) {
          s.rating = poi.rating;
          const h = heatOf(poi.rating, poi.type);
          if (h !== s.heat) { s.heat_prev = s.heat; s.heat = h; }
        }
      }
      // ④ 营业时间 / 闭馆日
      const open = parseOpen(poi.openTime, poi.openText);
      if (open && open !== s.open) { stat.openUpd++; if (APPLY) s.open = open; }
      if (poi.openText && poi.openText !== s.open_text) { if (APPLY) s.open_text = poi.openText; }
      const closed = parseClosed(poi.bizExt);
      if (closed !== null && closed !== s.closed_mon && APPLY) s.closed_mon = closed;
      // ⑤ 电话 / 地址 / 区县 / 多图 / 人均 / 可订票
      if (poi.tel && !s.tel) { stat.telUpd++; if (APPLY) s.tel = poi.tel; }
      if (poi.address && !s.address) { stat.addrUpd++; if (APPLY) s.address = poi.address; }
      if (APPLY) {
        if (poi.district && !s.district) s.district = poi.district;
        if (poi.adcode && !s.adcode) s.adcode = poi.adcode;
        if (poi.cost != null && s.cost == null) s.cost = poi.cost;
        if (poi.bizExt && poi.bizExt.ticket_ordering != null && s.ticket_ordering == null) s.ticket_ordering = String(poi.bizExt.ticket_ordering);
        if (!s.photos && poi.photo) s.photos = [poi.photo];
        if (poi.photo && !s.photo) { stat.photoUpd++; s.photo = poi.photo; }
        // 景区等级（AAAA/4A景区 → 5A/4A）：规则里「非常知名」的权威判据
        const lvl = String((poi.bizExt && poi.bizExt.level) || '') + ' ' + String(poi.keytag || '');
        let aLevel = null;
        if (/5A|AAAAA/.test(lvl)) aLevel = '5A';
        else if (/4A|AAAA/.test(lvl)) aLevel = '4A';
        else if (/3A|AAA/.test(lvl)) aLevel = '3A';
        if (aLevel) s.a_level = aLevel;
        if (poi.keytag && poi.keytag !== aLevel) s.keytag = poi.keytag;
        // 入口坐标（路由到点更准）
        if (poi.entrLocation) {
          const [elng, elat] = String(poi.entrLocation).split(',').map(Number);
          if (elng && elat) s.entrance = [+elng.toFixed(6), +elat.toFixed(6)];
        }
        if (poi.naviPoiid) s.navi_poiid = poi.naviPoiid;
        if (poi.businessArea && !s.business_area) s.business_area = poi.businessArea;
        if (Array.isArray(poi.children) && poi.children.length && !s.has_children) s.has_children = true;
        if (Array.isArray(poi.photosAll) && poi.photosAll.length) {
          const merged = [...new Set([...(s.photos || []), ...poi.photosAll])].slice(0, 3);
          if (merged.length > (s.photos || []).length) stat.photoUpd++;
          s.photos = merged;
          if (!s.photo) s.photo = merged[0];
        }
        if (poi.importance !== undefined && poi.importance !== null && String(poi.importance).length && s.importance == null) s.importance = Number(poi.importance) || poi.importance;
        if (poi.website && !s.website) s.website = poi.website;
        s.amap_poi_id = poi.id || s.amap_poi_id;
        s.verify_src = 'amap'; s.verified_at = today; s.amap_checked_at = today;
      }
    }
    if (APPLY) {
      d._meta.enrich_at = today;
      fs.writeFileSync(libPath, JSON.stringify(d, null, 2) + '\n');
      fs.writeFileSync(libPath.replace(/\.json$/, '.enrich-report.json'), JSON.stringify(stat, null, 2) + '\n');
    }
    grand.spots += stat.spots; grand.checked += stat.checked; grand.renamed += stat.renamed.length;
    grand.ratingUpd += stat.ratingUpd.length; grand.openUpd += stat.openUpd; grand.telUpd += stat.telUpd;
    grand.addrUpd += stat.addrUpd; grand.photoUpd += stat.photoUpd; grand.coordFixed += stat.coordFixed.length; grand.noPoi += stat.noPoi.length;
    console.log(cn + '：' + stat.spots + ' 点｜核验 ' + stat.checked + '｜改名 ' + stat.renamed.length + '｜评分更新 ' + stat.ratingUpd.length +
      '｜补营业时间 ' + stat.openUpd + '｜补电话 ' + stat.telUpd + '｜补地址 ' + stat.addrUpd + '｜补图 ' + stat.photoUpd +
      '｜校坐标 ' + stat.coordFixed.length + '｜无实体 ' + stat.noPoi.length);
    report.cities.push(stat);
  }
  if (APPLY) fs.writeFileSync(path.join(d0, 'enrich-summary.json'), JSON.stringify({ date: today, grand, cities: report.cities }, null, 2) + '\n');
  console.log('\n合计：' + grand.spots + ' 点｜核验 ' + grand.checked + '｜改名 ' + grand.renamed + '｜评分 ' + grand.ratingUpd +
    '｜营业时间 ' + grand.openUpd + '｜电话 ' + grand.telUpd + '｜地址 ' + grand.addrUpd + '｜图 ' + grand.photoUpd + '｜坐标 ' + grand.coordFixed + '｜无实体 ' + grand.noPoi);
})().catch(e => { console.error(e); process.exit(1); });
