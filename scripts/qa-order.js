'use strict';
const fs=require('fs'), path=require('path');
const ROOT=path.join(__dirname,'..');
const engine=require(path.join(ROOT,'engine','index.js'));
const CITIES={成都:['chengdu',104.0657,30.6572],杭州:['hangzhou',120.1489,30.2422],北京:['beijing',116.3975,39.9087],上海:['shanghai',121.4737,31.2304],西安:['xian',108.9402,34.3416],苏州:['suzhou',120.5853,31.2989],武汉:['wuhan',114.3055,30.5928],长沙:['changsha',112.9388,28.2282],广州:['guangzhou',113.2644,23.1291],厦门:['xiamen',118.0894,24.4798],青岛:['qingdao',120.3826,36.0671],昆明:['kunming',102.8329,24.8801]};
const P=x=>({lng:x.coord?x.coord[0]:x.lng, lat:x.coord?x.coord[1]:x.lat});
function perm(a){if(a.length<=1)return[a];const o=[];for(let i=0;i<a.length;i++){const r=a.slice(0,i).concat(a.slice(i+1));for(const p of perm(r))o.push([a[i]].concat(p));}return o;}
let totalDays=0,optDays=0,inv=0,spanBad=0,sumGap=0,worst=[];
for(const [cn,[f,lng,lat]] of Object.entries(CITIES)){
  const d=JSON.parse(fs.readFileSync(path.join(ROOT,'data','spots',f+'.json'),'utf8'));
  const origin={name:'起点',lng,lat};
  for(const days of [1,3,5]){
    const r=engine.genRoute({spots:d.spots,origin,days,startDate:'2026-10-26',city:cn});
    r.dayPlans.forEach(dp=>{
      const st=dp.items.filter(i=>i.type==='stop').map(s=>d.spots.find(x=>x.id===s.id)).filter(Boolean);
      if(st.length<2) return;
      totalDays++;
      const openKm=(arr)=>{let t=0,p=P(origin);const k=Math.cos(origin.lat*Math.PI/180)*111320;for(const s of arr){const q=P(s);t+=Math.hypot((q.lng-p.lng)*k,(q.lat-p.lat)*111320)/1000;p=q;}return t;};
      const cur=openKm(st);
      let best=cur; if(st.length<=6){ for(const p of perm(st)){const c=openKm(p); if(c<best)best=c;} }
      if(cur<=best*1.02+0.05) optDays++; else { sumGap+=(cur-best); worst.push(cn+'/'+days+'天 D'+dp.day+' 当前'+cur.toFixed(1)+'km 最优'+best.toFixed(1)+'km'); }
      // 回摆
      const o=P(origin),k=Math.cos(o.lat*Math.PI/180);
      const ang=st.map(s=>{const q=P(s);return Math.atan2(q.lat-o.lat,(q.lng-o.lng)*k);});
      let last=0;for(let i=1;i<ang.length;i++){let dd=ang[i]-ang[i-1];while(dd>Math.PI)dd-=2*Math.PI;while(dd<-Math.PI)dd+=2*Math.PI;if(Math.abs(dd)<Math.PI/6)continue;const sg=dd>0?1:-1;if(last&&sg!==last)inv++;last=sg;}
      // 跨区跨度：当天最远两点距离
      let span=0;for(let i=0;i<st.length;i++)for(let j=i+1;j<st.length;j++){const a=P(st[i]),b=P(st[j]);span=Math.max(span,Math.hypot((a.lng-b.lng)*k,(a.lat-b.lat)*111320)/1000);}
      if(span>40) spanBad++;
    });
  }
}
console.log('总天数:',totalDays,'| 顺序达到最优(±2%):',optDays,'('+(optDays/totalDays*100).toFixed(0)+'%)','| 平均差距:',(sumGap/totalDays).toFixed(2)+'km','| 回摆总数:',inv,'| 跨区日(>40km):',spanBad);
worst.slice(0,5).forEach(x=>console.log('  ',x));