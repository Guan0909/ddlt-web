'use strict';
// 路线套件：spots 加载 + 用腾讯距离矩阵/路径规划回填真实通勤（dist_cache 缓存优先）
// 配额红线：单次路线生成腾讯调用 ≤15 次。多日矩阵每天每模式 1 次 + 少量公交单段，
// 冷缓存下典型 3 日 ≈ 6~8 次；缓存命中时逼近 0。

const engine = require('./engine/index');
const lbs = require('./lbs');
const store = require('./store');

const CITY_FILES = {
  '成都': 'chengdu', '北京': 'beijing', '重庆': 'chongqing',
  '杭州': 'hangzhou', '上海': 'shanghai', '西安': 'xian',
};

// 起点必须是有效的经纬度对：旧版云函数只校验 lng，lat 缺失或越界会让引擎算出 NaN 时刻表
function validOrigin(o) {
  if (!o) return false;
  const lng = +o.lng, lat = +o.lat;
  return Number.isFinite(lng) && Number.isFinite(lat) &&
    lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

function loadSpots(city) {
  const f = CITY_FILES[city];
  if (!f) return null;
  return require(`./data/${f}.json`).spots;
}

const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const keyOf = p => `${(+p.lng).toFixed(5)},${(+p.lat).toFixed(5)}`;
const straightKm = (a, b) => engine.estimateCommute(a, b).km;

// 为一天的有序站点构建真实通勤函数（同步返回，供引擎 runClock 逐腿查询）
async function buildCommuteFn(origin, stopObjs, suburb) {
  const pts = [origin, ...stopObjs.map(s => ({ lng: s.coord[0], lat: s.coord[1] }))];
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) legs.push([i, i + 1]);
  legs.push([pts.length - 1, 0]);  // 回程

  // 逐腿定模式（直线距离启发，与引擎估算一致）
  const legMode = ([fi, ti]) => {
    const km = straightKm(pts[fi], pts[ti]);
    return km < 1.5 ? 'walking' : km < 15 ? 'transit' : 'driving';
  };
  const toIdOf = ti => (ti === 0 ? '__origin__' : stopObjs[ti - 1].id);

  const cells = {};   // 'fromKey>toKey' => {km, min, mode}
  const missing = { walking: new Set(), driving: new Set(), transit: [] };

  for (const leg of legs) {
    const [fi, ti] = leg;
    const mode = legMode(leg);
    const cached = await store.cacheGet(pts[fi].lng, pts[fi].lat, toIdOf(ti), mode);
    if (cached) cells[`${keyOf(pts[fi])}>${keyOf(pts[ti])}`] = { ...cached, mode };
    else if (mode === 'transit') missing.transit.push(leg);
    else missing[mode].add(fi);
  }

  // 批量矩阵补齐步行/驾车缺失段（每模式 1 次调用，顺带把全矩阵写进缓存）
  for (const mode of ['walking', 'driving']) {
    const froms = [...missing[mode]];
    if (!froms.length) continue;
    if (!(await store.tencentBudget(1))) break;
    try {
      const m = await lbs.matrix(froms.map(i => pts[i]), pts, mode);
      let k = 0;
      for (const fi of froms) {
        for (let ti = 0; ti < pts.length; ti++) {
          const cell = m[`${k}>${ti}`];
          if (!cell) continue;
          const toId = toIdOf(ti);
          await store.cachePut(pts[fi].lng, pts[fi].lat, toId, mode, cell.km, cell.min);
          cells[`${keyOf(pts[fi])}>${keyOf(pts[ti])}`] = { ...cell, mode };
        }
        k++;
      }
    } catch (e) { /* 矩阵失败 → 回退估算 */ }
  }

  // 公交段逐段路径规划（矩阵无 transit 模式）
  for (const [fi, ti] of missing.transit) {
    if (!(await store.tencentBudget(1))) break;
    try {
      const r = await lbs.direction(pts[fi], pts[ti], 'transit');
      await store.cachePut(pts[fi].lng, pts[fi].lat, toIdOf(ti), 'transit', r.km, r.min);
      cells[`${keyOf(pts[fi])}>${keyOf(pts[ti])}`] = { km: r.km, min: r.min, mode: 'transit' };
    } catch (e) { /* 单段失败 → 回退估算 */ }
  }

  return (a, b) => {
    const cell = cells[`${keyOf(a)}>${keyOf(b)}`];
    if (!cell) return engine.estimateCommute(a, b);
    const label = cell.mode === 'walking' ? '步行'
      : cell.mode === 'transit' ? '公交/地铁'
      : cell.km >= 60 ? '打车/城际' : '打车';
    return { mode: cell.mode === 'walking' ? 'walk' : cell.mode === 'transit' ? 'transit' : 'drive', label, km: cell.km, min: cell.min };
  };
}

// 用真实通勤重排已生成路线的每一天（retimeDay 强制全量重校验）
async function refineWithRealCommute(route, spots) {
  const spotById = Object.fromEntries(spots.map(s => [s.id, s]));
  for (const dp of route.dayPlans) {
    const ids = dp.items.filter(i => i.type === 'stop').map(i => i.id);
    const stopObjs = ids.map(id => spotById[id]).filter(Boolean);
    if (!stopObjs.length) continue;
    const suburb = stopObjs.every(s => s.suburb);
    const commute = await buildCommuteFn(route.origin, stopObjs, suburb);
    const sim = engine.retimeDay(stopObjs, route.origin, dp.date, {
      suburb, startMin: toMin(dp.startTime), commute,
    });
    dp.items = sim.items;
    dp.dropped = sim.dropped;
    dp.stats = sim.stats;
  }
  route.totals = {
    km: +route.dayPlans.reduce((t, d) => t + d.stats.km, 0).toFixed(1),
    stops: route.dayPlans.reduce((t, d) => t + d.stats.stops, 0),
    visitMin: route.dayPlans.reduce((t, d) => t + d.stats.visitMin, 0),
    commuteMin: route.dayPlans.reduce((t, d) => t + d.stats.commuteMin, 0),
  };
  return route;
}

module.exports = { loadSpots, refineWithRealCommute, buildCommuteFn, CITY_FILES, validOrigin };
