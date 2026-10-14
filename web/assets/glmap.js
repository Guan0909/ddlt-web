'use strict';
// 腾讯地图 JS API(GL) 动态地图层。仅当 web/assets/config.js 配了 DDN_GL_KEY 才启用；
// 该 Key 为前端公开 Key（控制台配 decidenow.asia / tcloudbaseapp.com 域名白名单防盗用），
// 与云函数环境变量里的 WebService Key 双隔离。
window.DDNGL = (() => {
  let readyPromise = null;

  function load() {
    if (window.TMap) return Promise.resolve();
    if (!window.DDN_GL_KEY) return Promise.reject(new Error('未配置 DDN_GL_KEY'));
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = `https://map.qq.com/api/gljs?v=1.exp&key=${window.DDN_GL_KEY}`;
      s.onload = () => (window.TMap ? res() : rej(new Error('TMap 未就绪')));
      s.onerror = () => rej(new Error('GL 脚本加载失败'));
      document.head.appendChild(s);
    });
    return readyPromise;
  }

  // 圆点图标 dataURI（免外链资源）
  function dotURI(color, r, ring) {
    const s = 2 * (r + 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">` +
      `<circle cx="${s / 2}" cy="${s / 2}" r="${r}" fill="${color}" stroke="${ring}" stroke-width="2"/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function originURI() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34">` +
      `<circle cx="17" cy="17" r="15" fill="#182119" stroke="#fff" stroke-width="3"/>` +
      `<text x="17" y="21.5" font-size="12" font-weight="700" fill="#fff" text-anchor="middle" font-family="-apple-system,'PingFang SC'">起</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  // create(container, { onSpotTap }) → { setDay, destroy } 或创建失败抛错
  function create(container, { onSpotTap } = {}) {
    const map = new TMap.Map(container, {
      center: new TMap.LatLng(30.657, 104.0668),
      zoom: 12,
      viewMode: '2D',
      showBuilding: false,
    });
    // 视觉柔化：与静态图同一滤镜，底图退后、路线为主角
    container.style.filter = DDN.MAP_SOFT_FILTER;

    let stopLayer = null, dotLayer = null, labelLayer = null, routeHalo = null, routeMain = null;
    let pathToken = 0;

    function clearLayers() {
      for (const l of [stopLayer, dotLayer, labelLayer, routeHalo, routeMain]) {
        if (l) { try { l.setMap(null); } catch (e) {} }
      }
      stopLayer = dotLayer = labelLayer = routeHalo = routeMain = null;
    }

    // 真实路网路径：先画直线，routePaths 返回后升级为真实路径
    async function upgradeToRealPaths(legs, color, token) {
      try {
        const j = await DDN.cloudPost('routePaths', { legs }, 12000);
        if (token !== pathToken || !j.paths) return;
        const geoms = [];
        j.paths.forEach((path, i) => {
          if (!path || path.length < 2) {
            const leg = legs[i];   // 单腿失败回退直线
            geoms.push({ id: 'leg' + i, styleId: 'main', paths: [
              new TMap.LatLng(leg.from.lat, leg.from.lng),
              new TMap.LatLng(leg.to.lat, leg.to.lng)] });
            return;
          }
          const ll = path.map(p => new TMap.LatLng(p[0], p[1]));
          geoms.push({ id: 'leg' + i, styleId: 'main', paths: ll });
        });
        if (routeHalo && routeMain) {
          routeHalo.setGeometries(geoms.map(g => ({ ...g, styleId: 'halo' })));
          routeMain.setGeometries(geoms);
        }
      } catch (e) { /* 保持直线 */ }
    }

    // setDay({ origin:{lng,lat,name}, stops:[{id,name,coord:[lng,lat]}], others:[spots 库], color, legs?:[{from,to,mode}] })
    function setDay({ origin, stops, others, color, legs }) {
      clearLayers();
      const token = ++pathToken;
      const inRoute = new Set(stops.map(s => s.id));
      const bounds = new TMap.LatLngBounds();
      const all = [origin, ...stops.map(s => ({ lng: s.coord[0], lat: s.coord[1] }))];
      all.forEach(p => bounds.extend(new TMap.LatLng(p.lat, p.lng)));

      // 路线：先直线（白衬底 + 当日色），真实路径到达后升级
      const path = [...all.map(p => new TMap.LatLng(p.lat, p.lng)), new TMap.LatLng(origin.lat, origin.lng)];
      routeHalo = new TMap.MultiPolyline({
        map,
        styles: { halo: new TMap.PolylineStyle({ color: 'rgba(255,255,255,.9)', width: 7, lineCap: 'round' }) },
        geometries: [{ id: 'halo', styleId: 'halo', paths: path }],
      });
      routeMain = new TMap.MultiPolyline({
        map,
        styles: { main: new TMap.PolylineStyle({ color, width: 4, lineCap: 'round' }) },
        geometries: [{ id: 'main', styleId: 'main', paths: path }],
      });
      if (legs && legs.length > 1 && DDN.cloudAvailable()) upgradeToRealPaths(legs, color, token);

      // 其他景点：小点 + 小字，可点选
      const otherGeoms = [], otherLabels = [];
      for (const s of others || []) {
        if (inRoute.has(s.id) || !s.coord) continue;
        otherGeoms.push({ id: s.id, styleId: 'spot', position: new TMap.LatLng(s.coord[1], s.coord[0]), properties: { spot: s } });
        otherLabels.push({ id: 'lb' + s.id, styleId: 'spotLabel', position: new TMap.LatLng(s.coord[1], s.coord[0]), content: s.name });
      }
      dotLayer = new TMap.MultiMarker({
        map,
        styles: { spot: new TMap.MarkerStyle({ width: 12, height: 12, src: dotURI('#7d887f', 4.4, '#FBFBF8'), anchor: { x: 6, y: 6 } }) },
        geometries: otherGeoms,
      });
      labelLayer = new TMap.MultiLabel({
        map,
        styles: {
          spotLabel: new TMap.LabelStyle({
            color: '#4a554d', size: 11, offset: { x: 0, y: -14 },
            strokeColor: '#FBFBF8', strokeWidth: 3,
          }),
        },
        geometries: otherLabels,
      });
      if (onSpotTap) {
        for (const layer of [dotLayer, labelLayer]) {
          layer.on('click', evt => {
            const s = evt.geometry && evt.geometry.properties && evt.geometry.properties.spot;
            if (s) onSpotTap(s);
          });
        }
      }

      // 起点 + 站点标记与名称
      const stopGeoms = [
        { id: 'origin', styleId: 'origin', position: new TMap.LatLng(origin.lat, origin.lng) },
        ...stops.map(s => ({ id: s.id, styleId: 'stop', position: new TMap.LatLng(s.coord[1], s.coord[0]) })),
      ];
      stopLayer = new TMap.MultiMarker({
        map,
        styles: {
          origin: new TMap.MarkerStyle({ width: 34, height: 34, src: originURI(), anchor: { x: 17, y: 17 } }),
          stop: new TMap.MarkerStyle({ width: 20, height: 20, src: dotURI(color, 7.5, '#fff'), anchor: { x: 10, y: 10 } }),
        },
        geometries: stopGeoms,
      });
      const stopLabelGeoms = [
        { id: 'lborigin', styleId: 'stopLabel', position: new TMap.LatLng(origin.lat, origin.lng), content: origin.name.length > 10 ? origin.name.slice(0, 9) + '…' : origin.name },
        ...stops.map(s => ({ id: 'lb' + s.id, styleId: 'stopLabel', position: new TMap.LatLng(s.coord[1], s.coord[0]), content: s.name })),
      ];
      labelLayer = new TMap.MultiLabel({
        map,
        styles: {
          stopLabel: new TMap.LabelStyle({
            color: '#182119', size: 12, offset: { x: 0, y: -16 },
            strokeColor: '#FBFBF8', strokeWidth: 3, fontWeight: 600,
          }),
          spotLabel: new TMap.LabelStyle({
            color: '#4a554d', size: 11, offset: { x: 0, y: -14 },
            strokeColor: '#FBFBF8', strokeWidth: 3,
          }),
        },
        geometries: [...stopLabelGeoms, ...otherLabels],
      });

      if (all.length > 1) map.fitBounds(bounds, { padding: 46 });
      else { map.setCenter(new TMap.LatLng(origin.lat, origin.lng)); map.setZoom(14); }
    }

    function destroy() { clearLayers(); try { map.destroy(); } catch (e) {} }
    return { setDay, destroy, map };
  }

  return { load, create };
})();
