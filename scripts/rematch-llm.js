'use strict';
// LLM 裁判回填：对双源（腾讯/高德）字符串匹配仍失败的 estimate 点，
// 用高德召回候选 + DeepSeek 判断哪条是目标 POI，再过距离容差才入库。
// 用法：AMAP_WS_KEY=高德Key DEEPSEEK_KEY=中转Key node scripts/rematch-llm.js [city.json ...]
// 只处理 coord_src 仍为 estimate 的点；结果 coord_src 标 "amap"（裁判过程记入报告）。

const fs = require('fs');
const path = require('path');

const AMAP_BASE = (process.env.AMAP_BASE || 'https://restapi.amap.com').replace(/\/+$/, '');
const AMAP = AMAP_BASE + '/v3/place/text';
const AI_URL = process.env.AI_BASE_URL || 'https://new.fluapi.com/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4.1-flash';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function haversineM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}
const norm = s => (s || '').replace(/[·（(【\[].*$/, '').replace(/\s+/g, '');

async function amapSearch(keyword, city) {
  const url = `${AMAP}?keywords=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}&citylimit=true&offset=8&key=${process.env.AMAP_WS_KEY}`;
  for (let a = 0; a < 2; a++) {
    try {
      const j = await (await fetch(url)).json();
      if (j.infocode === '10000' || j.status === '1') {
        return (j.pois || []).map(p => {
          const [lng, lat] = String(p.location || '').split(',').map(Number);
          return { id: p.id, title: p.name, address: String(p.address || ''), type: String(p.type || ''), lng, lat };
        }).filter(p => p.lng);
      }
    } catch (e) { if (a === 1) throw e; await sleep(500); }
  }
  return [];
}

async function judge(spot, cands, city) {
  const list = cands.map((c, i) => `${i}. ${c.title}｜${c.address}｜${c.type}`).join('\n');
  const res = await fetch(AI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: '你是地图 POI 匹配裁判。给定目标景点名和候选 POI 列表，判断哪个候选就是目标（允许名称带后缀/别名，警惕同名异地）。只输出 JSON：{"pick": 序号}；都不像则 {"pick": -1}。' },
        { role: 'user', content: `城市：${city}\n目标：${spot.name}（${spot.cat}，估计坐标 ${spot.coord}）\n候选：\n${list}` },
      ],
      temperature: 0, max_tokens: 400,
    }),
    signal: AbortSignal.timeout(25000),
  });
  const j = await res.json();
  const raw = (j.choices && j.choices[0] && j.choices[0].message.content || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('裁判无 JSON 输出');
  const parsed = JSON.parse(m[0]);
  return typeof parsed.pick === 'number' ? parsed.pick : -1;
}

async function run(file) {
  const abs = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const city = data._meta.city;
  const targets = data.spots.filter(s => !s.coord_src || s.coord_src === 'estimate');
  if (!targets.length) { console.log(`${city}: 无待裁判点`); return; }
  let ok = 0, rej = 0, err = 0;
  const log = [];
  for (const spot of targets) {
    await sleep(200);
    try {
      let cands = await amapSearch(spot.name, city);
      if (!cands.length) {
        const base = spot.name.split(/[（(·]/)[0];
        if (base !== spot.name) { await sleep(200); cands = await amapSearch(base, city); }
      }
      if (!cands.length) { rej++; log.push({ id: spot.id, name: spot.name, why: '高德无召回' }); continue; }
      let pick = -1;
      for (let attempt = 0; attempt < 2; attempt++) { try { pick = await judge(spot, cands, city); break; } catch (e) { if (attempt === 1) throw e; await sleep(800); } }
      if (pick < 0 || !cands[pick]) { rej++; log.push({ id: spot.id, name: spot.name, why: '裁判否决', cands: cands.slice(0, 3).map(c => c.title) }); continue; }
      const c = cands[pick];
      const dist = haversineM(spot.coord, [c.lng, c.lat]);
      const tol = spot.suburb ? 8000 : 3000;
      if (dist > tol) { rej++; log.push({ id: spot.id, name: spot.name, why: `裁判选中但距离 ${Math.round(dist)}m 超容差`, picked: c.title }); continue; }
      spot.coord = [+c.lng.toFixed(6), +c.lat.toFixed(6)];
      spot.amap_poi_id = c.id;
      spot.coord_src = 'amap';
      spot.refreshed_at = new Date().toISOString().slice(0, 10);
      ok++; log.push({ id: spot.id, name: spot.name, picked: c.title, drift_m: Math.round(dist) });
    } catch (e) { err++; log.push({ id: spot.id, name: spot.name, why: String(e.message || e) }); }
  }
  data._meta.rematch_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(abs.replace(/\.json$/, '.rematch-report.json'), JSON.stringify(log, null, 2) + '\n');
  console.log(`${city}: 裁判通过 ${ok} / 否决 ${rej} / 错误 ${err}（原剩 ${targets.length}）`);
}

(async () => {
  if (!(process.env.AMAP_KEY || process.env.AMAP_WS_KEY) || !process.env.DEEPSEEK_KEY) { console.error('需要 AMAP_KEY/AMAP_WS_KEY 与 DEEPSEEK_KEY'); process.exit(2); }
  const files = process.argv.slice(2).length ? process.argv.slice(2)
    : ['chengdu', 'beijing', 'chongqing', 'hangzhou', 'shanghai', 'xian'].map(c => `data/spots/${c}.json`);
  for (const f of files) await run(f);
})();
