'use strict';
// P2 · 坐标回填脚本（离线运行，Node 18+）
// 用法：
//   干跑（不调 API，只校验数据与匹配计划）： node scripts/backfill.js data/spots/chengdu.json --dry-run
//   正式回填： TENCENT_WS_KEY=离线Key node scripts/backfill.js data/spots/chengdu.json
//   回填并剔除对不上的点：                       同上 + --prune
//
// 纪律：
// - Key 只从环境变量 TENCENT_WS_KEY 读取，永不写进文件/前端；
// - 每条 spot 用腾讯地点搜索按「城市 + 名称」召回，取名称匹配且与估计坐标
//   距离 ≤ MATCH_TOLERANCE_M 的第一条回填真实坐标与 POI ID；
// - 200ms 节流 + 失败重试 1 次；对不上的点默认保留 estimate 并列入报告，--prune 才剔除。

const fs = require('fs');
const path = require('path');

const THROTTLE_MS = 200;
const API = 'https://apis.map.qq.com/ws/place/v1/search';

// ---- 几何（避免引 engine 依赖，脚本自洽） ----
function haversineM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '').replace(/[·（(【\[].*$/, '').replace(/\s+/g, '').toLowerCase();
}

async function searchPoi(keyword, city, key) {
  const url = `${API}?keyword=${encodeURIComponent(keyword)}` +
    `&boundary=${encodeURIComponent(`region(${city},0)`)}` +
    `&page_size=10&page_index=1&key=${key}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      const json = await res.json();
      if (json.status === 0) return json.data || [];
      lastErr = new Error(`腾讯接口 status=${json.status} ${json.message || ''}`);
    } catch (e) { lastErr = e; }
    if (attempt === 0) await sleep(500); // 重试 1 次
  }
  throw lastErr;
}

function pickMatch(candidates, spot) {
  const want = norm(spot.name);
  const tol = spot.suburb ? 5000 : 2500;   // 远郊估计坐标偏差大，容差放宽
  let best = null;
  for (const c of candidates) {
    const got = norm(c.title);
    if (!(got.includes(want) || want.includes(got))) continue;
    const dist = haversineM(spot.coord, [c.location.lng, c.location.lat]);
    if (dist <= tol && (!best || dist < best.dist)) best = { cand: c, dist };
  }
  return best;
}

// 名称降级变体：「钟书阁（都江堰）」→「钟书阁」、「泡桐树街·小通巷」→「泡桐树街」
function nameVariants(name) {
  const base = name.split(/[（(·]/)[0];
  return base && base !== name ? [name, base] : [name];
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const prune = args.includes('--prune');
  if (!file) {
    console.error('用法：node scripts/backfill.js <spots.json> [--dry-run] [--prune]');
    process.exit(2);
  }
  const key = process.env.TENCENT_WS_KEY;
  if (!dryRun && !key) {
    console.error('缺少环境变量 TENCENT_WS_KEY（离线 Key）。干跑请加 --dry-run。');
    process.exit(2);
  }

  const abs = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const city = data._meta && data._meta.city;
  if (!city) { console.error('文件缺少 _meta.city'); process.exit(2); }

  const today = new Date().toISOString().slice(0, 10);
  const report = { city, date: today, dryRun, total: data.spots.length, ok: [], mismatch: [], error: [] };

  for (const spot of data.spots) {
    if (spot.coord_src === 'tencent') { report.ok.push({ id: spot.id, skip: '已回填' }); continue; }
    if (dryRun) {
      if (!Array.isArray(spot.coord) || spot.coord.length !== 2) {
        report.error.push({ id: spot.id, name: spot.name, err: '缺估计坐标' });
      }
      continue;
    }
    await sleep(THROTTLE_MS);
    try {
      let hit = null, lastCands = [];
      for (const kw of nameVariants(spot.name)) {
        if (hit) break;
        lastCands = await searchPoi(kw, city, key);
        hit = pickMatch(lastCands, spot);
        if (!hit && kw !== spot.name) await sleep(THROTTLE_MS);
      }
      if (hit) {
        spot.coord = [+hit.cand.location.lng.toFixed(6), +hit.cand.location.lat.toFixed(6)];
        spot.tencent_poi_id = hit.cand.id;
        spot.coord_src = 'tencent';
        spot.refreshed_at = today;
        report.ok.push({ id: spot.id, name: spot.name, drift_m: Math.round(hit.dist), poi: hit.cand.title });
      } else {
        report.mismatch.push({ id: spot.id, name: spot.name, candidates: lastCands.slice(0, 3).map(c => c.title) });
      }
    } catch (e) {
      report.error.push({ id: spot.id, name: spot.name, err: String(e.message || e) });
    }
  }

  if (!dryRun) {
    const before = data.spots.length;
    if (prune) {
      const bad = new Set(report.mismatch.map(m => m.id));
      data.spots = data.spots.filter(s => !bad.has(s.id) || s.coord_src === 'tencent');
    }
    data._meta.backfilled_at = today;
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
    const reportPath = abs.replace(/\.json$/, '') + '.backfill-report.json';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`回填完成：成功 ${report.ok.length} / 对不上 ${report.mismatch.length} / 错误 ${report.error.length}` +
      (prune ? `，剔除 ${before - data.spots.length} 条` : '（未剔除，加 --prune 可剔除对不上的点）'));
    console.log(`报告：${path.relative(process.cwd(), reportPath)}`);
  } else {
    console.log(`干跑完成：${report.total} 条待回填${report.error.length ? `，${report.error.length} 条缺估计坐标` : ''}。未调用 API。`);
  }
  if (report.mismatch.length) {
    console.log('对不上的点：');
    for (const m of report.mismatch) console.log(`  - ${m.name}（候选：${(m.candidates || []).join('、') || '无'}）`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
