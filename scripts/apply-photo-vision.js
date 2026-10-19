'use strict';
// 应用视觉审计结果：把模型选出的最佳照片调为封面（photos[0]），其余顺序不变
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SPOT_DIR = path.join(ROOT, 'data', 'spots');
const REPORT = path.join(ROOT, 'build', 'photo-vision-report.json');
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const files = fs.readdirSync(SPOT_DIR).filter(f => /^[a-z-]+\.json$/.test(f));
let changed = 0, filesChanged = 0, skippedNone = 0, outOfRange = 0;
for (const f of files) {
  const p = path.join(SPOT_DIR, f);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(j.spots)) continue;
  let dirty = false;
  for (const s of j.spots) {
    const rec = report[f + '|' + s.id];
    if (!rec || typeof rec.best !== 'number') continue;
    const ph = Array.isArray(s.photos) ? s.photos.slice() : [];
    if (rec.best < 0) { skippedNone++; continue; }
    if (rec.best >= ph.length) { outOfRange++; continue; }
    if (rec.best !== 0) {
      const chosen = ph[rec.best];
      s.photos = [chosen].concat(ph.filter((_, i) => i !== rec.best));
      s.photo = s.photos[0];
      changed++; dirty = true;
    }
  }
  if (dirty) { fs.writeFileSync(p, JSON.stringify(j, null, 1), 'utf8'); filesChanged++; }
}
console.log('重排封面:', changed, '| 涉及文件:', filesChanged, '| 全不合格(跳过):', skippedNone, '| 越界:', outOfRange);