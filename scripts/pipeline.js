'use strict';
// 计划内城市统一流水线（与第一批次上线城市完全同规则）
//   ① 坐标修复（repair-coords，双源/高德）② LLM 别名裁判（仍有 estimate 时）
//   ③ 营业信息 + POI 校准 + 官方名对齐（biz-info）④ 候选池采集（rebuild --collect）
//   ⑤ 库重构（rebuild --plan --apply：删演出/体验类、受限类目配额、FAME 必留、heat 按评分重算）
//   ⑥ 校验（heat 区间/坐标/重名/残留演出类）
// 用法：node scripts/pipeline.js <城市中文名> [--apply] [--skip-coords] [--skip-llm]
//   例：node scripts/pipeline.js 丽江 --apply
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const CITY_FILES = {
  成都: 'chengdu', 北京: 'beijing', 上海: 'shanghai', 西安: 'xian', 重庆: 'chongqing', 杭州: 'hangzhou',
  大理: 'dali', 广州: 'guangzhou', 贵阳: 'guiyang', 合肥: 'hefei', 昆明: 'kunming', 拉萨: 'lhasa',
  丽江: 'lijiang', 南京: 'nanjing', 宁波: 'ningbo', 绍兴: 'shaoxing', 苏州: 'suzhou', 温州: 'wenzhou',
  无锡: 'wuxi', 香格里拉: 'xianggelila', 西双版纳: 'xishuangbanna', 扬州: 'yangzhou',
};
const args = process.argv.slice(2);
const city = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const SKIP_COORDS = args.includes('--skip-coords');
const SKIP_LLM = args.includes('--skip-llm');
if (!city || !CITY_FILES[city]) {
  console.error('用法：node scripts/pipeline.js <城市> [--apply] [--skip-coords] [--skip-llm]');
  console.error('已注册城市：' + Object.keys(CITY_FILES).join('、'));
  process.exit(2);
}
const file = CITY_FILES[city];
const lib = path.join(ROOT, 'data', 'spots', file + '.json');
const node = process.execPath;
function run(step, scriptArgs) {
  console.log('\n=== ' + step + ' ===');
  const r = spawnSync(node, scriptArgs, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) { console.error('!! 步骤失败（exit ' + r.status + '）：' + step); if (APPLY) process.exit(r.status || 1); }
  return r.status === 0;
}
const estimateCount = () => {
  const d = JSON.parse(fs.readFileSync(lib, 'utf8'));
  return (d.spots || []).filter(s => s.coord_src === 'estimate').length;
};

console.log('城市：' + city + '（' + file + '.json）｜' + (APPLY ? '应用模式' : '干跑模式'));
if (!SKIP_COORDS) run('① 坐标修复', ['scripts/repair-coords.js', 'data/spots/' + file + '.json', '--provider', 'amap'].concat(APPLY ? ['--apply'] : ['--dry-run']));
let est = estimateCount();
if (est && !SKIP_LLM) {
  run('② LLM 别名裁判（剩余 ' + est + ' 个估算点）', ['scripts/rematch-llm.js', 'data/spots/' + file + '.json']);
  est = estimateCount();
}
run('③ 营业信息 + POI 校准 + 官方名对齐', ['scripts/biz-info.js', 'data/spots/' + file + '.json'].concat(APPLY ? ['--apply'] : ['--dry-run']));
run('④ 候选池采集', ['scripts/rebuild-library.js', '--collect', city]);
run('⑤ 库重构（删弱项 + 配额 + 必留名单 + heat 重算）', ['scripts/rebuild-library.js', '--plan', city].concat(APPLY ? ['--apply'] : []));
// ⑥ 校验
const d = JSON.parse(fs.readFileSync(lib, 'utf8'));
const s = d.spots || [];
const badHeat = s.filter(x => typeof x.heat !== 'number' || x.heat < 5 || x.heat > 10).length;
const badCoord = s.filter(x => !Array.isArray(x.coord) || x.coord.length !== 2 || !x.coord[0]).length;
const SHOW = /《[^》]*》|沉浸式|戏剧|音乐剧|话剧|舞台剧|光影秀|水秀|演唱会/;
const VENUE = /大剧院|剧场|剧院|音乐厅|演艺中心/;
const shows = s.filter(x => SHOW.test(x.name) && !VENUE.test(x.name)).length;
const seen = new Map(); const dups = [];
for (const x of s) { const k = String(x.name).replace(/\s+/g, ''); if (seen.has(k)) dups.push(x.name); else seen.set(k, 1); }
console.log('\n=== ⑥ 校验 ===');
console.log('  ' + s.length + ' 点 | 剩余估算 ' + est + ' | heat 越界 ' + badHeat + ' | 坐标异常 ' + badCoord + ' | 残留演出类 ' + shows + ' | 重名 ' + dups.length);
if (badHeat || badCoord || shows) process.exit(1);
console.log('\n完成。' + (APPLY ? '如为上线城市，记得：重建 engine.bundle → 部署 genRoute/reRoute/aiCopy + hosting data → push。' : '（干跑，未写库；确认无误后加 --apply）'));
