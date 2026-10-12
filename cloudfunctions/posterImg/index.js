'use strict';
// posterImg：腾讯静态图代理（Key 不出云函数）→ base64，供 Canvas 海报合成
// body: { center: 'lng,lat', zoom, size: '750x500', markers?, paths? }（静态图参数白名单透传）

const lbs = require('./lbs');
const store = require('./store');
const { parseBody, ok, fail } = require('./http');

const ALLOWED = ['center', 'zoom', 'size', 'markers', 'paths', 'scale', 'maptype', 'format', 'labels', 'linkid', 'traffic'];

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event) || {};
  const params = {};
  for (const k of ALLOWED) {
    if (body[k] != null) params[k] = String(body[k]).slice(0, 1500);
  }
  if (!params.center || !params.zoom) return fail('缺 center/zoom');
  if (!(await store.tencentBudget())) return fail('海报底图暂不可用', 503);
  try {
    const buf = await lbs.staticMapBuffer(params);
    return ok({ base64: buf.toString('base64'), contentType: 'image/png' });
  } catch (e) {
    console.error(e);
    return fail('静态图获取失败', 502);
  }
};
