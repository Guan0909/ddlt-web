'use strict';
// 11 个「高德无合适图」的景点：网络搜图 → 视觉模型逐张核实是否为目标景点且能作封面 → 存到 web/photos/ 并替换封面
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const AI_BASE = 'https://new.fluapi.com/v1';
const AI_KEY = 'sk-J7G1QYIcXWqomeyYrSUyTY2kOkIo0sqtzYHS7VioyKgkRiOS';
const MODEL = 'gemini-3-flash';
const BAD = /699pic|tukuchina|zhitu|qiantu|58pic|quanjing|hippopx|pixabay|tuchong|vcg|gettyimages|shutterstock|hanyuguoxue|zidian|nipic|dfic/i;

function dims(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      if (m === 0xD8 || m === 0xD9) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
async function search(q) {
  const u = 'https://www.bing.com/images/async?q=' + encodeURIComponent(q) + '&first=1&count=35&scenario=ImageBasicHover&datsrc=N_I&layout=RowBased&mmasync=1';
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    const out = [];
    for (const m of t.matchAll(/m="([^"]+)"/g)) {
      const d = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try { const o = JSON.parse(d); if (o.murl) out.push({ murl: o.murl.replace(/\\\//g, '/'), purl: o.purl || '', title: o.t || '' }); } catch (e) {}
    }
    return out;
  } catch (e) { return []; }
}
async function download(u) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://www.bing.com/' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!/image/i.test(ct)) return null;
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 45000 || b.length > 2500000) return null;
    const d = dims(b);
    if (!d || d.w < 800 || d.h < 500) return null;
    const ar = d.w / d.h;
    if (ar < 0.55 || ar > 2.2) return null;
    return { buf: b, w: d.w, h: d.h };
  } catch (e) { return null; }
}
async function verify(name, city, b64) {
  const content = [{
    type: 'text',
    text: '请判断这张图片是否**确实拍摄的是**「' + name + '」（城市：' + city + '）这个地点。' +
      '只输出 JSON：{"match":true/false,"kind":"街景|建筑外观|场馆内景|自然风光|地标牌坊|菜品|菜单|商品陈列|文字|其他","cover":true/false,"why":"≤12字"}' +
      '；match 只有在能确认是同一地点时才为 true；cover 表示是否适合当景点封面（菜品/菜单/商品陈列/文字不适合作封面）。',
  }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(AI_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI_KEY },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content }], max_tokens: 160 }),
        signal: AbortSignal.timeout(60000),
      });
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
  { file: 'chengdu.json', id: 'zhongshuge', name: '钟书阁（都江堰）', city: '都江堰', qs: ['钟书阁 都江堰', '都江堰 钟书阁 书店 内景'] },
  { file: 'dunhuang.json', id: 'x7451fb8e', name: '敦煌研究院文化创意馆', city: '敦煌', qs: ['敦煌研究院 文化创意馆', '敦煌 文创馆 建筑'] },
  { file: 'huangshan.json', id: 's526c6dbf', name: '练江新夜市', city: '歙县', qs: ['练江新夜市 歙县', '歙县 练江 夜市'] },
  { file: 'huangshan.json', id: 'sf9fb9960', name: '百大名品门特色小吃一条街', city: '黄山', qs: ['百大名品门 小吃街', '屯溪 小吃街 牌坊 夜景'] },
  { file: 'huhehaote.json', id: 'sd00325a9', name: '饕界美食街', city: '呼和浩特', qs: ['饕界美食街 呼和浩特', '呼和浩特 美食街 夜景'] },
  { file: 'kaifeng.json', id: 's2e28a026', name: '开封博物馆', city: '开封', qs: ['开封博物馆 新馆 外观', '开封博物馆 建筑'] },
  { file: 'kashi.json', id: 'xc20b5e3f', name: '喀什美食街(团结路店)', city: '喀什', qs: ['喀什 团结路 美食街', '喀什 夜市 街景'] },
  { file: 'luoyang.json', id: 'sf8a13094', name: '日光夜市(肆)', city: '洛阳', qs: ['洛阳 日光夜市', '洛阳 老城 夜市 街景'] },
  { file: 'quanzhou.json', id: 's574eb53a', name: '阳光夜市', city: '泉州', qs: ['泉州 阳光夜市', '泉州 夜市 街景'] },
  { file: 'taiyuan.json', id: 'se879d952', name: '太原市博物馆', city: '太原', qs: ['太原市博物馆 外观', '太原博物馆 建筑'] },
  { file: 'wuyuan.json', id: 's0f2b0de6', name: '红山文体公园', city: '婺源', qs: ['婺源 红山文体公园', '婺源 红山 公园'] },
];

(async () => {
  const photosDir = path.join(ROOT, 'web', 'photos');
  fs.mkdirSync(photosDir, { recursive: true });
  const report = [];
  for (const t of targets) {
    const seen = new Set();
    const cands = [];
    for (const q of t.qs) {
      const list = await search(q);
      for (const c of list) {
        if (BAD.test(c.murl) || seen.has(c.murl)) continue;
        seen.add(c.murl);
        cands.push(c);
      }
      if (cands.length >= 30) break;
    }
    let pick = null;
    let checked = 0;
    for (const c of cands.slice(0, 14)) {
      const d = await download(c.murl);
      if (!d) continue;
      checked++;
      const v = await verify(t.name, t.city, d.buf.toString('base64'));
      if (v && v.match === true && v.cover === true) { pick = { d, c, v }; break; }
      if (checked >= 8) break;
    }
    if (!pick) { report.push({ ...t, err: 'no-verified-photo', candidates: cands.length, checked }); console.log(t.name, 'NO', cands.length, checked); continue; }
    const fname = t.file.replace('.json', '') + '-' + t.id + '.jpg';
    const fp = path.join(photosDir, fname);
    fs.writeFileSync(fp, pick.d.buf);
    report.push({ ...t, src: pick.c.murl, purl: pick.c.purl, title: pick.c.title, w: pick.d.w, h: pick.d.h, bytes: pick.d.buf.length, file: '/photos/' + fname, verdict: pick.v, checked });
    console.log(t.name, '->', pick.d.w + 'x' + pick.d.h, '(' + pick.v.kind + ')', pick.c.murl.slice(0, 70));
  }
  fs.writeFileSync(path.join(ROOT, 'build', 'web-photo-verified.json'), JSON.stringify(report, null, 1), 'utf8');
})();