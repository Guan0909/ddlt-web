'use strict';
// photoImg：高德 CDN 图片 → base64 代理（海报 canvas 绘制用；跨域图片会污染 canvas，必须服务端转）
// body: { urls: string[]（≤12，白名单 amap 域名） }
// 返回 { images: [{ b64, type } | null, ...] }；dist_cache 缓存 30 天

const store = require('./store');
const { parseBody, ok, fail } = require('./http');

const HOSTS = ['store.is.autonavi.com', 'aos-comment.amap.com', 'aos-cdn-image.amap.com'];
const MAX_BYTES = 700 * 1024;
const TTL = 30 * 86400000;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

exports.main = async (event) => {
  const body = parseBody(event) || {};
  // 兼容两种入参：urls:[..]（单图）或 items:[{urls:[..]}（多候选，逐张尝试）
  let items = [];
  if (Array.isArray(body.items)) items = body.items.slice(0, 12);
  else if (Array.isArray(body.urls)) items = body.urls.slice(0, 12).map(u => [u]);
  else items = [];
  if (!items.length) return fail('缺 urls');
  const images = [];
  for (const cands of items) {
    const rawList = Array.isArray(cands) ? cands : (cands && Array.isArray(cands.urls) ? cands.urls : []);
    const list = rawList.slice(0, 3).map(u => {
      let s2 = String(u || '');
      if (s2.indexOf('http://') === 0) s2 = 'https://' + s2.slice(7);
      return s2;
    }).filter(u => /^https:\/\//.test(u));
    let hitImg = null;
    for (const url of list) {
      if (hitImg) break;
      try {
        let host = '';
        try { host = new URL(url).host; } catch (e) { host = ''; }
        if (!/(^|\.)(store\.is\.autonavi\.com|aos-comment\.amap\.com|aos-cdn-image\.amap\.com)$/.test(host)) continue;
        const key = 'img__' + hash(url);
        let hit = null;
        try {
          const doc = await store.db.collection('dist_cache').doc(key).get();
          const d = doc.data && (Array.isArray(doc.data) ? doc.data[0] : doc.data);
          if (d && d.expire_at > Date.now() && d.b64) hit = d;
        } catch (e) {}
        if (hit) { hitImg = { b64: hit.b64, type: hit.type || 'image/jpeg' }; continue; }
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1', Referer: 'https://www.amap.com/' },
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > MAX_BYTES) continue;
        const rec = { b64: buf.toString('base64'), type: res.headers.get('content-type') || 'image/jpeg', updated_at: new Date().toISOString(), expire_at: Date.now() + TTL };
        store.db.collection('dist_cache').doc(key).set(rec).catch(() => {});
        hitImg = { b64: rec.b64, type: rec.type };
      } catch (e) { /* 试下一张 */ }
    }
    images.push(hitImg);
  }
  return ok({ images });
};