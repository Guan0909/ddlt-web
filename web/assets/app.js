'use strict';
/* 点定旅途 P3 · 页面共享逻辑：数据加载、存储、投影、DOM/图标工具、微调重排 */
window.DDN = (() => {
  const DAY_CN = ['一', '二', '三', '四', '五'];
  // 城市 → spots 数据文件（已建库 6 城）
  const SPOT_FILES = {
    '成都': '/data/spots/chengdu.json', '北京': '/data/spots/beijing.json',
    '重庆': '/data/spots/chongqing.json', '杭州': '/data/spots/hangzhou.json',
    '上海': '/data/spots/shanghai.json', '西安': '/data/spots/xian.json',
  };
  // 海报顶部拼音占位：映射不了的城市用 DECIDENOW.ASIA
  const PINYIN = { '成都': 'CHENGDU', '北京': 'BEIJING', '重庆': 'CHONGQING', '杭州': 'HANGZHOU', '上海': 'SHANGHAI', '西安': 'XIAN' };
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------- DOM 工具 ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgEl(name, attrs) {
    const n = document.createElementNS(SVGNS, name);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    return n;
  }

  // ---------- 静态 SVG 图标（照原型内联，非用户/数据文本） ----------
  const ICONS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/>',
    pin: '<path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M13 8l-2.5 5 3 3 1 5M13 8l3 2.5L18.5 12M10.5 13 8 16l-2 5"/>',
    transit: '<rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 20l-1.5 2M15 20l1.5 2"/><circle cx="9" cy="13.5" r=".8" fill="currentColor"/><circle cx="15" cy="13.5" r=".8" fill="currentColor"/>',
    drive: '<path d="M5 16l1.5-5.5A2 2 0 0 1 8.4 9h7.2a2 2 0 0 1 1.9 1.5L19 16"/><path d="M4 16h16v3.5a.5.5 0 0 1-.5.5H18a.5.5 0 0 1-.5-.5V18h-11v1.5a.5.5 0 0 1-.5.5H4.5a.5.5 0 0 1-.5-.5z"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="9" cy="9" r="1.6"/><path d="m21 15-4.5-4.5L9 18"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    download: '<path d="M12 4v12M6.5 10.5 12 16l5.5-5.5"/><path d="M4 20h16"/>',
  };
  function icon(name, cls, style) {
    const s = svgEl('svg', { viewBox: '0 0 24 24' });
    s.setAttribute('class', cls || 'ic');
    if (style) s.setAttribute('style', style);
    s.innerHTML = ICONS[name] || '';
    return s;
  }

  // ---------- 数据加载 ----------
  const spotsCache = {};
  async function loadCities() {
    const r = await fetch('/data/cities.json');
    if (!r.ok) throw new Error('cities.json 加载失败');
    return r.json();
  }
  async function loadSpots(city) {
    if (spotsCache[city]) return spotsCache[city];
    const f = SPOT_FILES[city];
    if (!f) return null;
    const r = await fetch(f);
    if (!r.ok) throw new Error(city + ' spots 加载失败');
    const d = await r.json();
    spotsCache[city] = d.spots;
    return d.spots;
  }

  // ---------- 存储 ----------
  function saveRoute(route) { sessionStorage.setItem('ddn_route', JSON.stringify(route)); }
  function loadRoute() { try { return JSON.parse(sessionStorage.getItem('ddn_route')); } catch (e) { return null; } }
  function saveShared(route) { localStorage.setItem('ddn_shared', JSON.stringify(route)); }
  function loadShared() { try { return JSON.parse(localStorage.getItem('ddn_shared')); } catch (e) { return null; } }
  // 起点页 → 加载页的请求快照（origin 可能尚未解析出坐标，由加载页负责解析与校验）
  function saveRequest(req) { sessionStorage.setItem('ddn_request', JSON.stringify(req)); }
  function loadRequest() { try { return JSON.parse(sessionStorage.getItem('ddn_request')); } catch (e) { return null; } }

  // ---------- 时间/数字格式 ----------
  function todayISO() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function parseHM(s) { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; }
  function fmtHour(min) {
    const h = Math.round(min / 60 * 10) / 10;
    return Number.isInteger(h) ? String(h) : h.toFixed(1);
  }
  function fmtDur(min) {
    if (min < 60) return min + 'min';
    const h = min / 60;
    return (Number.isInteger(h) ? h : h.toFixed(1)) + 'h';
  }
  function fmtHourCn(min) {
    if (min < 60) return `约 ${min} 分钟`;
    return `约 ${fmtHour(min)} 小时`;
  }
  function dateRange(startDate, days) {
    const end = window.Engine.addDays(startDate, days - 1);
    const p = s => { const d = new Date(s + 'T12:00:00'); return { m: d.getMonth() + 1, d: d.getDate() }; };
    const a = p(startDate), b = p(end);
    return `${a.m}月${a.d}日–${a.m === b.m ? '' : b.m + '月'}${b.d}日`;
  }
  function dayCn(n) { return DAY_CN[n - 1] || String(n); }
  function pinyinOf(city) { return PINYIN[city] || 'DECIDENOW.ASIA'; }
  // 日 label 形如「城西 · 文博线」→ Tab 小字取主题部分「城西文博」
  function themeOf(label) { return String(label || '').replace(/\s*·\s*/g, '').replace(/线$/, ''); }

  // ---------- Web 墨卡托（与腾讯静态图同投影）+ 底图拉取 ----------
  const mercY = lat => {
    const s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  function mercatorProjector(cLng, cLat, zoom, w, h) {
    const worldSize = 256 * 2 ** zoom;
    const cx = (cLng + 180) / 360 * worldSize;
    const cy = mercY(cLat) * worldSize;
    return p => ({
      x: (p.lng + 180) / 360 * worldSize - cx + w / 2,
      y: mercY(p.lat) * worldSize - cy + h / 2,
    });
  }
  function fitZoom(pts, w, h, pad) {
    const xs = pts.map(p => (p.lng + 180) / 360), ys = pts.map(p => mercY(p.lat));
    const dx = Math.max(...xs) - Math.min(...xs) || 1e-6;
    const dy = Math.max(...ys) - Math.min(...ys) || 1e-6;
    const zx = (w - pad * 2) / (dx * 256), zy = (h - pad * 2) / (dy * 256);
    return Math.max(9, Math.min(13, Math.floor(Math.log2(Math.min(zx, zy)))));
  }
  // 拉真实底图：返回 { img(dataURI Image), proj }，失败返回 null（调用方回退纸色示意）
  const baseMapCache = {};
  async function fetchBaseMap(pts, w, h, pad = 18) {
    const lngs = pts.map(p => p.lng), lats = pts.map(p => p.lat);
    const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const zoom = fitZoom(pts, w, h, pad);
    const cacheKey = `${cLng.toFixed(4)},${cLat.toFixed(4)},${zoom},${w}x${h}`;
    if (baseMapCache[cacheKey]) return baseMapCache[cacheKey];
    const j = await cloudPost('posterImg', {
      center: `${cLat.toFixed(6)},${cLng.toFixed(6)}`, zoom,
      size: `${Math.round(w)}x${Math.round(h)}`, scale: 1,
    }, 15000);
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = 'data:image/png;base64,' + j.base64;
    });
    const out = { img, dataURI: img.src, proj: mercatorProjector(cLng, cLat, zoom, w, h) };
    baseMapCache[cacheKey] = out;
    return out;
  }
  function makeProjector(points, w, h, pad) {
    const xs = [], ys = [];
    let latSum = 0;
    for (const p of points) latSum += p.lat;
    const kx = Math.cos((latSum / Math.max(1, points.length)) * Math.PI / 180);
    for (const p of points) { xs.push(p.lng * kx); ys.push(p.lat); }
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const dx = maxX - minX, dy = maxY - minY;
    const scale = Math.min(
      dx > 0 ? (w - pad * 2) / dx : Infinity,
      dy > 0 ? (h - pad * 2) / dy : Infinity
    );
    if (!isFinite(scale)) {
      return () => ({ x: w / 2, y: h / 2 });
    }
    const offX = (w - dx * scale) / 2, offY = (h - dy * scale) / 2;
    return p => ({
      x: offX + (p.lng * kx - minX) * scale,
      y: h - (offY + (p.lat - minY) * scale),
    });
  }

  // ---------- 路线平滑（中点二次贝塞尔）与柔和底图滤镜 ----------
  // SVG path 字符串版
  function smoothPathD(pts) {
    if (!pts.length) return '';
    if (pts.length < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    return d + ` L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  }
  // Canvas 描画版
  function smoothTrace(ctx, pts) {
    if (!pts.length) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts.length < 3) { pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y)); return; }
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  // 柔和底图滤镜（比原滤镜更退后，路线才是唯一主角）
  const MAP_SOFT_FILTER = 'grayscale(.8) sepia(.12) contrast(.9) brightness(1.05)';
  // genRoute 之后调用：按各日 items 顺序把 spot 对象挂到 route.__stops，供微调
  function attachStops(route, spots) {
    const byId = {};
    spots.forEach(s => { byId[s.id] = s; });
    route.__stops = route.dayPlans.map(dp =>
      dp.items.filter(i => i.type === 'stop').map(i => byId[i.id]).filter(Boolean));
    route.__startMin = route.dayPlans.map(dp => parseHM(dp.startTime));
    refreshSuburb(route);
    return route;
  }
  function refreshSuburb(route) {
    route.__suburb = route.dayPlans.map((dp, i) => {
      const st = route.__stops[i] || [];
      return st.length > 0 && st.every(s => s.suburb);
    });
  }
  function recalcTotals(route) {
    route.totals = {
      km: +route.dayPlans.reduce((t, d) => t + d.stats.km, 0).toFixed(1),
      stops: route.dayPlans.reduce((t, d) => t + d.stats.stops, 0),
      visitMin: route.dayPlans.reduce((t, d) => t + d.stats.visitMin, 0),
      commuteMin: route.dayPlans.reduce((t, d) => t + d.stats.commuteMin, 0),
    };
  }
  // ---------- 云函数适配层（P4）----------
  // Vercel/正式域名：同源 /api/<fn>（rewrite → CloudBase HTTP 触发器）；
  // CloudBase 静态托管/本地预览：直连 CloudBase HTTP 服务地址（函数已带 CORS *）。
  // 任何一步失败都静默回退本地引擎，页面永远可用（红线：一切输出可降级）。
  const API_BASE = /(^|\.)vercel\.app$|(^|\.)decidenow\.asia$/.test(location.hostname)
    ? '/api'
    : 'https://ddlt-d7gvi23us2cc67847.service.tcloudbase.com';
  function cloudAvailable() { return true; }   // CORS 已开，任意源可直连；失败由调用方 catch 回退
  async function cloudPost(fn, body, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${API_BASE}/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      let j = null;
      try { j = await r.json(); } catch (e) { /* 非 JSON */ }
      if (!r.ok) {
        // 透传业务错误码：校验类错误（ORIGIN_*/NOT_ENOUGH_SPOTS/PLAN_EMPTY/CITY_CLOSED）调用方不得回退本地引擎
        const err = new Error((j && j.error) || ('HTTP ' + r.status));
        err.code = (j && j.code) || null;
        err.httpStatus = r.status;
        throw err;
      }
      if (j && j.error) { const err = new Error(j.error); err.code = j.code || null; throw err; }
      return j;
    } finally { clearTimeout(timer); }
  }
  // 云端生成路线：返回 { route, routeId }；失败抛错由调用方回退
  async function cloudGenRoute(opts) {
    const j = await cloudPost('genRoute', opts, 9000);
    return { route: j.route, routeId: j.routeId || null };
  }

  // 云端重排一天（真实通勤）；失败回退本地 retimeDay
  async function retime(route, i) {
    refreshSuburb(route);
    const dp = route.dayPlans[i];
    let res = null;
    if (cloudAvailable()) {
      try {
        res = await cloudPost('reRoute', {
          city: route.city, origin: route.origin, date: dp.date,
          startMin: route.__startMin[i], suburb: route.__suburb[i],
          stops: route.__stops[i].map(s => ({ id: s.id, dur: s.dur })),
        });
      } catch (e) { /* 回退本地 */ }
    }
    if (!res) {
      res = window.Engine.retimeDay(route.__stops[i], route.origin, dp.date, {
        suburb: route.__suburb[i],
        startMin: route.__startMin[i],
      });
    }
    dp.items = res.items;
    dp.dropped = res.dropped;
    dp.stats = res.stats;
    // __stops 回写为实际排入顺序，保证上移/下移与界面一致
    const byId = {};
    route.__stops[i].forEach(s => { byId[s.id] = s; });
    route.__stops[i] = res.items.filter(x => x.type === 'stop').map(x => byId[x.id]).filter(Boolean);
    recalcTotals(route);
  }
  // 分享克隆时按 stop id 从 spots 库重建 __stops（保留卡片上的 dur）
  function rebuildStopsFromLib(route, spots) {
    const byId = {};
    (spots || []).forEach(s => { byId[s.id] = s; });
    route.__stops = route.dayPlans.map(dp =>
      dp.items.filter(i => i.type === 'stop').map(it => {
        const lib = byId[it.id];
        if (lib) return Object.assign({}, lib, { dur: it.dur });
        return {
          id: it.id, name: it.name, cat: it.cat, tags: [], heat: 5,
          dur: it.dur, intro: '', reason: it.reason || '', open: null,
          closed_mon: null, suburb: false, coord: [it.coord.lng, it.coord.lat],
        };
      }));
    route.__startMin = route.dayPlans.map(dp => parseHM(dp.startTime));
    refreshSuburb(route);
    recalcTotals(route);
    return route;
  }

  // ---------- 轻提示 ----------
  let toastTimer = null;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = el('div', 'toast'); document.body.appendChild(t); }
    t.textContent = msg;
    requestAnimationFrame(() => t.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- 底部抽屉 ----------
  function openDrawer(title, build) {
    const mask = el('div', 'drawer-mask');
    const drawer = el('div', 'drawer');
    const head = el('div', 'drawer-head');
    head.appendChild(el('b', null, title));
    const closeBtn = el('button', null, '取消');
    head.appendChild(closeBtn);
    const body = el('div', 'drawer-body');
    drawer.appendChild(head);
    drawer.appendChild(body);
    mask.appendChild(drawer);
    document.body.appendChild(mask);
    function close() { mask.remove(); }
    closeBtn.onclick = close;
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    build(body, close);
    return close;
  }

  return {
    DAY_CN, SPOT_FILES,
    el, svgEl, icon,
    loadCities, loadSpots,
    saveRoute, loadRoute, saveShared, loadShared, saveRequest, loadRequest,
    todayISO, parseHM, fmtHour, fmtDur, fmtHourCn, dateRange, dayCn, pinyinOf, themeOf,
    makeProjector, mercatorProjector, fitZoom, fetchBaseMap,
    smoothPathD, smoothTrace, MAP_SOFT_FILTER,
    attachStops, refreshSuburb, recalcTotals, retime, rebuildStopsFromLib,
    cloudPost, cloudAvailable, cloudGenRoute,
    toast, openDrawer,
  };
})();
