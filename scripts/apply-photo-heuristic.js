'use strict';
const fs=require('fs'), path=require('path');
const ROOT='D:\\Deep Seek Files\\点定旅途';
const dir=path.join(ROOT,'data','spots');
const rep=JSON.parse(fs.readFileSync(path.join(ROOT,'build','photo-vision-report.json'),'utf8'));
const score=u=>{ const s=String(u); if(/store\.is\.autonavi\.com/.test(s)) return 0; if(/aliyuncs\.com|aos-cdn-image/.test(s)) return 1; return 2; };
let changed=0;
for(const f of fs.readdirSync(dir).filter(f=>/^[a-z-]+\.json$/.test(f))){
  const p=path.join(dir,f); const j=JSON.parse(fs.readFileSync(p,'utf8')); if(!Array.isArray(j.spots)) continue;
  let dirty=false;
  for(const s of j.spots){
    const rec=rep[f+'|'+s.id];
    const needFix = !rec || rec.err || rec.best===-1;
    if(!needFix) continue;
    const ph=Array.isArray(s.photos)?s.photos.slice():[];
    if(ph.length<2) continue;
    const sorted=ph.map((u,i)=>({u,i,sc:score(u)})).sort((a,b)=>a.sc-b.sc||a.i-b.i);
    if(sorted[0].i!==0){ s.photos=sorted.map(x=>x.u); s.photo=s.photos[0]; changed++; dirty=true; }
  }
  if(dirty) fs.writeFileSync(p, JSON.stringify(j,null,1),'utf8');
}
console.log('启发式重排封面:', changed);