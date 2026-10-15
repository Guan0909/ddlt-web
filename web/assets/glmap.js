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

  // 米制近似距离（equirectangular，城市尺度足够）
  function metersBetween(lng1, lat1, lng2, lat2) {
    const x = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
    const y = (lat2 - lat1) * 111320;
    return Math.hypot(x, y);
  }
  const normName = s => String(s || '').replace(/[\s（）()·\-—]/g, '');

  // create(container, { onSpotTap }) → { setDay, destroy } 或创建失败抛错
  function create(container, { onSpotTap } = {}) {
    const map = new TMap.Map(container, {
      center: new TMap.LatLng(30.657, 104.0668),
      zoom: 12,
      viewMode: '2D',
      showBuilding: false,
      // 控制台「个性化地图」发布的自定义样式（安静路网 + 精选 POI 文字）
      ...(window.DDN_GL_STYLE_ID ? { mapStyleId: window.DDN_GL_STYLE_ID } : {}),
    });
    // 未配自定义样式时退回默认样式 + 柔化滤镜，保持品牌观感
    if (!window.DDN_GL_STYLE_ID) container.style.filter = DDN.MAP_SOFT_FILTER;

    let stopLayer = null, dotLayer = null, stopLabelLayer = null, spotLabelLayer = null, routeHalo = null, routeMain = null;
    let pathToken = 0;
    let curDay = null;        // 当前一天的 { origin, stops, others }，供缩放停稳后重建标签
    let lastLabelZoom = null; // 上次重建标签时的 zoom（未变化则跳过）

    function clearLayers() {
      for (const l of [stopLayer, dotLayer, stopLabelLayer, spotLabelLayer, routeHalo, routeMain]) {
        if (l) { try { l.setMap(null); } catch (e) {} }
      }
      stopLayer = dotLayer = stopLabelLayer = spotLabelLayer = routeHalo = routeMain = null;
    }

    // ---------- 标签层：站点名（必显）+ 其他景点名（zoom≥13 且避让底图文字） ----------
    // k = px/度（setDay 时用包围盒推算的视野值；idle 时用当前 zoom 换算）
    function rebuildLabels(k, zoom) {
      if (!curDay) return;
      lastLabelZoom = zoom;
      const { origin, stops, others } = curDay;
      const inRoute = new Set(stops.map(s => s.id));
      const labelWidth = (name, size) => Math.min(name.length, 9) * size + 6;
      const crowded = (placed, lng, lat, wp) => placed.some(q =>
        Math.abs(q.lng - lng) < (q.w + wp) / 2 / k && Math.abs(q.lat - lat) < 18 / k);

      // 站点名先占位：必显，遇近邻换到点下方一档（不避让底图——路线主体的可读性优先）
      const placed = [];
      const stopPts = [
        { id: 'lborigin', lng: origin.lng, lat: origin.lat, name: origin.name },
        ...stops.map(s => ({ id: 'lb' + s.id, lng: s.coord[0], lat: s.coord[1], name: s.name })),
      ];
      const stopGeoms = stopPts.map(p => {
        const wp = labelWidth(p.name, 12);
        const near = crowded(placed, p.lng, p.lat, wp);
        placed.push({ lng: p.lng, lat: p.lat, w: wp });
        return {
          id: p.id, styleId: near ? 'stopLabelAlt' : 'stopLabel', rank: 2,
          position: new TMap.LatLng(p.lat, p.lng),
          content: p.name.length > 10 ? p.name.slice(0, 9) + '…' : p.name,
        };
      });

      // 其他景点：低倍让位给底图风景名胜（zoom<13 不标字）；高倍出现并与底图文字碰撞避让
      const spotGeoms = [];
      if (zoom >= 13) {
        for (const s of others || []) {
          if (inRoute.has(s.id) || !s.coord) continue;
          const wp = labelWidth(s.name, 11);
          if (crowded(placed, s.coord[0], s.coord[1], wp)) continue;
          placed.push({ lng: s.coord[0], lat: s.coord[1], w: wp });
          spotGeoms.push({
            id: 'lb' + s.id, styleId: 'spotLabel', rank: 1,
            position: new TMap.LatLng(s.coord[1], s.coord[0]),
            content: s.name, properties: { spot: s },
          });
        }
      }

      for (const l of [stopLabelLayer, spotLabelLayer]) {
        if (l) { try { l.setMap(null); } catch (e) {} }
      }
      stopLabelLayer = new TMap.MultiLabel({
        map,
        isStopPropagation: true,   // 点我们的标签不穿透到地图 click（避免连带触发底图 POI 拾取）
        collisionOptions: { sameSource: true, crossSource: true, vectorBaseMapSource: false },
        styles: {
          stopLabel: new TMap.LabelStyle({
            color: '#182119', size: 12, offset: { x: 0, y: -16 },
            strokeColor: '#FBFBF8', strokeWidth: 3,
          }),
          stopLabelAlt: new TMap.LabelStyle({
            color: '#182119', size: 12, offset: { x: 0, y: 22 },
            strokeColor: '#FBFBF8', strokeWidth: 3,
          }),
        },
        geometries: stopGeoms,
      });
      spotLabelLayer = new TMap.MultiLabel({
        map,
        isStopPropagation: true,
        // 与底图 POI 文字避让：底图风景名胜已有名字的地方，我们的重复标签自动隐藏
        collisionOptions: { sameSource: true, crossSource: true, vectorBaseMapSource: true },
        styles: {
          spotLabel: new TMap.LabelStyle({
            color: '#4a554d', size: 11, offset: { x: 0, y: -14 },
            strokeColor: '#FBFBF8', strokeWidth: 3,
          }),
        },
        geometries: spotGeoms,
      });
      if (onSpotTap) {
        spotLabelLayer.on('click', evt => {
          const s = evt.geometry && evt.geometry.properties && evt.geometry.properties.spot;
          if (s) onSpotTap(s);
        });
      }
    }

    // 缩放/拖拽停稳后：按当前 zoom 重算标签避让（修复"初始视野算的旧账"）
    map.on('idle', () => {
      if (!curDay) return;
      const z = map.getZoom();
      if (lastLabelZoom !== null && Math.abs(z - lastLabelZoom) < 0.5) return;
      rebuildLabels(256 * Math.pow(2, z) / 360, z);
    });

    // ---------- 底图风景名胜点击拾取（evt.poi：名字+坐标，仅 click） ----------
    map.on('click', evt => {
      const poi = evt.poi;
      if (!poi || !curDay) return;
      const all = [...(curDay.others || []), ...curDay.stops];
      const pn = normName(poi.name);
      if (!pn) return;
      let best = null, bd = Infinity;
      for (const s of all) {
        if (!s.coord) continue;
        const sn = normName(s.name);
        const d = metersBetween(s.coord[0], s.coord[1], poi.latLng.lng, poi.latLng.lat);
        const nameHit = sn === pn || sn.includes(pn) || pn.includes(sn);
        if (nameHit && d < 300) { best = s; break; }   // 名字命中且距离合理
        if (d < 120 && d < bd) { bd = d; best = s; }   // 纯距离兜底
      }
      if (!best) { DDN.toast('这个点不在我们的精选库'); return; }
      if (curDay.stops.some(s => s.id === best.id)) { DDN.toast(`「${best.name}」今天已经排了`); return; }
      if (onSpotTap) onSpotTap(best);
    });

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
          try { routeHalo.setMap(null); routeMain.setMap(null); } catch (e) {}
          routeHalo = new TMap.MultiPolyline({
            map,
            styles: { halo: new TMap.PolylineStyle({ color: 'rgba(255,255,255,.9)', width: 9, lineCap: 'round' }) },
            geometries: geoms.map(g => ({ ...g, styleId: 'halo' })),
          });
          routeMain = new TMap.MultiPolyline({
            map,
            styles: { main: new TMap.PolylineStyle({ color, width: 5.5, lineCap: 'round' }) },
            geometries: geoms,
          });
        }
      } catch (e) { /* 保持直线示意 */ }
    }

    // setDay({ origin:{lng,lat,name}, stops:[{id,name,coord:[lng,lat]}], others:[spots 库], color, legs?:[{from,to,mode}] })
    function setDay({ origin, stops, others, color, legs }) {
      clearLayers();
      const token = ++pathToken;
      const inRoute = new Set(stops.map(s => s.id));
      const bounds = new TMap.LatLngBounds();
      const all = [origin, ...stops.map(s => ({ lng: s.coord[0], lat: s.coord[1] }))];
      all.forEach(p => bounds.extend(new TMap.LatLng(p.lat, p.lng)));

      // 视野像素尺度（fitBounds 应用前的推算值；idle 事件到达后会用真实 zoom 重建标签）
      const w = container.clientWidth || 400, h = container.clientHeight || 280;
      const padBase = Math.max(30, Math.min(52, Math.round(w * 0.13)));
      const padRight = Math.round(w * 0.26);
      const lngs = all.map(p => p.lng), lats = all.map(p => p.lat);
      const spanLng = Math.max(Math.max(...lngs) - Math.min(...lngs), 1e-4);
      const spanLat = Math.max(Math.max(...lats) - Math.min(...lats), 1e-4);
      const k = Math.max(1, Math.min((w - padBase - padRight) / spanLng, (h - padBase * 2) / spanLat)); // px / 度
      const fitZoom = Math.log2(k * 360 / 256);

      curDay = { origin, stops, others };
      rebuildLabels(k, fitZoom);

      // 路线：先直线（白衬底 + 当日色），真实路径到达后升级
      const path = [...all.map(p => new TMap.LatLng(p.lat, p.lng)), new TMap.LatLng(origin.lat, origin.lng)];
      routeHalo = new TMap.MultiPolyline({
        map,
        isStopPropagation: true,
        styles: { halo: new TMap.PolylineStyle({ color: 'rgba(255,255,255,.9)', width: 9, lineCap: 'round' }) },
        geometries: [{ id: 'halo', styleId: 'halo', paths: path }],
      });
      routeMain = new TMap.MultiPolyline({
        map,
        isStopPropagation: true,
        styles: { main: new TMap.PolylineStyle({ color, width: 5.5, lineCap: 'round' }) },
        geometries: [{ id: 'main', styleId: 'main', paths: path }],
      });
      if (legs && legs.length > 1 && DDN.cloudAvailable()) upgradeToRealPaths(legs, color, token);

      // 其他景点：点全部保留（可点选加入当天），标签由 rebuildLabels 按缩放与避让决定
      const otherGeoms = [];
      for (const s of others || []) {
        if (inRoute.has(s.id) || !s.coord) continue;
        otherGeoms.push({ id: s.id, styleId: 'spot', position: new TMap.LatLng(s.coord[1], s.coord[0]), properties: { spot: s } });
      }
      dotLayer = new TMap.MultiMarker({
        map,
        isStopPropagation: true,
        styles: { spot: new TMap.MarkerStyle({ width: 12, height: 12, src: dotURI('#7d887f', 4.4, '#FBFBF8'), anchor: { x: 6, y: 6 } }) },
        geometries: otherGeoms,
      });

      // 起点 + 站点标记
      const stopGeoms = [
        { id: 'origin', styleId: 'origin', position: new TMap.LatLng(origin.lat, origin.lng) },
        ...stops.map(s => ({ id: s.id, styleId: 'stop', position: new TMap.LatLng(s.coord[1], s.coord[0]) })),
      ];
      stopLayer = new TMap.MultiMarker({
        map,
        isStopPropagation: true,
        styles: {
          origin: new TMap.MarkerStyle({ width: 34, height: 34, src: originURI(), anchor: { x: 17, y: 17 } }),
          stop: new TMap.MarkerStyle({ width: 20, height: 20, src: dotURI(color, 7.5, '#fff'), anchor: { x: 10, y: 10 } }),
        },
        geometries: stopGeoms,
      });

      if (onSpotTap) {
        dotLayer.on('click', evt => {
          const s = evt.geometry && evt.geometry.properties && evt.geometry.properties.spot;
          if (s) onSpotTap(s);
        });
      }

      // 右上角有 GL 自带缩放控件，按容器宽度留出净空（窄屏同比缩小，避免过度留白）
      if (all.length > 1) {
        map.fitBounds(bounds, { padding: { top: padBase, right: padRight, bottom: padBase, left: padBase } });
      } else { map.setCenter(new TMap.LatLng(origin.lat, origin.lng)); map.setZoom(14); }
    }

    function destroy() { clearLayers(); try { map.destroy(); } catch (e) {} }
    return { setDay, destroy, map };
  }

  return { load, create };
})();
