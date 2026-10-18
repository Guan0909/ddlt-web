'use strict';
// 补图：高德图片统一 HTTPS + OSS 高清参数（w_1440），逐张校验分辨率，失败回退原图
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SPOT_DIR = path.join(ROOT, 'data', 'spots');
const REPORT = path.join(ROOT, 'build', 'photo-upgrade-report.json');
const PARAM = 'x-oss-process=image/resize,w_1440';
const UPGRADABLE = /(^|\.)(store\.is\.autonavi\.com|aos-comment\.amap\.com)$/;
const ALIYUN = /aliyuncs\.com$/;
const CONCURRENCY = 16;

function dims(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      if (m === 0xD8 || m === 0xD9) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
async function probe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { ok: false, status: r.status };
    const b = Buffer.from(await r.arrayBuffer());
    const d = dims(b);
    if (!d) return { ok: false, status: r.status, dim: null };
    return { ok: true, w: d.w, h: d.h, bytes: b.length };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 60) }; }
}
function withParam(u) {
  const s = String(u).replace(/^http:/, 'https:');
  if (s.indexOf('x-oss-process') >= 0) return s;
  let host = '';
  try { host = new URL(s).host; } catch (e) { return s; }
  if (!UPGRADABLE.test(host) && !ALIYUN.test(host)) return s;
  return s + (s.indexOf('?') >= 0 ? '&' : '?') + PARAM;
}
async function pool(tasks, n) {
  let i = 0;
  const out = new Array(tasks.length);
  const workers = new Array(Math.min(n, tasks.length)).fill(0).map(async () => {
    while (true) {
      const k = i++;
      if (k >= tasks.length) break;
      out[k] = await tasks[k]();
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const files = fs.readdirSync(SPOT_DIR).filter(f => /^[a-z-]+\.json$/.test(f));
  const cities = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(SPOT_DIR, f), 'utf8'));
    if (!Array.isArray(j.spots)) continue;
    cities.push({ file: f, j });
  }
  // 收集任务：唯一 URL 的升级 + 校验
  const urlSet = new Map();
  for (const c of cities) for (const s of c.j.spots) for (const u of (s.photos || [])) {
    const orig = String(u);
    const up = withParam(orig);
    if (!urlSet.has(orig)) urlSet.set(orig, { up, state: 'pending' });
  }
  const entries = [...urlSet.entries()];
  console.log('景点文件:', cities.length, '| 唯一图片 URL:', entries.length);
  const results = await pool(entries.map(([orig, rec]) => async () => {
    if (orig === rec.up) { const p = await probe(orig); return { orig, final: orig, ok: !!(p.ok && p.w >= 700), w: p.w || 0, upgraded: false }; }
    const p = await probe(rec.up);
    if (p.ok && p.w >= 1000) return { orig, final: rec.up, ok: true, w: p.w, upgraded: true };
    // 高清不可用 → 用原图（https 化）
    const p2 = await probe(String(orig).replace(/^http:/, 'https:'));
    return { orig, final: String(orig).replace(/^http:/, 'https:'), ok: !!(p2.ok && p2.w >= 500), w: p2.w || 0, upgraded: false, fallback: true };
  }), CONCURRENCY);
  const map = new Map(results.map(r => [r.orig, r]));
  let upgraded = 0, fallback = 0, bad = 0, hd = 0, low = 0;
  for (const r of results) { if (r.upgraded) upgraded++; if (r.fallback) fallback++; if (!r.ok) bad++; if (r.w >= 1000) hd++; else low++; }
  let changedPhotos = 0;
  for (const c of cities) {
    for (const s of c.j.spots) {
      if (!Array.isArray(s.photos)) continue;
      const next = [];
      for (const u of s.photos) {
        const rec = map.get(String(u));
        const nu = rec ? rec.final : String(u).replace(/^http:/, 'https:');
        if (nu !== u) changedPhotos++;
        if (!next.includes(nu)) next.push(nu);
      }
      s.photos = next;
      if (typeof s.photo === 'string' && s.photos[0]) s.photo = s.photos[0];
    }
    fs.writeFileSync(path.join(SPOT_DIR, c.file), JSON.stringify(c.j, null, 1), 'utf8');
  }
  const report = { generated_at: new Date().toISOString(), unique_urls: entries.length, upgraded, fallback, bad, hd_ge_1000w: hd, low_lt_1000w: low, changed_photo_refs: changedPhotos };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });