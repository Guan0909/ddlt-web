'use strict';
// reRoute：微调后的显式顺序 → retimeDay 全量重校验 + 真实通勤回填
// body: { city, origin, date, startMin?, suburb?, stops: [{id, dur?}] }

const engine = require('./engine/index');
const store = require('./store');
const { parseBody, ok, fail } = require('./http');
const { loadSpots, buildCommuteFn, validOrigin } = require('./routeKit');

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event);
  if (!body || !body.city || !validOrigin(body.origin) || !Array.isArray(body.stops) || !body.date) return fail('参数不完整');
  const spots = loadSpots(body.city);
  if (!spots) return fail('该城市暂未开通', 400, { code: 'CITY_CLOSED' });

  const spotById = Object.fromEntries(spots.map(s => [s.id, s]));
  const stopObjs = body.stops.slice(0, 8)
    .map(s => {
      const base = spotById[s.id];
      return base ? (s.dur ? { ...base, dur: +s.dur } : base) : null;
    })
    .filter(Boolean);

  try {
    const suburb = stopObjs.length > 0 && stopObjs.every(s => s.suburb);
    const commute = await buildCommuteFn(body.origin, stopObjs, suburb);
    const sim = engine.retimeDay(stopObjs, body.origin, body.date, {
      suburb,
      startMin: Number.isFinite(body.startMin) ? body.startMin : engine.DAY_START,
      commute,
    });
    return ok(sim);
  } catch (e) {
    console.error(e);
    return fail('重排失败，请重试', 500);
  }
};
