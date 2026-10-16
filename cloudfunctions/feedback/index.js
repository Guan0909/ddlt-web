'use strict';
// feedback：景点卡「信息有误」反馈
// body: { spotId?, routeId?, text }
// routeId 走与 routeGet 同一格式口径（128 位 hex），格式不符即拒，避免脏数据进库。

const store = require('./store');
const { parseBody, ok, fail } = require('./http');

const ROUTE_ID_RE = /^[0-9a-f]{32}$/;
const SPOT_ID_MAX = 64;

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event) || {};
  const text = String(body.text || '').trim();
  if (!text) return fail('反馈内容为空');

  let routeId = null;
  if (body.routeId != null && body.routeId !== '') {
    routeId = String(body.routeId);
    if (!ROUTE_ID_RE.test(routeId)) return fail('路线 ID 格式不对', 400, { code: 'BAD_ROUTE_ID' });
  }
  const spotId = body.spotId ? String(body.spotId).slice(0, SPOT_ID_MAX) : null;

  try {
    await store.feedbackSave({ spotId, routeId, text });
    return ok({ saved: true });
  } catch (e) {
    console.error(e);
    return fail('提交失败，请稍后再试', 500);
  }
};
