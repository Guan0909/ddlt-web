'use strict';
// 用百度图片搜索补图：标题相关性筛选 → 下原图 → 视觉模型核实 → 存到 web/photos/
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const AI_BASE = 'https://new.fluapi.com/v1';
const AI_KEY = 'sk-J7G1QYIcXWqomeyYrSUyTY2kOkIo0sqtzYHS7VioyKgkRiOS';
const MODEL = 'gemini-3-flash';
const BAD = /699pic|tukuchina|zhitu|qiantu|58pic|quanjing|hippopx|pixabay|tuchong|vcg|gettyimages|shutterstock|nipic|dfic|hanyuguoxue|zidian/i;
function dims(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) { let i = 2; while (i < buf.length - 9) { if (buf[i] !== 0xFF) { i++; continue; } const m = buf[i + 1]; if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }; if (m === 0xD8 || m === 0xD9) { i += 2; continue; } i += 2 + buf.readUInt16BE(i + 2); } }
  return null;
}
async function baidu(q, pn) {
  const u = 'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&is=&fp=result&word=' + encodeURIComponent(q) + '&pn=' + (pn || 0) + '&rn=30&gsm=1e&queryWord=' + encodeURIComponent(q);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://image.baidu.com/', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return (j.data || []).filter(x => x && x.thumbURL);
  } catch (e) { return []; }
}
async function download(u) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://image.baidu.com/' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || ''; if (!/image/i.test(ct)) return null;
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 40000 || b.length > 2500000) return null;
    const d = dims(b); if (!d || d.w < 800 || d.h < 500) return null;
    const ar = d.w / d.h; if (ar < 0.55 || ar > 2.2) return null;
    return { buf: b, w: d.w, h: d.h };
  } catch (e) { return null; }
}
async function verify(name, city, b64) {
  const content = [{ type: 'text', text: '判断这张图片是否确实拍摄的是「' + name + '」（城市：' + city + '）。只输出 JSON：{"match":true/false,"kind":"街景|建筑外观|场馆内景|自然风光|地标牌坊|菜品|菜单|商品陈列|文字|其他","cover":true/false,"why":"≤12字"}。match 只有在能确认是同一地点时为 true；cover 表示适合当封面（菜品/菜单/商品/文字不适合）。' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(AI_BASE + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_KEY }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 160 }), signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await new Promise(x => setTimeout(x, 2000)); continue; }
      const j = await r.json();
      let txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      txt = String(txt).replace(/```json/gi, '').replace(/```/g, '').trim();
      const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
      if (a < 0 || b < 0) continue;
      return JSON.parse(txt.slice(a, b + 1));
    } catch (e) { await new Promise(x => setTimeout(x, 800)); }
  }
  return null;
}
const targets = [
  { file: 'chengdu.json', id: 'zhongshuge', name: '钟书阁（都江堰）', city: '都江堰', qs: ['钟书阁 都江堰 书店', '都江堰 钟书阁 网红书店'] },
  { file: 'dunhuang.json', id: 'x7451fb8e', name: '敦煌研究院文化创意馆', city: '敦煌', qs: ['敦煌研究院 文创馆', '敦煌 文化创意馆'] },
  { file: 'huangshan.json', id: 's526c6dbf', name: '练江新夜市', city: '歙县', qs: ['歙县 练江新夜市', '歙县 练江夜市'] },
  { file: 'huangshan.json', id: 'sf9fb9960', name: '百大名品门特色小吃一条街', city: '黄山', qs: ['屯溪老街 小吃街', '黄山 特色小吃街 牌坊'] },
  { file: 'huhehaote.json', id: 'sd00325a9', name: '饕界美食街', city: '呼和浩特', qs: ['呼和浩特 饕界美食街', '呼和浩特 美食街 夜景'] },
  { file: 'kashi.json', id: 'xc20b5e3f', name: '喀什美食街(团结路店)', city: '喀什', qs: ['喀什 美食街', '喀什 夜市 街景'] },
  { file: 'luoyang.json', id: 'sf8a13094', name: '日光夜市(肆)', city: '洛阳', qs: ['洛阳 老城十字街 夜市', '洛阳 夜市 街景'] },
  { file: 'quanzhou.json', id: 's574eb53a', name: '阳光夜市', city: '泉州', qs: ['泉州 阳光夜市', '泉州 夜市 街景'] },
  { file: 'taiyuan.json', id: 'se879d952', name: '太原市博物馆', city: '太原', qs: ['太原市博物馆', '太原博物馆 建筑'] },
  { file: 'wuyuan.json', id: 's0f2b0de6', name: '红山文体公园', city: '婺源', qs: ['婺源 红山文体公园', '婺源 红山 公园'] },
];
(async () => {
  const photosDir = path.join(ROOT, 'web', 'photos');
  fs.mkdirSync(photosDir, { recursive: true });
  const report = [];
  for (const t of targets) {
    const seen = new Set(); const cands = [];
    for (const q of t.qs) {
      for (const pn of [0, 30]) {
        const items = await baidu(q, pn);
        for (const it of items) {
          const title = String(it.fromPageTitleEnc || '');
          const urls = [it.replaceUrl && it.replaceUrl[0] && it.replaceUrl[0].ObjURL, it.middleURL, it.thumbURL].filter(Boolean);
          for (const u of urls) {
            if (BAD.test(u) || seen.has(u)) continue;
            seen.add(u);
            cands.push({ u, title, w: it.width, h: it.height });
            break;
          }
        }
      }
    }
    // 标题含关键词的候选优先
    const toks = String(t.name).replace(/[（）()·]/g, ' ').split(/\s+/).filter(x => x.length >= 2).concat([t.city]);
    cands.sort((a, b) => (toks.some(k => b.title.includes(k)) ? 1 : 0) - (toks.some(k => a.title.includes(k)) ? 1 : 0));
    let pick = null, checked = 0;
    for (const c of cands.slice(0, 24)) {
      const d = await download(c.u);
      if (!d) continue;
      checked++;
      const v = await verify(t.name, t.city, d.buf.toString('base64'));
      if (v && v.match === true && v.cover === true) { pick = { d, c, v }; break; }
      if (checked >= 10) break;
    }
    if (!pick) { report.push({ ...t, err: 'no-verified', candidates: cands.length, checked }); console.log(t.name, 'NO', cands.length, checked); continue; }
    const fname = t.file.replace('.json', '') + '-' + t.id + '.jpg';
    fs.writeFileSync(path.join(photosDir, fname), pick.d.buf);
    report.push({ ...t, src: pick.c.u, title: pick.c.title, w: pick.d.w, h: pick.d.h, bytes: pick.d.buf.length, file: '/photos/' + fname, verdict: pick.v, checked });
    console.log(t.name, '->', pick.d.w + 'x' + pick.d.h, '(' + pick.v.kind + ')', pick.c.u.slice(0, 60));
  }
  fs.writeFileSync(path.join(ROOT, 'build', 'web-photo-baidu.json'), JSON.stringify(report, null, 1), 'utf8');
})();