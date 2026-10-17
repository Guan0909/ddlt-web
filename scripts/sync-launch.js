'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-registry.json'), 'utf8'));
const BASE = { 成都:'chengdu',北京:'beijing',上海:'shanghai',西安:'xian',重庆:'chongqing',杭州:'hangzhou',大理:'dali',广州:'guangzhou',贵阳:'guiyang',合肥:'hefei',昆明:'kunming',拉萨:'lhasa',丽江:'lijiang',南京:'nanjing',宁波:'ningbo',绍兴:'shaoxing',苏州:'suzhou',温州:'wenzhou',无锡:'wuxi',香格里拉:'xianggelila',西双版纳:'xishuangbanna',扬州:'yangzhou' };
const FILE = Object.assign({}, BASE, Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, v.file])));
const PINYIN_OVERRIDE = { 香格里拉: 'SHANGRI-LA', 呼和浩特: 'HOHHOT', 乌鲁木齐: 'URUMQI', 喀什: 'KASHGAR', 西双版纳: 'XISHUANGBANNA' };
const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cities.json'), 'utf8')).cities.map(c => c.name);
const names = cities.filter(n => FILE[n]);
console.log('上线城市 ' + names.length);
if (names.length !== 60) { console.error('城市映射不完整'); process.exit(1); }
const appPath = path.join(ROOT, 'web', 'assets', 'app.js');
let app = fs.readFileSync(appPath, 'utf8');
const spotLines = [];
for (let i = 0; i < names.length; i += 3) { spotLines.push('    ' + names.slice(i, i + 3).map(n => "'" + n + "': '/data/spots/" + FILE[n] + ".json'").join(', ') + ','); }
app = app.replace(/  \/\/ 城市 → spots 数据文件（已建库 \d+ 城）\n  const SPOT_FILES = \{[\s\S]*?\n  \};/, '  // 城市 → spots 数据文件（已建库 ' + names.length + ' 城）\n  const SPOT_FILES = {\n' + spotLines.join('\n') + '\n  };');
const pinyinLines = [];
for (let i = 0; i < names.length; i += 3) { pinyinLines.push('    ' + names.slice(i, i + 3).map(n => "'" + n + "': '" + (PINYIN_OVERRIDE[n] || FILE[n].toUpperCase()) + "'").join(', ') + ','); }
app = app.replace(/  \/\/ 海报顶部拼音占位[^\n]*\n  const PINYIN = \{[\s\S]*?\n  \};/, '  // 海报顶部拼音占位：映射不了的城市用 DECIDENOW.ASIA\n  const PINYIN = {\n' + pinyinLines.join('\n') + '\n  };');
fs.writeFileSync(appPath, app, 'utf8');
console.log('app.js 已写入 SPOT_FILES/PINYIN：' + names.length + ' 城');
const rkPath = path.join(ROOT, 'cloudfunctions', '_shared', 'routeKit.js');
let rk = fs.readFileSync(rkPath, 'utf8');
const rkLines = [];
for (let i = 0; i < names.length; i += 4) { rkLines.push('  ' + names.slice(i, i + 4).map(n => "'" + n + "': '" + FILE[n] + "'").join(', ') + ','); }
rk = rk.replace(/const CITY_FILES = \{[\s\S]*?\n\};/, 'const CITY_FILES = {\n' + rkLines.join('\n') + '\n};');
fs.writeFileSync(rkPath, rk, 'utf8');
console.log('routeKit.js 已写入 CITY_FILES：' + names.length + ' 城');
const cjPath = path.join(ROOT, 'data', 'cities.json');
const cj = JSON.parse(fs.readFileSync(cjPath, 'utf8'));
let flipped = 0;
for (const c of cj.cities) if (FILE[c.name] && c.status !== 'done') { c.status = 'done'; flipped++; }
cj._meta = cj._meta || {}; cj._meta.launched_at = new Date().toISOString().slice(0, 10); cj._meta.launched = cj.cities.filter(c => c.status === 'done').length;
fs.writeFileSync(cjPath, JSON.stringify(cj, null, 2), 'utf8');
console.log('cities.json：' + flipped + ' 城置 done，共 ' + cj._meta.launched + ' 城开通');