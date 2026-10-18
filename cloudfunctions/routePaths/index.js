'use strict';
// routePaths：真实路网路径（腾讯 direction API）→ 解压 polyline、抽稀、端头吸附后返回经纬度序列
// body: { legs: [{from:{lng,lat}, to:{lng,lat}, mode:'walk'|'transit'|'drive'}], date? }
// 返回 { paths: [ [[lat,lng],...] | null, ... ] }（与 legs 同序；单腿失败为 null，前端回退直线）
// 缓存：path 级 dist_cache（walk/drive 7 天、transit 当天）；单 IP 限频 + 日预算熔断沿用 store。
//
// 两道几何处理（2026-10-16 依据实测加入，见 项目上下文.md §9.7）：
//   ① 抽稀：道格拉斯-普克，阈值按模式给（步行 6m / 公交 8m / 驾车 12m）——实测 1356 点 → 276 点（-80%），
//      最大偏差 5.5/7.9/12.0m，远小于道路宽度，肉眼不丢转弯。
//   ② 端头吸附：把折线首尾接到请求的 from/to 坐标（仅当间隙 ≤120m）。实测：城区腿尾部 1~46m、
//      起点侧 86m（天府广场这种面状 POI 的路网入口就在几十米外）、远郊景区门口 171~254m。
//      ≤120m 直接接上（视觉上就是「最后几步路」）；>120m 不接，留给前端画浅色补线，避免长直线假路。

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

// ---------- 几何 ----------
const R = 6371008.8;
const rad = d => d * Math.PI / 180;
// 两点距离（米，等距近似，城市尺度足够）
function distM(a, b) {
  const x = rad(b[1] - a[1]) * Math.cos(rad((a[1] + b[1]) / 2)) * R;
  const y = rad(b[0] - a[0]) * R;
  return Math.hypot(x, y);
}
// 点到线段距离（米）
function pointSegM(p, a, b) {
  const k = Math.cos(rad((a[0] + b[0]) / 2));
  const px = rad(p[1]) * k, py = rad(p[0]);
  const ax = rad(a[1]) * k, ay = rad(a[0]), bx = rad(b[1]) * k, by = rad(b[0]);
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? (wx * vx + wy * vy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) * R;
}
// 道格拉斯-普克抽稀（保留首尾与所有超过阈值的转折点）
function rdp(pts, tolM) {
  if (!Array.isArray(pts) || pts.length < 3) return (pts || []).slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let maxD = -1, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = pointSegM(pts[k], pts[i], pts[j]);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (maxD > tolM && idx > 0) { keep[idx] = 1; stack.push([i, idx], [idx, j]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
const TOL_M = { walk: 6, transit: 8, drive: 12 };
const SNAP_MAX_M = 120;

// 端头吸附：[lat,lng] 折线首尾接到 {lat,lng} 的 from/to（间隙 ≤ SNAP_MAX_M 才接）
function snapEnds(path, from, to) {
  if (!path || path.length < 2) return path;
  const out = path.slice();
  const head = [+from.lat.toFixed(6), +from.lng.toFixed(6)];
  const tail = [+to.lat.toFixed(6), +to.lng.toFixed(6)];
  const dHead = distM(head, out[0]);
  if (dHead > 1 && dHead <= SNAP_MAX_M) out.unshift(head);
  const dTail = distM(tail, out[out.length - 1]);
  if (dTail > 1 && dTail <= SNAP_MAX_M) out.push(tail);
  return out;
}
// 抽稀 + 端头吸附（幂等：对已处理过的折线再跑一次结果不变）
function finalizePath(path, mode, from, to) {
  return snapEnds(rdp(path, TOL_M[mode] || 10), from, to);
}

// 几何可信度：公交路径/极简路径常返回「近乎直线」的假几何——距离长、点数少、偏离直线很小的判为不可信
function plausiblePath(path, from, to) {
  if (!path || path.length < 2) return false;
  const A = [+from.lat.toFixed(6), +from.lng.toFixed(6)];
  const B = [+to.lat.toFixed(6), +to.lng.toFixed(6)];
  const straight = distM(A, B);
  if (straight < 400) return true;                    // 短腿不校验
  if (path.length < 4) return false;                  // 点数过少 → 不可信
  let maxDev = 0, len = 0;
  for (let i = 0; i < path.length; i++) {
    maxDev = Math.max(maxDev, pointSegM(path[i], A, B));
    if (i > 0) len += distM(path[i - 1], path[i]);
  }
  // 真路径一定比直线长（绕路系数通常 ≥1.05），且会明显偏离直线；假几何两者都会接近 1/0
  if (straight > 500) {
    if (len / straight < 1.02) return false;                        // 几乎等于直线长度 → 假
    if (maxDev < Math.max(20, straight * 0.03)) return false;       // 偏离过小 → 假
  }
  return true;
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
    if (path) {
      // 旧缓存是未处理的原始折线：读出时同样过一遍（幂等），并做可信度校验
      const fin = finalizePath(path, mode, leg.from, leg.to);
      paths.push(plausiblePath(fin, leg.from, leg.to) ? fin : null);
      continue;
    }
    if (!(await store.tencentBudget())) { paths.push(null); continue; }
    try {
      // 直接调底层拿原始 polyline（lbs.direction 只回距离/时长）
      const fmt = p => `${(+p.lat).toFixed(6)},${(+p.lng).toFixed(6)}`;
      // 公交腿用「驾车」路网几何：公交 direction 的 polyline 常是简化直线，不能当真实道路用
      const apiMode = mode === 'walk' ? 'walking' : 'driving';
      const key = process.env.TENCENT_WS_KEY;
      const res = await fetch(`https://apis.map.qq.com/ws/direction/v1/${apiMode}?from=${fmt(leg.from)}&to=${fmt(leg.to)}&key=${key}`,
        { signal: AbortSignal.timeout(5000) });
      const j = await res.json();
      if (j.status !== 0 || !j.result || !j.result.routes || !j.result.routes[0]) throw new Error('no route');
      const r0 = j.result.routes[0];
      path = decompress(r0.polyline);
      if (path) {
        path = finalizePath(path, mode, leg.from, leg.to);
        if (!plausiblePath(path, leg.from, leg.to)) path = null;   // 假几何不返回，让前端画浅色虚线兜底
        const expire = mode === 'transit'
          ? new Date(new Date().toDateString()).getTime() + 86400000
          : Date.now() + 7 * 86400000;
        await store.db.collection('dist_cache').doc(cacheKey)
          .set({ path, updated_at: new Date().toISOString(), expire_at: expire })
          .catch(() => {});
      }
    } catch (e) { path = null; }
    paths.push(path);
  }
  return ok({ paths });
};

// 供本地回归直接验证几何处理（云函数入口不受影响）
exports.geom = { rdp, snapEnds, finalizePath, distM, pointSegM, TOL_M, SNAP_MAX_M, plausiblePath };
