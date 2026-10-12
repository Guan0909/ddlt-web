'use strict';
// 引擎验证脚本：node engine/test.js
// 用成都真实数据跑多组场景，打印完整时间轴并做约束校验（人工校验闸口）。

const path = require('path');
const data = require(path.join(__dirname, '..', 'data', 'spots', 'chengdu.json'));
const { genRoute, retimeDay, estimateCommute, addDays, isMonday } = require('./index');
const { pt, haversineM } = require('./geo');

const spots = data.spots;
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

// ---------- 校验器 ----------
function validate(route, opts) {
  const errors = [];
  const spotById = Object.fromEntries((opts.spots || spots).map(s => [s.id, s]));

  if (route.dayPlans.length !== opts.days) {
    errors.push(`天数不符：期望 ${opts.days}，实际 ${route.dayPlans.length}`);
  }

  route.dayPlans.forEach(day => {
    const stops = day.items.filter(i => i.type === 'stop');
    // 与引擎一致：整日为远郊点时收束放宽至 20:30
    const daySuburb = stops.length > 0 && stops.every(i => spotById[i.id].suburb);
    const dayEndLimit = daySuburb ? 20 * 60 + 30 : 19 * 60 + 30;
    let prevEnd = toMin(day.startTime);

    for (const it of day.items) {
      if (it.type === 'meal') {
        const start = toMin(it.time);
        if (start < prevEnd) errors.push(`D${day.day} 用餐槽重叠：${it.time} < ${fmtM(prevEnd)}`);
        prevEnd = start + it.dur;
      }
      if (it.type === 'stop') {
        const s = spotById[it.id];
        const arr = toMin(it.arr), dep = toMin(it.dep);
        if (arr < prevEnd) errors.push(`D${day.day} 时间重叠：${it.name} 到达 ${it.arr} 早于上一段结束 ${fmtM(prevEnd)}`);
        if (dep <= arr) errors.push(`D${day.day} 时长非法：${it.name}`);
        // 营业时间硬约束
        if (s.open) {
          const [os, oe] = s.open.split('-').map(toMin);
          if (arr < os) errors.push(`D${day.day} 早于开门：${it.name} ${it.arr} < ${s.open.split('-')[0]}`);
          if (dep > oe) errors.push(`D${day.day} 晚于关门：${it.name} ${it.dep} > ${s.open.split('-')[1]}`);
        }
        // 周一闭馆
        if (isMonday(day.date) && s.closed_mon === true) {
          errors.push(`D${day.day} 周一闭馆仍被排入：${it.name}（${day.date}）`);
        }
        // 收束时间
        if (dep > dayEndLimit) errors.push(`D${day.day} 超过收束：${it.name} 结束于 ${it.dep}（上限 ${fmtM(dayEndLimit)}）`);
        prevEnd = dep;
      }
    }

    // 远郊不与市区混日
    const hasSuburb = stops.some(i => spotById[i.id].suburb);
    const hasCity = stops.some(i => !spotById[i.id].suburb);
    if (hasSuburb && hasCity) {
      // 允许 25km 内的近郊混排，否则报错
      for (const a of stops) for (const b of stops) {
        if (spotById[a.id].suburb !== spotById[b.id].suburb &&
            haversineM(pt(spotById[a.id].coord), pt(spotById[b.id].coord)) > 25000) {
          errors.push(`D${day.day} 远郊与市区混日：${a.name} / ${b.name}`);
        }
      }
    }
  });

  // 起点命中景点须为 D1 第 1 站
  if (opts.origin.spotId) {
    const first = route.dayPlans[0].items.find(i => i.type === 'stop');
    if (!first || first.id !== opts.origin.spotId) {
      errors.push(`锚点景点未成为 D1 第 1 站（实际：${first ? first.name : '无'}）`);
    }
  }

  return errors;
}

function fmtM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ---------- 打印 ----------
function printRoute(route) {
  console.log(`\n${'='.repeat(58)}`);
  console.log(`起点：${route.origin.name} ｜ ${route.days} 日 ｜ 起始 ${route.startDate}`);
  console.log(`总计：${route.totals.km}km · ${route.totals.stops} 站 · 游览 ${Math.round(route.totals.visitMin / 60)}h · 通勤 ${(route.totals.commuteMin / 60).toFixed(1)}h`);
  for (const day of route.dayPlans) {
    console.log(`\n── D${day.day} ${day.date}${isMonday(day.date) ? '（周一）' : ''} · ${day.label} ｜ ${day.stats.km}km · ${day.stats.stops} 站 ──`);
    for (const it of day.items) {
      if (it.type === 'start') console.log(`  ${it.time}  ● 起点 ${it.name}`);
      if (it.type === 'commute') console.log(`         ${it.text}`);
      if (it.type === 'meal') console.log(`  ${it.time}  ○ ${it.hint}`);
      if (it.type === 'stop') {
        console.log(`  ${it.arr}–${it.dep}  ◆ ${it.name}${it.flag ? ` [${it.flag}]` : ''}（${it.cat}）`);
        if (it.reason) console.log(`         "${it.reason}"`);
        if (it.notice) console.log(`         ⚠ ${it.notice}`);
      }
      if (it.type === 'end') console.log(`  ${it.time}  ● ${it.name}`);
    }
    if (day.dropped.length) {
      console.log(`  ✂ 未排入：${day.dropped.map(d => `${d.spot.name}(${d.cause})`).join('、')}`);
    }
  }
}

// ---------- 场景 ----------
const scenarios = [
  {
    name: 'A1 春熙路出发 · 1 日',
    opts: { spots, city: '成都', origin: { name: '春熙路亚朵酒店', lng: 104.0765, lat: 30.6570 }, days: 1, startDate: '2026-10-13' },
  },
  {
    name: 'A2 春熙路出发 · 3 日',
    opts: { spots, city: '成都', origin: { name: '春熙路亚朵酒店', lng: 104.0765, lat: 30.6570 }, days: 3, startDate: '2026-10-13' },
  },
  {
    name: 'A3 春熙路出发 · 5 日',
    opts: { spots, city: '成都', origin: { name: '春熙路亚朵酒店', lng: 104.0765, lat: 30.6570 }, days: 5, startDate: '2026-10-13' },
  },
  {
    name: 'B 起点即景点（大熊猫基地）· 2 日',
    opts: { spots, city: '成都', origin: { name: '大熊猫繁育研究基地', lng: 104.1506, lat: 30.7326, spotId: 'panda-base' }, days: 2, startDate: '2026-10-13' },
  },
  {
    name: 'C 周一闭馆压力测试 · 3 日（起始周一 2026-10-12）',
    opts: { spots, city: '成都', origin: { name: '天府广场周边酒店', lng: 104.0665, lat: 30.6570 }, days: 3, startDate: '2026-10-12' },
  },
  {
    name: 'E1 北京 · 3 日',
    opts: { spots: require('../data/spots/beijing.json').spots, city: '北京', origin: { name: '王府井酒店', lng: 116.4114, lat: 39.9086 }, days: 3, startDate: '2026-10-13' },
  },
  {
    name: 'E2 北京 · 周一起始 3 日（故宫周一闭馆）',
    opts: { spots: require('../data/spots/beijing.json').spots, city: '北京', origin: { name: '王府井酒店', lng: 116.4114, lat: 39.9086 }, days: 3, startDate: '2026-10-12' },
  },
  {
    name: 'E3 重庆 · 3 日',
    opts: { spots: require('../data/spots/chongqing.json').spots, city: '重庆', origin: { name: '解放碑酒店', lng: 106.5516, lat: 29.5630 }, days: 3, startDate: '2026-10-13' },
  },
  {
    name: 'E4 杭州 · 3 日',
    opts: { spots: require('../data/spots/hangzhou.json').spots, city: '杭州', origin: { name: '湖滨酒店', lng: 120.1551, lat: 30.2741 }, days: 3, startDate: '2026-10-13' },
  },
  {
    name: 'E5 上海 · 3 日',
    opts: { spots: require('../data/spots/shanghai.json').spots, city: '上海', origin: { name: '人民广场酒店', lng: 121.4737, lat: 31.2304 }, days: 3, startDate: '2026-10-13' },
  },
  {
    name: 'E6 西安 · 3 日',
    opts: { spots: require('../data/spots/xian.json').spots, city: '西安', origin: { name: '钟楼酒店', lng: 108.9402, lat: 34.3416 }, days: 3, startDate: '2026-10-13' },
  },
];

let fail = 0;

// ---------- 场景 D：微调重推演（上移/下移/删除/时长 +15min） ----------
{
  console.log(`\n### D 微调重推演：交换 D1 第 2/3 站、删末站、首站时长 +15min`);
  const base = genRoute(scenarios[1].opts);
  const day1 = base.dayPlans[0];
  const byId = Object.fromEntries(spots.map(s => [s.id, s]));
  const stopIds = day1.items.filter(i => i.type === 'stop').map(i => i.id);
  const adj = stopIds.slice(0, -1).map(id => byId[id]);       // 删末站
  [adj[1], adj[2]] = [adj[2], adj[1]];                         // 交换第 2/3 站
  adj[0] = { ...adj[0], dur: (adj[0].dur || 90) + 15 };        // 时长 +15min
  const re = retimeDay(adj, base.origin, day1.date, { suburb: false });
  const wrappedDay = { ...day1, ...re };
  printRoute({ ...base, dayPlans: [wrappedDay] });
  const errors = validate({ ...base, dayPlans: [wrappedDay] }, { days: 1, origin: {} });
  if (!Array.isArray(re.dropped)) errors.push('retimeDay 缺少 dropped 字段');
  const kept = re.items.filter(i => i.type === 'stop').map(i => i.id);
  if (kept[0] !== adj[0].id || kept[1] !== adj[1].id) errors.push('retimeDay 未保持用户显式顺序');
  if (errors.length) {
    fail += errors.length;
    console.log(`\n  ✗ 校验未通过（${errors.length} 项）：`);
    for (const e of errors) console.log(`    - ${e}`);
  } else {
    console.log(`\n  ✓ 校验通过（保序重排 + 约束复核）`);
  }
}

for (const sc of scenarios) {
  const t0 = Date.now();
  const route = genRoute(sc.opts);
  const ms = Date.now() - t0;
  console.log(`\n### ${sc.name}（引擎耗时 ${ms}ms）`);
  printRoute(route);
  const errors = validate(route, sc.opts);
  if (errors.length) {
    fail += errors.length;
    console.log(`\n  ✗ 校验未通过（${errors.length} 项）：`);
    for (const e of errors) console.log(`    - ${e}`);
  } else {
    console.log(`\n  ✓ 校验通过`);
  }
}

console.log(`\n${'='.repeat(58)}`);
console.log(fail ? `共 ${fail} 项校验失败` : '全部场景校验通过');
process.exit(fail ? 1 : 0);
