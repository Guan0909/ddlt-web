'use strict';
// 景点库重构工具（规范见 项目上下文.md §12.5）
// 用法：
//   node scripts/rebuild-library.js --audit                     组成体检（零配额，随时可跑）
//   AMAP_WS_KEY=… node scripts/rebuild-library.js --collect 成都 采集候选池 + 评分/等级（需配额）
//   node scripts/rebuild-library.js --plan 成都                  生成「保留 / 剔除 / 新增」三张清单（零配额）
// 产物：data/spots/<city>.rebuild-pool.json（候选池）、<city>.rebuild-report.json（三张清单）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { amapAround, norm } = require('./repair-coords.js');

const CITY_FILES = {
  '成都': 'chengdu', '北京': 'beijing', '上海': 'shanghai',
  '西安': 'xian', '重庆': 'chongqing', '杭州': 'hangzhou',
  // 第二批次（离线，规则与第一批次完全一致：biz-info 对齐官方名 + 重构删弱项）
  '大理': 'dali', '广州': 'guangzhou', '贵阳': 'guiyang', '合肥': 'hefei',
  '昆明': 'kunming', '拉萨': 'lhasa', '丽江': 'lijiang', '南京': 'nanjing',
  '宁波': 'ningbo', '绍兴': 'shaoxing', '苏州': 'suzhou', '温州': 'wenzhou',
  '无锡': 'wuxi', '香格里拉': 'xianggelila', '西双版纳': 'xishuangbanna', '扬州': 'yangzhou',
};
const CENTERS = {
  chengdu: [104.0657, 30.6572], beijing: [116.3975, 39.9087], shanghai: [121.4737, 31.2304],
  xian: [108.9402, 34.3416], chongqing: [106.5516, 29.5630], hangzhou: [120.1551, 30.2741],
  dali: [100.2676, 25.6065], guangzhou: [113.2644, 23.1291], guiyang: [106.6302, 26.6477],
  hefei: [117.2272, 31.8206], kunming: [102.8329, 24.8801], lhasa: [91.1409, 29.6456],
  lijiang: [100.2330, 26.8721], nanjing: [118.7969, 32.0603], ningbo: [121.5440, 29.8683],
  shaoxing: [120.5802, 30.0303], suzhou: [120.5853, 31.2989], wenzhou: [120.6994, 27.9944],
  wuxi: [120.3119, 31.4912], xianggelila: [99.7066, 27.8289], xishuangbanna: [100.7979, 22.0100],
  yangzhou: [119.4129, 32.3942],
};
// §12.5 目标画像：类目 → 目标上限/下限
const TARGET = {
  core: { cats: ['古迹', '博物馆', '山水', '古镇'], min: 26, max: 34 },
  night: { cats: ['夜景', '演出'], min: 5, max: 8 },
  family: { cats: ['亲子'], min: 4, max: 7 },
  street: { cats: ['街区'], min: 0, max: 8 },
  food: { cats: ['美食'], min: 0, max: 4 },
  park: { cats: ['公园'], min: 0, max: 5 },
  mall: { cats: ['商圈'], min: 0, max: 2 },
};
const CORE_CATS = new Set([...TARGET.core.cats, ...TARGET.night.cats]);

const score = (rating, level, curation) => {
  const nr = typeof rating === 'number' ? Math.max(0, Math.min(1, (rating - 3.5) / 1.5)) : null;
  const lv = level === 'national' ? 1 : level === 'province' ? 0.6 : level === 'city' ? 0.3 : 0;
  const cur = curation ? 1 : 0;
  if (nr === null && lv === 0 && !cur) return null;   // 无任何信号 → 待人工
  return +(0.6 * (nr === null ? lv : nr) + 0.25 * lv + 0.15 * cur).toFixed(3);
};
const heatOf = s => (s === null ? null : Math.max(5, Math.min(10, Math.round(5 + 5 * s))));

function composition(spots) {
  const c = {};
  for (const s of spots) c[s.cat] = (c[s.cat] || 0) + 1;
  const grp = {};
  for (const [k, t] of Object.entries(TARGET)) grp[k] = t.cats.reduce((n, cat) => n + (c[cat] || 0), 0);
  grp.total = spots.length;
  grp.suburb = spots.filter(s => s.suburb).length;
  grp.coreRatio = +((spots.filter(s => CORE_CATS.has(s.cat)).length / Math.max(1, spots.length)) * 100).toFixed(0);
  return { byCat: c, byGroup: grp };
}

function audit() {
  const rows = [];
  for (const [city, file] of Object.entries(CITY_FILES)) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'spots', file + '.json'), 'utf8'));
    const spots = d.spots || [];
    const comp = composition(spots);
    const gaps = [];
    for (const [k, t] of Object.entries(TARGET)) {
      const n = comp.byGroup[k];
      if (n > t.max) gaps.push(k + ' 超 ' + (n - t.max));
    }
    if (comp.byGroup.suburb < 4) gaps.push('远郊仅 ' + comp.byGroup.suburb);
    if (comp.byGroup.coreRatio < 60) gaps.push('核心类 ' + comp.byGroup.coreRatio + '%');
    rows.push({ city, total: spots.length, core: comp.byGroup.core + comp.byGroup.night, coreRatio: comp.byGroup.coreRatio, street: comp.byGroup.street, food: comp.byGroup.food, park: comp.byGroup.park, mall: comp.byGroup.mall, suburb: comp.byGroup.suburb, gaps });
  }
  console.log('城市   总数  核心类  核心占比  街区/美食/公园/商圈  远郊   缺口');
  for (const r of rows) {
    console.log(r.city.padEnd(5) + String(r.total).padStart(4) + String(r.core).padStart(7) + String(r.coreRatio + '%').padStart(8) +
      '   ' + [r.street, r.food, r.park, r.mall].map(v => String(v).padStart(2)).join('/') +
      String(r.suburb).padStart(6) + '   ' + (r.gaps.join('；') || '达标'));
  }
}

async function collect(city) {
  const file = CITY_FILES[city];
  if (!file) { console.error('未知城市：' + city + '（支持：' + Object.keys(CITY_FILES).join('/') + '）'); process.exit(2); }
  const AK = process.env.AMAP_KEY || process.env.AMAP_WS_KEY;
  if (!AK) { console.error('需要 AMAP_KEY 或 AMAP_WS_KEY'); process.exit(2); }
  const [lng, lat] = CENTERS[file];
  const pool = [];
  const seen = new Set();
  const rounds = [
    ['风景名胜', 50000], ['博物馆', 50000], ['公园', 50000], ['古镇', 50000],
    ['主题乐园', 50000], ['文化街区', 30000], ['美食街', 20000],
  ];
  for (const [kw, radius] of rounds) {
    for (let page = 0; page < 3; page++) {
      const url = (process.env.AMAP_BASE || 'https://restapi.amap.com').replace(/\/+$/, '') + '/v3/place/around?location=' + lng + ',' + lat + '&radius=' + radius +
        '&keywords=' + encodeURIComponent(kw) + '&sortrule=weight&extensions=all&offset=25&page=' + (page + 1) + '&key=' + AK;
      const j = await (await fetch(url)).json();
      if (String(j.status) !== '1') { console.error('  采集失败 ' + kw + ' page' + (page + 1) + '：' + j.info); break; }
      const pois = j.pois || [];
      for (const p of pois) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const [plng, plat] = String(p.location || '').split(',').map(Number);
        const type = String(p.type || '');
        pool.push({
          id: p.id, name: p.name, coord: [plng, plat], type,
          rating: p.biz_ext && p.biz_ext.rating ? Number(p.biz_ext.rating) : null,
          level: /国家级/.test(type) ? 'national' : /省级/.test(type) ? 'province' : /市级/.test(type) ? 'city' : null,
          kw,
        });
      }
      await new Promise(r => setTimeout(r, 400));
      if (pois.length < 25) break;
    }
  }
  const out = path.join(ROOT, 'data', 'spots', file + '.rebuild-pool.json');
  fs.writeFileSync(out, JSON.stringify({ city, date: new Date().toISOString().slice(0, 10), count: pool.length, pool }, null, 2) + '\n');
  const withRating = pool.filter(p => p.rating).length;
  console.log(city + '：候选池 ' + pool.length + ' 个（有评分 ' + withRating + '）→ ' + path.relative(ROOT, out));
}

function plan(city) {
  const file = CITY_FILES[city];
  const libPath = path.join(ROOT, 'data', 'spots', file + '.json');
  const d = JSON.parse(fs.readFileSync(libPath, 'utf8'));
  const spots = d.spots || [];
  const poolPath = path.join(ROOT, 'data', 'spots', file + '.rebuild-pool.json');
  const pool = fs.existsSync(poolPath) ? JSON.parse(fs.readFileSync(poolPath, 'utf8')).pool : [];
  const byName = new Map(pool.map(p => [norm(p.name), p]));
  // 判定规则（2026-10-17 按产品口径改）：高德评分满分 5 分
  //   ① 知名必留：FAME 名单 / 评分 ≥4.5 / POI 类型含风景名胜·国家级景点；
  //   ② 演出/体验类（《不眠之夜》沉浸式戏剧）不是地理地点 → 删；
  //   ③ 核心类：评分 <4.0 删，其余留；
  //   ④ 受限类目（街区/公园/美食/商圈）按配额留高分者；
  //   ⑤ 拿不到评分 = 不确定 → 除知名/风景名胜外，按用户口径直接删。
  const CORE = new Set(['古迹', '博物馆', '山水', '古镇', '夜景', '演出', '亲子']);
  const QUOTA = { 街区: 8, 美食: 4, 公园: 5, 商圈: 2 };
  // 可删黑名单（产品明确判断为低价值：景区/文旅盘性质）
  const BLACKLIST = { 成都: ['麓湖水城'] };
  // 必留名单（非常知名的地标/景点，用户口径：这类不可删）
  const FAME = {
    成都: ['宽窄巷子', '锦里', '武侯祠', '杜甫草堂', '大熊猫', '都江堰', '青城山', '春熙路', '太古里', '人民公园', '金沙遗址', '成都博物馆', '西岭雪山', '天府广场', '文殊院', '罨画池', '望江楼', '九眼桥'],
    北京: ['天安门', '故宫', '长城', '颐和园', '天坛', '圆明园', '雍和宫', '恭王府', '南锣鼓巷', '什刹海', '北海公园', '景山', '鸟巢', '水立方', '798', '王府井', '三里屯', '军事博物馆', '国家博物馆', '十三陵', '潭柘寺', '红螺寺', '古北水镇', '司马台', '爨底下', '琉璃厂'],
    上海: ['外滩', '豫园', '迪士尼', '东方明珠', '南京路', '陆家嘴', '新天地', '田子坊', '上海博物馆', '科技馆', '朱家角', '武康路', '静安寺', '前滩太古里', '世博', '七宝', '召稼楼', '天文馆', '野生动物园', '东方绿舟'],
    西安: ['兵马俑', '城墙', '大雁塔', '钟楼', '鼓楼', '回民街', '陕西历史博物馆', '华清宫', '华山', '大唐不夜城', '碑林', '大明宫', '永兴坊', '法门寺', '乾陵', '茂陵', '汉阳陵', '翠华山', '秦岭'],
    重庆: ['洪崖洞', '解放碑', '磁器口', '长江索道', '李子坝', '朝天门', '十八梯', '南山', '鹅岭', '两江夜游', '三峡博物馆', '钓鱼城', '大足石刻', '武隆', '白帝城', '仙女山', '金佛山', '四面山', '龚滩', '乌江画廊'],
    杭州: ['西湖', '灵隐', '雷峰塔', '断桥', '苏堤', '西溪', '千岛湖', '河坊街', '南宋御街', '杭州植物园', '九溪', '龙井', '宋城', '六和塔', '岳王庙', '运河', '钱王祠', '满觉陇', '京杭大运河'],
    // —— 第二批次（离线城，规则与第一批次一致）——
    大理: ['洱海', '大理古城', '崇圣寺', '三塔', '苍山', '喜洲', '双廊', '沙溪', '蝴蝶泉', '巍山古城', '鸡足山', '无量山', '天龙八部'],
    广州: ['广州塔', '陈家祠', '沙面', '白云山', '珠江夜游', '上下九', '北京路', '越秀公园', '长隆', '华南植物园', '黄埔军校', '永庆坊', '沙湾古镇', '西关', '荔枝湾'],
    贵阳: ['黔灵山', '甲秀楼', '青岩古镇', '花溪', '天河潭', '多彩贵州城', '贵州省博物馆', '观山湖', '阿哈湖', '黔灵'],
    合肥: ['包公园', '逍遥津', '三河古镇', '大蜀山', '安徽博物院', '天鹅湖', '罍街', '徽园', '李鸿章故居', '巢湖', '紫蓬山'],
    昆明: ['石林', '滇池', '翠湖', '云南民族村', '西山龙门', '金马碧鸡', '大观楼', '世博园', '圆通寺', '官渡古镇', '九乡', '轿子雪山', '东川红土地'],
    拉萨: ['布达拉宫', '大昭寺', '八廓街', '罗布林卡', '色拉寺', '哲蚌寺', '甘丹寺', '纳木错', '羊卓雍措', '小昭寺', '西藏博物馆', '药王山', '宗角禄康'],
    丽江: ['丽江古城', '玉龙雪山', '束河', '白沙', '泸沽湖', '蓝月谷', '拉市海', '木府', '黑龙潭', '虎跳峡', '观音峡', '万古楼', '四方街'],
    南京: ['中山陵', '夫子庙', '秦淮河', '明孝陵', '总统府', '玄武湖', '南京博物院', '鸡鸣寺', '先锋书店', '老门东', '栖霞山', '阅江楼', '南京城墙', '汤山'],
    宁波: ['天一阁', '老外滩', '溪口', '奉化', '河姆渡', '宁波博物馆', '慈城', '东钱湖', '月湖', '天一广场', '象山影视城', '四明山', '雪窦山'],
    绍兴: ['鲁迅故里', '沈园', '兰亭', '东湖', '柯岩', '大禹陵', '仓桥直街', '安昌古镇', '会稽山', '西施故里', '覆卮山', '绍兴古城'],
    苏州: ['拙政园', '虎丘', '留园', '狮子林', '网师园', '苏州博物馆', '平江路', '山塘街', '寒山寺', '周庄', '同里', '木渎', '金鸡湖', '沧浪亭', '盘门', '观前街'],
    温州: ['雁荡山', '楠溪江', '江心屿', '洞头', '南麂岛', '泰顺廊桥', '泽雅', '五马街', '温州博物馆', '百丈漈', '仙岩'],
    无锡: ['鼋头渚', '灵山大佛', '惠山古镇', '三国城', '水浒城', '南长街', '清名桥', '荡口古镇', '蠡园', '梅园', '拈花湾', '宜兴竹海', '灵山'],
    香格里拉: ['普达措', '独克宗', '松赞林寺', '纳帕海', '梅里雪山', '虎跳峡', '巴拉格宗', '白水台', '雨崩', '石卡雪山', '龟山公园'],
    西双版纳: ['热带植物园', '曼听公园', '野象谷', '告庄西双景', '傣族园', '望天树', '基诺山', '大金塔', '六国水上市场', '打洛', '星光夜市', '热带花卉园'],
    扬州: ['瘦西湖', '个园', '何园', '东关街', '大明寺', '双博馆', '茱萸湾', '宋夹城', '冶春', '皮市街', '仁丰里', '汪氏小苑', '扬州八怪'],
  };
  const SHOW_RE = /《[^》]*》|沉浸式|戏剧|音乐剧|话剧|舞台剧|光影秀|水秀|演唱会/;
  const VENUE_RE = /大剧院|剧场|剧院|音乐厅|演艺中心/;
  const FAME_RATING = 4.5;   // 5 分制：≥4.5 视为「非常知名」
  const fames = FAME[city] || [];
  const keep = [], drop = [], manual = [], heatChanges = [];
  const limited = {};
  for (const s of spots) {
    // 池子匹配：先精确，再「互相包含」里取评分最高者（避免被同名的子设施/低分项拖走）
    const loose = pool.filter(p => norm(p.name).includes(norm(s.name)) || norm(s.name).includes(norm(p.name)))
      .sort((a, b) => (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating));
    const hit = byName.get(norm(s.name)) || loose[0];
    // 评分优先用「库内回填值」（biz-info 已按 POI id 精确取），池子评分只作兜底
    const libRating = (typeof s.rating === 'number' && s.rating > 0) ? s.rating : null;
    const rating = libRating != null ? libRating : (hit && hit.rating != null ? hit.rating : null);
    const level = (hit && hit.level) || null;
    const sc = score(rating, level, false);
    const rec = { id: s.id, name: s.name, cat: s.cat, heat: s.heat, rating, level, score: sc };
    const h = heatOf(sc);
    if (h !== null && h !== s.heat) heatChanges.push({ id: s.id, name: s.name, from: s.heat, to: h });
    rec.heatNew = h;
    const famename = fames.some(k => s.name.includes(k));
    const banned = (BLACKLIST[city] || []).some(k => s.name.includes(k));
    if (banned) { drop.push({ ...rec, why: '低价值黑名单（景区/文旅盘）' }); continue; }
    const goodType = (!!hit && /风景名胜|国家级景点|省级景点/.test(hit.type))
      || (rating != null && rating >= 4.6 && CORE.has(s.cat));
    if (SHOW_RE.test(s.name) && !VENUE_RE.test(s.name)) { drop.push({ ...rec, why: '演出/体验类，非地理地点' }); continue; }
    if (famename) { keep.push({ ...rec, why: '知名地标（必留名单）' }); continue; }
    if (CORE.has(s.cat)) {
      // 核心类：确定性优先——有评分看评分（≥4.0 留；≥4.5 视为非常知名必留）；无评分且非风景名胜 → 按口径删
      if (rec.rating == null && !goodType) drop.push({ ...rec, why: '无评分且非风景名胜（不确定即删）' });
      else if (rec.rating == null) keep.push({ ...rec, why: '风景名胜/国家级（无评分但类型可信）' });
      else if (rec.rating < 4.0) drop.push({ ...rec, why: '评分 ' + rec.rating + ' < 4.0' });
      else keep.push({ ...rec, why: rec.rating >= FAME_RATING ? '评分 ' + rec.rating + ' ≥4.5（非常知名）' : undefined });
    } else {
      // 受限类目：不看单个高分，统一按「类目配额 + 评分排序」减量（§12.5 目标画像）
      (limited[s.cat] = limited[s.cat] || []).push(rec);
    }
  }
  // 受限类目：按评分（缺失排后）排序，保留 quota 内的高分者
  for (const [cat, list] of Object.entries(limited)) {
    list.sort((a, b) => (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating));
    const quota = QUOTA[cat] == null ? 5 : QUOTA[cat];
    list.forEach((rec, i) => {
      if (i < quota) keep.push(rec);
      else drop.push({ ...rec, why: '类目配额（' + cat + ' ≤' + quota + '）且评分靠后' + (rec.rating == null ? '/无评分' : '') });
    });
  }
  const inLib = new Set(spots.map(s => norm(s.name)));
  const add = pool.filter(p => score(p.rating, p.level, false) !== null && score(p.rating, p.level, false) >= 0.6
      && (p.rating == null || p.rating >= 4.3) && !inLib.has(norm(p.name)))
    .sort((a, b) => score(b.rating, b.level, false) - score(a.rating, a.level, false))
    .map(p => ({ name: p.name, coord: p.coord, type: p.type, rating: p.rating, level: p.level, score: score(p.rating, p.level, false), heat: heatOf(score(p.rating, p.level, false)) }))
    .slice(0, 30);
  // 改名可能造成重名（两个点被对齐到同一官方 POI）：单独报出来
  const seenName = new Map(), duplicates = [];
  for (const s of spots) {
    const k = norm(s.name);
    if (seenName.has(k)) duplicates.push({ name: s.name, ids: [seenName.get(k), s.id] });
    else seenName.set(k, s.id);
  }
  const comp = composition(spots);
  const date = new Date().toISOString().slice(0, 10);
  const report = { city, date, compositionBefore: comp, keep, drop, manual, add, heatChanges, duplicates };
  const out = path.join(ROOT, 'data', 'spots', file + '.rebuild-report.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  // --apply：真删点 + heat 按评分重算（数据在 git 里可回滚）
  if (process.argv.includes('--apply')) {
    const dropIds = new Set(drop.map(x => x.id));
    const before = spots.length;
    d.spots = spots.filter(s => !dropIds.has(s.id));
    const heatMap = new Map(heatChanges.map(x => [x.id, x.to]));
    for (const s of d.spots) { const h = heatMap.get(s.id); if (h != null && h !== s.heat) { s.heat_prev = s.heat; s.heat = h; } }
    d._meta.rebuild_at = date;
    fs.writeFileSync(libPath, JSON.stringify(d, null, 2) + '\n');
    fs.writeFileSync(libPath.replace(/\.json$/, '.rebuild-apply-report.json'),
      JSON.stringify({ city, date, before, after: d.spots.length, removed: drop, heatApplied: heatChanges.length }, null, 2) + '\n');
    console.log('  ✅ 已应用：' + before + ' → ' + d.spots.length + ' 点（删 ' + drop.length + '），heat 重算 ' + heatChanges.length);
  }
  if (duplicates.length) console.log('  ⚠ 重名 ' + duplicates.length + ' 组：' + duplicates.map(x => x.name).join('、'));
  console.log(city + '：保留 ' + keep.length + ' / 剔除 ' + drop.length + ' / 待人工 ' + manual.length + ' / 建议新增 ' + add.length + ' / heat 变动 ' + heatChanges.length);
  console.log('  报告：' + path.relative(ROOT, out));
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--audit') || !args.length) return audit();
  const iC = args.indexOf('--collect'), iP = args.indexOf('--plan');
  const city = iC >= 0 ? args[iC + 1] : (iP >= 0 ? args[iP + 1] : undefined);
  if (args.includes('--collect')) return collect(city);
  if (args.includes('--plan')) return plan(city);
  console.log('用法：--audit | --collect <城市> | --plan <城市>');
})();
