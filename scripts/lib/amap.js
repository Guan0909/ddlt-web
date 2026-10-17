'use strict';
// 高德 Web 服务统一入口。默认官方域名；可用环境变量切到转发通道（免 IP 白名单）：
//   AMAP_BASE=https://pass-api.ibtmap.com/a  AMAP_KEY=<转发 key>
//   node scripts/xxx.js  # 脚本内统一读 process.env.AMAP_KEY || AMAP_WS_KEY
const BASE = (process.env.AMAP_BASE || 'https://restapi.amap.com').replace(/\/+$/, '');
const KEY = process.env.AMAP_KEY || process.env.AMAP_WS_KEY || '';

function url(p, params) {
  const parts = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  if (KEY) parts.push('key=' + encodeURIComponent(KEY));
  return BASE + p + (parts.length ? '?' + parts.join('&') : '');
}

async function get(p, params, opts = {}) {
  const tries = opts.tries || 2;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url(p, params), { signal: AbortSignal.timeout(opts.timeout || 15000) });
      const j = await r.json();
      if (String(j.status) === '1') return j;
      if (String(j.infocode) === '10021' || String(j.infocode) === '10019' || String(j.infocode) === '10010') {
        await new Promise(r2 => setTimeout(r2, 600));   // QPS 超限 → 退避重试
        continue;
      }
      return j;   // 其它业务错误原样返回，由调用方判断
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r2 => setTimeout(r2, 800));
    }
  }
  return { status: '0', info: 'retry exhausted', pois: [] };
}

// POI 归一：location → [lng, lat]，tel → 字符串，biz_ext → 营业信息
function normPoi(p) {
  const [lng, lat] = String(p.location || '').split(',').map(Number);
  const be = p.biz_ext || {};
  const tel = Array.isArray(p.tel) ? p.tel.filter(Boolean).join(';') : String(p.tel || '');
  const ph = (p.photos || []).map(x => x.url).filter(Boolean);
  return {
    id: p.id, name: p.name, type: String(p.type || ''), typecode: p.typecode || '',
    address: String(p.address || ''), coord: [lng, lat],
    province: p.pname || '', city: p.cityname || '', district: p.adname || '',
    tel: tel || '', rating: be.rating === undefined || be.rating === '' ? null : Number(be.rating),
    cost: be.cost === undefined || be.cost === '' ? null : Number(be.cost),
    openTime: be.open_time || '', openText: be.opentime2 || '', photo: ph[0] || '',
  };
}

module.exports = { BASE, KEY, url, get, normPoi };
