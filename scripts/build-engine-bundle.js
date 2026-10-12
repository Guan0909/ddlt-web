'use strict';
// 把 engine/ 的 CommonJS 模块打包成浏览器可用的单文件 web/assets/engine.bundle.js
// 用法：node scripts/build-engine-bundle.js
// 原理：engine 三个文件只在本目录内互相 require，包一层模块壳即可，不引第三方打包器。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['./geo', './copy', './index'];

function wrap(name, src) {
  src = src.replace(/^'use strict';\s*/, '');
  return `__mods[${JSON.stringify(name)}] = (function(module, exports, require) {\n${src}\nreturn module.exports;\n})({ exports: {} }, undefined, __req);\n`;
}

let out = `/* 自动生成：scripts/build-engine-bundle.js · 请勿手改（源在 engine/） */\n`;
out += `window.__engineMods = {};\n`;
out += `var __mods = window.__engineMods;\n`;
out += `function __req(p) { if (!__mods[p]) throw new Error('engine module missing: ' + p); return __mods[p]; }\n`;

for (const name of FILES) {
  const src = fs.readFileSync(path.join(ROOT, 'engine', name.replace('./', '') + '.js'), 'utf8');
  out += '\n' + wrap(name, src);
}

out += `\nwindow.Engine = __mods['./index'];\nwindow.EngineGeo = __mods['./geo'];\nwindow.EngineCopy = __mods['./copy'];\n`;

const dest = path.join(ROOT, 'web', 'assets', 'engine.bundle.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(`已生成 ${path.relative(ROOT, dest)}（${(out.length / 1024).toFixed(1)}KB）`);
