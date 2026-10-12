/* 自动生成：scripts/build-engine-bundle.js · 请勿手改（源在 engine/） */
window.__engineMods = {};
var __mods = window.__engineMods;
function __req(p) { if (!__mods[p]) throw new Error('engine module missing: ' + p); return __mods[p]; }

__mods["./geo"] = (function(module, exports, require) {
// 纯几何工具：距离、方位、聚类。无依赖，Node / 云函数 / 浏览器通用。

const EARTH_R = 6371000;

function pt(v) {
  return Array.isArray(v) ? { lng: v[0], lat: v[1] } : v;
}

function haversineM(a, b) {
  const p1 = pt(a), p2 = pt(b);
  const rad = Math.PI / 180;
  const dLat = (p2.lat - p1.lat) * rad;
  const dLng = (p2.lng - p1.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * rad) * Math.cos(p2.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

// 八分方位：从 from 看 to
function bearing8(from, to) {
  const f = pt(from), t = pt(to);
  if (haversineM(f, t) < 3000) return '城内';
  const rad = Math.PI / 180;
  const y = Math.sin((t.lng - f.lng) * rad) * Math.cos(t.lat * rad);
  const x = Math.cos(f.lat * rad) * Math.sin(t.lat * rad) -
    Math.sin(f.lat * rad) * Math.cos(t.lat * rad) * Math.cos((t.lng - f.lng) * rad);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return names[Math.round(deg / 45) % 8];
}

function centroid(points) {
  let lng = 0, lat = 0;
  for (const p of points) { const q = pt(p); lng += q.lng; lat += q.lat; }
  return { lng: lng / points.length, lat: lat / points.length };
}

// k-means（k-means++ 简化播种），points 元素需带 lng/lat 或 coord
function kmeans(points, k, iters = 12) {
  if (points.length <= k) return points.map(p => [p]);
  const seeds = [points[0]];
  while (seeds.length < k) {
    let best = null, bestD = -1;
    for (const p of points) {
      const d = Math.min(...seeds.map(s => haversineM(pt(p), pt(s))));
      if (d > bestD) { bestD = d; best = p; }
    }
    seeds.push(best);
  }
  let assign = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    points.forEach((p, i) => {
      let bi = 0, bd = Infinity;
      seeds.forEach((s, si) => {
        const d = haversineM(pt(p), pt(s));
        if (d < bd) { bd = d; bi = si; }
      });
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    });
    if (!moved) break;
    for (let si = 0; si < k; si++) {
      const members = points.filter((_, i) => assign[i] === si);
      if (members.length) seeds[si] = centroid(members);
    }
  }
  const out = Array.from({ length: k }, () => []);
  points.forEach((p, i) => out[assign[i]].push(p));
  return out.filter(g => g.length);
}

module.exports = { pt, haversineM, bearing8, centroid, kmeans };

return module.exports;
})({ exports: {} }, undefined, __req);

__mods["./copy"] = (function(module, exports, require) {
// 模板文案层：AI 文案的降级底座。所有输出可由本模块独立拼装，不依赖任何在线服务。

const THEME_MAP = {
  '博物馆': '文博', '古迹': '古迹', '山水': '山水', '古镇': '古镇',
  '街区': '街区', '公园': '公园', '商圈': '商圈', '美食': '美食',
  '演出': '演出', '亲子': '亲子', '夜景': '夜景',
};

function flagOf(spot) {
  if (spot.heat >= 9) return { text: '热门', tone: 'hot' };
  if (spot.heat < 8) return { text: '宝藏', tone: 'mint' };
  return null;
}

function buildReason(spot) {
  return spot.reason || spot.intro || '';
}

// dateISO 形如 'YYYY-MM-DD'
function buildNotice(spot, dateISO) {
  const isMon = new Date(dateISO + 'T12:00:00').getDay() === 1;
  if (spot.closed_mon === true && !isMon) return '周一闭馆，今天正常开放';
  if (spot.closed_mon === null || spot.closed_mon === undefined) {
    if (spot.cat === '博物馆') return '闭馆日未核实，建议出发前确认';
  }
  if (!spot.open) return '营业时间未核实，建议现场确认';
  return null;
}

// 日主题标签：方位 · 主题线（如「城西 · 文博线」）
function buildDayLabel(spots, origin, dirOf) {
  const catScore = {};
  for (const s of spots) {
    catScore[s.cat] = (catScore[s.cat] || 0) + (s.heat || 5);
  }
  const topCat = Object.entries(catScore).sort((a, b) => b[1] - a[1])[0][0];
  const theme = THEME_MAP[topCat] || '漫游';
  const dir = dirOf(spots);
  const allSuburb = spots.every(s => s.suburb);
  const prefix = allSuburb ? '远郊' : dir;
  return `${prefix} · ${theme}线`;
}

function mealHint(kind) {
  return kind === 'lunch' ? '午餐时间，弹性 1 小时' : '晚餐时间，弹性 1 小时';
}

function commuteText(c) {
  const km = c.km >= 1 ? `${c.km.toFixed(1)}km` : `${Math.round(c.km * 1000)}m`;
  const note = c.mode === 'transit' ? ' · 不含候车' : '';
  return `${c.label} · 约${c.min}分钟 · ${km}${note}`;
}

module.exports = { flagOf, buildReason, buildNotice, buildDayLabel, mealHint, commuteText };

return module.exports;
})({ exports: {} }, undefined, __req);

__mods["./index"] = (function(module, exports, require) {
// 点定旅途 · 路线引擎（纯 JS，无依赖）
// 排序永远由算法完成；本模块不调用任何外部 API，距离/时间在开发期为直线估算，
// 上线后由云函数侧以腾讯距离矩阵结果替换 estimateCommute 的输入。

const { pt, haversineM, bearing8, kmeans } = require('./geo');
const copy = require('./copy');

const DAY_START = 9 * 60;          // 明早 09:00 出发
const DAY_END = 19 * 60 + 30;      // 19:30 收束（最后一站游览结束上限）
const LUNCH = { from: 11 * 60 + 30, latest: 13 * 60, dur: 60 };
const DINNER = { from: 17 * 60 + 30, latest: 18 * 60 + 30, dur: 60 };
const MAX_STOPS_PER_DAY = 5;
const MAX_PER_CAT = 3;             // 粗筛分类多样性上限
const SUBURB_GROUP_RADIUS_M = 20000; // 远郊打包半径
const SUBURB_GROUP_MAX_MIN = 480;    // 远郊单日游览总时长上限

const DAY_COLORS = ['#3B7356', '#3E8E9E', '#B08A3E', '#7A9E43', '#8C6A4A'];

// ---------- 工具 ----------

function fmt(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function isMonday(iso) {
  return new Date(iso + 'T12:00:00').getDay() === 1;
}

function parseOpen(open) {
  if (!open) return null;
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(open);
  if (!m) return null;
  return [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]];
}

// 通勤估算（开发期直线 × 绕行系数；上线后由腾讯矩阵回填真实值）
// 速度分档：近距步行、城内公交、近郊驾车、远郊按城际（高速/铁路等效）估
function estimateCommute(a, b) {
  const km = haversineM(pt(a), pt(b)) / 1000 * 1.3;
  if (km < 1.5) return { mode: 'walk', label: '步行', km, min: Math.max(3, Math.round(km / 4.5 * 60)) };
  if (km < 15) return { mode: 'transit', label: '公交/地铁', km, min: Math.max(8, Math.round(km / 16 * 60 * 1.2)) };
  if (km < 60) return { mode: 'drive', label: '打车', km, min: Math.round(km / 32 * 60) };
  return { mode: 'drive', label: '打车/城际', km, min: Math.round(km / 45 * 60) };
}

// ---------- 粗筛 ----------

function selectCandidates(spots, days) {
  const city = [], suburb = [];
  for (const s of spots) (s.suburb ? suburb : city).push(s);

  const cap = days * MAX_STOPS_PER_DAY;
  const catCount = {};
  const cityPicked = [];
  for (const s of [...city].sort((a, b) => b.heat - a.heat)) {
    if (cityPicked.length >= cap) break;
    if ((catCount[s.cat] || 0) >= MAX_PER_CAT) continue;
    catCount[s.cat] = (catCount[s.cat] || 0) + 1;
    cityPicked.push(s);
  }

  const groups = [];
  for (const s of [...suburb].sort((a, b) => b.heat - a.heat)) {
    const g = groups.find(g =>
      haversineM(pt(g[0].coord), pt(s.coord)) <= SUBURB_GROUP_RADIUS_M &&
      g.reduce((t, x) => t + (x.dur || 90), 0) + (s.dur || 90) <= SUBURB_GROUP_MAX_MIN);
    if (g) g.push(s); else groups.push([s]);
  }
  const groupHeat = g => g.reduce((t, s) => t + s.heat, 0);
  groups.sort((a, b) => groupHeat(b) - groupHeat(a));

  // 远郊日数节制：1~2 日全留市区，3 日 1 个远郊日，5 日至多 3 个
  const suburbDayCount = Math.min(Math.max(days - 2, 0), 3);
  return { cityPicked, suburbGroups: groups.slice(0, suburbDayCount) };
}

// ---------- 分日 ----------

function planDays(candidates, days, anchorSpot) {
  const buckets = candidates.suburbGroups.map(g => ({ spots: g.slice(), pinned: null, suburb: true }));

  const remainDays = days - buckets.length;
  if (remainDays > 0 && candidates.cityPicked.length) {
    const pts = candidates.cityPicked.map(s => ({ spot: s, lng: pt(s.coord).lng, lat: pt(s.coord).lat }));
    for (const cluster of kmeans(pts, Math.min(remainDays, pts.length))) {
      buckets.push({ spots: cluster.map(p => p.spot), pinned: null, suburb: false });
    }
  }

  // 容量再平衡：单日游览总时长超 480 分钟，把最低热度点让给最近的同类桶；
  // 没有同类桶可接收的桶保持原样（超出的点交给时钟推演按「时间排不下」剔除，
  // 避免单日/单桶场景候选被提前清空）
  const overflow = [];
  const locked = new Set();
  for (let round = 0; round < 20; round++) {
    const over = buckets.find(b => !locked.has(b) &&
      b.spots.reduce((t, s) => t + (s.dur || 90), 0) > 480 && b.spots.length > 1);
    if (!over) break;
    const worst = [...over.spots].sort((a, b) => a.heat - b.heat)[0];
    let target = null, td = Infinity;
    for (const b of buckets) {
      if (b === over || b.suburb !== over.suburb) continue;
      const c = b.spots[0] ? pt(b.spots[0].coord) : null;
      if (!c) continue;
      const d = haversineM(pt(worst.coord), c);
      if (d < td) { td = d; target = b; }
    }
    if (target) {
      over.spots = over.spots.filter(s => s !== worst);
      target.spots.push(worst);
    } else {
      locked.add(over);
    }
  }

  // 起点命中库内景点：所在桶置顶并钉为第一日第 1 站；
  // 若不在任何桶内，并入最近的同类桶（避免锚点单独空转一天）
  if (anchorSpot) {
    let bucket = buckets.find(b => b.spots.some(s => s.id === anchorSpot.id));
    if (!bucket) {
      let bd = Infinity;
      for (const b of buckets) {
        if (b.suburb !== !!anchorSpot.suburb || !b.spots.length) continue;
        const d = Math.min(...b.spots.map(s => haversineM(pt(s.coord), pt(anchorSpot.coord))));
        if (d < bd) { bd = d; bucket = b; }
      }
      if (bucket) bucket.spots.push(anchorSpot);
      else {
        bucket = { spots: [anchorSpot], pinned: null, suburb: !!anchorSpot.suburb };
        buckets.push(bucket);
      }
    }
    bucket.pinned = anchorSpot.id;
    buckets.splice(buckets.indexOf(bucket), 1);
    buckets.unshift(bucket);
  }

  const heat = b => b.spots.reduce((t, s) => t + s.heat, 0);
  const [first, ...rest] = buckets;
  rest.sort((a, b) => heat(b) - heat(a));
  const ordered = anchorSpot ? [first, ...rest] : buckets.sort((a, b) => heat(b) - heat(a));
  const cut = ordered.slice(days);
  for (const b of cut) overflow.push(...b.spots);
  return { buckets: ordered.slice(0, days), overflow };
}

// ---------- 日内排序：贪心 + 2-opt ----------

function orderStops(spots, origin, pinnedId) {
  let pinned = null;
  let rest = spots.slice();
  if (pinnedId) {
    pinned = rest.find(s => s.id === pinnedId) || null;
    rest = rest.filter(s => s !== pinned);
  }
  const order = [];
  let cur = pinned ? pt(pinned.coord) : pt(origin);
  if (pinned) order.push(pinned);
  while (rest.length) {
    let bi = 0, bd = Infinity;
    rest.forEach((s, i) => {
      const d = haversineM(cur, pt(s.coord));
      if (d < bd) { bd = d; bi = i; }
    });
    const next = rest.splice(bi, 1)[0];
    order.push(next);
    cur = pt(next.coord);
  }
  return slotFix(twoOpt(order, origin, !!pinned), pinnedId);
}

// 时间槽修正：算法定序后只做解释性微调——
// 含「早去」标签的点尽量靠前，夜景/演出类尽量压尾（pinned 始终第 1 站不动）
function slotFix(order, pinnedId) {
  const isEarly = s => s.id !== pinnedId && (s.tags || []).some(t => /早去|赶早/.test(t));
  const isLate = s => s.id !== pinnedId &&
    (s.cat === '夜景' || s.cat === '演出' || (s.tags || []).some(t => /夜景|晚上/.test(t)));
  const early = order.filter(s => isEarly(s) && !isLate(s));
  const late = order.filter(isLate);
  const mid = order.filter(s => !early.includes(s) && !late.includes(s));
  mid.sort((a, b) => (a.id === pinnedId ? -1 : 0) - (b.id === pinnedId ? -1 : 0));
  return [...mid.filter(s => s.id === pinnedId), ...early, ...mid.filter(s => s.id !== pinnedId), ...late];
}

function twoOpt(order, origin, pinnedFirst) {
  if (order.length < 3) return order;
  const dist = (a, b) => haversineM(pt(a.coord ? a.coord : a), pt(b.coord ? b.coord : b));
  for (let iter = 0; iter < 30; iter++) {
    let improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      if (pinnedFirst && i === 0) continue;
      for (let j = i + 1; j < order.length; j++) {
        const a = i === 0 ? origin : order[i - 1];
        const b = order[i], c = order[j];
        const d = j + 1 < order.length ? order[j + 1] : origin;
        const delta = dist(a, b) + dist(c, d) - dist(a, c) - dist(b, d);
        if (delta > 50) {
          const seg = order.slice(i, j + 1).reverse();
          order.splice(i, seg.length, ...seg);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return order;
}

// ---------- 时钟推演 ----------

function simulateDay(bucket, origin, dateISO, startMin) {
  const monday = isMonday(dateISO);
  const stops = orderStops(
    bucket.spots.filter(s => !(monday && s.closed_mon === true)),
    origin, bucket.pinned);
  const dropped = bucket.spots.filter(s => monday && s.closed_mon === true)
    .map(s => ({ spot: s, cause: '周一闭馆' }));
  return runClock(stops, origin, dateISO, startMin, !!bucket.suburb, dropped);
}

// 微调重推演（上移/下移/删除/±15min/跨天移动后调用）：
// stops 为用户调整后的显式顺序（spot 原字段，可直接改 dur），
// 不重排序，只做全量时间校验与重算——排不下的站会进 dropped
function retimeDay(stops, origin, dateISO, opts = {}) {
  return runClock(stops, origin, dateISO, opts.startMin || DAY_START, !!opts.suburb, []);
}

// 时钟推演主循环：stops 为已确定顺序的站点数组
function runClock(stopsIn, origin, dateISO, startMin, suburb, dropped) {
  let stops = stopsIn.slice();
  // 远郊日收束放宽：游览可至 20:30，到家上限 21:45；市区日 19:30 / 21:00
  const dayEnd = suburb ? 20 * 60 + 30 : DAY_END;
  const homeLimit = suburb ? 21 * 60 + 45 : 21 * 60;

  let t = startMin;
  let pos = origin;
  let lunchDone = false, dinnerDone = false;
  const items = [{ type: 'start', time: fmt(t), name: origin.name, sub: '起点 · 结束后返回这里' }];
  let km = 0, commuteMin = 0, visitMin = 0;
  const placedStops = [];

  const pendingMeal = () => {
    if (!lunchDone && t >= LUNCH.from) {
      lunchDone = true;
      if (t <= LUNCH.latest) {
        items.push({ type: 'meal', kind: 'lunch', time: fmt(t), dur: LUNCH.dur, hint: copy.mealHint('lunch') });
        t += LUNCH.dur;
      }
    }
    if (!dinnerDone && t >= DINNER.from) {
      dinnerDone = true;
      if (t <= DINNER.latest) {
        items.push({ type: 'meal', kind: 'dinner', time: fmt(t), dur: DINNER.dur, hint: copy.mealHint('dinner') });
        t += DINNER.dur;
      }
    }
  };

  while (stops.length) {
    pendingMeal();
    let placed = false;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      const leg = estimateCommute(pos, pt(s.coord));
      let arr = t + leg.min;
      let dur = s.dur || 90;
      const win = parseOpen(s.open);
      if (win) {
        if (arr < win[0]) arr = win[0];          // 等开门
        if (arr + Math.min(dur, 60) > win[1]) continue; // 来不及入场，试下一个
        if (arr + dur > win[1]) {
          if (win[1] - arr >= 45) dur = win[1] - arr;   // 缩短游览至关门
          else continue;
        }
      }
      // 纯夜场（17:00 后才开放，如川剧演出）允许演到散场，不受日常收束限制
      const depLimit = (win && win[0] >= 17 * 60) ? win[1] : dayEnd;
      const dep = arr + dur;
      if (dep > depLimit) continue;              // 超收束时间，试下一个

      items.push({ type: 'commute', ...leg, text: copy.commuteText(leg) });
      const flag = copy.flagOf(s);
      const notice = copy.buildNotice(s, dateISO);
      // 餐食类站点落在用餐时段内，记为含餐，跳过独立餐槽
      if (s.cat === '美食') {
        if (!lunchDone && arr >= 11 * 60 && arr <= 13 * 60 + 30) lunchDone = true;
        if (!dinnerDone && arr >= 17 * 60) dinnerDone = true;
      }
      items.push({
        type: 'stop', id: s.id, name: s.name, cat: s.cat,
        arr: fmt(arr), dep: fmt(dep), dur,
        flag: flag ? flag.text : null, flagTone: flag ? flag.tone : null,
        reason: copy.buildReason(s), notice,
        coord: pt(s.coord),
      });
      km += leg.km; commuteMin += leg.min; visitMin += dur;
      t = dep; pos = pt(s.coord);
      placedStops.push({ itemIndex: items.length - 1, spot: s, leg, dur });
      stops.splice(i, 1);
      placed = true;
      break;
    }
    if (!placed) {
      for (const s of stops) dropped.push({ spot: s, cause: '时间排不下' });
      break;
    }
  }

  // 回程到达过晚：从末尾撤站重排（最多撤 2 站）
  for (let pop = 0; pop < 2 && placedStops.length; pop++) {
    const back = estimateCommute(pos, origin);
    if (t + back.min <= homeLimit) break;
    const last = placedStops.pop();
    dropped.push({ spot: last.spot, cause: '回程太晚' });
    // 回滚该站及其通勤的时间与里程
    t -= last.leg.min + last.dur;
    km -= last.leg.km; commuteMin -= last.leg.min; visitMin -= last.dur;
    items.splice(last.itemIndex - 1, 2);
    const prev = placedStops.length ? items[placedStops[placedStops.length - 1].itemIndex] : null;
    pos = prev ? prev.coord : origin;
  }

  const back = estimateCommute(pos, origin);
  items.push({ type: 'commute', ...back, text: copy.commuteText(back) });
  items.push({ type: 'end', time: fmt(t + back.min), name: `回到${origin.name}`, sub: '全程结束' });
  km += back.km; commuteMin += back.min;

  return { items, dropped, stats: { km: +km.toFixed(1), stops: items.filter(i => i.type === 'stop').length, visitMin, commuteMin } };
}

// ---------- 入口 ----------

// opts: { spots, origin:{name,lng,lat,spotId?}, days, startDate:'YYYY-MM-DD', startNow:false, nowMin }
function genRoute(opts) {
  const { spots, origin, days, startDate } = opts;
  const anchorSpot = origin.spotId ? spots.find(s => s.id === origin.spotId) || null : null;
  const candidates = selectCandidates(spots.filter(s => s !== anchorSpot), days);
  if (anchorSpot && anchorSpot.suburb) {
    // 远郊起点：并入所在分组
    const g = candidates.suburbGroups.find(g =>
      haversineM(pt(g[0].coord), pt(anchorSpot.coord)) <= SUBURB_GROUP_RADIUS_M);
    if (g && !g.includes(anchorSpot)) g.push(anchorSpot);
    else if (!g) candidates.suburbGroups.unshift([anchorSpot]);
  }
  const { buckets, overflow } = planDays(candidates, days, anchorSpot);

  const dayPlans = buckets.map((bucket, i) => {
    const dateISO = addDays(startDate, i);
    const startMin = (i === 0 && opts.startNow && opts.nowMin != null && opts.nowMin > DAY_START)
      ? opts.nowMin : DAY_START;
    const sim = simulateDay(bucket, origin, dateISO, startMin);
    const dirOf = ss => bearing8(origin, { lng: avg(ss, 'lng'), lat: avg(ss, 'lat') });
    return {
      day: i + 1,
      date: dateISO,
      color: DAY_COLORS[i % DAY_COLORS.length],
      label: copy.buildDayLabel(bucket.spots, origin, dirOf),
      startTime: fmt(startMin),
      ...sim,
    };
  });

  const totals = {
    km: +dayPlans.reduce((t, d) => t + d.stats.km, 0).toFixed(1),
    stops: dayPlans.reduce((t, d) => t + d.stats.stops, 0),
    visitMin: dayPlans.reduce((t, d) => t + d.stats.visitMin, 0),
    commuteMin: dayPlans.reduce((t, d) => t + d.stats.commuteMin, 0),
  };

  return {
    city: opts.city || null,
    days: dayPlans.length,
    startDate,
    origin: { name: origin.name, lng: pt(origin).lng, lat: pt(origin).lat, spotId: origin.spotId || null },
    dayPlans,
    totals,
    droppedAll: [
      ...dayPlans.flatMap(d => d.dropped.map(x => ({ day: d.day, ...x }))),
      ...overflow.map(s => ({ day: null, spot: s, cause: '候选溢出' })),
    ],
  };
}

function avg(spots, key) {
  return spots.reduce((t, s) => t + pt(s.coord)[key], 0) / Math.max(1, spots.length);
}

module.exports = { genRoute, retimeDay, estimateCommute, fmt, addDays, isMonday, DAY_START, DAY_END };

return module.exports;
})({ exports: {} }, undefined, __req);

window.Engine = __mods['./index'];
window.EngineGeo = __mods['./geo'];
window.EngineCopy = __mods['./copy'];
