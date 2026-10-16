'use strict';
// 估算坐标修复：只处理 coord_src === 'estimate' 的点，用「腾讯 + 高德双源一致」做判据。
// 用法：
//   干跑： node scripts/repair-coords.js data/spots/xian.json --dry-run
//   修复： TENCENT_WS_KEY=… AMAP_WS_KEY=… node scripts/repair-coords.js data/spots/xian.json [--apply]
//
// 为什么需要它：backfill.js 的容差（普通 2500m / 远郊 5000m）是为「估计坐标大体正确、只需微调」
// 设计的；实测发现部分城市的 estimate 点系统性偏了 3~19km（如西安钟楼 9.1km），于是全部被判「对不上」
// 而永远修不了。本脚本换判据：**两家服务商对同一名称给出的坐标互相吻合（≤ CONFIRM_M）** 才认定
// 「真实位置确实在那里」，此时才覆盖；两家不一致或只有一家命中就保留原值并列入报告，交人工复核。
//
// 安全边界：只改 estimate 点；默认不写文件（需 --apply）；写入前逐条记录 before/after 漂移。

const fs = require('fs');
const path = require('path');

const CONFIRM_M = 300;        // 第一档：双源一致阈值（普通点）
const CONFIRM_M_SUBURB = 600; // 第一档远郊放宽（POI 中心定义差异更大）
const LOOSE_M = 1000;         // 第二档：双源一致阈值（仅当名称「完全相等」时才用）
const LOOSE_M_SUBURB = 1500;  // 第二档远郊
const MAX_MOVE_M = 20000;     // 只用高德时的位移上限：超过就当成同名异地，不落盘
// 第二档存在的理由：街区/道路型 POI（回民街、洒金桥）两家给的「中心」天然差几百米，但两边都离我们的
// 估算 9km 远——此时原值必错，取腾讯坐标远好于不修。名称必须完全相等，避免「同名异地」误修
// （乾陵/华山/法门寺这类在别处同名 POI 的点，正是靠这一条挡住的）。
const THROTTLE_MS = 400;   // 腾讯个人版 5 QPS：150ms 会偶发 status=121（提示写的是日配额，实为突发限流）

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hav = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
};
// 归一：去掉括号/间隔号后的后缀，去空白，转小写
const norm = s => String(s || '').replace(/[·（(【\[].*$/, '').replace(/\s+/g, '').toLowerCase();
const baseName = s => String(s || '').split(/[（(·]/)[0] || s;

async function tencentSearch(kw, city, key) {
  const url = 'https://apis.map.qq.com/ws/place/v1/search' +
    `?keyword=${encodeURIComponent(kw)}&boundary=${encodeURIComponent(`region(${city},0)`)}&page_size=10&page_index=1&key=${key}`;
  const j = await (await fetch(url)).json();
  if (j.status !== 0) throw new Error(`腾讯 status=${j.status} ${j.message || ''}`);
  return (j.data || []).map(d => ({ title: d.title, coord: [d.location.lng, d.location.lat], id: d.id, addr: d.address || '', cat: d.category || '' }));
}
async function amapSearch(kw, city, key, nationwide) {
  const url = `https://restapi.amap.com/v3/place/text?keywords=${encodeURIComponent(kw)}&city=${encodeURIComponent(city)}&citylimit=${nationwide ? 'false' : 'true'}&offset=10&key=${key}`;
  const j = await (await fetch(url)).json();
  if (j.status !== '1') throw new Error(`高德 infocode=${j.infocode} ${j.info || ''}`);
  return (j.pois || []).map(p => {
    const [lng, lat] = String(p.location || '').split(',').map(Number);
    return { title: p.name, coord: [lng, lat], id: p.id, addr: p.address || '', cat: p.type || '' };
  }).filter(p => p.coord[0] && p.coord[1]);
}
// 只用高德时的名称判据（比双源模式更严）：必须完全相等，没有「互相包含」的余地
function pickExact(cands, name) {
  const names = [norm(name), norm(baseName(name))];
  for (const c of cands) if (names.includes(norm(c.title))) return { c, score: 0 };
  return null;
}

// 名称匹配：完全相等优先，其次互相包含
function pickMatch(cands, name) {
  const want = norm(name);
  let best = null;
  for (const c of cands) {
    const got = norm(c.title);
    const exact = got === want;
    const loose = got.includes(want) || want.includes(got);
    if (!exact && !loose) continue;
    const score = exact ? 0 : 1;
    if (!best || score < best.score) best = { c, score };
  }
  return best;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  const TK = process.env.TENCENT_WS_KEY, AK = process.env.AMAP_WS_KEY;
  const onlyAmap = args.includes('--provider') && args[args.indexOf('--provider') + 1] === 'amap';
  if (!file) { console.error('用法：node scripts/repair-coords.js <spots.json> [--dry-run|--apply] [--provider amap]'); process.exit(2); }
  if (!dryRun && !AK) { console.error('需要 AMAP_WS_KEY（双源模式还需 TENCENT_WS_KEY；干跑请加 --dry-run）'); process.exit(2); }
  if (!dryRun && !onlyAmap && !TK) { console.error('双源模式需要 TENCENT_WS_KEY，或改用 --provider amap（只用高德，额度更高）'); process.exit(2); }

  const abs = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const city = data._meta && data._meta.city;
  if (!city) { console.error('文件缺少 _meta.city'); process.exit(2); }

  const targets = data.spots.filter(s => s.coord_src === 'estimate');
  console.log(`${city}：${data.spots.length} 个点位，其中 estimate ${targets.length} 个待复核`);
  if (dryRun) { console.log('（干跑，不调 API、不写文件）'); return; }

  const today = new Date().toISOString().slice(0, 10);
  // 与既有报告合并：同一 id 以本次结果为准，历史条目保留（数据留痕不该被下一次运行冲掉）
  const reportPath0 = abs.replace(/\.json$/, '') + '.coord-repair-report.json';
  let prev = { fixed: [], skipped: [], errors: [] };
  try { prev = JSON.parse(fs.readFileSync(reportPath0, 'utf8')); } catch (e) {}
  const report = { city, date: today, runs: [...new Set([...(prev.runs || [prev.date]).filter(Boolean), today])], fixed: [], skipped: [], errors: [] };
  const mergeBy = (oldArr, newArr) => {
    const seen = new Set(newArr.map(x => x.id));
    return [...oldArr.filter(x => !seen.has(x.id)), ...newArr];
  };
  let n = 0;
  for (const spot of targets) {
    n++;
    await sleep(THROTTLE_MS);
    try {
      // ---- 只用高德（额度更高）：名称必须完全相等 + 候选离估算 ≤ MAX_MOVE_M ----
      if (onlyAmap) {
        let hit = pickExact(await amapSearch(spot.name, city, AK, false), spot.name);
        if (!hit) { await sleep(THROTTLE_MS); hit = pickExact(await amapSearch(baseName(spot.name), city, AK, false), spot.name); }
        if (!hit) { await sleep(THROTTLE_MS); hit = pickExact(await amapSearch(spot.name, city, AK, true), spot.name); }  // 全国兜底（华山/法门寺这类在邻市的点）
        const entry = { id: spot.id, name: spot.name, before: spot.coord.slice(), provider: 'amap' };
        if (!hit) {
          report.skipped.push({ ...entry, why: '高德未命中（含全国兜底）' });
          console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（高德未命中）`);
          continue;
        }
        const drift = Math.round(hav(spot.coord, hit.c.coord));
        entry.after = [+hit.c.coord[0].toFixed(6), +hit.c.coord[1].toFixed(6)];
        entry.drift_m = drift;
        entry.amap_poi_id = hit.c.id;
        entry.tier = 'amap-exact';
        if (drift > MAX_MOVE_M) {
          report.skipped.push({ ...entry, why: `候选离估算 ${drift}m > ${MAX_MOVE_M}m，疑似同名异地` });
          console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（高德候选离估算 ${drift}m，超 ${MAX_MOVE_M}m 上限）`);
          continue;
        }
        report.fixed.push(entry);
        if (apply) {
          spot.coord = entry.after;
          spot.coord_src = 'amap';
          spot.amap_poi_id = hit.c.id;
          spot.refreshed_at = report.date;
        }
        console.log(`  [${n}/${targets.length}] ${apply ? '修复' : '待修'} ${spot.name}：漂移 ${drift}m（高德·${hit.c.title}）`);
        continue;
      }
      const t = pickMatch(await tencentSearch(spot.name, city, TK), spot.name)
        || pickMatch(await tencentSearch(baseName(spot.name), city, TK), spot.name);
      await sleep(THROTTLE_MS);
      const a = pickMatch(await amapSearch(baseName(spot.name), city, AK), spot.name);
      const entry = { id: spot.id, name: spot.name, before: spot.coord.slice() };
      if (!t || !a) {
        report.skipped.push({ ...entry, why: !t && !a ? '双源均未命中' : (t ? '高德未命中' : '腾讯未命中') });
        console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（${!t && !a ? '双源未命中' : t ? '高德未命中' : '腾讯未命中'}）`);
        continue;
      }
      const agree = hav(t.c.coord, a.c.coord);
      const lim = spot.suburb ? CONFIRM_M_SUBURB : CONFIRM_M;
      const looseLim = spot.suburb ? LOOSE_M_SUBURB : LOOSE_M;
      const exactName = norm(t.c.title) === norm(spot.name) || norm(t.c.title) === norm(baseName(spot.name))
        || norm(a.c.title) === norm(spot.name) || norm(a.c.title) === norm(baseName(spot.name));
      let tier = 0;
      if (agree <= lim) tier = 1;
      else if (agree <= looseLim && exactName) tier = 2;
      if (!tier) {
        report.skipped.push({ ...entry, why: `双源不一致 ${Math.round(agree)}m`, tencent: t.c.coord, amap: a.c.coord });
        console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（双源相距 ${Math.round(agree)}m > ${lim}m，交人工复核）`);
        continue;
      }
      const drift = Math.round(hav(spot.coord, t.c.coord));
      entry.after = [+t.c.coord[0].toFixed(6), +t.c.coord[1].toFixed(6)];
      entry.drift_m = drift;
      entry.tencent_poi_id = t.c.id;
      entry.agree_m = Math.round(agree);
      entry.tier = tier;
      report.fixed.push(entry);
      if (apply) {
        spot.coord = entry.after;
        spot.coord_src = 'tencent';
        spot.tencent_poi_id = t.c.id;
        spot.refreshed_at = report.date;
      }
      console.log(`  [${n}/${targets.length}] ${apply ? '修复' : '待修'} ${spot.name}：漂移 ${drift}m（双源相距 ${Math.round(agree)}m）`);
    } catch (e) {
      report.errors.push({ id: spot.id, name: spot.name, err: String(e.message || e) });
      console.log(`  [${n}/${targets.length}] 错误 ${spot.name}：${e.message}`);
    }
  }

  if (apply) {
    data._meta.coord_repaired_at = report.date;
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  }
  report.fixed = mergeBy(prev.fixed || [], report.fixed);
  report.skipped = mergeBy(prev.skipped || [], report.skipped);
  report.errors = mergeBy(prev.errors || [], report.errors);
  const reportPath = reportPath0;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${apply ? '已写入' : '未写入（加 --apply 才落盘）'}：可修 ${report.fixed.length} / 跳过 ${report.skipped.length} / 错误 ${report.errors.length}`);
  console.log('报告：' + path.relative(process.cwd(), reportPath));
  const big = report.fixed.filter(f => f.drift_m > 3000);
  if (big.length) console.log('漂移 >3km 的点：' + big.map(b => b.name + '(' + (b.drift_m / 1000).toFixed(1) + 'km)').join('、'));
}

main().catch(e => { console.error(e); process.exit(1); });
