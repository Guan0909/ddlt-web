'use strict';
// P4 部署脚本：打包 cloudfunctions 到 build/functions/<fn>/（含 _shared；genRoute/reRoute 另带
// engine/ 与 data/spots/），安装依赖，然后逐个 tcb 部署为 HTTP 云函数（--httpFn --path）。
//
// 前置：本机已登录 CloudBase CLI（npx -p @cloudbase/cli tcb login）
// 用法：TENCENT_WS_KEY=线上Key node scripts/deploy-functions.js [函数名...]
// 安全：Key 只经环境变量传入，临时写入 build/cloudbaserc.json（build/ 已 gitignore，部署后可删）

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ENV_ID = process.env.TCB_ENV_ID || 'ddlt-d7gvi23us2cc67847';
const NEEDS_ENGINE = new Set(['genRoute', 'reRoute', 'aiCopy']);
const ALL = ['searchPoi', 'genRoute', 'reRoute', 'routeGet', 'posterImg', 'feedback', 'aiCopy'];
const targets = process.argv.slice(2).filter(a => !a.startsWith('--'));
const fns = targets.length ? targets : ALL;
const KEY = process.env.TENCENT_WS_KEY || '';
const GLM_KEY = process.env.GLM_KEY || '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || '';
const AI_BASE_URL = process.env.AI_BASE_URL || '';
const AI_MODEL = process.env.AI_MODEL || '';
const AI_PROVIDER = process.env.AI_PROVIDER || '';

const PKG = {
  name: 'ddlt-fn', private: true, version: '1.0.0', main: 'index.js',
  dependencies: { '@cloudbase/node-sdk': '^2.9.0' },
};

function cp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// 临时 cloudbaserc.json（含 Key 环境变量）放 build/，绝不进 git
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(BUILD, 'cloudbaserc.json'), JSON.stringify({
  envId: ENV_ID,
  functions: fns.map(name => ({
    name,
    envVariables: {
      ...(KEY ? { TENCENT_WS_KEY: KEY } : {}),
      ...(GLM_KEY ? { GLM_KEY } : {}),
      ...(DEEPSEEK_KEY ? { DEEPSEEK_KEY } : {}),
      ...(AI_BASE_URL ? { AI_BASE_URL } : {}),
      ...(AI_MODEL ? { AI_MODEL } : {}),
      ...(AI_PROVIDER ? { AI_PROVIDER } : {}),
    },
    timeout: 20,
    memorySize: 256,
  })),
}, null, 2));

if (!KEY) console.warn('⚠ 未提供 TENCENT_WS_KEY，函数环境变量将为空（可后续在控制台补）');

for (const fn of fns) {
  const src = path.join(ROOT, 'cloudfunctions', fn);
  if (!fs.existsSync(path.join(src, 'index.js'))) { console.error(`跳过：cloudfunctions/${fn}/index.js 不存在`); continue; }
  const stage = path.join(BUILD, 'functions', fn);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  cp(path.join(src, 'index.js'), path.join(stage, 'index.js'));
  for (const s of fs.readdirSync(path.join(ROOT, 'cloudfunctions', '_shared'))) {
    if (s === 'routeKit.js' && !NEEDS_ENGINE.has(fn)) continue;  // routeKit 依赖 engine，只随 genRoute/reRoute
    cp(path.join(ROOT, 'cloudfunctions', '_shared', s), path.join(stage, s));
  }
  if (NEEDS_ENGINE.has(fn)) {
    for (const s of fs.readdirSync(path.join(ROOT, 'engine'))) {
      if (s.endsWith('.js') && s !== 'test.js') cp(path.join(ROOT, 'engine', s), path.join(stage, 'engine', s));
    }
    for (const s of fs.readdirSync(path.join(ROOT, 'data', 'spots'))) {
      if (s.endsWith('.json') && !s.includes('report')) cp(path.join(ROOT, 'data', 'spots', s), path.join(stage, 'data', s));
    }
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(PKG, null, 2));

  console.log(`\n== ${fn} ==`);
  execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: stage, stdio: 'inherit' });
  execSync(`npx -p @cloudbase/cli tcb fn deploy ${fn} --dir "${stage}" --force --path=/${fn} --install-dependency false`,
    { cwd: BUILD, stdio: 'inherit', env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' } });
}

console.log('\n部署完成。HTTP 访问路径形如 https://<env>.ap-shanghai.tcb.qcloud.la/<fn>（以部署输出为准）。');
