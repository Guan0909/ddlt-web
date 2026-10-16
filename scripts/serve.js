'use strict';
// 本地预览服务器：与 vercel.json 相同的路由规则，/api 代理到 CloudBase。
// 用法：node scripts/serve.js [端口=8130]
// 启动时会打印真实「站点根」，因为同一个端口上很可能还挂着别的项目拷贝留下的旧服务
// （旧服务会用旧代码骗你：2026-10-16 就发生过一次，8131 上跑的是迁移前的 
//  D:\kimi files\点定旅途 那份拷贝，页面里没有当天的新改动）。

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = +process.argv[2] || 8130;
const API_TARGET = 'https://ddlt-d7gvi23us2cc67847.service.tcloudbase.com';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const REWRITES = [
  [/^\/$/, '/web/index.html'],
  [/^\/(index|result|loading|share|poster|privacy)$/, '/web/$1.html'],
  [/^\/(index|result|loading|share|poster|privacy)\.html$/, '/web/$1.html'],
  [/^\/share\/[0-9a-f]{32}$/, '/web/share.html'],
  [/^\/assets\/(.+)$/, '/web/assets/$1'],
];

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);

  if (p.startsWith('/api/')) {
    // 代理到 CloudBase 云函数
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const r = await fetch(API_TARGET + p.slice(4), {
        method: req.method, headers: { 'Content-Type': 'application/json' }, body,
      });
      const text = await r.text();
      res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text);
    } catch (e) {
      res.writeHead(502); res.end(JSON.stringify({ error: String(e.message) }));
    }
    return;
  }

  for (const [re, dest] of REWRITES) {
    const m = p.match(re);
    if (m) { p = dest.replace(/\$(\d)/g, (_, n) => m[n]); break; }
  }

  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  let entryNote = '（缺 web/result.html）';
  try { entryNote = fs.statSync(path.join(ROOT, 'web', 'result.html')).mtime.toLocaleString(); } catch (e) {}
  console.log(`本地预览 http://localhost:${PORT}（路由规则同 vercel.json）`);
  console.log(`站点根：${ROOT}`);                      // 先看清在预览哪一份拷贝
  console.log(`web/result.html 最后修改：${entryNote}`);
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用——很可能是上次留下的预览服务；`);
    console.error('若它跑在别的项目拷贝里，你看到的就是旧代码。先查是谁：');
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }`);
    console.error(`或换个端口：node scripts/serve.js ${PORT + 1}`);
    process.exit(1);
  }
  throw e;
});

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => resolve(b));
  });
}
