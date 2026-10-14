'use strict';
// routePaths：真实路网路径（腾讯 direction API）→ 解压 polyline 返回经纬度序列
// body: { legs: [{from:{lng,lat}, to:{lng,lat}, mode:'walk'|'transit'|'drive'}], date? }
// 返回 { paths: [ [[lat,lng],...] | null, ... ] }（与 legs 同序；单腿失败为 null，前端回退直线）
// 缓存：path 级 dist_cache（walk/drive 7 天、transit 当天）；单 IP 限频 + 日预算熔断沿用 store。

const lbs = require('./lbs');
const store = require('./store');
const { parseBody, ok, fail } = require('./http');

// 腾讯 direction polyline 解压：首对绝对 [lat,lng]，其后为 1e-6 度差分
function decompress(pl) {
  if (!Array.isArray(pl) || pl.length < 2) return null;
  const out = [[pl[0], pl[1]]];
  let lat = pl[0], lng = pl[1];
  for (let i = 2; i + 1 < pl.length; i += 2) {
    lat += pl[i] / 1e6; lng += pl[i + 1] / 1e6;
    out.push([+lat.toFixed(6), +lng.toFixed(6)]);
  }
  return out;
}

// transit 返回多段 steps，各自带 polyline，拼起来（在主流程内处理）

exports.main = async (event) => {
  if (!(await store.rateLimit(event))) return fail('请求太频繁，请稍后再试', 429);
  const body = parseBody(event) || {};
  const legs = Array.isArray(body.legs) ? body.legs.slice(0, 24) : [];
  if (!legs.length) return fail('缺 legs');

  const paths = [];
  for (const leg of legs) {
    const mode = leg.mode === 'walk' ? 'walk' : leg.mode === 'transit' ? 'transit' : 'drive';
    const keyFrom = `${(+leg.from.lng).toFixed(4)},${(+leg.from.lat).toFixed(4)}`;
    const keyTo = `${(+leg.to.lng).toFixed(4)},${(+leg.to.lat).toFixed(4)}`;
    const cacheKey = `${keyFrom}__${keyTo}__${mode}__path`;
    let path = null;
    try {
      const doc = await store.db.collection('dist_cache').doc(cacheKey).get();
      const d = doc.data && (Array.isArray(doc.data) ? doc.data[0] : doc.data);
      if (d && d.expire_at > Date.now() && Array.isArray(d.path)) path = d.path;
    } catch (e) {}
    if (!path) {
      if (!(await store.tencentBudget())) { paths.push(null); continue; }
      try {
        // 直接调底层拿原始 polyline（lbs.direction 只回距离/时长）
        const fmt = p => `${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)}`;
        const apiMode = mode === 'walk' ? 'walking' : mode === 'transit' ? 'transit' : 'driving';
        const key = process.env.TENCENT_WS_KEY;
        const res = await fetch(`https://apis.map.qq.com/ws/direction/v1/${apiMode}?from=${fmt(leg.from)}&to=${fmt(leg.to)}&key=${key}`,
          { signal: AbortSignal.timeout(5000) });
        const j = await res.json();
        if (j.status !== 0 || !j.result || !j.result.routes || !j.result.routes[0]) throw new Error('no route');
        const r0 = j.result.routes[0];
        if (mode === 'transit' && Array.isArray(r0.steps)) {
          const all = [];
          for (const st of r0.steps) {
            const seg = decompress(st.polyline);
            if (seg) for (const p of seg) all.push(p);
          }
          path = all.length ? all : null;
        } else {
          path = decompress(r0.polyline);
        }
        if (path) {
          const expire = mode === 'transit'
            ? new Date(new Date().toDateString()).getTime() + 86400000
            : Date.now() + 7 * 86400000;
          await store.db.collection('dist_cache').doc(cacheKey)
            .set({ path, updated_at: new Date().toISOString(), expire_at: expire })
            .catch(() => {});
        }
      } catch (e) { path = null; }
    }
    paths.push(path);
  }
  return ok({ paths });
};
