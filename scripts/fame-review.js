'use strict';
// FAME 必留名单复核：为 38 个新城市补登「非常知名」但无 A 级标注的景点（地标/广场/街区/免费名胜）
// 判据：不在 FAME 中 + 无 a_level + （评分≥4.6 或 命中数据说明的标志性关键词）
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const d0 = path.join(ROOT, 'data', 'spots');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-registry.json'), 'utf8'));
const ICONIC = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'iconic.json'), 'utf8'));
const FILE = Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, v.file]));
const famePath = path.join(ROOT, 'data', 'fame.json');
const fame = fs.existsSync(famePath) ? JSON.parse(fs.readFileSync(famePath, 'utf8')) : {};
let added = 0; const report = [];
for (const [cn, f] of Object.entries(FILE)) {
  const p = path.join(d0, f + '.json');
  if (!fs.existsSync(p)) continue;
  const spots = JSON.parse(fs.readFileSync(p, 'utf8')).spots || [];
  const cur = fame[cn] || [];
  const keys = ICONIC[cn] || [];
  const picked = [];
  for (const s of spots) {
    if (cur.some(k => String(s.name).includes(k))) continue;
    if (s.a_level) continue;                       // A 级标注已由规则豁免，无需 FAME
    if (typeof s.rating === 'number' && s.rating >= 4.6) continue;   // 评分≥4.6 同样已豁免
    // FAME 的边际价值：标志性清单命中、但评分不高（<4.6）且无 A 级的「知名但非高评分」点
    if (!keys.some(k => String(s.name).includes(k))) continue;
    // 排除子设施/商业场所/暂停营业等（FAME 只收地理地标）
    if (/美食城|小吃街|儿童友好|问天台|石窟|四号陵|暂停开放|创意产业|葡萄酒博物馆|石林|码头|广场\-|北寺/.test(s.name)) continue;
    picked.push(s.name);
  }
  if (picked.length) {
    fame[cn] = cur.concat(picked);
    added += picked.length;
    report.push(cn + ' +' + picked.length + '：' + picked.join('、'));
  }
}
if (!process.argv.includes('--dry')) fs.writeFileSync(famePath, JSON.stringify(fame, null, 2));
console.log('FAME 补登 ' + added + ' 条（' + Object.keys(fame).length + ' 城）');
report.forEach(r => console.log('  ' + r));