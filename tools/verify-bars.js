/* ============================================================================
 * tools/verify-bars.js —— 在真实 Chrome 里验证「自定义左右黑边」功能
 * ----------------------------------------------------------------------------
 * 为什么需要这个工具：
 *   黑边的核心机制是「覆盖 window.innerWidth，让 c2runtime 自己重新 setSize()」，
 *   而 setSize() 会把 #c2canvasdiv 的 margin-left 写成**内联样式** —— 我们靠一条
 *   带 !important 的样式表规则盖住它。这条规则能不能扛住运行时每帧重写，
 *   **只有真浏览器跑起 c2runtime 才看得出来**（jsdom 跑不了 c2runtime，
 *   test/mdz_bars.test.js 只能验证到 API 与持久化那一层）。
 *
 * 依赖：只需要一个 Chrome/Edge（Node 22 自带 WebSocket 与 http，无需 npm 包）。
 * 用法：
 *   node tools/verify-bars.js
 *   node tools/verify-bars.js --chrome "C:\path\to\chrome.exe"
 *   node tools/verify-bars.js --headful        # 想看画面时用（默认无头）
 *   node tools/verify-bars.js --hold 60        # 验证完再多等 60 秒观察稳定性
 *
 * 退出码：0 = 全部通过；1 = 有失败；2 = 环境不具备（找不到浏览器等，不算失败）
 * ==========================================================================*/
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');

/* ------------------------------------------------------------------ 参数 */
const argv = process.argv.slice(2);
function argVal(name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; }
const HEADFUL = argv.includes('--headful');
const HOLD = parseInt(argVal('--hold') || '0', 10) || 0;
const CHROME_ARG = argVal('--chrome');

/* --------------------------------------------------------------- 小工具 */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

/* ------------------------------------------------- 内置静态服务（免 Python） */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.xml': 'application/xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf'
};
function startServer() {
  const srv = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/' ) rel = '/index.html';
    const abs = path.join(WEB, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!abs.startsWith(WEB) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}
async function waitForDevtools(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await getJSON('http://127.0.0.1:' + port + '/json/version'); return true; } catch (e) { await sleep(250); }
  }
  return false;
}

/* ------------------------------------------------------------ 测量表达式 */
const MEASURE = `(function(){
  var d = document.getElementById('c2canvasdiv');
  var c = document.getElementById('c2canvas');
  var rt = window.cr_getC2Runtime && window.cr_getC2Runtime();
  var cs = d ? getComputedStyle(d) : null;
  return {
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    docClientWidth: document.documentElement.clientWidth,
    divWidth: cs ? cs.width : null, divMarginLeft: cs ? cs.marginLeft : null,
    canvasBitmapW: c ? c.width : null,
    rtWidth: rt ? rt.width : null, rtHeight: rt ? rt.height : null,
    rtLastWindowWidth: rt ? rt.lastWindowWidth : null,
    rtMode: rt ? rt.fullscreen_mode : null,
    rtTick: rt ? rt.tickcount : null,
    rtLayout: rt && rt.running_layout ? rt.running_layout.name : null,
    uiViewport: (window.MDZUI && window.MDZUI.viewport) ? window.MDZUI.viewport() : null,
    bars: (window.MDZUI && window.MDZUI.getBars) ? window.MDZUI.getBars() : null,
    barsSupported: (window.MDZUI && window.MDZUI.barsSupported) ? window.MDZUI.barsSupported() : null,
    build: window.MDZ_BUILD || null
  };
})()`;

/* -------------------------------------------------------------------- 主流程 */
(async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('跳过：没找到 Chrome/Edge。用 --chrome <路径> 指定，或设 CHROME_PATH。');
    process.exit(2);
  }
  console.log('浏览器: ' + chrome);
  console.log('无头模式: ' + (!HEADFUL));

  const srv = await startServer();
  const httpPort = srv.address().port;
  const base = 'http://127.0.0.1:' + httpPort + '/index.html';
  console.log('本地服务: ' + base);

  const dbgPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mdz-bars-'));
  const args = [
    '--remote-debugging-port=' + dbgPort,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=2314,980',
    'about:blank'
  ];
  if (!HEADFUL) args.unshift('--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader');

  const proc = spawn(chrome, args, { stdio: 'ignore', detached: false });
  let ws = null;
  let exitCode = 1;
  try {
    if (!(await waitForDevtools(dbgPort, 30000))) throw new Error('调试端口没起来');
    const targets = await getJSON('http://127.0.0.1:' + dbgPort + '/json/list');
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('没有 page target');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0; const pending = new Map(); const errors = []; const consoleErrors = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const f = pending.get(m.id); pending.delete(m.id); f(m); return; }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
    });
    const send = (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, m => (m.error ? rej(new Error(method + ' -> ' + JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面内异常: ' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
      return r.result.value;
    };
    const poll = async (expr, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch (e) {} await sleep(300); }
      return false;
    };

    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

    console.log('\n加载游戏并等待 c2runtime 启动...');
    await send('Page.navigate', { url: base });
    const booted = await poll('!!(window.cr_getC2Runtime && window.cr_getC2Runtime() && window.cr_getC2Runtime().width > 0)', 120000);
    ok('c2runtime 启动了（jsdom 做不到这一步）', booted);
    if (!booted) throw new Error('运行时没起来，后面的检查没有意义');
    ok('联机面板与黑边功能就绪', await poll('!!(window.MDZUI && window.MDZUI.barsSupported)', 20000));
    await sleep(1200);

    section('A. 基线（未设黑边）');
    await ev('window.MDZUI.setBars(0, 0, true)');
    await sleep(800);
    const base0 = await ev(MEASURE);
    eq('全屏模式是 crop(1)（与 data.js 里读出的值一致）', base0.rtMode, 1);
    eq('画布 div 宽度 == innerWidth', base0.divWidth, base0.innerWidth + 'px');
    eq('margin-left 为 0px', base0.divMarginLeft, '0px');
    eq('真实视口 == innerWidth', base0.docClientWidth, base0.innerWidth);
    ok('黑边功能受支持', base0.barsSupported === true);

    section('B. 设成 左60 / 右40');
    await ev('window.MDZUI.setBars(60, 40, true)');
    await sleep(900);
    const b = await ev(MEASURE);
    eq('window.innerWidth 被改写', b.innerWidth, base0.innerWidth - 100);
    eq('运行时自己也认了（rtWidth）', b.rtWidth, base0.innerWidth - 100);
    eq('运行时记录的 lastWindowWidth 同步', b.rtLastWindowWidth, base0.innerWidth - 100);
    eq('画布 div 宽度跟着变', b.divWidth, (base0.innerWidth - 100) + 'px');
    eq('画布被推到左黑边之后（margin-left=60px）', b.divMarginLeft, '60px');
    eq('画布位图宽度 = 收窄后宽度', b.canvasBitmapW, base0.innerWidth - 100);
    eq('高度一点没动', b.innerHeight, base0.innerHeight);
    eq('运行时高度也没动', b.rtHeight, base0.innerHeight);
    eq('真实视口不受影响', b.docClientWidth, base0.docClientWidth);
    eq('MDZUI.viewport() 仍报真实宽度', b.uiViewport.w, base0.innerWidth);
    eq('getBars() 返回生效值', JSON.stringify(b.bars), JSON.stringify({ left: 60, right: 40 }));

    section('C. 极端值保护');
    await ev('window.MDZUI.setBars(9999, 9999, true)');
    await sleep(900);
    const c = await ev(MEASURE);
    ok('单边夹到 <=400', c.bars.left <= 400 && c.bars.right <= 400, JSON.stringify(c.bars));
    ok('至少留 240px 游戏画面', c.innerWidth >= 240, 'innerWidth=' + c.innerWidth);
    ok('运行时没崩', c.rtWidth === c.innerWidth);

    section('D. 重置');
    await ev('window.MDZUI.resetBars()');
    await sleep(900);
    const d = await ev(MEASURE);
    eq('innerWidth 复原', d.innerWidth, base0.innerWidth);
    eq('margin-left 回到 0px', d.divMarginLeft, '0px');
    eq('运行时宽度复原', d.rtWidth, base0.innerWidth);

    section('E. 稳定性：连续多帧不被运行时抢回去（这条最关键）');
    await ev('window.MDZUI.setBars(140, 60, true)');
    await sleep(800);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      await sleep(3000);
      samples.push(await ev(MEASURE));
    }
    const last = samples[samples.length - 1];
    ok('15 秒内 margin-left 始终是 140px（!important 规则扛住了 setSize 的内联样式）',
      samples.every(s => s.divMarginLeft === '140px'), samples.map(s => s.divMarginLeft).join(','));
    ok('宽度始终稳定', samples.every(s => s.innerWidth === base0.innerWidth - 200), last.innerWidth);
    ok('运行时 tick 在推进（没卡死）', last.rtTick > samples[0].rtTick, samples[0].rtTick + ' -> ' + last.rtTick);

    section('F. 运行期有没有引入报错');
    ok('无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | '));
    ok('无 console.error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

    if (HOLD > 0) {
      section('G. 额外观察 ' + HOLD + ' 秒');
      await sleep(HOLD * 1000);
      const g = await ev(MEASURE);
      console.log('   ' + JSON.stringify(g));
      ok('观察结束后宽度与布局仍正常', g.innerWidth === base0.innerWidth - 200, 'layout=' + g.rtLayout);
    }

    console.log('\n--------------------------------------------------');
    console.log('构建标记: ' + base0.build);
    console.log(`真实浏览器验证: ${pass} 通过 / ${fail} 失败`);
    exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n验证失败: ' + (e && e.stack || e));
    exitCode = 1;
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
    try { srv.close(); } catch (e) {}
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(exitCode);
})();
