'use strict';
// genRoute：起点 + 天数 → 引擎生成路线 → 真实通勤回填 → 存 routes（128 位 ID）→ 返回

const engine = require('./engine/index');
const store = require('./store');
const { parseBody, ok, fail } = require('./http');
const { loadSpots, refineWithRealCommute, validOrigin } = require('./routeKit');

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event);
  if (!body || !body.city || !validOrigin(body.origin)) return fail('参数不完整');
  const spots = loadSpots(body.city);
  if (!spots) return fail('该城市暂未开通', 400, { code: 'CITY_CLOSED' });

  const days = Math.min(5, Math.max(1, +body.days || 3));
  // 第一天出发时间：'HH:MM' 或分钟数（结果页可点选；只作用于第一天，其余天默认 09:00）
  let startMin = null;
  if (body.startMin != null) {
    if (typeof body.startMin === 'string' && /^\d{1,2}:\d{2}$/.test(body.startMin)) {
      const hm = body.startMin.split(':');
      startMin = (+hm[0]) * 60 + (+hm[1]);
    } else if (Number.isFinite(+body.startMin)) startMin = +body.startMin;
  }
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(body.startDate || '')
    ? body.startDate : engine.addDays(new Date().toISOString().slice(0, 10), 1);

  // 输入校验（与浏览器端同一引擎规则）：起点过偏 / 周边景点不够分配
  const origin = { name: String(body.origin.name || '我的起点').slice(0, 40), lng: +body.origin.lng, lat: +body.origin.lat, spotId: body.origin.spotId || null };
  const v = engine.validateInputs(spots, origin, days);
  if (!v.ok) return fail(v.message, 400, { code: v.code });

  try {
    const route = engine.genRoute({
      spots,
      origin,
      days, startDate,
      startNow: !!body.startNow,
      nowMin: Number.isFinite(body.nowMin) ? body.nowMin : null,
      startMin: startMin,
      city: body.city,
    });
    if (!route.dayPlans.length) return fail('这条路线排不出来。换个起点，或减少天数试试。', 400, { code: 'PLAN_EMPTY' });
    await refineWithRealCommute(route, spots);
    route.dayStopIds = route.dayPlans.map(dp => dp.items.filter(i => i.type === 'stop').map(i => i.id));
    const routeId = await store.routeSave(route).catch(() => null);
    return ok({ route, routeId });
  } catch (e) {
    console.error(e);
    return fail('路线生成失败，请重试', 500);
  }
};
