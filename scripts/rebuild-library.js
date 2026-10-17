'use strict';
// 景点库重构工具（规范见 项目上下文.md §12.5）
// 用法：
//   node scripts/rebuild-library.js --audit                     组成体检（零配额，随时可跑）
//   AMAP_WS_KEY=… node scripts/rebuild-library.js --collect 成都 采集候选池 + 评分/等级（需配额）
//   node scripts/rebuild-library.js --plan 成都                  生成「保留 / 剔除 / 新增」三张清单（零配额）
// 产物：data/spots/<city>.rebuild-pool.json（候选池）、<city>.rebuild-report.json（三张清单）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { amapAround, norm } = require('./repair-coords.js');

const CITY_FILES = {
  '成都': 'chengdu', '北京': 'beijing', '上海': 'shanghai',
  '西安': 'xian', '重庆': 'chongqing', '杭州': 'hangzhou',
};
const CENTERS = {
  chengdu: [104.0657, 30.6572], beijing: [116.3975, 39.9087], shanghai: [121.4737, 31.2304],
  xian: [108.9402, 34.3416], chongqing: [106.5516, 29.5630], hangzhou: [120.1551, 30.2741],
};
// §12.5 目标画像：类目 → 目标上限/下限
const TARGET = {
  core: { cats: ['古迹', '博物馆', '山水', '古镇'], min: 26, max: 34 },
  night: { cats: ['夜景', '演出'], min: 5, max: 8 },
  family: { cats: ['亲子'], min: 4, max: 7 },
  street: { cats: ['街区'], min: 0, max: 8 },
  food: { cats: ['美食'], min: 0, max: 4 },
  park: { cats: ['公园'], min: 0, max: 5 },
  mall: { cats: ['商圈'], min: 0, max: 2 },
};
const CORE_CATS = new Set([...TARGET.core.cats, ...TARGET.night.cats]);

const score = (rating, level, curation) => {
  const nr = typeof rating === 'number' ? Math.max(0, Math.min(1, (rating - 3.5) / 1.5)) : null;
  const lv = level === 'national' ? 1 : level === 'province' ? 0.6 : level === 'city' ? 0.3 : 0;
  const cur = curation ? 1 : 0;
  if (nr === null && lv === 0 && !cur) return null;   // 无任何信号 → 待人工
  return +(0.6 * (nr === null ? lv : nr) + 0.25 * lv + 0.15 * cur).toFixed(3);
};
const heatOf = s => (s === null ? null : Math.max(5, Math.min(10, Math.round(5 + 5 * s))));

function composition(spots) {
  const c = {};
  for (const s of spots) c[s.cat] = (c[s.cat] || 0) + 1;
  const grp = {};
  for (const [k, t] of Object.entries(TARGET)) grp[k] = t.cats.reduce((n, cat) => n + (c[cat] || 0), 0);
  grp.total = spots.length;
  grp.suburb = spots.filter(s => s.suburb).length;
  grp.coreRatio = +((spots.filter(s => CORE_CATS.has(s.cat)).length / Math.max(1, spots.length)) * 100).toFixed(0);
  return { byCat: c, byGroup: grp };
}

function audit() {
  const rows = [];
  for (const [city, file] of Object.entries(CITY_FILES)) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'spots', file + '.json'), 'utf8'));
    const spots = d.spots || [];
    const comp = composition(spots);
    const gaps = [];
    for (const [k, t] of Object.entries(TARGET)) {
      const n = comp.byGroup[k];
      if (n > t.max) gaps.push(k + ' 超 ' + (n - t.max));
    }
    if (comp.byGroup.suburb < 4) gaps.push('远郊仅 ' + comp.byGroup.suburb);
    if (comp.byGroup.coreRatio < 60) gaps.push('核心类 ' + comp.byGroup.coreRatio + '%');
    rows.push({ city, total: spots.length, core: comp.byGroup.core + comp.byGroup.night, coreRatio: comp.byGroup.coreRatio, street: comp.byGroup.street, food: comp.byGroup.food, park: comp.byGroup.park, mall: comp.byGroup.mall, suburb: comp.byGroup.suburb, gaps });
  }
  console.log('城市   总数  核心类  核心占比  街区/美食/公园/商圈  远郊   缺口');
  for (const r of rows) {
    console.log(r.city.padEnd(5) + String(r.total).padStart(4) + String(r.core).padStart(7) + String(r.coreRatio + '%').padStart(8) +
      '   ' + [r.street, r.food, r.park, r.mall].map(v => String(v).padStart(2)).join('/') +
      String(r.suburb).padStart(6) + '   ' + (r.gaps.join('；') || '达标'));
  }
}

async function collect(city) {
  const file = CITY_FILES[city];
  if (!file) { console.error('未知城市：' + city + '（支持：' + Object.keys(CITY_FILES).join('/') + '）'); process.exit(2); }
  const AK = process.env.AMAP_KEY || process.env.AMAP_WS_KEY;
  if (!AK) { console.error('需要 AMAP_KEY 或 AMAP_WS_KEY'); process.exit(2); }
  const [lng, lat] = CENTERS[file];
  const pool = [];
  const seen = new Set();
  const rounds = [
    ['风景名胜', 50000], ['博物馆', 50000], ['公园', 50000], ['古镇', 50000],
    ['主题乐园', 50000], ['文化街区', 30000], ['美食街', 20000],
  ];
  for (const [kw, radius] of rounds) {
    for (let page = 0; page < 3; page++) {
      const url = (process.env.AMAP_BASE || 'https://restapi.amap.com').replace(/\/+$/, '') + '/v3/place/around?location=' + lng + ',' + lat + '&radius=' + radius +
        '&keywords=' + encodeURIComponent(kw) + '&sortrule=weight&extensions=all&offset=25&page=' + (page + 1) + '&key=' + AK;
      const j = await (await fetch(url)).json();
      if (String(j.status) !== '1') { console.error('  采集失败 ' + kw + ' page' + (page + 1) + '：' + j.info); break; }
      const pois = j.pois || [];
      for (const p of pois) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const [plng, plat] = String(p.location || '').split(',').map(Number);
        const type = String(p.type || '');
        pool.push({
          id: p.id, name: p.name, coord: [plng, plat], type,
          rating: p.biz_ext && p.biz_ext.rating ? Number(p.biz_ext.rating) : null,
          level: /国家级/.test(type) ? 'national' : /省级/.test(type) ? 'province' : /市级/.test(type) ? 'city' : null,
          kw,
        });
      }
      await new Promise(r => setTimeout(r, 400));
      if (pois.length < 25) break;
    }
  }
  const out = path.join(ROOT, 'data', 'spots', file + '.rebuild-pool.json');
  fs.writeFileSync(out, JSON.stringify({ city, date: new Date().toISOString().slice(0, 10), count: pool.length, pool }, null, 2) + '\n');
  const withRating = pool.filter(p => p.rating).length;
  console.log(city + '：候选池 ' + pool.length + ' 个（有评分 ' + withRating + '）→ ' + path.relative(ROOT, out));
}

function plan(city) {
  const file = CITY_FILES[city];
  const libPath = path.join(ROOT, 'data', 'spots', file + '.json');
  const d = JSON.parse(fs.readFileSync(libPath, 'utf8'));
  const spots = d.spots || [];
  const poolPath = path.join(ROOT, 'data', 'spots', file + '.rebuild-pool.json');
  const pool = fs.existsSync(poolPath) ? JSON.parse(fs.readFileSync(poolPath, 'utf8')).pool : [];
  const byName = new Map(pool.map(p => [norm(p.name), p]));
  const keep = [], drop = [], manual = [], heatChanges = [];
  for (const s of spots) {
    const hit = byName.get(norm(s.name)) || pool.find(p => norm(p.name).includes(norm(s.name)) || norm(s.name).includes(norm(p.name)));
    const sc = score(hit && hit.rating, hit && hit.level, false);
    const h = heatOf(sc);
    const rec = { id: s.id, name: s.name, cat: s.cat, heat: s.heat, rating: hit ? hit.rating : null, level: hit ? hit.level : null, score: sc };
    if (sc === null) { manual.push({ ...rec, why: '无评分/无等级，待人工' }); continue; }
    if (h !== s.heat) heatChanges.push({ id: s.id, name: s.name, from: s.heat, to: h });
    const t = Object.entries(TARGET).find(([, v]) => v.cats.includes(s.cat));
    const capped = t && t[1].max <= 2 && sc < 0.75;   // 受限类目（商圈/美食）且分数不高 → 剔除
    if (sc < 0.55 || capped) drop.push({ ...rec, why: sc < 0.55 ? '综合分 < 0.55' : '受限类目且分数 < 0.75' });
    else keep.push(rec);
  }
  const inLib = new Set(spots.map(s => norm(s.name)));
  const add = pool.filter(p => score(p.rating, p.level, false) !== null && score(p.rating, p.level, false) >= 0.7 && !inLib.has(norm(p.name)))
    .map(p => ({ name: p.name, coord: p.coord, type: p.type, rating: p.rating, level: p.level, score: score(p.rating, p.level, false), heat: heatOf(score(p.rating, p.level, false)) }))
    .slice(0, 30);
  const comp = composition(spots);
  const report = { city, date: new Date().toISOString().slice(0, 10), compositionBefore: comp, keep, drop, manual, add, heatChanges };
  const out = path.join(ROOT, 'data', 'spots', file + '.rebuild-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(city + '：保留 ' + keep.length + ' / 剔除 ' + drop.length + ' / 待人工 ' + manual.length + ' / 建议新增 ' + add.length + ' / heat 变动 ' + heatChanges.length);
  console.log('  报告：' + path.relative(ROOT, out));
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--audit') || !args.length) return audit();
  const city = args[args.indexOf('--collect') + 1] || args[args.indexOf('--plan') + 1];
  if (args.includes('--collect')) return collect(city);
  if (args.includes('--plan')) return plan(city);
  console.log('用法：--audit | --collect <城市> | --plan <城市>');
})();
