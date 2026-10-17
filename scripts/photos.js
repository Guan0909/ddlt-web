'use strict';
// 景点照片富化：用高德关键字搜索取 POI 首图，写入 spots 的 photo 字段（低成本，0 元）
// 用法：AMAP_WS_KEY=高德Key node scripts/photos.js [data/spots/chengdu.json ...]（缺省 6 城全跑）
// 已有 photo 的跳过；200ms 节流；失败的留空，不影响其他字段。

const fs = require('fs');
const path = require('path');

const AMAP_BASE = (process.env.AMAP_BASE || 'https://restapi.amap.com').replace(/\/+$/, '');
const API = AMAP_BASE + '/v3/place/text';
const KEY = process.env.AMAP_KEY || process.env.AMAP_WS_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function photoOf(name, city) {
  const url = `${API}?keywords=${encodeURIComponent(name)}&city=${encodeURIComponent(city)}` +
    `&citylimit=true&offset=5&key=${KEY}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      const json = await res.json();
      if (json.infocode !== '10000' && json.status !== '1') throw new Error(`infocode=${json.infocode}`);
      for (const poi of json.pois || []) {
        const norm = s => (s || '').replace(/[·（(【\[].*$/, '').replace(/\s+/g, '');
        if (!norm(poi.name).includes(norm(name)) && !norm(name).includes(norm(poi.name))) continue;
        const photo = (poi.photos || [])[0];
        if (photo && photo.url) return photo.url;
      }
      return null;
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(500);
    }
  }
  return null;
}

async function run(file) {
  const abs = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const city = data._meta.city;
  let ok = 0, miss = 0, err = 0;
  for (const spot of data.spots) {
    if (spot.photo) { ok++; continue; }
    await sleep(200);
    try {
      const photo = await photoOf(spot.name, city);
      if (photo) { spot.photo = photo; ok++; } else miss++;
    } catch (e) { err++; }
  }
  data._meta.photos_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  console.log(`${city}: 有图 ${ok} / 无图 ${miss} / 错误 ${err}`);
}

(async () => {
  if (!KEY) { console.error('缺少 AMAP_WS_KEY'); process.exit(2); }
  const files = process.argv.slice(2).length ? process.argv.slice(2)
    : ['chengdu', 'beijing', 'chongqing', 'hangzhou', 'shanghai', 'xian'].map(c => `data/spots/${c}.json`);
  for (const f of files) await run(f);
})();
