'use strict';
// 腾讯地图 JS API(GL) 动态地图层。仅当 web/assets/config.js 配了 DDN_GL_KEY 才启用；
// 该 Key 为前端公开 Key（控制台配 decidenow.asia / tcloudbaseapp.com 域名白名单防盗用），
// 与云函数环境变量里的 WebService Key 双隔离。
window.DDNGL = (() => {
  let readyPromise = null;
  // 视野半径：规划模式给「起点周边」的舒适视野，编辑模式给「当天路线周边」。
  // 规划模式不再 fit 全天跨度——远郊日会把视野拉到 60km+，圆点密集、画面空旷。
  const PLAN_VIEW_RADIUS_KM = 6;
  const EDIT_VIEW_RADIUS_KM = 15;
  // 缩放下限：最多缩到约 45km 宽（不让用户缩成"看整个省"的空画面）；上限交给 GL 默认
  const MIN_VIEW_KM = 45;
  const MAX_ZOOM = 18;

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
  // 站点序号徽章（模仿主流地图：实心圆 + 白色序号）
  function badgeURI(color, num) {
    const s = 32, c = s / 2, r = 13;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + s + '" height="' + s + '">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + (r + 2) + '" fill="rgba(24,33,25,.16)"/>' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="' + color + '" stroke="#fff" stroke-width="2.4"/>' +
      '<text x="' + c + '" y="' + (c + 5) + '" font-family="-apple-system,PingFang SC,sans-serif" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">' + num + '</text></svg>';
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

  // create(container, { onSpotTap, onSpotToggle })
  //   onSpotTap(spot)：规划模式下点底图 POI 命中库内点（加入抽屉）
  //   onSpotToggle(spot, selected)：编辑模式下点景点（加入/移出切换）
  function create(container, { onSpotTap, onSpotToggle } = {}) {
    // 缩放下限由「最小可视宽度」换算成 zoom：meters/px = 156543·cos(lat)/2^z
    const minZoomFor = (w, lat) => Math.max(4, Math.log2((w || 430) * 156543 * Math.cos(lat * Math.PI / 180) / (MIN_VIEW_KM * 1000)));
    const map = new TMap.Map(container, {
      center: new TMap.LatLng(30.657, 104.0668),
      zoom: 12,
      minZoom: minZoomFor(container.clientWidth, 30.66),
      maxZoom: MAX_ZOOM,
      viewMode: '2D',
      showBuilding: false,
      // 控制台「个性化地图」发布的自定义样式（安静路网 + 精选 POI 文字）
      ...(window.DDN_GL_STYLE_ID ? { mapStyleId: window.DDN_GL_STYLE_ID } : {}),
    });
    // 未配自定义样式时退回默认样式 + 柔化滤镜，保持品牌观感
    if (!window.DDN_GL_STYLE_ID) container.style.filter = DDN.MAP_SOFT_FILTER;

    let stopLayer = null, dotLayer = null, stopLabelLayer = null, spotLabelLayer = null, routeHalo = null, routeMain = null, routeLink = null, routeSchematic = null, routeFallback = null;
    let curColor = '#3B7356';   // 当前天的路线色（线宽按缩放更新时用）
    let pathToken = 0;
    let fitSeq = 0;           // 视野 fit 的序号：延迟执行时只认最后一次
    let curDay = null;        // { origin, stops, others, edit }，供缩放停稳后重建标签
    let lastLabelZoom = null; // 上次重建标签时的 zoom（未变化则跳过）

    function clearLayers() {
      for (const l of [stopLayer, dotLayer, stopLabelLayer, spotLabelLayer, routeHalo, routeMain, routeLink, routeSchematic, routeFallback]) {
        if (l) { try { l.setMap(null); } catch (e) {} }
      }
      stopLayer = dotLayer = stopLabelLayer = spotLabelLayer = routeMain = routeHalo = routeLink = routeSchematic = routeFallback = null;
    }

    // ---------- 标签层：站点名（必显）+ 编辑模式下的其他景点名（碰撞避让交给 GL） ----------
    // k = px/度（setDay 时用包围盒推算；idle 时用当前 zoom 换算）
    function rebuildLabels(k, zoom) {
      if (!curDay) return;
      lastLabelZoom = zoom;
      const { origin, stops, others, edit } = curDay;
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
        const seqIdx = stops.findIndex(s => s.id === p.id);
        const seq = seqIdx >= 0 ? (seqIdx + 1) + '. ' : '';
        return {
          id: p.id, styleId: near ? 'stopLabelAlt' : 'stopLabel', rank: 2,
          position: new TMap.LatLng(p.lat, p.lng),
          content: seq + (p.name.length > 9 ? p.name.slice(0, 8) + '…' : p.name),
        };
      });

      // 其他景点名：只在编辑模式给（规划视图只留路线与站点）；GL 碰撞避让自动消解重叠
      const spotGeoms = [];
      if (edit) {
        // 低倍率下景点名会糊成一片：按评分降序只给前 N 个标签（缩放后自动重建）
        const cap = zoom < 12.5 ? 10 : zoom < 13.5 ? 16 : 24;
        let shown = 0;
        const sorted = [...(others || [])].sort((a, b) => (b.rating || 0) - (a.rating || 0));
        for (const s of sorted) {
          if (inRoute.has(s.id) || !s.coord) continue;
          if (shown >= cap) break;
          const wp = labelWidth(s.name, 11);
          if (crowded(placed, s.coord[0], s.coord[1], wp)) continue;
          shown++;
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
        // 与底图 POI 文字避让：底图已有名字的地方，我们的重复标签自动隐藏
        collisionOptions: { sameSource: true, crossSource: true, vectorBaseMapSource: true },
        styles: {
          spotLabel: new TMap.LabelStyle({
            color: '#4a554d', size: 11, offset: { x: 0, y: -14 },
            strokeColor: '#FBFBF8', strokeWidth: 3,
          }),
        },
        geometries: spotGeoms,
      });
      if (edit && onSpotToggle) {
        spotLabelLayer.on('click', evt => {
          const s = evt.geometry && evt.geometry.properties && evt.geometry.properties.spot;
          if (s) onSpotToggle(s, false);
        });
      } else if (onSpotTap) {
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
      applyRouteMode(z);   // 概览模式：低倍率用平滑示意线，放大后再显示真实路网
      if (lastLabelZoom !== null && Math.abs(z - lastLabelZoom) < 0.5) return;
      rebuildLabels(256 * Math.pow(2, z) / 360, z);
    });

    // ---------- 底图 POI 点击拾取（evt.poi：名字+坐标，仅 click） ----------
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
      const selected = curDay.stops.some(s => s.id === best.id);
      if (curDay.edit) {
        if (onSpotToggle) onSpotToggle(best, selected);
        return;
      }
      if (selected) { DDN.toast(`「${best.name}」今天已经排了`); return; }
      if (onSpotTap) onSpotTap(best);
    });

    // 真实路网路径（routePaths 云函数）；全部失败才回退直线示意
    async function upgradeToRealPaths(legs, color, token, straightGeoms) {
      try {
        const j = await DDN.cloudPost('routePaths', { legs }, 12000);
        if (token !== pathToken || !j.paths) return;
        const links = [], fallbackGeoms = [];
        // 主流地图观感：相邻腿在站点处相接 → 合并为一条连续折线（不再多条叠加交叉）
        const merged = [];
        const pushPath = pts => {
          if (!pts || pts.length < 2) return;
          const last = merged[merged.length - 1];
          if (last) {
            const tail = last[last.length - 1];
            const head = pts[0];
            const d = metersBetween(tail[1], tail[0], head[1], head[0]);
            if (d <= 45) { last.push.apply(last, pts.slice(1)); return; }
          }
          merged.push(pts.slice());
        };
        // 「线点分离」补线：服务端已把 ≤120m 的端头吸附掉；120~600m（实测远郊驾车 171~254m，
        // 路网只到景区门口）用一条浅色细线连到圆点，明确表达「最后一段步行」，不冒充真实路网。
        const LINK_MIN_M = 120, LINK_MAX_M = 600;
        const addLink = (tail, target) => {
          if (!tail || !target) return;
          const d = metersBetween(tail.lng, tail.lat, target.lng, target.lat);
          if (d <= LINK_MIN_M || d > LINK_MAX_M) return;
          links.push({ id: 'link' + links.length, styleId: 'link', paths: [
            new TMap.LatLng(tail.lat, tail.lng), new TMap.LatLng(target.lat, target.lng)] });
        };
        j.paths.forEach((path, i) => {
          const leg = legs[i];
          if (!path || path.length < 2) {
            // 单腿失败：用虚线浅色兜底（明确是估算段，不冒充真实路网）
            fallbackGeoms.push({ id: 'fb' + i, styleId: 'fb', paths: [
              new TMap.LatLng(leg.from.lat, leg.from.lng),
              new TMap.LatLng(leg.to.lat, leg.to.lng)] });
            return;
          }
          pushPath(path);   // [lat,lng] 序列，最后统一合成一条线
          const head = { lng: path[0][1], lat: path[0][0] };
          const tail = { lng: path[path.length - 1][1], lat: path[path.length - 1][0] };
          if (i === 0) addLink(head, leg.from);   // 起点侧
          addLink(tail, leg.to);
        });
        drawRoute(merged.length ? [{ id: 'main', styleId: 'main', paths: merged.map(arr => arr.map(p => new TMap.LatLng(p[0], p[1]))) }] : [], color, links, fallbackGeoms);
      } catch (e) {
        if (straightGeoms) drawRoute([], color, [], straightGeoms);   // 整体失败：虚线示意 + 概览线
      }
    }

    // 十六进制品牌色 → 稍带透明度，线交叠处不发闷（非 6 位 hex 原样返回）
    const withAlpha = (c, a) => {
      if (!/^#[0-9a-f]{6}$/i.test(String(c || ''))) return c;
      const n = parseInt(c.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
    };

    // 补线样式：细、淡，明显弱于主路线；dashArray 不被支持时退回同色实线（仍然远弱于主线）
    const LINK_COLOR = 'rgba(24,33,25,.34)';
    function linkStyle(width) {
      const w = width || 2;
      try { return new TMap.PolylineStyle({ color: LINK_COLOR, width: w, lineCap: 'round', dashArray: [2, 2] }); }
      catch (e) { return new TMap.PolylineStyle({ color: LINK_COLOR, width: w, lineCap: 'round' }); }
    }

    // 线宽随缩放分级：低倍率加粗（并保留细描边），放大后回到精细线宽
    function routeWidths(zoom) {
      // 模仿主流地图：线更粗、无白描边（宽度只接受整数）
      if (zoom >= 14.5) return { main: 5, halo: 0, link: 3, fb: 3 };
      if (zoom >= 13) return { main: 6, halo: 0, link: 3, fb: 3 };
      if (zoom >= 11.5) return { main: 7, halo: 0, link: 4, fb: 4 };
      return { main: 7, halo: 0, link: 4, fb: 4 };
    }
    function applyRouteWidths(zoom) {
      const w = routeWidths(zoom);
      const setStyle = (layer, key, style) => { try { if (layer) layer.setStyles({ [key]: style }); } catch (e) {} };
      setStyle(routeMain, 'main', new TMap.PolylineStyle({ color: curColor, width: w.main, lineCap: 'round', lineJoin: 'round' }));
      setStyle(routeSchematic, 'sch', new TMap.PolylineStyle({ color: withAlpha(curColor, 0.9), width: w.main + 1, lineCap: 'round', lineJoin: 'round' }));
      // link / fallback 样式在创建时固定（GL 对 setStyles 部分字段校验严格）
    }
    function fallbackStyle(width) {
      try { return new TMap.PolylineStyle({ color: 'rgba(24,33,25,.30)', width: width || 2, lineCap: 'round', dashArray: [5, 4] }); }
      catch (e) { return new TMap.PolylineStyle({ color: 'rgba(24,33,25,.30)', width: width || 2, lineCap: 'round' }); }
    }
    // 概览模式：低倍率（<12.6）不画真实路网细节，改画「站点顺序的平滑示意线」
    function buildSchematic() {
      const cd = curDay;
      if (!cd || !cd.origin) return [];
      const pts = [{ lng: cd.origin.lng, lat: cd.origin.lat }].concat((cd.stops || []).map(s => ({ lng: s.coord[0], lat: s.coord[1] })));
      const out = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dLng = b.lng - a.lng, dLat = b.lat - a.lat;
        const bow = 0.10 * (i % 2 === 0 ? 1 : -1);
        const cLng = (a.lng + b.lng) / 2 - dLat * bow;
        const cLat = (a.lat + b.lat) / 2 + dLng * bow;
        const seg = [];
        const N = 12;
        for (let k = 0; k <= N; k++) {
          const t = k / N;
          const x = (1 - t) * (1 - t) * a.lng + 2 * (1 - t) * t * cLng + t * t * b.lng;
          const y = (1 - t) * (1 - t) * a.lat + 2 * (1 - t) * t * cLat + t * t * b.lat;
          seg.push(new TMap.LatLng(y, x));
        }
        out.push({ id: 'sch' + i, styleId: 'sch', paths: seg });
      }
      return out;
    }
    function applyRouteMode(zoom) {
      const z = (typeof zoom === 'number' && isFinite(zoom)) ? zoom : (map.getZoom ? map.getZoom() : 13);
      const overview = z < 12.6;   // 概览：只显示平滑示意线；放大到 12.6+ 才显示真实路网细节
      const show = (layer, on) => { try { if (layer) layer.setMap(on ? map : null); } catch (e) {} };
      show(routeHalo, !overview);
      show(routeMain, !overview);
      show(routeLink, !overview);
      show(routeFallback, !overview);
      show(routeSchematic, overview);
      applyRouteWidths(z);
      try { window.__routeMode = overview ? 'overview' : 'detail'; window.__routeZoom = z; } catch (e) {}
    }
    function drawRoute(geoms, color, links, fallbackGeoms) {
      curColor = color || '#3B7356';
      for (const l of [routeHalo, routeMain, routeLink, routeSchematic, routeFallback]) {
        if (l) { try { l.setMap(null); } catch (e) {} }
      }
      const w = routeWidths(map.getZoom ? map.getZoom() : 13);
      routeLink = new TMap.MultiPolyline({
        map,
        isStopPropagation: true,
        styles: { link: linkStyle(w.link) },
        geometries: links || [],
      });
      routeHalo = null;   // 不再画白色描边，模仿主流地图的单层实色线
      routeMain = new TMap.MultiPolyline({
        map,
        isStopPropagation: true,
        styles: { main: new TMap.PolylineStyle({ color: curColor, width: w.main, lineCap: 'round', lineJoin: 'round' }) },
        geometries: geoms || [],
      });
      routeFallback = new TMap.MultiPolyline({
        map,
        isStopPropagation: true,
        styles: { fb: fallbackStyle(w.fb) },
        geometries: (fallbackGeoms || []).map(x => ({ ...x, styleId: 'fb' })),
      });
      routeSchematic = new TMap.MultiPolyline({
        map,
        isStopPropagation: true,
        styles: { sch: new TMap.PolylineStyle({ color: withAlpha(curColor, 0.9), width: w.main + 1, lineCap: 'round', lineJoin: 'round' }) },
        geometries: buildSchematic(),
      });
      applyRouteMode(map.getZoom ? map.getZoom() : 13);
    }

    // setDay({ origin:{lng,lat,name}, stops:[{id,name,coord:[lng,lat]}], others:[spots 库], color,
    //        legs?:[{from,to,mode}], mode?:'plan'|'edit', keepView?:bool })
    // plan：只画路线+站点（其余景点不出现）；edit：画全部景点（无路线），站点更醒目，点击切换加入/移出
    function setDay({ origin, stops, others, color, legs, mode, keepView }) {
      clearLayers();
      const token = ++pathToken;
      const edit = mode === 'edit';
      const inRoute = new Set(stops.map(s => s.id));
      const all = [origin, ...stops.map(s => ({ lng: s.coord[0], lat: s.coord[1] }))];
      const othersAll = edit ? (others || []) : [];

      // 视野：规划模式默认「起点周边 PLAN_VIEW_RADIUS_KM」；只有当天站点都落在该半径内时才 fit 全部点
      // （城内日视野更紧凑，远郊日不会被拉到 60km+）。编辑模式以当天路线为中心、半径 15km。
      // 与路线取并集：远郊日路线本身超过 30km 时，绝不把当天站点切出视野。
      const w = container.clientWidth || 400, h = container.clientHeight || 280;
      const padBase = Math.max(30, Math.min(52, Math.round(w * 0.13)));
      const padRight = edit ? padBase : Math.round(w * 0.26);   // 规划模式右侧留给缩放控件

      let fitPts = all;
      if (edit) {
        const lngs0 = all.map(p => p.lng), lats0 = all.map(p => p.lat);
        const cLng = (Math.min(...lngs0) + Math.max(...lngs0)) / 2;
        const cLat = (Math.min(...lats0) + Math.max(...lats0)) / 2;
        const dLat = EDIT_VIEW_RADIUS_KM / 111.32;
        const dLng = EDIT_VIEW_RADIUS_KM / (111.32 * Math.max(0.2, Math.cos(cLat * Math.PI / 180)));
        fitPts = [...all, { lng: cLng - dLng, lat: cLat - dLat }, { lng: cLng + dLng, lat: cLat + dLat }];
      } else {
        // 规划模式：当天站点都在「起点周边 R」内 → fit 全部点（紧凑）；否则只给起点周边 R，
        // 路线自然延伸出画面（远郊日），用户可平移/缩放查看，但不会被拉到 60km+ 的空旷视野。
        const R = PLAN_VIEW_RADIUS_KM;
        const far = all.some(p => metersBetween(origin.lng, origin.lat, p.lng, p.lat) > R * 1000);
        if (far && all.length > 1) {
          // 盒子按「内容区」的纵横比给：内容区正好 2R 宽（扁容器不会把横向放大成 25km+）
          const cw = Math.max(80, w - padBase - padRight);
          const ch = Math.max(60, h - padBase * 2);
          const dLng = R / (111.32 * Math.max(0.2, Math.cos(origin.lat * Math.PI / 180)));
          const dLat = (R / 111.32) * (ch / cw);
          fitPts = [all[0],
            { lng: origin.lng - dLng, lat: origin.lat - dLat },
            { lng: origin.lng + dLng, lat: origin.lat + dLat }];
        }
      }
      const bounds = new TMap.LatLngBounds();
      fitPts.forEach(p => bounds.extend(new TMap.LatLng(p.lat, p.lng)));

      // 视野像素尺度（fitBounds 应用前的推算值；idle 事件到达后会用真实 zoom 重建标签）
      // 注：w/h/padBase/padRight 已在上面算好（规划模式的视野盒子要用它们配纵横比）
      const lngs = fitPts.map(p => p.lng), lats = fitPts.map(p => p.lat);
      const spanLng = Math.max(Math.max(...lngs) - Math.min(...lngs), 1e-4);
      const spanLat = Math.max(Math.max(...lats) - Math.min(...lats), 1e-4);
      const k = Math.max(1, Math.min((w - padBase - padRight) / spanLng, (h - padBase * 2) / spanLat)); // px / 度
      const fitZoom = Math.log2(k * 360 / 256);

      curDay = { origin, stops, others, edit, color, legs };   // others 全量保留：底图 POI 拾取匹配用；渲染层只在编辑模式画
      rebuildLabels(k, fitZoom);

      // 路线（仅规划模式）：真实路径到达前不画线（避免"看似贴路的假象"）；
      // routePaths 整体失败时才回退直线示意；不画返程（末站不回起点）
      if (!edit && all.length > 1) {
        const straightGeoms = [{
          id: 'straight', styleId: 'main',
          paths: all.map(p => new TMap.LatLng(p.lat, p.lng)),
        }];
        if (legs && legs.length && DDN.cloudAvailable()) {
          upgradeToRealPaths(legs, color, token, straightGeoms);
        } else {
          drawRoute([], color, [], straightGeoms);
        }
      }

      // 其他景点（仅编辑模式）：全量淡点，点击切换加入
      if (edit) {
        const otherGeoms = [];
        for (const s of othersAll) {
          if (inRoute.has(s.id) || !s.coord) continue;
          otherGeoms.push({ id: s.id, styleId: 'spot', position: new TMap.LatLng(s.coord[1], s.coord[0]), properties: { spot: s } });
        }
        dotLayer = new TMap.MultiMarker({
          map,
          isStopPropagation: true,
          styles: { spot: new TMap.MarkerStyle({ width: 12, height: 12, src: dotURI('#9AA69C', 4.4, '#FBFBF8'), anchor: { x: 6, y: 6 } }) },
          geometries: otherGeoms,
        });
        if (onSpotToggle) {
          dotLayer.on('click', evt => {
            const s = evt.geometry && evt.geometry.properties && evt.geometry.properties.spot;
            if (s) onSpotToggle(s, false);
          });
        }
      }

      // 起点 + 站点标记（编辑模式站点更大更醒目）
      const stopSize = edit ? 26 : 22;
      const stopGeoms = [
        { id: 'origin', styleId: 'origin', position: new TMap.LatLng(origin.lat, origin.lng) },
        ...stops.map(s => ({ id: s.id, styleId: 'stop', position: new TMap.LatLng(s.coord[1], s.coord[0]), properties: { spot: s } })),
      ];
      stopLayer = new TMap.MultiMarker({
        map,
        isStopPropagation: true,
        styles: {
          origin: new TMap.MarkerStyle({ width: 34, height: 34, src: originURI(), anchor: { x: 17, y: 17 } }),
          stop: new TMap.MarkerStyle({ width: stopSize, height: stopSize, src: dotURI(color, edit ? 10 : 8, '#fff'), anchor: { x: stopSize / 2, y: stopSize / 2 } }),
        },
        geometries: stopGeoms,
      });
      if (edit && onSpotToggle) {
        stopLayer.on('click', evt => {
          const s = evt.geometry && evt.geometry.properties && evt.geometry.properties.spot;
          if (s) onSpotToggle(s, true);
        });
      }

      if (!keepView) {
        const myFit = ++fitSeq;
        const doFit = () => {
          if (myFit !== fitSeq) return;   // 已被更晚的一次 setDay 取代
          if (fitPts.length > 1) {
            map.fitBounds(bounds, { padding: { top: padBase, right: padRight, bottom: padBase, left: padBase } });
          } else { map.setCenter(new TMap.LatLng(origin.lat, origin.lng)); map.setZoom(14); }
        };
        // 等布局生效再 fit：GL 按自己缓存的容器尺寸算视野，而 #glMap 会在「规划 280px ↔ 编辑全屏」
        // 之间切换。若在 resize 被 GL 处理前就算，视野会多拉出约 2 倍（实测 73.7km vs 39.6km 宽）。
        requestAnimationFrame(() => requestAnimationFrame(doFit));
      }
    }

    function destroy() { clearLayers(); try { map.destroy(); } catch (e) {} }
    return { setDay, destroy, map };
  }

  return { load, create };
})();
