'use strict';
// searchPoi：起点搜索（关键词提示，6000/日）+ 定位逆地址（城市判定）
// body: { keyword?, region?, lat?, lng? }

const lbs = require('./lbs');
const store = require('./store');
const { parseBody, ok, fail } = require('./http');

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event) || {};

  // 逆地址：定位兜底（WGS84 浏览器坐标直接传，腾讯按 GCJ-02 解析的偏差在 H5 场景可接受，P5 前评估纠偏）
  if (body.lat != null && body.lng != null && !body.keyword) {
    if (!(await store.tencentBudget())) return fail('定位服务暂不可用', 503);
    try { return ok(await lbs.reverseGeocode(+body.lng, +body.lat)); }
    catch (e) { return fail('定位解析失败', 502); }
  }

  const kw = String(body.keyword || '').trim().slice(0, 30);
  if (!kw || !body.region) return fail('缺参数');
  if (!(await store.tencentBudget())) return ok({ data: [], degraded: true });
  try {
    return ok({ data: await lbs.suggestion(kw, String(body.region).slice(0, 10)) });
  } catch (e) {
    return ok({ data: [], degraded: true });   // 降级为空建议，前端回退本地库
  }
};
