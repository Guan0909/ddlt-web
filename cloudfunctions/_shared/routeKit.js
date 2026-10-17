'use strict';
// 路线套件：spots 加载 + 用腾讯距离矩阵/路径规划回填真实通勤（dist_cache 缓存优先）
// 配额红线：单次路线生成腾讯调用 ≤15 次。多日矩阵每天每模式 1 次 + 少量公交单段，
// 冷缓存下典型 3 日 ≈ 6~8 次；缓存命中时逼近 0。

const engine = require('./engine/index');
const lbs = require('./lbs');
const store = require('./store');

const CITY_FILES = {
  '成都': 'chengdu', '重庆': 'chongqing', '昆明': 'kunming', '大理': 'dali',
  '丽江': 'lijiang', '贵阳': 'guiyang', '拉萨': 'lhasa', '西双版纳': 'xishuangbanna',
  '香格里拉': 'xianggelila', '上海': 'shanghai', '杭州': 'hangzhou', '南京': 'nanjing',
  '苏州': 'suzhou', '无锡': 'wuxi', '扬州': 'yangzhou', '绍兴': 'shaoxing',
  '宁波': 'ningbo', '温州': 'wenzhou', '合肥': 'hefei', '黄山': 'huangshan',
  '厦门': 'xiamen', '福州': 'fuzhou', '泉州': 'quanzhou', '青岛': 'qingdao',
  '济南': 'jinan', '威海': 'weihai', '烟台': 'yantai', '婺源': 'wuyuan',
  '广州': 'guangzhou', '深圳': 'shenzhen', '珠海': 'zhuhai', '桂林': 'guilin',
  '北海': 'beihai', '三亚': 'sanya', '海口': 'haikou', '北京': 'beijing',
  '天津': 'tianjin', '大同': 'datong', '太原': 'taiyuan', '呼和浩特': 'huhehaote',
  '武汉': 'wuhan', '长沙': 'changsha', '郑州': 'zhengzhou', '洛阳': 'luoyang',
  '开封': 'kaifeng', '宜昌': 'yichang', '张家界': 'zhangjiajie', '凤凰': 'fenghuang',
  '西安': 'xian', '兰州': 'lanzhou', '西宁': 'xining', '敦煌': 'dunhuang',
  '张掖': 'zhangye', '乌鲁木齐': 'wulumuqi', '喀什': 'kashi', '银川': 'yinchuan',
  '哈尔滨': 'haerbin', '长春': 'changchun', '沈阳': 'shenyang', '大连': 'dalian',
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
  // froms 取「全部点」而非仅缺失腿的起点：同一次调用就能拿到全对时长，供日内排序再优化使用（不增加调用次数）
  for (const mode of ['walking', 'driving']) {
    const froms = missing[mode].size ? pts.map((_, i) => i) : [];
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

  const fn = (a, b) => {
    const cell = cells[`${keyOf(a)}>${keyOf(b)}`];
    if (!cell) return engine.estimateCommute(a, b);
    const label = cell.mode === 'walking' ? '步行'
      : cell.mode === 'transit' ? '公交/地铁'
      : cell.km >= 60 ? '打车/城际' : '打车';
    return { mode: cell.mode === 'walking' ? 'walk' : cell.mode === 'transit' ? 'transit' : 'drive', label, km: cell.km, min: cell.min };
  };
  // 供排序再优化读取「任意两点」的真实分钟（无数据的对回退引擎估算，口径一致）
  fn.minutes = (a, b) => fn(a, b).min;
  return fn;
}

// ---------- 日内排序再优化（真实路网时长） ----------
// 引擎的日内顺序用直线距离 + 2-opt 得到，再按「早去/夜景」标签分组（slotFix）。直线距离看不见
// 江河/立交/单行，真实路网时长可以。这里在**不打破 slotFix 分组**、**钉住当天第 1 站**的前提下，
// 用真实分钟做组内 2-opt；只有省得够多（≥5% 且 ≥3 分钟）才采用，否则保持引擎顺序。
const isEarlySpot = s => (s.tags || []).some(t => /早去|赶早/.test(t));
const isLateSpot = s => s.cat === '夜景' || s.cat === '演出' || (s.tags || []).some(t => /夜景|晚上/.test(t));
const ptOf = s => (s.coord ? { lng: s.coord[0], lat: s.coord[1] } : { lng: s.lng, lat: s.lat });

function slotGroups(stops) {
  const groups = [];
  for (const s of stops) {
    const cls = isEarlySpot(s) && !isLateSpot(s) ? 'early' : isLateSpot(s) ? 'late' : 'mid';
    const last = groups[groups.length - 1];
    if (last && last.cls === cls) last.items.push(s); else groups.push({ cls, items: [s] });
  }
  return groups;
}
// 组内 2-opt：prev/next 是组两端的锚点（保证跨界不改），顺序为开放的「环线段」
function twoOptByMinutes(items, prev, next, mins) {
  const arr = items.slice();
  const at = i => (i < 0 ? prev : i >= arr.length ? next : arr[i]);
  for (let iter = 0; iter < 20; iter++) {
    let improved = false;
    for (let i = 0; i < arr.length - 1; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = at(i - 1), b = at(i), c = at(j), d = at(j + 1);
        if (!a || !d) continue;
        if (mins(a, b) + mins(c, d) - mins(a, c) - mins(b, d) > 1) {
          const seg = arr.slice(i, j + 1).reverse();
          arr.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return arr;
}
function loopMinutes(order, origin, mins) {
  let total = 0, prev = origin;
  for (const s of order) { total += mins(prev, s); prev = s; }
  return total + mins(prev, origin);   // 环线口径：含回起点（与引擎目标一致）
}
function reorderByRealMinutes(stops, origin, commute) {
  if (stops.length < 3) return stops;
  const mins = (a, b) => commute.minutes(ptOf(a), ptOf(b));
  const before = loopMinutes(stops, origin, mins);
  const groups = slotGroups(stops);
  const out = [];
  groups.forEach((g, gi) => {
    const prev = gi === 0 ? origin : groups[gi - 1].items[groups[gi - 1].items.length - 1];
    const next = gi === groups.length - 1 ? origin : groups[gi + 1].items[0];
    if (gi === 0 && g.items.length > 2) {
      const head = g.items[0];   // 钉住当天第 1 站（D1 锚点规则）
      out.push(head, ...twoOptByMinutes(g.items.slice(1), head, next, mins));
    } else {
      out.push(...twoOptByMinutes(g.items, prev, next, mins));
    }
  });
  const after = loopMinutes(out, origin, mins);
  if (before - after >= 3 && after <= before * 0.95) return out;
  return stops;
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
    const ordered = reorderByRealMinutes(stopObjs, route.origin, commute);   // 真实时长再优化（带守卫）
    const sim = engine.retimeDay(ordered, route.origin, dp.date, {
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

module.exports = { loadSpots, refineWithRealCommute, buildCommuteFn, CITY_FILES, validOrigin,
  // 以下导出供本地回归直接验证排序再优化（云函数入口不受影响）
  reorderByRealMinutes, slotGroups, twoOptByMinutes, loopMinutes };
