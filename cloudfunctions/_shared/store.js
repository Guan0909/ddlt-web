'use strict';
// CloudBase 文档库访问 + 配额守护。仅在云函数内运行。

const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;

// doc.get() 的 data 是对象；collection.get() 的 data 是数组。统一归一。
function docData(doc) {
  if (!doc || !doc.data) return null;
  return Array.isArray(doc.data) ? doc.data[0] : doc.data;
}

// ---------- 配额守护：单 IP 限频 + 腾讯日调用预算 ----------
// 单 IP 每分钟 20 次；腾讯外部调用日预算 12000 次，达 70% 标记告警，达 100% 熔断降级
const IP_LIMIT_PER_MIN = 20;
const DAILY_TENCENT_BUDGET = 12000;
const ALARM_RATIO = 0.7;

function clientIp(event) {
  const h = event.headers || {};
  return (h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim() || 'unknown';
}

async function rateLimit(event) {
  const ip = clientIp(event);
  const now = new Date();
  const minuteKey = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const id = `ip_${ip}_${minuteKey}`;
  const coll = db.collection('ratelimit');
  try {
    await coll.doc(id).update({ n: _.inc(1) });
    const doc = await coll.doc(id).get();
    const d = docData(doc); return (d && d.n || 1) <= IP_LIMIT_PER_MIN;
  } catch (e) {
    try { await coll.doc(id).set({ n: 1, created_at: now.toISOString() }); return true; }
    catch (e2) { return true; }  // 限频存储失败不阻塞主流程
  }
}

// 每次腾讯调用前记账；返回 true=允许，false=熔断（调用方降级）
async function tencentBudget(n = 1) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const id = `tencent_${dateKey}`;
  const coll = db.collection('guard');
  try {
    await coll.doc(id).update({ n: _.inc(n) });
    const doc = await coll.doc(id).get();
    const d2 = docData(doc); const used = d2 && d2.n || 0;
    if (used === Math.floor(DAILY_TENCENT_BUDGET * ALARM_RATIO)) {
      console.warn(`[配额告警] 腾讯日调用已达 70%（${used}/${DAILY_TENCENT_BUDGET}）`);
    }
    return used <= DAILY_TENCENT_BUDGET;
  } catch (e) {
    try { await coll.doc(id).set({ n, note: '腾讯日调用计数' }); } catch (e2) {}
    return true;
  }
}

// ---------- dist_cache：起点 200m 网格 + TTL（walk/drive 7 天，transit 当天） ----------
function gridKey(lng, lat) {
  const g = v => (Math.floor(v * 500) / 500).toFixed(3);  // ≈200m 网格
  return `${g(lng)},${g(lat)}`;
}
function cacheId(fromLng, fromLat, toId, mode) {
  return `${gridKey(fromLng, fromLat)}__${toId}__${mode}`;
}
function ttlOf(mode) {
  return mode === 'transit'
    ? new Date(new Date().toDateString()).getTime() + 86400000      // 当天 24 点
    : Date.now() + 7 * 86400000;                                    // 7 天
}
async function cacheGet(fromLng, fromLat, toId, mode) {
  try {
    const doc = await db.collection('dist_cache').doc(cacheId(fromLng, fromLat, toId, mode)).get();
    const d = docData(doc);
    if (d && d.expire_at > Date.now()) return { km: d.km, min: d.min };
  } catch (e) {}
  return null;
}
async function cachePut(fromLng, fromLat, toId, mode, km, min) {
  try {
    await db.collection('dist_cache').doc(cacheId(fromLng, fromLat, toId, mode))
      .set({ km, min, updated_at: new Date().toISOString(), expire_at: ttlOf(mode) });
  } catch (e) {}
}

// ---------- routes：128 位不可猜测 ID ----------
function newRouteId() {
  return require('crypto').randomBytes(16).toString('hex');
}
async function routeSave(route) {
  const id = newRouteId();
  await db.collection('routes').doc(id).set({
    city: route.city, days: route.days, startDate: route.startDate,
    origin: route.origin, dayPlans: route.dayPlans, totals: route.totals,
    dayStopIds: route.dayStopIds,
    created_at: new Date().toISOString(),
  });
  return id;
}
async function routeGet(id) {
  if (!/^[0-9a-f]{32}$/.test(id || '')) return null;
  try {
    const doc = await db.collection('routes').doc(id).get();
    return docData(doc);
  } catch (e) { return null; }
}

async function feedbackSave(fb) {
  await db.collection('feedback').add({
    spot_id: fb.spotId || null, route_id: fb.routeId || null,
    text: String(fb.text || '').slice(0, 500),
    created_at: new Date().toISOString(),
  });
}

module.exports = { db, rateLimit, tencentBudget, clientIp, cacheGet, cachePut, routeSave, routeGet, feedbackSave, gridKey };
