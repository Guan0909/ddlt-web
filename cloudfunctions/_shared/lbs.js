'use strict';
// 腾讯位置服务 WebService 封装（lbsProvider 的腾讯实现）
// Key 只从环境变量 TENCENT_WS_KEY 读取，严禁落地到代码/前端。

const BASE = 'https://apis.map.qq.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let lastCall = 0;
async function throttle() {
  const wait = 200 - (Date.now() - lastCall);   // 200ms 节流（并发 5/s 红线内）
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

async function call(path, params) {
  const key = process.env.TENCENT_WS_KEY;
  if (!key) throw new Error('云函数缺少环境变量 TENCENT_WS_KEY');
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${BASE}${path}?${qs}&key=${key}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = await res.json();
      if (json.status === 0) return json;
      lastErr = new Error(`腾讯接口 ${path} status=${json.status} ${json.message || ''}`);
      if (json.status === 121) lastErr.quotaExceeded = true;  // 日配额耗尽，调用方应降级
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// 关键词输入提示（线上起点搜索主用，6000/日）
// region 可空：空 = 全国提示（首页未选城市时用，避免「默认成都搜上海」搜不到）
async function suggestionRaw(keyword, region) {
  const params = { keyword, page_size: 10 };
  if (region) params.region = region;
  return call('/ws/place/v1/suggestion', params);
}
async function suggestion(keyword, region) {
  const j = await suggestionRaw(keyword, region);
  return (j.data || []).map(d => ({
    id: d.id, title: d.title, address: d.address || '',
    lng: d.location && d.location.lng, lat: d.location && d.location.lat,
    // 城市/区县：前端据此自动切换城市。注意腾讯 suggestion 是**平铺字段**（province/city/district/adcode），
    // 不是 ad_info 嵌套（ad_info 是 place/search 等接口的形态），两者都兜一下。
    category: d.category || '',   // 「旅游景点:风景名胜」这类类目串，前端做自定义站点的类目映射
    city: d.city || (d.ad_info && d.ad_info.city) || '',
    district: d.district || (d.ad_info && d.ad_info.district) || '',
    adcode: d.adcode || (d.ad_info && d.ad_info.adcode) || '',
  })).filter(d => d.lng != null);
}

// 逆地址（定位 → 城市判定）
async function reverseGeocode(lng, lat) {
  const j = await call('/ws/geocoder/v1/', { location: `${lat},${lng}` });
  const r = j.result || {};
  return { city: r.ad_info && r.ad_info.city, address: r.address, adcode: r.ad_info && r.ad_info.adcode };
}

// 距离矩阵：froms/tos 均为 [{lng,lat}]，mode = walking|driving
// 返回 map：'fromIdx>toIdx' => { km, min }
async function matrix(froms, tos, mode) {
  const fmt = p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const j = await call('/ws/distance/v1/matrix', {
    mode, from: froms.map(fmt).join(';'), to: tos.map(fmt).join(';'),
  });
  const out = {};
  (j.result.rows || []).forEach((row, fi) => {
    (row.elements || []).forEach((el, ti) => {
      out[`${fi}>${ti}`] = { km: +(el.distance / 1000).toFixed(2), min: Math.max(1, Math.round(el.duration / 60)) };
    });
  });
  return out;
}

// 单段路径规划（公交等需要线路细节时用）：mode = walking|driving|transit
// 注意单位差异：direction 的 duration 为分钟；matrix 的 duration 为秒
async function direction(from, to, mode) {
  const fmt = p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const j = await call(`/ws/direction/v1/${mode}`, { from: fmt(from), to: fmt(to) });
  const r = j.result;
  const route = r && r.routes && r.routes[0];
  if (!route) throw new Error(`腾讯 ${mode} 路径规划无结果`);
  return { km: +(route.distance / 1000).toFixed(2), min: Math.max(1, Math.round(route.duration)), mode };
}

// 静态图（海报链路，posterImg 代理用）：返回图片 Buffer
async function staticMapBuffer(params) {
  const key = process.env.TENCENT_WS_KEY;
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${BASE}/ws/staticmap/v2?${qs}&key=${key}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`静态图 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { suggestion, suggestionRaw, reverseGeocode, matrix, direction, staticMapBuffer };
