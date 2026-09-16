/* ============================================================================
 * mdz_bars.test.js —— 「自定义左右黑边」功能回归测试（挖孔屏 / 灵动岛适配）
 * ----------------------------------------------------------------------------
 * 功能约定：
 *   - 只收左右、**高度不变**（避让挖孔/灵动岛，不是等比缩放）
 *   - 可自定义、可持久化、可重置，单边上限 400px
 *   - 无论怎么设，至少给游戏留 240px 宽，不能把画面压没
 * 实现约定（本测试要钉住的机制）：
 *   - 接管 window.innerWidth 的 getter，返回「真实宽度 - 左黑边 - 右黑边」；
 *     c2runtime 每帧比对 window.innerWidth 与 lastWindowWidth，自己就会重排，
 *     所以我们不需要（也不应该）去直接调运行时的 setSize。
 *   - #c2canvasdiv 的 margin-left 由带 !important 的样式表规则驱动 CSS 变量
 *     （setSize 会把 margin-left 写成内联样式，普通规则盖不过它）。
 *   - 页面自己的其它视口计算（面板定位、二维码浮层、桌面判定）必须走"真实宽度"，
 *     不能被黑边影响。
 *
 * 运行：node test/mdz_bars.test.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const WEB = path.join(__dirname, '..', 'web');
const BARS_KEY = 'mdz.ui.bars.v1';
const BAR_MAX = 400;
const REAL_W = 1024, REAL_H = 768;   // jsdom 默认视口

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a).slice(0, 90) + ' want=' + JSON.stringify(b).slice(0, 90)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000, step = 10) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

const PAGE = '<!doctype html><html><head></head><body>' +
  '<div id="c2canvasdiv"><canvas id="c2canvas" width="1024" height="768"></canvas></div>' +
  '</body></html>';

const cache = {};
function readScript(rel) {
  if (!cache[rel]) cache[rel] = fs.readFileSync(path.join(WEB, rel), 'utf8');
  return cache[rel];
}

/** 起一个"页面"：按 index.html 的真实顺序装 pako -> mdz_core -> mdz_p2p -> mdz_ui，
 *  并等到面板真的建出来（jsdom 的 DOMContentLoaded 是异步的，不能立刻断言）。 */
async function makePage(seedBars) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(PAGE, {
    runScripts: 'outside-only', pretendToBeVisual: true,
    url: 'http://localhost:8765/index.html', virtualConsole: vc
  });
  const w = dom.window;
  w.console.log = function () {};
  w.console.warn = function () {};
  w.console.error = function () {};
  if (seedBars !== undefined) w.localStorage.setItem(BARS_KEY, JSON.stringify(seedBars));

  // runScripts:'outside-only' 下文档里的 <script> 不会自动执行，必须用 window.eval
  const run = (code) => w.eval(code);
  run(readScript('vendor/pako.min.js'));
  run(readScript('mdz_core.js'));
  run(readScript('mdz_p2p.js'));
  run('MDZP2P.install(window);');
  run(readScript('mdz_ui.js'));

  const ready = await until(() => !!w.document.getElementById('mdz-panel-wrap'));
  if (!ready) throw new Error('mdz_ui.js 初始化超时：面板没有建出来');
  return w;
}

(async function main() {
  /* ----------------------------------------------- 1. 支持探测与规则注入 */
  section('1. 支持探测与画布定位规则');

  const w1 = await makePage();
  const UI = w1.MDZUI;
  ok('MDZUI 已导出', !!UI);
  eq('支持接管 window.innerWidth', UI.barsSupported(), true);
  const styleEl = w1.document.getElementById('mdz-bars-style');
  ok('已注入样式元素 #mdz-bars-style', !!styleEl);
  ok('样式里含 #c2canvasdiv 的 margin-left 规则',
    !!styleEl && /#c2canvasdiv/.test(styleEl.textContent) && /margin-left/.test(styleEl.textContent));
  ok('规则带 !important（否则盖不过 setSize 写的内联样式）',
    !!styleEl && /!important/.test(styleEl.textContent));
  eq('默认黑边为 0', w1.innerWidth, REAL_W);
  eq('CSS 变量默认 0px', w1.document.documentElement.style.getPropertyValue('--mdz-bar-left'), '0px');

  /* --------------------------------------------------------- 2. 面板控件 */
  section('2. 面板里的设置项');

  const u = UI._ui;
  ok('左黑边数字框存在', !!u.barLeft);
  ok('右黑边数字框存在', !!u.barRight);
  ok('左黑边滑杆存在', !!u.barLeftRange);
  ok('右黑边滑杆存在', !!u.barRightRange);
  ok('重置按钮存在', !!u.btnResetBars);
  ok('控件挂在面板里', !!u.barBox && !!u.panel && u.panel.contains(u.barBox));
  eq('数字框类型是 number', u.barLeft.type, 'number');
  eq('数字框下限 0', u.barLeft.min, '0');
  eq('数字框上限 ' + BAR_MAX, u.barLeft.max, String(BAR_MAX));
  eq('滑杆类型是 range', u.barLeftRange.type, 'range');
  eq('滑杆上限 ' + BAR_MAX, u.barRightRange.max, String(BAR_MAX));

  /* ----------------------------------------------------- 3. 设置真的生效 */
  section('3. 设置黑边后视口与画布定位都跟着变');

  UI.setBars(60, 40, true);
  eq('window.innerWidth = 真实宽度 - 100', w1.innerWidth, REAL_W - 100);
  eq('左黑边 CSS 变量 = 60px', w1.document.documentElement.style.getPropertyValue('--mdz-bar-left'), '60px');
  eq('数字框同步为 60', u.barLeft.value, '60');
  eq('数字框同步为 40', u.barRight.value, '40');
  eq('滑杆同步为 60', u.barLeftRange.value, '60');
  eq('已写入 localStorage', w1.localStorage.getItem(BARS_KEY), JSON.stringify({ left: 60, right: 40 }));
  eq('高度不受影响（innerHeight 不变）', w1.innerHeight, REAL_H);
  eq('getBars 返回生效值', JSON.stringify(UI.getBars()), JSON.stringify({ left: 60, right: 40 }));

  UI.setBars(20, 40, true);
  eq('只改一边时另一边不变', JSON.stringify(UI.getBars()), JSON.stringify({ left: 20, right: 40 }));
  eq('innerWidth 同步更新', w1.innerWidth, REAL_W - 60);

  /* --------------------------------------------------- 4. 上限与安全裁剪 */
  section('4. 单边上限与"不能把画面压没"的保护');

  UI.setBars(9999, 9999, true);
  const capped = UI.getBars();
  ok('单边不超过 ' + BAR_MAX, capped.left <= BAR_MAX && capped.right <= BAR_MAX,
    'left=' + capped.left + ' right=' + capped.right);
  UI.setBars(400, 400, true);
  const tight = UI.getBars();
  ok('左右之和留足至少 240px 游戏画面', REAL_W - tight.left - tight.right >= 240,
    '剩余=' + (REAL_W - tight.left - tight.right));
  ok('window.innerWidth 不会变成 0 或负数', w1.innerWidth > 0, 'innerWidth=' + w1.innerWidth);

  UI.setBars(-5, 'abc', true);
  eq('负数与非法值当 0 处理', JSON.stringify(UI.getBars()), JSON.stringify({ left: 0, right: 0 }));
  eq('非法值下 innerWidth 回到真实宽度', w1.innerWidth, REAL_W);

  /* ------------------------------------------------------------- 5. 重置 */
  section('5. 重置回 0');

  UI.setBars(80, 80, true);
  eq('重置前已收窄', w1.innerWidth, REAL_W - 160);
  UI.resetBars();
  eq('重置后 innerWidth 复原', w1.innerWidth, REAL_W);
  eq('重置后 CSS 变量为 0px', w1.document.documentElement.style.getPropertyValue('--mdz-bar-left'), '0px');
  eq('重置后 localStorage 记录为 0', w1.localStorage.getItem(BARS_KEY), JSON.stringify({ left: 0, right: 0 }));

  /* ----------------------------------------------------------- 6. 持久化 */
  section('6. 设置会记住（下次打开还在）');

  const w2 = await makePage({ left: 44, right: 22 });
  eq('启动即按已保存值收窄', w2.innerWidth, REAL_W - 66);
  eq('控件回显已保存的左值', w2.MDZUI._ui.barLeft.value, '44');
  eq('控件回显已保存的右值', w2.MDZUI._ui.barRight.value, '22');
  eq('CSS 变量按已保存值设置', w2.document.documentElement.style.getPropertyValue('--mdz-bar-left'), '44px');

  const w3 = await makePage('这不是 JSON');
  eq('配置损坏时不崩、按 0 处理', w3.innerWidth, REAL_W);
  eq('配置损坏时控件仍可用', w3.MDZUI._ui.barLeft.value, '0');
  eq('配置损坏时功能仍然可用', w3.MDZUI.barsSupported(), true);

  /* --------------------------------------- 7. 面板自身不能用被改写的宽度 */
  section('7. 页面其它视口计算必须走"真实宽度"');

  const w4 = await makePage();
  w4.MDZUI.setBars(300, 300, true);
  eq('黑边生效后 window.innerWidth 已被改写', w4.innerWidth, REAL_W - 600);
  eq('真实视口宽度不受黑边影响', w4.MDZUI.viewport().w, REAL_W);
  eq('真实视口高度不受黑边影响', w4.MDZUI.viewport().h, REAL_H);
  eq('高度始终不变', w4.innerHeight, REAL_H);

  // 反向对照：如果页面误用 window.innerWidth 算布局，面板可拖拽范围会从 1024 缩到 424。
  // 这里直接把面板摆到 x=900（> 424），再走一次真实的面板定位逻辑，看会不会被夹回去。
  const panelEl = w4.MDZUI._ui.panel;
  panelEl.style.left = '900px'; panelEl.style.right = 'auto';
  w4.MDZUI._ui.toggleBtn.click();          // 收起
  w4.MDZUI._ui.toggleBtn.click();          // 再展开，触发一次 mirrorPos/applyPos
  const leftPx = parseInt(panelEl.style.left, 10);
  ok('面板能被摆到超出"收窄后宽度"的位置（说明用的是真实视口）',
    !isFinite(leftPx) || leftPx > w4.innerWidth - 200,
    'panel.left=' + panelEl.style.left + ' innerWidth=' + w4.innerWidth);

  console.log('\n--------------------------------------------------');
  console.log(`结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
