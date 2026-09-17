/* ============================================================================
 * tools/measure-perf.js —— 帧率 / 发热相关指标的测量工具（真浏览器，零依赖）
 * ----------------------------------------------------------------------------
 * 为什么需要它：
 *   手机上的掉帧与发热，用 jsdom 或桌面全屏视口都测不准 ——
 *   画布像素数 = CSS 视口 × 渲染倍率²，桌面视口（2300+ px 宽）会得出
 *   比手机高一个数量级的假象。所以必须**按手机视口**测量。
 *
 * 用法：
 *   node tools/measure-perf.js                      # 默认测三种机型
 *   node tools/measure-perf.js --device iphone15    # 只测某一款
 *   node tools/measure-perf.js --css 800x360 --dpr 3
 *   node tools/measure-perf.js --seconds 10         # 每档测更久（默认 6 秒）
 *   node tools/measure-perf.js --chrome "C:\path\to\chrome.exe"
 *
 * 依赖：只需要一个 Chrome/Edge（用 Node 自带的 http + WebSocket 连 CDP）。
 * 退出码：0 = 正常；2 = 环境不具备（找不到浏览器）
 * ==========================================================================*/
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const DEVICES = {
  'iphone15': { label: 'iPhone 15 Pro 横屏', cssW: 852, cssH: 393, dpr: 3 },
  'android-mid': { label: '中端安卓 横屏', cssW: 800, cssH: 360, dpr: 3 },
  'android-1080': { label: '1080p 安卓 横屏', cssW: 960, cssH: 432, dpr: 2.5 },
  'desktop': { label: '桌面（对照，非手机）', cssW: 1600, cssH: 900, dpr: 1 }
};

/* ------------------------------------------------------------------ 参数 */
const argv = process.argv.slice(2);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const CHROME_ARG = argVal('--chrome');
const SECONDS = parseInt(argVal('--seconds') || '6', 10) || 6;
const CSS_ARG = argVal('--css');
const DPR_ARG = parseFloat(argVal('--dpr') || '0');
const DEV_ARG = argVal('--device');

function pickDevices() {
  if (CSS_ARG && DPR_ARG) {
    const m = /^(\d+)x(\d+)$/.exec(CSS_ARG);
    if (!m) { console.error('--css 格式应为 宽x高，例如 800x360'); process.exit(2); }
    return [{ label: '自定义 ' + CSS_ARG + ' @' + DPR_ARG + 'x', cssW: +m[1], cssH: +m[2], dpr: DPR_ARG }];
  }
  if (DEV_ARG) {
    if (!DEVICES[DEV_ARG]) { console.error('未知机型：' + DEV_ARG + '，可选：' + Object.keys(DEVICES).join(', ')); process.exit(2); }
    return [DEVICES[DEV_ARG]];
  }
  return [DEVICES['iphone15'], DEVICES['android-mid'], DEVICES['android-1080']];
}

/* --------------------------------------------------------------- 小工具 */
function findChrome() {
  if (CHROME_ARG) return fs.existsSync(CHROME_ARG) ? CHROME_ARG : null;
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.xml': 'application/xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};
function startServer() {
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const abs = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!abs.startsWith(WEB) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const getJSON = u => new Promise((res, rej) => { http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitDevtools(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { await getJSON('http://127.0.0.1:' + port + '/json/version'); return true; } catch (e) { await sleep(250); } }
  return false;
}

const MEASURE = (label, sec) => `(function(){
  var rt = window.cr_getC2Runtime();
  if (!rt.__mpPatch) {
    rt.__mpPatch = true; rt.__mpSamples = [];
    var orig = rt.tick;
    rt.tick = function () {
      var a = performance.now();
      var r = orig.apply(this, arguments);
      rt.__mpSamples.push(performance.now() - a);
      if (rt.__mpSamples.length > 6000) rt.__mpSamples.shift();
      return r;
    };
  }
  rt.__mpSamples = []; rt.__mpTick0 = rt.tickcount; rt.__mpT0 = performance.now();
  return true; })()`;

const READ = (label, sec) => `(function(){
  var rt = window.cr_getC2Runtime(); var c = document.getElementById('c2canvas');
  var wall = (performance.now() - rt.__mpT0) / 1000;
  var frames = rt.tickcount - rt.__mpTick0;
  var s = rt.__mpSamples.slice().sort(function(a,b){return a-b;});
  var q = function(p){ return s.length ? Math.round(s[Math.min(s.length-1, Math.floor(s.length*p))]*100)/100 : 0; };
  return {
    label: '${label}',
    fps: Math.round(frames / wall * 10) / 10,
    p50: q(0.5), p95: q(0.95), max: q(0.999),
    longFrames: rt.__mpSamples.filter(function(v){return v>50;}).length,
    canvas: c.width + 'x' + c.height,
    mp: Math.round(c.width * c.height / 10000),
    scale: rt.devicePixelRatio,
    deviceDpr: window.devicePixelRatio || 1,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    renderer: rt.glwrap ? 'WebGL' : 'Canvas2D'
  }; })()`;

(async function main() {
  const chrome = findChrome();
  if (!chrome) { console.log('跳过：没找到 Chrome/Edge。用 --chrome <路径> 指定。'); process.exit(2); }
  const devices = pickDevices();

  const srv = await startServer();
  const base = 'http://127.0.0.1:' + srv.address().port + '/index.html';
  const dbg = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-perf-'));
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
    '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + dbg, '--user-data-dir=' + profile,
    '--window-size=1200,700', 'about:blank'
  ], { stdio: 'ignore' });

  const results = [];
  let ws = null;
  try {
    if (!(await waitDevtools(dbg, 30000))) throw new Error('调试端口没起来');
    const targets = await getJSON('http://127.0.0.1:' + dbg + '/json/list');
    const page = targets.find(t => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m); } });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('CDP 连接失败'))); });
    const send = (method, params) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, m => (m.error ? rej(new Error(method + ' -> ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面内异常: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
      return r.result.value;
    };
    const poll = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (e) {} await sleep(300); } return false; };

    await send('Page.enable'); await send('Runtime.enable');
    console.log('浏览器: ' + chrome);
    console.log('注：无头环境用的是 SwiftShader **软件渲染**，绝对帧率低于真机 GPU；');
    console.log('    这里真正可信的是「画布像素数」与各档位的相对关系。\n');

    for (const dev of devices) {
      const physW = Math.round(dev.cssW * dev.dpr), physH = Math.round(dev.cssH * dev.dpr);
      console.log('================ ' + dev.label + '  ' + dev.cssW + 'x' + dev.cssH + ' CSS @' + dev.dpr + 'x  ->  物理 ' + physW + 'x' + physH + ' ================');
      await send('Emulation.setDeviceMetricsOverride', { width: dev.cssW, height: dev.cssH, deviceScaleFactor: dev.dpr, mobile: true });
      await send('Page.navigate', { url: base });
      const booted = await poll(`(function(){var rt=window.cr_getC2Runtime&&window.cr_getC2Runtime();return !!rt&&rt.running_layout&&rt.running_layout.name==='Menu'&&!!window.MDZUI;})()`, 180000);
      if (!booted) { console.log('  运行时没起来，跳过\n'); continue; }
      await sleep(4000);

      // 1) 真 3x：显式绕过我们的封顶
      await ev(`(function(){var rt=window.cr_getC2Runtime();rt.isRetina=true;rt.devicePixelRatio=window.devicePixelRatio||1;
        rt.setSize(window.innerWidth,window.innerHeight,true);return true;})()`);
      await sleep(1500);
      await ev(MEASURE('设备原生倍率（未封顶）', SECONDS));
      await sleep(SECONDS * 1000);
      const raw = await ev(READ('设备原生倍率（未封顶）', SECONDS));
      results.push({ dev: dev.label, ...raw });
      console.log('  未封顶 ' + raw.scale + 'x  ' + fmt(raw));

      // 2) 三档
      for (const [lv, cap] of [['high', 2], ['mid', 1.5], ['low', 1]]) {
        await ev(`window.MDZUI.setRenderLevel('${lv}', true)`);
        await sleep(1500);
        await ev(MEASURE(lv, SECONDS));
        await sleep(SECONDS * 1000);
        const r = await ev(READ(lv, SECONDS));
        results.push({ dev: dev.label, ...r });
        console.log('  ' + lv.padEnd(6) + ' ' + r.scale + 'x  ' + fmt(r));
      }
      console.log('');
    }

    console.log('================ 汇总（画布像素数是发热的第一驱动）================');
    console.log('机型'.padEnd(20) + '档位'.padEnd(12) + '渲染倍率'.padEnd(10) + '画布'.padEnd(14) + '像素(万)'.padEnd(10) + 'FPS');
    for (const r of results) {
      console.log(String(r.dev).padEnd(20) + String(r.label).padEnd(12) +
        (r.scale + 'x').padEnd(10) + String(r.canvas).padEnd(14) + String(r.mp).padEnd(10) + r.fps);
    }
    console.log('\n提示：手机上的真实温度与降频需要用系统侧工具测（见 README-DEV「衡量优化效果」）。');
    console.log('      App 内也可以点联机面板的「性能快照」按钮，直接读到同一组指标。');
  } catch (e) {
    console.error('失败: ' + (e && e.stack || e));
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
    try { srv.close(); } catch (e) {}
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(0);

  function fmt(r) {
    return '画布 ' + r.canvas + '（' + r.mp + '万像素）  FPS ' + r.fps +
      '  帧耗时 p50 ' + r.p50 + 'ms / p95 ' + r.p95 + 'ms' + (r.longFrames ? '  长帧 ' + r.longFrames : '');
  }
})();
