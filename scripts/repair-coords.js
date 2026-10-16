'use strict';
// 估算坐标修复：只处理 coord_src === 'estimate' 的点，用「腾讯 + 高德双源一致」做判据。
// 用法：
//   干跑： node scripts/repair-coords.js data/spots/xian.json --dry-run
//   修复： TENCENT_WS_KEY=… AMAP_WS_KEY=… node scripts/repair-coords.js data/spots/xian.json [--apply]
//
// 为什么需要它：backfill.js 的容差（普通 2500m / 远郊 5000m）是为「估计坐标大体正确、只需微调」
// 设计的；实测发现部分城市的 estimate 点系统性偏了 3~19km（如西安钟楼 9.1km），于是全部被判「对不上」
// 而永远修不了。本脚本换判据：**两家服务商对同一名称给出的坐标互相吻合（≤ CONFIRM_M）** 才认定
// 「真实位置确实在那里」，此时才覆盖；两家不一致或只有一家命中就保留原值并列入报告，交人工复核。
//
// 安全边界：只改 estimate 点；默认不写文件（需 --apply）；写入前逐条记录 before/after 漂移。

const fs = require('fs');
const path = require('path');

const CONFIRM_M = 300;        // 第一档：双源一致阈值（普通点）
const CONFIRM_M_SUBURB = 600; // 第一档远郊放宽（POI 中心定义差异更大）
const LOOSE_M = 1000;         // 第二档：双源一致阈值（仅当名称「完全相等」时才用）
const LOOSE_M_SUBURB = 1500;  // 第二档远郊
const MAX_MOVE_M = 20000;     // 只用高德时的位移上限：超过就当成同名异地，不落盘
// 第二档存在的理由：街区/道路型 POI（回民街、洒金桥）两家给的「中心」天然差几百米，但两边都离我们的
// 估算 9km 远——此时原值必错，取腾讯坐标远好于不修。名称必须完全相等，避免「同名异地」误修
// （乾陵/华山/法门寺这类在别处同名 POI 的点，正是靠这一条挡住的）。
const THROTTLE_MS = 400;   // 腾讯个人版 5 QPS：150ms 会偶发 status=121（提示写的是日配额，实为突发限流）
const AROUND_RADIUS_M = 500;   // 周边召回半径：我们的坐标若正确，真实 POI 必在此范围内
const AI_URL = process.env.AI_BASE_URL ? process.env.AI_BASE_URL.replace(/\/$/, '') + '/chat/completions'
  : 'https://new.fluapi.com/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4.1-flash';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hav = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
};
// 归一：去掉括号/间隔号后的后缀，去空白，转小写
const norm = s => String(s || '').replace(/[·（(【\[].*$/, '').replace(/\s+/g, '').toLowerCase();
const baseName = s => String(s || '').split(/[（(·]/)[0] || s;

async function tencentSearch(kw, city, key) {
  const url = 'https://apis.map.qq.com/ws/place/v1/search' +
    `?keyword=${encodeURIComponent(kw)}&boundary=${encodeURIComponent(`region(${city},0)`)}&page_size=10&page_index=1&key=${key}`;
  const j = await (await fetch(url)).json();
  if (j.status !== 0) throw new Error(`腾讯 status=${j.status} ${j.message || ''}`);
  return (j.data || []).map(d => ({ title: d.title, coord: [d.location.lng, d.location.lat], id: d.id, addr: d.address || '', cat: d.category || '' }));
}
// 高德周边搜索：给定坐标附近找 POI（用于「名字对不上但地方真实存在」的别名判定）
async function amapAround(lng, lat, key, kw, radius) {
  const u = 'https://restapi.amap.com/v3/place/around?location=' + lng + ',' + lat + '&radius=' + (radius || AROUND_RADIUS_M) +
    (kw ? '&keywords=' + encodeURIComponent(kw) : '') + '&offset=20&key=' + key;
  const j = await (await fetch(u)).json();
  return (j.pois || []).map(p => {
    const [plng, plat] = String(p.location || '').split(',').map(Number);
    return { title: p.name, coord: [plng, plat], id: p.id, addr: p.address || '', cat: p.type || '' };
  }).filter(p => p.coord[0]);
}
// LLM 裁判：只允许在给定候选里挑，或全部否决（{-1}）。幻觉无法引入新地点。
// 返回 {pick, why} 或 null。**null 表示「裁判不可用」**（空回复/超时/解析失败），调用方必须
// 与「裁判明确否决（pick = -1）」区分对待——不可用不能当作不存在，否则会误删真实景点。
async function judgeAlias(spot, cands, city) {
  const list = cands.slice(0, 30).map((c, i) => (i + 1) + '. ' + c.title + '｜' + (c.addr || '') + '｜' + (c.cat || '')).join('\n');
  const body = {
    model: AI_MODEL,
    messages: [
      { role: 'system', content: '你是地图 POI 匹配裁判。给定目标地点名与候选 POI（都在目标坐标附近），判断哪个候选**就是**这个地方。允许别名/简称/官方全称（如小吃街登记为「XX巷」、书店登记为「XX(成都店)」）；警惕只是同区域内的无关店铺。只输出 JSON：{"pick": 序号, "why": "简短理由"}；都不像则 {"pick": -1, "why": "..."}。' },
      { role: 'user', content: '城市：' + city + '\n目标：' + spot.name + '（' + (spot.cat || '') + '，坐标 ' + spot.coord + '）\n候选：\n' + list },
    ],
    temperature: 0, max_tokens: 300,   // 之前 30 会把 JSON 截断成空串，导致「全否决」的假象
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.DEEPSEEK_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json();
      const raw = ((j.choices && j.choices[0] && j.choices[0].message.content) || '').trim();
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { const p = JSON.parse(m[0]); if (typeof p.pick === 'number') return p; }
    } catch (e) { /* 重试一次 */ }
    await sleep(600);
  }
  return null;
}

async function amapSearch(kw, city, key, nationwide) {
  const url = `https://restapi.amap.com/v3/place/text?keywords=${encodeURIComponent(kw)}&city=${encodeURIComponent(city)}&citylimit=${nationwide ? 'false' : 'true'}&offset=10&key=${key}`;
  const j = await (await fetch(url)).json();
  if (j.status !== '1') throw new Error(`高德 infocode=${j.infocode} ${j.info || ''}`);
  return (j.pois || []).map(p => {
    const [lng, lat] = String(p.location || '').split(',').map(Number);
    return { title: p.name, coord: [lng, lat], id: p.id, addr: p.address || '', cat: p.type || '' };
  }).filter(p => p.coord[0] && p.coord[1]);
}
// 名称变体：POI 库里常带「景区/公园/观景台/欢乐世界」这类后缀，官方 POI 名未必带；
// 也可能反过来（我们要「汉城湖公园」，高德叫「汉城湖旅游风景区」）。只做**去后缀**，不做模糊包含，
// 以免像「乾陵黑猪肉」这种同名店铺被误当景点。
const SUFFIXES = ['国家森林公园', '森林公园', '旅游风景区', '风景名胜区', '湿地公园', '欢乐世界', '文化街区',
  '观景台', '博物馆', '步行街', '美食街', '风景区', '旅游区', '古镇', '景区', '公园', '夜市', '老街'];
function nameVariants(name) {
  const base = baseName(name);
  const out = [name, base];
  for (const s of SUFFIXES) {
    if (name.endsWith(s) && name.length > s.length + 1) out.push(name.slice(0, -s.length));
    if (base.endsWith(s) && base.length > s.length + 1) out.push(base.slice(0, -s.length));
  }
  return [...new Set(out.filter(Boolean))];
}

// 只用高德时的名称判据（比双源模式更严）：必须完全相等，没有「互相包含」的余地
// 名称可采信性：高德结果里「售票处/停车场/地铁站/入口」是**子设施**，「…道路/交通地名」是纯地名词条。
// 坐标可以采信子设施（它就在场馆范围内），但**名称只采信主体 POI**，否则会把「乐华恒业欢乐世界」
// 改名成「…售票处」、「云南南路美食街」改成「云南南路（道路）」，属于产品降级。
const SUB_POI = /售票处|停车场|停车点|公交站|地铁站|入口|出口|服务中心|游客中心|驿站|警务|厕所|暂停开放|附近|游览车|观光车|索道|缆车|游船|摆渡|接驳|导览|讲解|寄存|餐厅|商店|分店|旗舰店|店$/;
const ROAD_CAT = /地名地址|交通地名|道路/;
const NAME_CATS = /风景名胜|旅游景点|景点|公园|娱乐|休闲|体育|展馆|展览|文化|博物馆|古镇|寺|景区|街区/;
// 只采纳「**包含我们名字**的官方长名」（如「大熊猫繁育研究基地」→「成都大熊猫繁育研究基地」）。
// 部分重叠但语义已变的不能采纳——实测把「远洋太古里」改成了「太古里东广场-广东会馆」（那是里面一个小区域）。
// 后缀白名单只放「同类归一」的词（景区/公园/古镇…）。博物馆/博物院/纪念馆**故意不放**：
// 它们常是景区内部的子馆（实测「南山植物园」会被改成「南山植物园博物馆」、「大足石刻」→「大足石刻博物馆」），
// 属于把景点类型改窄。
const NAME_SUFFIXES = ['景区', '旅游景区', '旅游度假区', '公园', '古镇', '文化区', '文化旅游区',
  '遗址公园', '风景区', '历史街区', '步行街', '广场'];
function nameAdoptable(cand, ours) {
  const t = String(cand.title || ''), cat = String(cand.cat || '');
  if (SUB_POI.test(t)) return false;
  if (ROAD_CAT.test(cat)) return false;
  if (!NAME_CATS.test(cat)) return false;
  const a = norm(t), b = norm(ours || '');
  if (!b || a === b) return false;
  // 我们自己带限定词的（「淀山湖·彩虹桥」「朝天门广场·来福士」）不改名：官方名往往只剩前半个词，
  // 采纳后反而把具体地点泛化掉了。
  if (/[·（(]/.test(String(ours || ''))) return false;
  // 只接受「纯前缀扩展」（成都 + 大熊猫繁育研究基地）或「纯后缀扩展」（龙泉山丹景台 + 旅游景区）。
  // 带破折号/编号/其它尾巴的一律不采纳——实测那些多是子设施或片区（「…-游览车」「…东广场-广东会馆」）。
  const pre = a.endsWith(b) ? a.slice(0, a.length - b.length) : null;
  const suf = a.startsWith(b) ? a.slice(b.length) : null;
  const okPre = !!pre && pre.length <= 4 && !/[0-9\-—·、]/.test(pre);
  const okSuf = !!suf && NAME_SUFFIXES.includes(suf);
  return okPre || okSuf;
}

// 类目白名单：只在「本身是地点」的 POI 上做包含匹配，避免「乾陵黑猪肉」「云南南路小吃店」这类同名店铺
const PLACE_CATS = /风景名胜|旅游景点|景点|公园|娱乐|休闲|体育|展馆|展览|度假|古镇|景区|寺/;
// 反向排除：同名的小学/医院/公司/店铺常被包含匹配误收（实测「桠溪国际慢城」匹配到了「…慢城小学」）
const NOT_PLACE = /学校|小学|中学|大学|医院|诊所|公司|工厂|有限|门店|便利店|超市|银行|小区|住宅|公寓|办事处|村委会|加油站|停车场|收费站|公交站|地铁站/;
function pickExact(cands, name, loose) {
  const vars = nameVariants(name).map(norm).filter(v => v.length >= 2);
  // 带括号限定词的候选（「鸡鸣寺(地铁站)」「X-东门」「X(暂停开放)」）归一化后会与主名相同，
  // 但它们是入口/站点而非本体：排到后面，让不带限定词的候选优先。
  const ordered = [...cands].sort((a, b) => (/[（(]|-/.test(a.title) ? 1 : 0) - (/[（(]|-/.test(b.title) ? 1 : 0));
  cands = ordered;
  for (const c of cands) if (vars.includes(norm(c.title))) return { c, how: 'exact' };
  // 官方名 = 我们的名字 + 已知后缀（「汉城湖」→「汉城湖旅游风景区」）
  for (const c of cands) {
    const t = norm(c.title);
    for (const v of vars) if (SUFFIXES.some(s => t === v + norm(s))) return { c, how: 'suffix' };
  }
  if (loose) {
    // 第三档：类目受控的包含匹配（挡住「乾陵黑猪肉」这类同名店铺）
    for (const c of cands) {
      const t = norm(c.title);
      for (const v of vars) {
        const cat = String(c.cat || '');
        if (t.includes(v) && PLACE_CATS.test(cat) && !NOT_PLACE.test(cat) && !NOT_PLACE.test(c.title)) return { c, how: 'contains+cat' };
      }
    }
    // 第四档：官方改名的情况（「桠溪国际慢城」→「南京高淳国际慢城」、「溧水天生桥」→「天生桥景区」）。
    // 判据：与我们的名字有 ≥3 字连续公共子串 + 类目是景点类 + 非同名店铺/学校。
    for (const c of cands) {
      const t = norm(c.title), cat = String(c.cat || '');
      if (!PLACE_CATS.test(cat) || NOT_PLACE.test(cat) || NOT_PLACE.test(c.title)) continue;
      for (const v of vars) {
        for (let len = Math.min(v.length, t.length); len >= 3; len--) {
          let hitSub = false;
          for (let i = 0; i + len <= v.length && !hitSub; i++) {
            if (t.includes(v.slice(i, i + len))) hitSub = true;
          }
          if (hitSub) return { c, how: 'substr' + len };
        }
      }
    }
  }
  return null;
}

// 名称匹配：完全相等优先，其次互相包含
function pickMatch(cands, name) {
  const want = norm(name);
  let best = null;
  for (const c of cands) {
    const got = norm(c.title);
    const exact = got === want;
    const loose = got.includes(want) || want.includes(got);
    if (!exact && !loose) continue;
    const score = exact ? 0 : 1;
    if (!best || score < best.score) best = { c, score };
  }
  return best;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  const TK = process.env.TENCENT_WS_KEY, AK = process.env.AMAP_WS_KEY;
  const onlyAmap = args.includes('--provider') && args[args.indexOf('--provider') + 1] === 'amap';
  if (!file) { console.error('用法：node scripts/repair-coords.js <spots.json> [--dry-run|--apply] [--provider amap]'); process.exit(2); }
  if (!dryRun && !AK) { console.error('需要 AMAP_WS_KEY（双源模式还需 TENCENT_WS_KEY；干跑请加 --dry-run）'); process.exit(2); }
  if (!dryRun && !onlyAmap && !TK) { console.error('双源模式需要 TENCENT_WS_KEY，或改用 --provider amap（只用高德，额度更高）'); process.exit(2); }

  const abs = path.resolve(file);
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const city = data._meta && data._meta.city;
  if (!city) { console.error('文件缺少 _meta.city'); process.exit(2); }

  const verifyAll = args.includes('--verify-all');   // 全库核验：连已回填的点也过一遍高德（真实性 + 名称以高德为准）
  const rescueOnly = args.includes('--rescue-only'); // 只捞：跳过名称阶梯，直接用「周边召回 + LLM 裁判」处理未核验点
  const targets = rescueOnly ? data.spots.filter(s => s.verify_src !== 'amap')
    : verifyAll ? data.spots.slice() : data.spots.filter(s => s.coord_src === 'estimate');
  console.log(verifyAll
    ? `${city}：全库核验 ${targets.length} 个点位（高德为准：存在性 + 名称）`
    : `${city}：${data.spots.length} 个点位，其中 estimate ${targets.length} 个待复核`);
  if (dryRun) { console.log('（干跑，不调 API、不写文件）'); return; }

  const today = new Date().toISOString().slice(0, 10);
  // 与既有报告合并：同一 id 以本次结果为准，历史条目保留（数据留痕不该被下一次运行冲掉）
  const reportPath0 = abs.replace(/\.json$/, '') + '.coord-repair-report.json';
  let prev = { fixed: [], skipped: [], errors: [] };
  try { prev = JSON.parse(fs.readFileSync(reportPath0, 'utf8')); } catch (e) {}
  const report = { city, date: today, runs: [...new Set([...(prev.runs || [prev.date]).filter(Boolean), today])], fixed: [], skipped: [], errors: [] };
  const runSkipped = [];   // 仅本次运行：供 --prune-unmatched 判断「地图数据源里确实没有」
  const mergeBy = (oldArr, newArr) => {
    const seen = new Set(newArr.map(x => x.id));
    return [...oldArr.filter(x => !seen.has(x.id)), ...newArr];
  };
  let n = 0;
  for (const spot of targets) {
    n++;
    await sleep(THROTTLE_MS);
    try {
      // ---- 只用高德（额度更高）：名称必须完全相等 + 候选离估算 ≤ MAX_MOVE_M ----
      if (onlyAmap) {
        // 依次尝试：本城（名称变体）→ 全国带城市偏置 → 全国不带 city（乾陵/乐华这类实际在邻市的点，
        // 只要带 city 参数就会一直被本地同名店铺占满结果）
        // 收集三轮搜索的命中，取「位移在 MAX_MOVE_M 内、离估算最近」的那个。
        // 不能第一个命中就停：本城偏置常先给出同名异地（如茯茶镇），而正确结果在邻市（咸阳泾阳）。
        const cands = [];
        const attempts = rescueOnly ? [] : [
          ...nameVariants(spot.name).map(kw => [kw, city, false, false]),
          ...nameVariants(spot.name).map(kw => [kw, city, true, true]),
          ...nameVariants(spot.name).map(kw => [kw, '', true, true]),
        ];
        for (const [kw, c, nat, loose] of attempts) {
          const h = pickExact(await amapSearch(kw, c, AK, nat), spot.name, loose);
          await sleep(THROTTLE_MS);
          if (h) {
            h.drift = Math.round(hav(spot.coord, h.c.coord));
            cands.push({ hit: h, how: h.how, kw });
            if (h.drift <= MAX_MOVE_M) break;   // 已在合理范围内，不必再搜
          }
        }
        const inRange = cands.filter(x => x.hit.drift <= MAX_MOVE_M).sort((a, b) => a.hit.drift - b.hit.drift)[0];
        let hit = inRange ? inRange.hit : null;
        let entryHow = inRange ? (inRange.how || 'exact') : 'exact';
        const wasEstimate = spot.coord_src === 'estimate';
        const entry = { id: spot.id, name: spot.name, before: spot.coord.slice(), provider: 'amap' };
        // 名称对不上、但地方真实存在的情形（小吃街/夜市/商圈/演出场馆）：以我们的坐标为中心做高德
        // 周边搜索（真实 POI 必在 500m 内），交给 LLM 只做「在候选里挑一个或全否」的裁判。
        if (!hit && process.env.DEEPSEEK_KEY) {
          try {
            // 召回两路并集：① 坐标 500m 内全部 POI ② 用名称关键词在 2km 内搜（「方所」「建设」这类词
            // 才能把场馆内的小店海里那条目标捞出来，纯按距离取前 25 条会被咖啡店占满）
            const around = [];
            const seen = new Set();
            const push = arr => { for (const c of arr) { const k = c.id || c.title; if (!seen.has(k)) { seen.add(k); around.push(c); } } };
            push(await amapAround(spot.coord[0], spot.coord[1], AK, ''));
            await sleep(THROTTLE_MS);
            const kws = [...new Set([...nameVariants(spot.name).map(v => v.slice(0, 4)), spot.name.slice(0, 2), spot.name.slice(0, 3)])];
            for (const kw of kws.slice(0, 3)) {
              push(await amapAround(spot.coord[0], spot.coord[1], AK, kw, 2000));
              await sleep(THROTTLE_MS);
            }
            if (around.length) {
              const verdict = await judgeAlias(spot, around, city);
              if (verdict === null) {
                entry.why = '裁判不可用（空回复/超时），保留待人工';
                report.skipped.push({ ...entry, why: entry.why });
                console.log(`  [${n}/${targets.length}] ${spot.name}：裁判不可用，保留待人工`);
                continue;
              }
              const pick = verdict.pick;
              if (pick > 0 && around[pick - 1]) {
                hit = { c: around[pick - 1], how: 'llm-around' };
                entryHow = 'llm-around';
                console.log(`  [${n}/${targets.length}] ${spot.name}：裁判选中「${hit.c.title}」（${(verdict.why || '').slice(0, 40)}）`);
              } else {
                console.log(`  [${n}/${targets.length}] ${spot.name}：${around.length} 个候选，裁判判为都不像（${(verdict.why || '').slice(0, 40)}）`);
              }
            }
          } catch (e) { console.log(`  [${n}/${targets.length}] ${spot.name}：周边召回失败 ${e.message}`); }
        }
        if (!hit) {
          report.skipped.push({ ...entry, why: '高德未命中（名称阶梯 + 全国兜底 + 周边裁判）' });
          runSkipped.push({ ...entry, why: '高德未命中（名称阶梯 + 全国兜底 + 周边裁判）' });
          console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（高德未命中）`);
          continue;
        }
        const drift = Math.round(hav(spot.coord, hit.c.coord));
        entry.after = [+hit.c.coord[0].toFixed(6), +hit.c.coord[1].toFixed(6)];
        entry.drift_m = drift;
        entry.amap_poi_id = hit.c.id;
        entry.tier = 'amap-' + entryHow;
        if (drift > MAX_MOVE_M) {
          report.skipped.push({ ...entry, why: `候选离估算 ${drift}m > ${MAX_MOVE_M}m，疑似同名异地` });
          console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（高德候选离估算 ${drift}m，超 ${MAX_MOVE_M}m 上限）`);
          continue;
        }
        report.fixed.push(entry);
        // —— 高德为准的三件事：① 存在性核验 ② 名称对齐 ③ 坐标（estimate 必换；已回填的仅在漂移 ≤500m 时微调）——
        const poi = hit.c.title;
        const adoptName = nameAdoptable(hit.c, spot.name)
          || (entryHow === 'llm-around' && !SUB_POI.test(String(hit.c.title || '')) && norm(hit.c.title) !== norm(spot.name));
        const moveCoord = wasEstimate || drift <= 500;
        if (apply) {
          if (moveCoord) { spot.coord = entry.after; spot.coord_src = 'amap'; }
          if (!wasEstimate && drift > 500) entry.coord_conflict = { ours: spot.coord.slice(), amap: entry.after, drift_m: drift };
          if (adoptName) { entry.renamed_from = spot.name; entry.renamed_to = poi; spot.name = poi; }
          spot.amap_poi_id = spot.amap_poi_id || hit.c.id;
          spot.verify_src = 'amap';
          spot.verified_at = report.date;
          spot.refreshed_at = report.date;
        }
        entry.poi_name = poi;
        entry.name_adopted = !!adoptName;
        entry.coord_moved = !!moveCoord;
        console.log(`  [${n}/${targets.length}] ${apply ? '核验' : '待核验'} ${entry.renamed_from || spot.name}：漂移 ${drift}m（高德·${poi}）`
          + (adoptName ? ` → 更名为「${poi}」` : '')
          + (!moveCoord ? `（坐标保留，差异 ${drift}m 记入报告）` : ''));
        continue;
      }
      const t = pickMatch(await tencentSearch(spot.name, city, TK), spot.name)
        || pickMatch(await tencentSearch(baseName(spot.name), city, TK), spot.name);
      await sleep(THROTTLE_MS);
      const a = pickMatch(await amapSearch(baseName(spot.name), city, AK), spot.name);
      const entry = { id: spot.id, name: spot.name, before: spot.coord.slice() };
      if (!t || !a) {
        report.skipped.push({ ...entry, why: !t && !a ? '双源均未命中' : (t ? '高德未命中' : '腾讯未命中') });
        console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（${!t && !a ? '双源未命中' : t ? '高德未命中' : '腾讯未命中'}）`);
        continue;
      }
      const agree = hav(t.c.coord, a.c.coord);
      const lim = spot.suburb ? CONFIRM_M_SUBURB : CONFIRM_M;
      const looseLim = spot.suburb ? LOOSE_M_SUBURB : LOOSE_M;
      const exactName = norm(t.c.title) === norm(spot.name) || norm(t.c.title) === norm(baseName(spot.name))
        || norm(a.c.title) === norm(spot.name) || norm(a.c.title) === norm(baseName(spot.name));
      let tier = 0;
      if (agree <= lim) tier = 1;
      else if (agree <= looseLim && exactName) tier = 2;
      if (!tier) {
        report.skipped.push({ ...entry, why: `双源不一致 ${Math.round(agree)}m`, tencent: t.c.coord, amap: a.c.coord });
        console.log(`  [${n}/${targets.length}] 跳过 ${spot.name}（双源相距 ${Math.round(agree)}m > ${lim}m，交人工复核）`);
        continue;
      }
      const drift = Math.round(hav(spot.coord, t.c.coord));
      entry.after = [+t.c.coord[0].toFixed(6), +t.c.coord[1].toFixed(6)];
      entry.drift_m = drift;
      entry.tencent_poi_id = t.c.id;
      entry.agree_m = Math.round(agree);
      entry.tier = tier;
      report.fixed.push(entry);
      if (apply) {
        spot.coord = entry.after;
        spot.coord_src = 'tencent';
        spot.tencent_poi_id = t.c.id;
        spot.refreshed_at = report.date;
      }
      console.log(`  [${n}/${targets.length}] ${apply ? '修复' : '待修'} ${spot.name}：漂移 ${drift}m（双源相距 ${Math.round(agree)}m）`);
    } catch (e) {
      report.errors.push({ id: spot.id, name: spot.name, err: String(e.message || e) });
      console.log(`  [${n}/${targets.length}] 错误 ${spot.name}：${e.message}`);
    }
  }

  if (apply) {
    data._meta.coord_repaired_at = report.date;
    // --prune-unmatched：按「以地图数据源为准」的策略，删掉本次确认在高德/腾讯都搜不到的估算点
    if (args.includes('--prune-unmatched')) {
      const gone = new Set(runSkipped.filter(s => /未命中/.test(s.why)).map(s => s.id));
      const before = data.spots.length;
      data.spots = data.spots.filter(s => !(gone.has(s.id) && s.coord_src === 'estimate'));
      report.pruned = [...gone];
      console.log(`按策略删除搜不到的景点：${before - data.spots.length} 个（${[...gone].join('、')}）`);
    }
    fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  }
  report.fixed = mergeBy(prev.fixed || [], report.fixed);
  report.skipped = mergeBy(prev.skipped || [], report.skipped);
  report.errors = mergeBy(prev.errors || [], report.errors);
  const reportPath = reportPath0;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${apply ? '已写入' : '未写入（加 --apply 才落盘）'}：可修 ${report.fixed.length} / 跳过 ${report.skipped.length} / 错误 ${report.errors.length}`);
  console.log('报告：' + path.relative(process.cwd(), reportPath));
  const big = report.fixed.filter(f => f.drift_m > 3000);
  if (big.length) console.log('漂移 >3km 的点：' + big.map(b => b.name + '(' + (b.drift_m / 1000).toFixed(1) + 'km)').join('、'));
}

// 供 scripts/rebuild-library.js 复用（同一套采集/匹配逻辑，避免两处实现漂移）
module.exports = { amapAround, amapSearch, norm, baseName, nameVariants, nameAdoptable, hav, MAIN: true };

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
