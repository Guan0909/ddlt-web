'use strict';
// 标志性景点补录：对 data/iconic.json 里每城的关键词，缺库的用高德名称搜索补入（规则同建库器）
// 用法：AMAP_BASE=… AMAP_KEY=… node scripts/supplement-iconic.js [城市…] [--apply]
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const amap = require('./lib/amap.js');
const ROOT = path.join(__dirname, '..');
const d0 = path.join(ROOT, 'data', 'spots');
const ICONIC = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'iconic.json'), 'utf8'));
const REG = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-registry.json'), 'utf8'));
const FILE = {};
for (const [cn, v] of Object.entries(REG)) FILE[cn] = { file: v.file, center: v.center };
Object.assign(FILE, {
  成都: { file: 'chengdu', center: [104.0657, 30.6572] }, 北京: { file: 'beijing', center: [116.3975, 39.9087] },
  上海: { file: 'shanghai', center: [121.4737, 31.2304] }, 西安: { file: 'xian', center: [108.9402, 34.3416] },
  重庆: { file: 'chongqing', center: [106.5516, 29.5630] }, 杭州: { file: 'hangzhou', center: [120.1551, 30.2741] },
  大理: { file: 'dali', center: [100.2676, 25.6065] }, 广州: { file: 'guangzhou', center: [113.2644, 23.1291] },
  贵阳: { file: 'guiyang', center: [106.6302, 26.6477] }, 合肥: { file: 'hefei', center: [117.2272, 31.8206] },
  昆明: { file: 'kunming', center: [102.8329, 24.8801] }, 拉萨: { file: 'lhasa', center: [91.1409, 29.6456] },
  丽江: { file: 'lijiang', center: [100.2330, 26.8721] }, 南京: { file: 'nanjing', center: [118.7969, 32.0603] },
  宁波: { file: 'ningbo', center: [121.5440, 29.8683] }, 绍兴: { file: 'shaoxing', center: [120.5802, 30.0303] },
  苏州: { file: 'suzhou', center: [120.5853, 31.2989] }, 温州: { file: 'wenzhou', center: [120.6994, 27.9944] },
  无锡: { file: 'wuxi', center: [120.3119, 31.4912] }, 香格里拉: { file: 'xianggelila', center: [99.7066, 27.8289] },
  西双版纳: { file: 'xishuangbanna', center: [100.7979, 22.0100] }, 扬州: { file: 'yangzhou', center: [119.4129, 32.3942] },
});
const BAD_TYPE = /地铁站|公交车站|公交站|售票处|停车场|入口|出口|检票|收费站|道路名|地名地址|公司|写字楼|便利店|ATM|餐厅|餐饮|快餐|小吃|咖啡|茶楼|酒家|饭店|商店|超市|银行|酒店|宾馆|民宿|加油站|充电|司机之家|码头|游船|客运站|集散中心|游客中心|政府机关|住宅|公寓|小区|学校|医院/;
const SHOP_NAME = /[（(][^）)]*店[）)]\s*$|(店|铺|铺面房|摊位|专柜|旗舰店|商城|公寓|售楼处)$/;
const PLACE_TYPE = /风景名胜|旅游景点|博物馆|博物院|纪念馆|美术馆|公园|古镇|古街|寺|庙|宫|陵|塔|遗址|故居|文化|乐园|主题公园|游乐场|景区|园林|湿地|湖泊|山|峡谷|溶洞|瀑布|温泉|广场|步行街|商业街|特色商业街|摩天轮|观景/;
const DUR = { 古镇: 180, 山水: 180, 亲子: 210, 古迹: 120, 博物馆: 120, 公园: 90, 街区: 90, 夜景: 90, 美食: 75, 演出: 120, 商圈: 60 };
const norm = s => String(s || '').replace(/[\s（）()·\-—／\/]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function hav(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function mapCat(type, name) {
  const t = String(type || '') + ' ' + String(name || '');
  if (/古镇|古街|老街|古城|古村/.test(t)) return '古镇';
  if (/博物馆|博物院|美术馆|纪念馆|科技馆|展览馆|陈列馆|艺术中心/.test(t)) return '博物馆';
  if (/乐园|主题乐园|水世界|海洋馆|水族馆|动物园|欢乐谷/.test(t)) return '亲子';
  if (/植物园|园林|花园|绿地/.test(t)) return '公园';
  if (/夜景|剧院|剧场|演出|灯光秀|夜游|电视塔|观光厅/.test(t)) return '夜景';
  if (/炮台|古迹|遗址|寺|庙|宫|陵|塔|故居|祠堂|关隘|城楼|会馆|书院|石窟|石刻/.test(t)) return '古迹';
  if (/森林公园|湿地公园|地质公园/.test(t)) return '山水';
  if (/公园/.test(t)) return '公园';
  if (/特色商业街|文化街区|历史文化街|街区|胡同|里弄|坊/.test(t)) return '街区';
  if (/步行街|商圈|购物|商场|商业中心/.test(t)) return '商圈';
  if (/美食|小吃|餐饮/.test(t)) return '美食';
  if (/风景名胜|国家级景点|省级景点|景区|山水|山|湖|湿地|森林|峡谷|溶洞|瀑布|温泉/.test(t)) return '山水';
  return '街区';
}
function levelOf(type) { if (/国家级景点/.test(type)) return 1; if (/省级景点/.test(type)) return 0.6; return 0; }
function heatOf(rating, type) {
  const nr = Math.max(0, Math.min(1, (rating - 3.5) / 1.5));
  const lv = levelOf(type);
  return Math.max(5, Math.min(10, Math.round(5 + 5 * (0.6 * nr + 0.25 * lv))));
}
const pickVariant = (name, arr) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 100000; return arr[h % arr.length]; };
function template(s) {
  const full = s.dur >= 180 ? '一整天' : s.dur >= 120 ? '半天' : '一小时上下';
  const loc = s.suburb ? '在城郊' : '在城内';
  const INTRO = { 古镇: ['古镇街区，' + loc + '，适合留' + full + '边走边吃。'], 山水: ['自然山水，' + loc + '，排' + full + '。'], 公园: ['城市公园，' + loc + '，走一圈' + full + '。'], 古迹: ['历史古迹，' + loc + '，看' + full + '。'], 博物馆: ['博物馆，' + loc + '，看展两小时上下。'], 夜景: ['适合入夜再看的地标，' + loc + '。'], 亲子: ['适合带娃的景点，' + loc + '，排一整个上午。'], 街区: ['街区，' + loc + '，边走边吃一两小时。'], 美食: ['吃的街区，' + loc + '，饭点来。'], 商圈: ['商圈，' + loc + '，顺路逛一小时。'] };
  const REASON = { 古镇: ['留半天，把饭点安排在镇上', '傍晚进来，灯亮之后更好看'], 山水: ['赶早进山，中午前到主要观景点', '上午来，慢慢走'], 公园: ['清晨或傍晚来，走一圈就够', '顺路进来歇脚就好'], 古迹: ['上午来，人少光线也好', '避开正午，慢慢看'], 博物馆: ['午后进馆，躲开一天里最热的时段', '开门就到，人少先看常设展'], 夜景: ['等灯亮之后再来', '傍晚先到附近，天黑再上去'], 亲子: ['带娃排一整个上午', '开门就到，午后孩子容易累'], 街区: ['傍晚进来，边走边吃', '饭点前到，少排队'], 美食: ['饭点提前半小时到', '两个人分着吃，多试几家'], 商圈: ['顺路逛一逛就好', '傍晚人多，早点来'] };
  return { intro: pickVariant(s.name, INTRO[s.cat] || INTRO.街区).slice(0, 45), reason: pickVariant(s.name + 'r', REASON[s.cat] || REASON.街区).slice(0, 24) };
}
async function findPoi(name, city) {
  const tries = [
    { keywords: name, city, citylimit: 'true', extensions: 'all', offset: 10 },
    { keywords: name, city, citylimit: 'false', extensions: 'all', offset: 10 },
    { keywords: name + '景区', city, citylimit: 'false', extensions: 'all', offset: 5 },
  ];
  for (const params of tries) {
    let j;
    try { j = await amap.get('/v3/place/text', params); } catch (e) { continue; }
    const list = (j.pois || []).map(amap.normPoi).filter(p => p.coord[0]);
    const ok = list.filter(p => PLACE_TYPE.test(p.type) && !BAD_TYPE.test(p.type) && !SHOP_NAME.test(p.name) && (p.rating == null || p.rating >= 4.0));
    // 排序：名字含关键词优先 → 无连字符子区域优先 → 以关键词开头优先 → 评分高优先
    const rank = p => {
      const n = norm(p.name), k = norm(name);
      let r = 0;
      if (n === k) r += 300;                    // 与关键词完全相同最优先
      else if (n.startsWith(k)) r += 150;       // 以关键词开头（官方全称）
      else if (n.includes(k)) r += 80;          // 包含关键词
      if (!/[-－·]/.test(p.name)) r += 40;      // 无连字符子区域
      if (!/(观景台|观景平台|入口|出口|售票|停车场|游客中心|集散中心|码头|四号陵|一号陵|遗址区)$/.test(p.name)) r += 30;
      if (/(观景台|观景平台|售|停车|入口|出口)/.test(p.name)) r -= 120;   // 子设施重罚
      r += (p.rating || 0) * 2;
      return r;
    };
    const best = ok.sort((a, b) => rank(b) - rank(a))[0];
    if (best) return best;
    await sleep(220);
  }
  return null;
}
(async () => {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const only = args.filter(a => !a.startsWith('--'));
  const today = new Date().toISOString().slice(0, 10);
  let added = 0, skipped = 0, failed = 0;
  for (const [cn, keys] of Object.entries(ICONIC)) {
    if (only.length && !only.includes(cn)) continue;
    const meta = FILE[cn];
    if (!meta) { console.log('未映射：' + cn); continue; }
    const libPath = path.join(d0, meta.file + '.json');
    if (!fs.existsSync(libPath)) continue;
    const d = JSON.parse(fs.readFileSync(libPath, 'utf8'));
    const names = (d.spots || []).map(s => norm(s.name));
    const missing = keys.filter(k => !names.some(n => n.includes(norm(k))));
    if (!missing.length) continue;
    const cityAdded = [];
    for (const key of missing) {
      const poi = await findPoi(key, cn);
      await sleep(220);
      if (!poi) { failed++; console.log('  ✗ ' + cn + '｜' + key + '：高德未找到'); continue; }
      if (names.some(n => n.includes(norm(poi.name)))) { skipped++; continue; }
      const cat = mapCat(poi.type, poi.name);
      const dist = hav(meta.center, poi.coord);
      const s = {
        id: 'x' + crypto.createHash('md5').update(meta.file + ':' + norm(poi.name)).digest('hex').slice(0, 8),
        name: poi.name, cat,
        tags: [levelOf(poi.type) === 1 ? '国家级' : levelOf(poi.type) === 0.6 ? '省级' : null, dist > 25000 ? '远郊' : null].filter(Boolean),
        heat: heatOf(poi.rating || 4.5, poi.type), dur: DUR[cat] || 90, intro: '', reason: '',
        open: (() => { const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(poi.openTime || '').trim()); if (m) return String(m[1]).padStart(2, '0') + ':' + m[2] + '-' + String(m[2]).padStart(2, '0') + ':' + m[4]; if (/24\s*小时/.test(poi.openText || '')) return '00:00-23:59'; return null; })(),
        closed_mon: null, suburb: dist > 25000, coord: [+poi.coord[0].toFixed(6), +poi.coord[1].toFixed(6)],
        coord_src: 'amap', amap_poi_id: poi.id, refreshed_at: today, verify_src: 'amap', verified_at: today,
        rating: poi.rating, biz_src: 'amap', biz_at: today, added_at: today, note: '标志性景点补录',
      };
      const t = template(s); s.intro = t.intro; s.reason = t.reason;
      if (poi.openText) s.open_text = poi.openText;
      if (poi.tel) s.tel = poi.tel;
      if (poi.photo) s.photo = poi.photo;
      d.spots.push(s);
      names.push(norm(s.name));
      cityAdded.push(s.name);
      added++;
    }
    if (cityAdded.length) {
      console.log('  ' + cn + ' +' + cityAdded.length + '：' + cityAdded.join('、'));
      if (APPLY) fs.writeFileSync(libPath, JSON.stringify(d, null, 2) + '\n');
    }
  }
  console.log('\n补录 ' + added + ' 个（跳过重复 ' + skipped + '，高德未找到 ' + failed + '）' + (APPLY ? '' : '（干跑，加 --apply 写库）'));
})().catch(e => { console.error(e); process.exit(1); });
