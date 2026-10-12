'use strict';
// 纯几何工具：距离、方位、聚类。无依赖，Node / 云函数 / 浏览器通用。

const EARTH_R = 6371000;

function pt(v) {
  return Array.isArray(v) ? { lng: v[0], lat: v[1] } : v;
}

function haversineM(a, b) {
  const p1 = pt(a), p2 = pt(b);
  const rad = Math.PI / 180;
  const dLat = (p2.lat - p1.lat) * rad;
  const dLng = (p2.lng - p1.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(p1.lat * rad) * Math.cos(p2.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

// 八分方位：从 from 看 to
function bearing8(from, to) {
  const f = pt(from), t = pt(to);
  if (haversineM(f, t) < 3000) return '城内';
  const rad = Math.PI / 180;
  const y = Math.sin((t.lng - f.lng) * rad) * Math.cos(t.lat * rad);
  const x = Math.cos(f.lat * rad) * Math.sin(t.lat * rad) -
    Math.sin(f.lat * rad) * Math.cos(t.lat * rad) * Math.cos((t.lng - f.lng) * rad);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return names[Math.round(deg / 45) % 8];
}

function centroid(points) {
  let lng = 0, lat = 0;
  for (const p of points) { const q = pt(p); lng += q.lng; lat += q.lat; }
  return { lng: lng / points.length, lat: lat / points.length };
}

// k-means（k-means++ 简化播种），points 元素需带 lng/lat 或 coord
function kmeans(points, k, iters = 12) {
  if (points.length <= k) return points.map(p => [p]);
  const seeds = [points[0]];
  while (seeds.length < k) {
    let best = null, bestD = -1;
    for (const p of points) {
      const d = Math.min(...seeds.map(s => haversineM(pt(p), pt(s))));
      if (d > bestD) { bestD = d; best = p; }
    }
    seeds.push(best);
  }
  let assign = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let moved = false;
    points.forEach((p, i) => {
      let bi = 0, bd = Infinity;
      seeds.forEach((s, si) => {
        const d = haversineM(pt(p), pt(s));
        if (d < bd) { bd = d; bi = si; }
      });
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    });
    if (!moved) break;
    for (let si = 0; si < k; si++) {
      const members = points.filter((_, i) => assign[i] === si);
      if (members.length) seeds[si] = centroid(members);
    }
  }
  const out = Array.from({ length: k }, () => []);
  points.forEach((p, i) => out[assign[i]].push(p));
  return out.filter(g => g.length);
}

module.exports = { pt, haversineM, bearing8, centroid, kmeans };
