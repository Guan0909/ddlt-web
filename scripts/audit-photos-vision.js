'use strict';
// 用视觉模型审计每个景点的候选图片：判定类型（菜品/菜单/文字墙/街景…）并挑出最适合做封面的那张
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SPOT_DIR = path.join(ROOT, 'data', 'spots');
const OUT = path.join(ROOT, 'build', 'photo-vision-report.json');
const AI_BASE = 'https://new.fluapi.com/v1';
const AI_KEY = 'sk-J7G1QYIcXWqomeyYrSUyTY2kOkIo0sqtzYHS7VioyKgkRiOS';
const MODEL = 'gemini-3-flash';
const CONCURRENCY = +process.env.CONCURRENCY || 8;
const LIMIT = +process.env.LIMIT || 0;   // 调试用：只跑前 N 个

const report = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
function save() { fs.writeFileSync(OUT, JSON.stringify(report, null, 0), 'utf8'); }

function stripOss(u) {
  let x = String(u).replace(/^http:/, 'https:');
  x = x.replace(/([?&])x-oss-process=[^&]*/g, '$1').replace(/[?&]$/, '');
  return x + (x.indexOf('?') >= 0 ? '&' : '?') + 'x-oss-process=image/resize,w_360';
}
async function dl(u) {
  try {
    const r = await fetch(stripOss(u), { headers: { Referer: 'https://www.amap.com/' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 4000 || b.length > 900 * 1024) return null;
    return b.toString('base64');
  } catch (e) { return null; }
}
async function classify(spot, imgs) {
  const content = [{
    type: 'text',
    text: '城市：' + (spot.cityName || '') + '；景点：' + spot.name + '；类别：' + (spot.cat || '') + '；地址：' + (spot.address || '') + '。' +
      '下面是该景点的候选照片（按顺序编号 0..' + (imgs.length - 1) + '）。请判断每张图的类型，并选出最能代表该地点的一张作为封面。' +
      '可作封面：能看清地点的街景/建筑外观/自然风光/地标牌坊/场馆内景。' +
      '不可作封面：菜品或食物特写、菜单价目表、二维码/截图/地图、纯文字海报、商品陈列、人物自拍/合影（看不出地点）。' +
      '只输出 JSON（不要代码块、不要解释）：{"kinds":["每张图类型"],"best":序号或-1,"reason":"一句话"}',
  }];
  imgs.forEach(b => content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b } }));
  let r, j;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(AI_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_KEY },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 260 }),
      signal: AbortSignal.timeout(60000),
    });
    if (r.status === 429) { await new Promise(x => setTimeout(x, 1500 + attempt * 1500)); continue; }
    j = await r.json();
    if (r.ok && j && j.choices) break;
    await new Promise(x => setTimeout(x, 800));
  }
  if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
  let txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  txt = String(txt).replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = txt.indexOf('{'); const b = txt.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no json: ' + txt.slice(0, 80));
  const obj = JSON.parse(txt.slice(a, b + 1));
  return obj;
}
async function pool(tasks, n) {
  let i = 0; const out = new Array(tasks.length);
  await Promise.all(new Array(Math.min(n, tasks.length)).fill(0).map(async () => {
    while (true) { const k = i++; if (k >= tasks.length) break; out[k] = await tasks[k](); }
  }));
  return out;
}

(async () => {
  const files = fs.readdirSync(SPOT_DIR).filter(f => /^[a-z-]+\.json$/.test(f));
  const spots = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(SPOT_DIR, f), 'utf8'));
    if (!Array.isArray(j.spots)) continue;
    const city = j.city || j.cityName || f.replace(/\.json$/, '');
    for (const s of j.spots) spots.push(Object.assign({ _file: f, cityName: city, photos: s.photos || [] }, s));
  }
  const todo = spots.filter(s => s.photos.length && !report[s._file + '|' + s.id]);
  console.log('总景点:', spots.length, '| 待处理:', todo.length);
  const list = LIMIT ? todo.slice(0, LIMIT) : todo;
  let done = 0, fail = 0;
  await pool(list.map(s => async () => {
    const imgs = [];
    for (const u of s.photos.slice(0, 3)) { const b = await dl(u); if (b) imgs.push(b); }
    if (!imgs.length) { report[s._file + '|' + s.id] = { err: 'no-image' }; done++; return; }
    try {
      const res = await classify(s, imgs);
      report[s._file + '|' + s.id] = { name: s.name, city: s.cityName, best: res.best, kinds: res.kinds, reason: res.reason };
      done++;
    } catch (e) {
      fail++; report[s._file + '|' + s.id] = { err: String(e.message || e).slice(0, 80) };
    }
    if ((done + fail) % 25 === 0) { save(); console.log('进度', done + fail, '/', list.length, 'fail', fail); }
  }), CONCURRENCY);
  save();
  const vals = Object.values(report);
  const ok = vals.filter(v => typeof v.best === 'number' && v.best >= 0).length;
  const none = vals.filter(v => v.best === -1).length;
  const errs = vals.filter(v => v.err).length;
  console.log('完成 | 可用封面:', ok, '| 全部不合格:', none, '| 失败:', errs);
})();