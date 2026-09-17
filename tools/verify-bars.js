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

    section('G. 画面清晰度（渲染倍率封顶，治发热 / 掉帧）');
    const baseStat = await ev(`(function(){var rt=window.cr_getC2Runtime();var c=document.getElementById('c2canvas');
      return {dpr:rt.devicePixelRatio, mp:Math.round(c.width*c.height/10000), isRetina:rt.isRetina};})()`);
    ok('面板有清晰度三档', await ev(`document.querySelectorAll('#mdz-panel-wrap [data-lv]').length`) === 3);
    eq('默认档位是中', await ev(`window.MDZUI.getRenderLevel()`), 'mid');

    // 伪装成 dpr=3 的手机（手机上的默认情况）
    await ev(`(function(){
      try{Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:function(){return 3;}});}catch(e){}
      var rt=window.cr_getC2Runtime();rt.isRetina=true;rt.devicePixelRatio=3;
      rt.setSize(window.innerWidth,window.innerHeight,true);return true})()`);
    await sleep(1200);
    const un = await ev(`(function(){var rt=window.cr_getC2Runtime();var c=document.getElementById('c2canvas');
      return {dpr:rt.devicePixelRatio, mp:Math.round(c.width*c.height/10000)};})()`);
    ok('模拟 dpr=3 后画布被放大', un.mp > baseStat.mp * 5, baseStat.mp + '万 -> ' + un.mp + '万');

    for (const [lv, expect] of [['high', 2], ['mid', 1.5], ['low', 1]]) {
      await ev(`window.MDZUI.setRenderLevel('${lv}', true)`);
      await sleep(1200);
      const st = await ev(`(function(){var rt=window.cr_getC2Runtime();var c=document.getElementById('c2canvas');
        return {dpr:rt.devicePixelRatio, mp:Math.round(c.width*c.height/10000), isRetina:rt.isRetina};})()`);
      eq(`${lv} 档把渲染倍率压到 ${expect}x`, st.dpr, expect);
      ok(`${lv} 档画布像素数明显下降`, st.mp < un.mp, un.mp + '万 -> ' + st.mp + '万');
      eq(`${lv} 档 isRetina 仍为 true（否则画布会溢出屏幕）`, st.isRetina, true);
    }
    await ev(`window.MDZUI.setRenderLevel('mid', true)`);
    await sleep(800);

    section('G2. 帧率上限（高刷屏省电 / 降温）');
    const shim = await ev(`(function(){
      var src = String(window.requestAnimationFrame);
      return { 垫片变量存在: typeof window.__mdzRafMinMs !== 'undefined',
               原生rAF已保存: typeof window.__mdzOrigRaf === 'function',
               当前rAF是否原生: src.indexOf('native code') >= 0,   // 用 indexOf：正则里的反斜杠在模板字符串里会被吃掉
               当前rAF开头: src.slice(0, 46).replace(/\s+/g, ' '),
               面板控件数: document.querySelectorAll('#mdz-panel-wrap [data-fps]').length }; })()`);
    console.log('   ' + JSON.stringify(shim));
    ok('rAF 垫片已装（必须在 c2runtime 之前）',
      shim.垫片变量存在 && !shim.当前rAF是否原生, shim.当前rAF开头);
    eq('面板有帧率上限三档', shim.面板控件数, 3);

    const fpsOf = async (sec) => {
      await ev(`(function(){var rt=window.cr_getC2Runtime();rt.__ft0=rt.tickcount;rt.__fw0=performance.now();return true})()`);
      await sleep(sec * 1000);
      return await ev(`(function(){var rt=window.cr_getC2Runtime();
        var d=(performance.now()-rt.__fw0)/1000;
        return Math.round((rt.tickcount-rt.__ft0)/d*10)/10;})()`);
    };

    // 注意：本工具跑在桌面视口下，渲染本身就是瓶颈（约 40fps），
    // 所以这里只做**相对**比较，不设绝对阈值 —— 绝对帧率要按手机视口用 measure-perf 测。
    await ev(`window.MDZUI.setFpsLevel('auto', true)`);
    await sleep(1200);
    const fAuto = await fpsOf(5);
    console.log('   不限帧 ' + fAuto + ' fps（本环境渲染上限）');

    await ev(`window.MDZUI.setFpsLevel('30', true)`);
    await sleep(1500);
    const f30 = await fpsOf(5);
    console.log('   锁 30 帧 ' + f30 + ' fps');
    ok('锁 30 帧后帧率被压到 ~30', f30 >= 25 && f30 <= 35, fAuto + ' -> ' + f30 + ' fps');
    ok('确实比基线低', f30 < fAuto * 0.8, '基线 ' + fAuto + ' -> ' + f30);
    ok('跳帧计数器在增长', (await ev('window.__mdzRafSkips')) > 0);

    await ev(`window.MDZUI.setFpsLevel('auto', true)`);
    await sleep(1500);
    const fBack = await fpsOf(5);
    console.log('   切回不限 ' + fBack + ' fps');
    ok('切回不限后恢复到基线（±25%）', fBack >= fAuto * 0.75, f30 + ' -> ' + fBack + ' fps');

    section('H. 主菜单上两个遗留入口（MDZ☆START / MINI DayZ 2）');
    await send('Page.navigate', { url: base });
    await poll(`(function(){var rt=window.cr_getC2Runtime&&window.cr_getC2Runtime();return !!rt&&rt.running_layout&&rt.running_layout.name==='Menu'&&!!window.MDZUI;})()`, 120000);
    await sleep(4000);

    const entries = await ev(`(function(){
      var rt=window.cr_getC2Runtime();var out=[];
      for(var i=0;i<rt.types_by_index.length;i++){var t=rt.types_by_index[i];
        if(!t||!t.instances)continue;
        for(var j=0;j<t.instances.length;j++){var s=t.instances[j];
          if(typeof s.text!=='string'||!s.text)continue;
          if(/MINI\s*DayZ\s*2/i.test(s.text)||/MDZ\s*[☆★◇◆*+]{0,2}\s*START/i.test(s.text))
            out.push({text:String(s.text).slice(0,14),visible:s.visible});}}
      return out;})()`);
    ok('找到了这两个入口的实例', entries.length >= 2, entries.length + ' 个');
    ok('它们全部不可见', entries.length > 0 && entries.every(e => e.visible === false));
    const keep = await ev(`(function(){
      var rt=window.cr_getC2Runtime();var out=[];
      for(var i=0;i<rt.types_by_index.length;i++){var t=rt.types_by_index[i];
        if(!t||!t.instances)continue;
        for(var j=0;j<t.instances.length;j++){var s=t.instances[j];
          if(typeof s.text!=='string')continue;
          if(/^(新游戏|成就|解锁|选项)$/.test(s.text)) out.push(s.visible);}}
      return out;})()`);
    // 注意：这四个菜单项各有 t415 / t1056 两套实例（同一份文本），所以数量是 4 的倍数
    ok('正常菜单项仍然可见', keep.length >= 4 && keep.length % 4 === 0 && keep.every(v => v === true),
      keep.length + ' 个（应为 4 的倍数）');

    ok('C2 导航动作已包（原型层）', await ev(`window.__mdzNavPatched === true`));
    const beforeHref = await ev('location.href');
    await ev(`(function(){
      var B=window.cr.plugins_.Browser;var a=B.prototype.acts;
      var fake={runtime:window.cr_getC2Runtime(),is_arcade:false,isDomFree:false};
      try{a.GoToURL.call(fake,'https://t.me/likefreefun',0);}catch(e){}
      try{a.GoToURLWindow.call(fake,'https://store.bistudio.com/products/minidayz','Store');}catch(e){}
      return true;})()`);
    await sleep(1500);
    eq('直接调用 GoToURL / GoToURLWindow 都被拦住（页面没被带走）',
      await ev('location.href').catch(() => '(卸载)'), beforeHref);

    section('I. 联机功能没被动过');
    const intact = await ev(`(function(){return{
      peer: typeof window.Peer === 'function',
      host: typeof window.startHost === 'function',
      join: typeof window.joinGame === 'function',
      p2p: typeof window.MDZP2P === 'object',
      core: typeof window.MdzCore === 'object',
      scanBtn: !!Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent.indexOf('客机：加入房间')>=0;})
    };})()`);
    ok('window.Peer 垫片仍在', intact.peer);
    ok('startHost / joinGame 仍在', intact.host && intact.join);
    ok('mdz_core / mdz_p2p 仍在', intact.p2p && intact.core);
    ok('扫码按钮仍在', intact.scanBtn);

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
