'use strict';
// 点定旅途 · 路线引擎（纯 JS，无依赖）
// 排序永远由算法完成；本模块不调用任何外部 API，距离/时间在开发期为直线估算，
// 上线后由云函数侧以腾讯距离矩阵结果替换 estimateCommute 的输入。

const { pt, haversineM, bearing8, kmeans } = require('./geo');
const copy = require('./copy');

const DAY_START = 9 * 60;          // 明早 09:00 出发
const DAY_END = 19 * 60 + 30;      // 19:30 收束（最后一站游览结束上限）
const LUNCH = { from: 11 * 60 + 30, latest: 13 * 60, dur: 60 };
const DINNER = { from: 17 * 60 + 30, latest: 18 * 60 + 30, dur: 60 };
const MAX_STOPS_PER_DAY = 8;        // 每日站数上限：按可用时间自然收敛（不再卡 3~5 站）
const MAX_PER_CAT = 4;             // 粗筛分类多样性上限（放宽以支持「一天多玩几处」）
const START_MIN_EARLIEST = 5 * 60;  // 可选择的最早出发时间
const START_MIN_LATEST = 16 * 60;   // 可选择的最晚出发时间
const SUBURB_GROUP_RADIUS_M = 25000; // 远郊打包半径（与数据 schema 口径一致）
const SUBURB_GROUP_MAX_MIN = 480;    // 远郊单日游览总时长上限
const TOO_FAR_ONEWAY_MIN = 165;      // 单程估时上限：超过视为当天往返不现实
const VALIDATE_NEAR_M = 30000;       // 起点校验：最近景点超过 30km → 起点太偏
const VALIDATE_RANGE_M = 60000;      // 起点校验：60km 内可用景点数 ≤ 天数 → 不够分配

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

  // 远郊打包：量到组内最近成员（而非组首），避免顺序敏感与超长假组
  const groups = [];
  for (const s of [...suburb].sort((a, b) => b.heat - a.heat)) {
    const g = groups.find(g =>
      Math.min(...g.map(x => haversineM(pt(x.coord), pt(s.coord)))) <= SUBURB_GROUP_RADIUS_M &&
      g.reduce((t, x) => t + (x.dur || 90), 0) + (s.dur || 90) <= SUBURB_GROUP_MAX_MIN);
    if (g) g.push(s); else groups.push([s]);
  }
  // 组排序取组内最高热度：单点高热度远郊不应被规模大的组挤掉
  const groupHeat = g => Math.max(...g.map(s => s.heat));
  groups.sort((a, b) => groupHeat(b) - groupHeat(a));

  // 远郊日数节制：1~2 日全留市区，3 日 1 个远郊日，5 日至多 3 个
  const suburbDayCount = Math.min(Math.max(days - 2, 0), 3);
  const keptGroups = groups.slice(0, suburbDayCount);

  // 城内候选上限：days×5。不要按「实际市区日数」缩——候选收紧会让稀疏方向的点（如熊猫基地）
  // 无法单独成簇，被并进锚点所在的市区日，打乱「一日一区域」的分日质量
  const cap = days * MAX_STOPS_PER_DAY;
  const catCount = {};
  const cityPicked = [];
  for (const s of [...city].sort((a, b) => b.heat - a.heat)) {
    if (cityPicked.length >= cap) break;
    if ((catCount[s.cat] || 0) >= MAX_PER_CAT) continue;
    catCount[s.cat] = (catCount[s.cat] || 0) + 1;
    cityPicked.push(s);
  }

  return { cityPicked, suburbGroups: keptGroups };
}

// ---------- 分日 ----------

function planDays(candidates, days, anchorSpot, opts) {
  const cityVisitCap = (opts && opts.cityVisitCap) || 480;
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
      b.spots.reduce((t, s) => t + (s.dur || 90), 0) > (b.suburb ? SUBURB_GROUP_MAX_MIN : cityVisitCap) && b.spots.length > 1);
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

// ---------- 日内排序：贪心 + 2-opt（带线段交叉惩罚） ----------

// 平面近似坐标（米）：用于交叉判定与距离代价
function flatXY(p, lat0) {
  const k = Math.cos((lat0 || p.lat) * Math.PI / 180) * 111320;
  return { x: p.lng * k, y: p.lat * 111320 };
}
function segsCross(a, b, c, d) {
  const d1 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d2 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
  const d3 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
  const d4 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
// 路线代价 = 直线总距离 + 交叉惩罚（一段交叉约等于 600m 绕路）+ 折返惩罚
const CROSS_PENALTY_M = 600;
function routeCostOf(order, origin) {
  const lat0 = origin.lat;
  const pts = [flatXY({ lat: origin.lat, lng: origin.lng }, lat0)].concat(order.map(s => {
    const c = s.coord;
    return flatXY({ lat: Array.isArray(c) ? c[1] : c.lat, lng: Array.isArray(c) ? c[0] : c.lng }, lat0);
  }));
  let dist = 0, crossings = 0, backTracks = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    dist += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (i >= 2) {
      // 折返：连续两段夹角接近 180°
      const ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y;
      const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
      if (cos < -0.82) backTracks++;
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (segsCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) crossings++;
    }
  }
  return dist + crossings * CROSS_PENALTY_M + backTracks * 350;
}

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
  return slotFix(twoOpt(order, origin, !!pinned), origin, pinnedId);
}

// 时间槽修正：算法定序后只做解释性微调——
// 含「早去」标签的点尽量靠前，夜景/演出类尽量压尾（pinned 始终第 1 站不动）
function slotFix(order, origin, pinnedId) {
  const isEarly = s => s.id !== pinnedId && (s.tags || []).some(t => /早去|赶早/.test(t));
  // 只有「真的只能晚上去」的项目才强制压尾（夜游船/夜市/演出/夜景类）；
  // 「夜景」只是推荐词（如湖滨步行街、商圈），不能因此把顺路的点甩到最后。
  const isLate = s => s.id !== pinnedId &&
    (s.cat === '夜景' || s.cat === '演出' ||
      (s.tags || []).some(t => /夜游|夜市|看演出|灯光秀/.test(t)));
  const early = order.filter(s => isEarly(s) && !isLate(s));
  const late = order.filter(isLate);
  const mid = order.filter(s => !early.includes(s) && !late.includes(s));
  if (!early.length && !late.length) return order;
  const pinned = mid.find(s => s.id === pinnedId) || null;
  const mids = mid.filter(s => s.id !== pinnedId);
  // 时段优先的顺序：pinned → mid → early（早去靠前）→ late（夜景压尾）
  const slotOrder = [...(pinned ? [pinned] : []), ...early, ...mids, ...late];
  const baseCost = routeCostOf(order, origin);
  const slotCost = routeCostOf(slotOrder, origin);
  // 软约束：强行按标签排若绕路/交叉代价明显变差（>8%），保留空间更顺的顺序
  if (slotCost > baseCost * 1.08) return order;
  return slotOrder;
}

function twoOpt(order, origin, pinnedFirst) {
  if (order.length < 3) return order.slice();
  let best = order.slice();
  let bestCost = routeCostOf(best, origin);
  for (let iter = 0; iter < 40; iter++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      if (pinnedFirst && i === 0) continue;
      for (let j = i + 1; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const c = routeCostOf(cand, origin);
        if (c < bestCost - 5) { best = cand; bestCost = c; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

// ---------- 时钟推演 ----------

function simulateDay(bucket, origin, dateISO, startMin, commute) {
  const monday = isMonday(dateISO);
  const stops = orderStops(
    bucket.spots.filter(s => !(monday && s.closed_mon === true)),
    origin, bucket.pinned);
  const dropped = bucket.spots.filter(s => monday && s.closed_mon === true)
    .map(s => ({ spot: s, cause: '周一闭馆' }));
  return runClock(stops, origin, dateISO, startMin, !!bucket.suburb, dropped, commute);
}

// 微调重推演（上移/下移/删除/±15min/跨天移动后调用）：
// stops 为用户调整后的显式顺序（spot 原字段，可直接改 dur），
// 不重排序，只做全量时间校验与重算——排不下的站会进 dropped
// opts.commute：可选通勤函数 (a, b) => {mode, label, km, min}，默认直线估算
function retimeDay(stops, origin, dateISO, opts = {}) {
  return runClock(stops, origin, dateISO, opts.startMin || DAY_START, !!opts.suburb, [], opts.commute);
}

// 时钟推演主循环：stops 为已确定顺序的站点数组
function runClock(stopsIn, origin, dateISO, startMin, suburb, dropped, commute) {
  commute = commute || estimateCommute;
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
      const leg = commute(pos, pt(s.coord));
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
    const back = commute(pos, origin);
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

  const back = commute(pos, origin);
  items.push({ type: 'commute', ...back, text: copy.commuteText(back) });
  items.push({ type: 'end', time: fmt(t + back.min), name: `回到${origin.name}`, sub: '全程结束' });
  km += back.km; commuteMin += back.min;

  return { items, dropped, stats: { km: +km.toFixed(1), stops: items.filter(i => i.type === 'stop').length, visitMin, commuteMin } };
}

// ---------- 入口 ----------

// opts: { spots, origin:{name,lng,lat,spotId?}, days, startDate:'YYYY-MM-DD', startNow:false, nowMin, startMin }
function clampStartMin(v) {
  if (v == null || v === '' || !isFinite(Number(v))) return null;   // 注意 Number(null)=0，必须先判空
  const n = Math.round(Number(v));
  return Math.max(START_MIN_EARLIEST, Math.min(START_MIN_LATEST, n));
}
function genRoute(opts) {
  const { spots, origin, days, startDate } = opts;
  // 第一天出发时间：优先 opts.startMin（用户点选），其次兼容旧「现在就走」nowMin，默认 09:00
  const chosenStart = clampStartMin(opts.startMin) != null
    ? clampStartMin(opts.startMin)
    : (opts.startNow && Number.isFinite(opts.nowMin) ? clampStartMin(opts.nowMin) : DAY_START);
  let anchorSpot = origin.spotId ? spots.find(s => s.id === origin.spotId) || null : null;
  // 锚点 D1 闭馆（如周一闭馆的博物馆）：降级为普通候选，起点仅作坐标，
  // 该点由闭馆迁移挪到后续开放日，不再钉死 D1 第 1 站
  if (anchorSpot && anchorSpot.closed_mon === true && isMonday(startDate)) anchorSpot = null;

  // 超远远郊排除：单程估时超上限的点当天往返不现实，直接不入选（进未排入清单并明示）
  const tooFar = [], usable = [];
  for (const s of spots) {
    if (anchorSpot && s.id === anchorSpot.id) continue;
    if (estimateCommute(origin, pt(s.coord)).min > TOO_FAR_ONEWAY_MIN) tooFar.push(s);
    else usable.push(s);
  }
  // 单日游览容量：随出发时间动态放宽（早出发 → 一天能排更多站），上限 660 分钟
  // 单日游览容量：早出发放宽到 720，晚出发仍保留 480（由时钟按实际时间剔除，避免桶被提前掏空）
  const cityVisitCap = Math.max(480, Math.min(720, (DAY_END - chosenStart) - 60));
  const candidates = selectCandidates(usable, days);

  if (anchorSpot && anchorSpot.suburb) {
    // 远郊起点：并入最近成员可达的分组；落单则与最近的城内候选拼成一日，避免一日一站
    const g = candidates.suburbGroups.find(g =>
      Math.min(...g.map(x => haversineM(pt(x.coord), pt(anchorSpot.coord)))) <= SUBURB_GROUP_RADIUS_M);
    if (g && !g.includes(anchorSpot)) g.push(anchorSpot);
    else if (!g) {
      const merged = [anchorSpot];
      let sumMin = anchorSpot.dur || 90;
      const used = [];
      for (const s of [...candidates.cityPicked].sort((a, b) =>
        haversineM(pt(a.coord), pt(anchorSpot.coord)) - haversineM(pt(b.coord), pt(anchorSpot.coord)))) {
        if (merged.length >= MAX_STOPS_PER_DAY) break;
        if (sumMin + (s.dur || 90) > SUBURB_GROUP_MAX_MIN) continue;
        merged.push(s); used.push(s); sumMin += s.dur || 90;
      }
      candidates.cityPicked = candidates.cityPicked.filter(s => !used.includes(s));
      candidates.suburbGroups.unshift(merged);
    }
  }
  const { buckets, overflow } = planDays(candidates, days, anchorSpot, { cityVisitCap });

  // 周一闭馆点前向迁移：挪到后续同类型日（容量允许），挪不动的留给时钟推演上报
  for (let i = 0; i < buckets.length; i++) {
    if (!isMonday(addDays(startDate, i))) continue;
    for (const s of [...buckets[i].spots]) {
      if (s.closed_mon !== true || s.id === buckets[i].pinned) continue;
      for (let j = i + 1; j < buckets.length; j++) {
        if (buckets[j].suburb !== buckets[i].suburb) continue;
        // 容量阈值：远郊日 480（通勤长）；市区日放宽到 540——排不下由 runClock 裁最低价值点，
        // 好过整点丢失一个高热度博物馆
        const capMin = buckets[j].suburb ? SUBURB_GROUP_MAX_MIN : cityVisitCap;
        const sumMin = buckets[j].spots.reduce((t, x) => t + (x.dur || 90), 0);
        if (sumMin + (s.dur || 90) > capMin) continue;
        buckets[j].spots.push(s);
        buckets[i].spots = buckets[i].spots.filter(x => x !== s);
        break;
      }
    }
  }

  // 逐日推演 + 空日保护：0 站的日先用当日被裁点中热度最高者单点重试；
  // 仍为空则移除该日——日期前移会改变周一口径，幸存日按新日期重推演（最多 3 轮收敛）
  const emptyDropped = [];
  let pairs = buckets.map(bucket => ({ bucket, sim: null, dateISO: null, startMin: DAY_START }));
  for (let round = 0; round < 3; round++) {
    pairs.forEach((p, i) => {
      const dateISO = addDays(startDate, i);
      const startMin = (i === 0 && chosenStart != null) ? chosenStart : DAY_START;
      let sim = simulateDay(p.bucket, origin, dateISO, startMin, opts.commute);
      if (sim.stats.stops === 0) {
        const best = sim.dropped.filter(d => d.cause !== '周一闭馆').map(d => d.spot)
          .sort((a, b) => b.heat - a.heat)[0];
        if (best) {
          const retry = runClock([best], origin, dateISO, startMin, !!p.bucket.suburb, [], opts.commute);
          if (retry.stats.stops > 0) {
            sim = { ...retry, dropped: [...sim.dropped.filter(d => d.spot !== best), ...retry.dropped] };
          }
        }
      }
      p.sim = sim; p.dateISO = dateISO; p.startMin = startMin;
    });
    const before = pairs.length;
    emptyDropped.push(...pairs.filter(p => p.sim.stats.stops === 0).flatMap(p => p.sim.dropped));
    pairs = pairs.filter(p => p.sim.stats.stops > 0);
    if (pairs.length === before) break;
  }

  const dayPlans = pairs.map((p, i) => {
    const dirOf = ss => bearing8(origin, { lng: avg(ss, 'lng'), lat: avg(ss, 'lat') });
    return {
      day: i + 1,
      date: p.dateISO,
      color: DAY_COLORS[i % DAY_COLORS.length],
      label: copy.buildDayLabel(p.bucket.spots, origin, dirOf),
      startTime: fmt(p.startMin),
      ...p.sim,
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
      ...emptyDropped.map(x => ({ day: null, ...x })),
      ...tooFar.map(s => ({ day: null, spot: s, cause: '太远，当天往返不现实' })),
      ...overflow.map(s => ({ day: null, spot: s, cause: '候选溢出' })),
    ],
  };
}

function avg(spots, key) {
  return spots.reduce((t, s) => t + pt(s.coord)[key], 0) / Math.max(1, spots.length);
}

// 输入校验（云函数与浏览器 bundle 同源共用，杜绝两端口径漂移）：
// ORIGIN_TOO_FAR —— 最近景点超过 30km，起点太偏；
// NOT_ENOUGH_SPOTS —— 起点 60km 内可用景点数 ≤ 游玩天数，不够分配
function validateInputs(spots, origin, days) {
  const o = pt(origin);
  const dists = (spots || []).filter(s => s && s.coord).map(s => haversineM(pt(s.coord), o));
  if (!dists.length) {
    return { ok: false, code: 'SPOTS_EMPTY', message: '这座城市的数据还没准备好，换座城市试试。' };
  }
  const nearest = Math.min(...dists);
  if (nearest > VALIDATE_NEAR_M) {
    return {
      ok: false, code: 'ORIGIN_TOO_FAR',
      message: `这个起点离可玩的地方有点远（最近景点约 ${Math.round(nearest / 1000)} 公里）。换个起点试试。`,
    };
  }
  const inRange = dists.filter(d => d <= VALIDATE_RANGE_M).length;
  if (inRange <= days) {
    return {
      ok: false, code: 'NOT_ENOUGH_SPOTS',
      message: `这里目前收录了 ${inRange} 个景点，排不满 ${days} 天。减少天数，或换座城市。`,
    };
  }
  return { ok: true };
}

module.exports = { genRoute, retimeDay, validateInputs, estimateCommute, fmt, addDays, isMonday, DAY_START, DAY_END };
