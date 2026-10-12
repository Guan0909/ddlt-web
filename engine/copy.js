'use strict';
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

// 路线总推荐语（模板版，AI 文案的降级底座）
function buildNarrative(route) {
  const themes = route.dayPlans.map(d => d.label.replace(/\s*·\s*/, ''));
  const uniq = [...new Set(themes)];
  return `${route.days} 天 ${route.totals.stops} 站，从${route.origin.name}出发：${uniq.join('、')}。每天环线，${route.dayPlans[0].startTime} 出发，收束回${route.origin.name}。`;
}

function commuteText(c) {
  const km = c.km >= 1 ? `${c.km.toFixed(1)}km` : `${Math.round(c.km * 1000)}m`;
  const note = c.mode === 'transit' ? ' · 不含候车' : '';
  return `${c.label} · 约${c.min}分钟 · ${km}${note}`;
}

module.exports = { flagOf, buildReason, buildNotice, buildDayLabel, mealHint, commuteText, buildNarrative };
