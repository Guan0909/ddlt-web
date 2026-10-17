'use strict';
// 营业信息回填的「事后审计 + 定向回滚」：
//   biz-info 用报告记录每处变更（poi/coord/rename），本脚本按可疑模式找回原值，
//   避免为几个坏例重跑整城（25min/16城）。
// 可疑模式：改名后多出 >6 字 / 含店铺·设施词 / 明显不是景点
// 用法：node scripts/biz-audit.js data/spots/<city>.json [--revert]
const fs = require('fs');
const path = require('path');

const SUSPECT_NAME = /(洗车站|洗车|摄影|旅拍|租衣|租车|便利店|超市|商店|专卖|门店|药店|诊所|停车场|充电|牌坊|大门|售票|检票|服务中心|游客中心|商业街$|小吃店|餐厅|咖啡|茶楼)/;
const args = process.argv.slice(2);
const REVERT = args.includes('--revert');
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('用法：node scripts/biz-audit.js data/spots/<city>.json [--revert]'); process.exit(2); }
const abs = path.resolve(file);
const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
const repPath = abs.replace(/\.json$/, '.biz-report.json');
if (!fs.existsSync(repPath)) { console.log('无 biz 报告：' + path.basename(repPath)); process.exit(0); }
const rep = JSON.parse(fs.readFileSync(repPath, 'utf8'));
const byId = new Map((data.spots || []).map(s => [s.id, s]));
let suspect = 0, reverted = 0;
const examples = [];
for (const entry of rep.log || []) {
  const ch = entry.changes;
  if (!ch || entry.reverted) continue;   // 已回滚过的跳过（幂等）
  const spot = byId.get(entry.id);
  if (!spot) continue;
  const renamed = ch.rename ? ch.rename.to : null;
  const delta = renamed ? String(renamed).length - String(ch.rename.from).length : 0;
  const bad = (renamed && (SUSPECT_NAME.test(renamed) || delta > 6)) ||
              (ch.poi && SUSPECT_NAME.test(String(entry.pick || '')));
  if (!bad) continue;
  suspect++;
  if (examples.length < 8) examples.push((ch.rename ? ch.rename.from + ' → ' + ch.rename.to : entry.name) + (ch.poi ? '｜POI ' + ch.poi.from + '→' + ch.poi.to : ''));
  if (!REVERT) continue;
  // 回滚：名字 / POI id / 坐标 / 由错误 POI 写入的营业信息
  if (ch.rename) spot.name = ch.rename.from;
  if (ch.poi) {
    if (ch.poi.from) spot.amap_poi_id = ch.poi.from; else delete spot.amap_poi_id;
    spot.coord_src = 'estimate';          // POI 也不可信了，坐标回退为估算待重跑
    delete spot.verify_src; delete spot.verified_at;
  }
  if (ch.coord) { spot.coord = ch.coord.from; spot.coord_src = 'estimate'; }
  delete spot.open; delete spot.open_text; delete spot.closed_mon;
  delete spot.tel; delete spot.rating; delete spot.cost;
  delete spot.biz_src; delete spot.biz_at;
  entry.reverted = true;
  reverted++;
}
console.log(path.basename(file) + '：可疑 ' + suspect + (REVERT ? ' / 已回滚 ' + reverted : '（干跑）'));
if (examples.length) console.log('  例：' + examples.join('；'));
if (REVERT) {
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(repPath, JSON.stringify(rep, null, 2) + '\n');
}
