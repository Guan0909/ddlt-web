'use strict';
// photoImg：高德 CDN 图片 → base64 代理（海报 canvas 绘制用；跨域图片会污染 canvas，必须服务端转）
// body: { urls: string[]（≤12，白名单 amap 域名） }
// 返回 { images: [{ b64, type } | null, ...] }；dist_cache 缓存 30 天

const store = require('./store');
const { parseBody, ok, fail } = require('./http');

const HOSTS = ['store.is.autonavi.com', 'aos-comment.amap.com', 'aos-cdn-image.amap.com'];
const MAX_BYTES = 420 * 1024;
const TTL = 30 * 86400000;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

exports.main = async (event) => {
  const body = parseBody(event) || {};
  const urls = (Array.isArray(body.urls) ? body.urls : []).slice(0, 12);
  if (!urls.length) return fail('缺 urls');
  const images = [];
  for (const u of urls) {
    try {
      const url = String(u || '');
      let host = '';
      try { host = new URL(url).host; } catch (e) { host = ''; }
      if (!/^https:\/\//.test(url) || HOSTS.indexOf(host) < 0) { images.push(null); continue; }
      const key = 'img__' + hash(url);
      let hit = null;
      try {
        const doc = await store.db.collection('dist_cache').doc(key).get();
        const d = doc.data && (Array.isArray(doc.data) ? doc.data[0] : doc.data);
        if (d && d.expire_at > Date.now() && d.b64) hit = d;
      } catch (e) {}
      if (hit) { images.push({ b64: hit.b64, type: hit.type || 'image/jpeg' }); continue; }
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) { images.push(null); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) { images.push(null); continue; }
      const rec = { b64: buf.toString('base64'), type: res.headers.get('content-type') || 'image/jpeg', updated_at: new Date().toISOString(), expire_at: Date.now() + TTL };
      store.db.collection('dist_cache').doc(key).set(rec).catch(() => {});
      images.push({ b64: rec.b64, type: rec.type });
    } catch (e) {
      images.push(null);
    }
  }
  return ok({ images });
};