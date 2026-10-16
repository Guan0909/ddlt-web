'use strict';
// 云函数本地回归：node scripts/test-functions.js
// 为什么需要这样跑：cloudfunctions/<fn>/ 里没有 store.js / lbs.js —— 它们是 deploy-functions.js
// 打包时从 cloudfunctions/_shared/ 注入的，直接 require 源码跑不起来。这里用同一套打包规则
// （--stage-only）先 stage 到 build/functions/，再把 store / lbs 换成 stub（预置 require.cache），
// 于是参数校验、业务码、限频这些分支都能在本地断言，且 genRoute/reRoute 正例是真跑引擎与真数据。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_FNS = path.join(ROOT, 'build', 'functions');
const FNS = ['feedback', 'genRoute', 'reRoute', 'routePaths'];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
}

// ---------- ① 按部署同款规则打包（不装依赖、不部署） ----------
console.log('打包 --stage-only（与部署同一套规则）…');
execFileSync(process.execPath, [path.join(__dirname, 'deploy-functions.js'), ...FNS, '--stage-only'], {
  cwd: ROOT, stdio: 'inherit',
});

// ---------- ② stub 状态 ----------
const state = { savedFeedback: [], savedRoutes: [], rateOk: true, budgetOk: true, saveThrows: false };
const storeStub = {
  db: {},
  clientIp: () => '203.0.113.9',
  rateLimit: async () => state.rateOk,
  tencentBudget: async () => state.budgetOk,
  cacheGet: async () => null,                                  // 冷缓存：走矩阵/估算分支
  cachePut: async () => {},
  routeSave: async route => { state.savedRoutes.push(route); return 'b'.repeat(32); },
  routeGet: async () => null,
  feedbackSave: async fb => { if (state.saveThrows) throw new Error('db down'); state.savedFeedback.push(fb); },
  gridKey: () => '0,0',
};
const lbsStub = {
  matrix: async () => ({}),                                    // 空矩阵 → 回退 engine.estimateCommute
  direction: async () => ({ km: 1.2, min: 5 }),
  suggestion: async () => [],
  reverseGeocode: async () => null,
  staticMapBuffer: async () => null,
};

function loadFn(fn) {
  const dir = path.join(BUILD_FNS, fn);
  for (const [name, exp] of [['store', storeStub], ['lbs', lbsStub]]) {
    const file = path.join(dir, name + '.js');
    if (!fs.existsSync(file)) throw new Error(`打包缺文件：${file}`);
    require.cache[file] = { id: file, filename: file, loaded: true, exports: exp, children: [], paths: [] };
  }
  const entry = path.join(dir, 'index.js');
  delete require.cache[entry];
  return require(entry);
}

async function call(main, payload, opts = {}) {
  const event = {
    headers: { 'x-forwarded-for': '203.0.113.9' },
    body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(payload),
  };
  const res = await main(event);
  let json = null;
  try { json = JSON.parse(res.body); } catch (e) {}
  return { status: res.statusCode, json };
}

(async () => {
  const genRoute = loadFn('genRoute');
  const reRoute = loadFn('reRoute');
  const feedback = loadFn('feedback');
  const ORIGIN = { name: '天府广场', lng: 104.0657, lat: 30.6572 };
  const spotIds = require(path.join(ROOT, 'data', 'spots', 'chengdu.json')).spots.map(s => s.id);

  // ---------- genRoute ----------
  console.log('\n### genRoute · 起点校验与业务码（§17#7）');
  let r = await call(genRoute.main, { city: '成都', origin: { name: 'x', lng: 104.06 }, days: 2 });
  check('缺 lat → 400 参数不完整', r.status === 400 && r.json.error === '参数不完整', JSON.stringify(r.json));
  r = await call(genRoute.main, { city: '成都', origin: { lng: 104.06, lat: 'abc' }, days: 2 });
  check('lat 非数字 → 400', r.status === 400 && r.json.error === '参数不完整', JSON.stringify(r.json));
  r = await call(genRoute.main, { city: '成都', origin: { lng: 104.06, lat: 200 }, days: 2 });
  check('lat 越界 → 400', r.status === 400 && r.json.error === '参数不完整', JSON.stringify(r.json));
  r = await call(genRoute.main, { city: '成都', origin: { lng: 1e9, lat: 30 }, days: 2 });
  check('lng 越界 → 400', r.status === 400 && r.json.error === '参数不完整', JSON.stringify(r.json));
  r = await call(genRoute.main, { city: '拉萨', origin: ORIGIN, days: 2 });
  check('未开通城市 → CITY_CLOSED', r.status === 400 && r.json.code === 'CITY_CLOSED', JSON.stringify(r.json));
  r = await call(genRoute.main, { city: '重庆', origin: { lng: 116.4, lat: 39.9 }, days: 3 });
  check('起点太远 → ORIGIN_TOO_FAR（校验链未被新守卫短路）', r.status === 400 && r.json.code === 'ORIGIN_TOO_FAR', JSON.stringify(r.json));
  r = await call(genRoute.main, { city: '成都', origin: ORIGIN, days: 2, startDate: '2026-10-20' });
  check('合法请求 → 200 + 逐日路线 + 32 位 routeId',
    r.status === 200 && Array.isArray(r.json.route && r.json.route.dayPlans) && r.json.route.dayPlans.length > 0
    && /^[0-9a-f]{32}$/.test(String(r.json.routeId)), JSON.stringify(r.status));
  check('路线已落库（stub 记录）', state.savedRoutes.length === 1 && state.savedRoutes[0].city === '成都',
    `savedRoutes=${state.savedRoutes.length}`);
  state.rateOk = false;
  r = await call(genRoute.main, { city: '成都', origin: ORIGIN, days: 2 });
  check('限频 → 429', r.status === 429, JSON.stringify(r.status));
  state.rateOk = true;

  // ---------- reRoute ----------
  console.log('\n### reRoute · 业务码与起点校验（§17#4 / §17#7）');
  r = await call(reRoute.main, { city: '拉萨', origin: ORIGIN, date: '2026-10-20', stops: [] });
  check('未开通城市 → 400 + code CITY_CLOSED', r.status === 400 && r.json.code === 'CITY_CLOSED' && /未开通/.test(r.json.error),
    JSON.stringify(r.json));
  r = await call(reRoute.main, { city: '成都', origin: { lng: 104.06 }, date: '2026-10-20', stops: [] });
  check('缺 lat → 400 参数不完整', r.status === 400 && r.json.error === '参数不完整', JSON.stringify(r.json));
  r = await call(reRoute.main, { city: '成都', origin: ORIGIN, date: '2026-10-20' });
  check('缺 stops → 400 参数不完整', r.status === 400 && r.json.error === '参数不完整', JSON.stringify(r.json));
  r = await call(reRoute.main, { city: '成都', origin: ORIGIN, date: '2026-10-20', stops: [] });
  check('空 stops → 200 空日（前端删光当天站点后仍要能重排，勿改成 400）',
    r.status === 200 && Array.isArray(r.json.items) && r.json.stats.stops === 0, JSON.stringify(r.json).slice(0, 100));
  r = await call(reRoute.main, { city: '成都', origin: ORIGIN, date: '2026-10-20', stops: spotIds.slice(0, 3).map(id => ({ id })) });
  check('合法请求 → 200 + items 数组', r.status === 200 && Array.isArray(r.json.items) && Array.isArray(r.json.dropped),
    JSON.stringify(r.json).slice(0, 120));

  // ---------- feedback ----------
  console.log('\n### feedback · routeId 口径与前端接线契约（§16.2 / §17#6）');
  r = await call(feedback.main, { text: '   ' });
  check('空内容 → 400 反馈内容为空', r.status === 400 && r.json.error === '反馈内容为空', JSON.stringify(r.json));
  r = await call(feedback.main, { spotId: 'panda-base', text: '名称写错了' });
  check('无 routeId → 200 且落库 route_id=null',
    r.status === 200 && r.json.saved === true && state.savedFeedback.length === 1
    && state.savedFeedback[0].routeId === null && state.savedFeedback[0].spotId === 'panda-base'
    && state.savedFeedback[0].text === '名称写错了', JSON.stringify(state.savedFeedback));
  r = await call(feedback.main, { routeId: 'not-a-route-id', text: 'x' });
  check('routeId 格式不对 → 400 + BAD_ROUTE_ID 且不落库',
    r.status === 400 && r.json.code === 'BAD_ROUTE_ID' && state.savedFeedback.length === 1, JSON.stringify(r.json));
  r = await call(feedback.main, { routeId: 'A'.repeat(32), text: 'x' });
  check('大写 hex 同样不收（与 routeGet 同口径）', r.status === 400 && r.json.code === 'BAD_ROUTE_ID', JSON.stringify(r.json));
  const rid = 'a1b2c3d4'.repeat(4);
  r = await call(feedback.main, { routeId: rid, spotId: 's'.repeat(100), text: '坐标偏了' });
  check('合法 routeId → 200，spotId 截断到 64',
    r.status === 200 && state.savedFeedback.length === 2
    && state.savedFeedback[1].routeId === rid && state.savedFeedback[1].spotId.length === 64,
    JSON.stringify(state.savedFeedback[1]).slice(0, 120));
  r = await call(feedback.main, null, { rawBody: { text: '对象体也要能解析' } });
  check('event.body 为对象 → 正常受理', r.status === 200 && state.savedFeedback.length === 3, JSON.stringify(r.json));
  r = await call(feedback.main, null, { rawBody: '{坏的 JSON' });
  check('event.body 解析失败 → 400 反馈内容为空', r.status === 400 && r.json.error === '反馈内容为空', JSON.stringify(r.json));
  state.saveThrows = true;
  const origError = console.error; console.error = () => {};   // 预期内的落库失败：静音函数的堆栈日志
  r = await call(feedback.main, { text: 'x' });
  console.error = origError;
  check('落库失败 → 500 提交失败（不抛异常）', r.status === 500 && r.json.error === '提交失败，请稍后再试', JSON.stringify(r.json));
  state.saveThrows = false;
  state.rateOk = false;
  r = await call(feedback.main, { text: 'x' });
  check('限频 → 429', r.status === 429, JSON.stringify(r.status));
  state.rateOk = true;

  // ---------- routePaths：几何处理（纯函数，不联网） ----------
  console.log('\n### routePaths · 抽稀与端头吸附（纯函数）');
  const geom = loadFn('routePaths').geom;
  const dense = [];
  for (let i = 0; i <= 100; i++) dense.push([30.65 + i * 0.0001, 104.05]);   // 每点约 11m 的直线
  const thin = geom.rdp(dense, 12);
  check('抽稀：1.1km 直线 101 点 → ≤3 点', thin.length <= 3, `实际 ${thin.length}`);
  check('抽稀：首尾必须保留', thin[0][0] === dense[0][0] && thin[thin.length - 1][0] === dense[100][0]);
  check('抽稀：L 形拐点不被抹平', geom.rdp([[30.65, 104.05], [30.65, 104.06], [30.66, 104.06]], 12).length === 3);
  const from = { lat: 30.65, lng: 104.05 }, to = { lat: 30.66, lng: 104.06 };
  const nearPts = [[30.6505, 104.0502], [30.6599, 104.0599]];   // 距 from/to 约 59m / 13m
  const snapped = geom.snapEnds(nearPts, from, to);
  check('吸附：≤120m 的端头接到请求坐标', snapped.length === 4 && snapped[0][0] === 30.65 && snapped[3][1] === 104.06, JSON.stringify(snapped));
  check('吸附：>120m 不硬接（不伪造长直线）', geom.snapEnds([[30.66, 104.06], [30.67, 104.07]], from, to).length === 2);
  const once = geom.finalizePath(nearPts, 'walk', from, to);
  const twice = geom.finalizePath(once, 'walk', from, to);
  const thrice = geom.finalizePath(twice, 'walk', from, to);
  check('吸附：处理结果的端点精确落在请求坐标上',
    once[0][0] === from.lat && once[0][1] === from.lng
    && once[once.length - 1][0] === to.lat && once[once.length - 1][1] === to.lng, JSON.stringify(once));
  check('处理稳定：继续处理不再变化（第 2、3 次一致）', JSON.stringify(twice) === JSON.stringify(thrice), JSON.stringify(thrice));
  const devOf = (orig, simp) => Math.max(...orig.map(p => Math.min(...simp.slice(1).map((q, i) => geom.pointSegM(p, simp[i], q)))));
  check('抽稀误差受控：相对原折线 ≤ 步行阈值 6m', devOf(nearPts, twice) <= 6.001, devOf(nearPts, twice).toFixed(2) + 'm');
  check('阈值口径：步行 6m / 公交 8m / 驾车 12m', geom.TOL_M.walk === 6 && geom.TOL_M.transit === 8 && geom.TOL_M.drive === 12 && geom.SNAP_MAX_M === 120);

  console.log(`\n${'='.repeat(58)}`);
  console.log(fail ? `共 ${fail} 项校验失败（通过 ${pass} 项）` : `云函数全部用例通过（${pass} 项）`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
