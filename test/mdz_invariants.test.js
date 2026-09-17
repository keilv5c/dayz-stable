/* ============================================================================
 * mdz_invariants.test.js —— 工程不变量（P2 清理项的回归守卫）
 * ----------------------------------------------------------------------------
 * 这些约束过去只写在 README 里，靠人记；踩过一次就白踩。现在钉成测试：
 *
 *  1. 构建脚本编码：tools/*.ps1 必须 UTF-8 **with BOM**（PowerShell 5.1 读无 BOM
 *     的 UTF-8 会按 ANSI 解码，中文变乱码直接语法错误）；
 *     而 sp/scripts/*.ps1 必须**纯 ASCII**（脚本刻意不放中文，避免同一类问题）。
 *     同一个仓库里这两条要求是相反的，最容易互相踩。
 *  2. .gitattributes 必须保护"按字节敏感"的文件，否则 core.autocrlf=true 的机器
 *     会把行尾改掉，"与原版逐字节一致"的承诺当场失效。
 *  3. WebView 调试开关必须是关的（面向朋友间互玩，不对外留调试入口）。
 *  4. 构建标记必须一致：index.html 的 MDZ_BUILD 与 mdz_ui.js 的 BUILD 是同一次改动，
 *     不一致时测试者按 README 排查会得出错误结论。
 *  5. index.html 里所有 <script src> 必须真实存在（不能有 404），
 *     且已删除的 6 个补丁模块不能再被任何地方引用。
 *
 * 运行：node test/mdz_invariants.test.js
 * ==========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '   (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '   (' + extra + ')' : '')); }
}
function eq(name, a, b) { ok(name, a === b, a === b ? '' : 'got=' + JSON.stringify(a).slice(0, 90) + ' want=' + JSON.stringify(b).slice(0, 90)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

const read = (p) => fs.readFileSync(path.join(ROOT, p));
const readText = (p) => read(p).toString('utf8');
const listDir = (rel, ext) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter(f => f.endsWith(ext)).map(f => rel + '/' + f);
};

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

/* --------------------------------------------- 1. PowerShell 脚本编码约束 */
section('1. PowerShell 脚本编码（两套相反的要求）');

const toolsPs1 = listDir('tools', '.ps1');
ok('tools/ 下有 .ps1 脚本', toolsPs1.length > 0, toolsPs1.length + ' 个');
for (const rel of toolsPs1) {
  const buf = read(rel);
  const hasBom = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
  ok(rel + ' 是 UTF-8 with BOM', hasBom);
}

const spPs1 = listDir('sp/scripts', '.ps1');
ok('sp/scripts/ 下有 .ps1 脚本', spPs1.length > 0, spPs1.length + ' 个');
for (const rel of spPs1) {
  const buf = read(rel);
  const bad = [];
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) { bad.push(i); break; }
  ok(rel + ' 是纯 ASCII（脚本里不放中文）', bad.length === 0,
    bad.length ? '首个非 ASCII 字节在偏移 ' + bad[0] : '');
}

/* ---------------------------------------------- 2. .gitattributes 覆盖 */
section('2. .gitattributes 必须保护按字节敏感的文件');

const ga = readText('.gitattributes');
const mustProtect = ['web/**', 'sp/web/**', 'sp/ios/**', 'ios/**', '*.ps1'];
for (const pat of mustProtect) {
  const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*\\\*/g, '\\*\\*') + '\\s+-text\\s*$', 'm');
  ok('.gitattributes 把 ' + pat + ' 标为 -text', re.test(ga));
}

/* ------------------------------------------------- 3. 调试开关必须是关的 */
section('3. WebView 调试开关已关闭');

const cap = readText('capacitor.config.ts');
ok('capacitor.config.ts 里 webContentsDebuggingEnabled 为 false',
  /webContentsDebuggingEnabled\s*:\s*false/.test(cap));
ok('没有残留的 webContentsDebuggingEnabled: true',
  !/webContentsDebuggingEnabled\s*:\s*true/.test(cap));

/* ----------------------------------------------------- 4. 构建标记一致 */
section('4. 构建标记必须自洽');

const html = readText('web/index.html');
const ui = readText('web/mdz_ui.js');
const mHtml = /MDZ_BUILD\s*=\s*'([^']+)'/.exec(html);
const mUi = /var\s+BUILD\s*=\s*'([^']+)'/.exec(ui);
ok('index.html 里有 MDZ_BUILD', !!mHtml, mHtml && mHtml[1]);
ok('mdz_ui.js 里有 BUILD', !!mUi, mUi && mUi[1]);
if (mHtml && mUi) {
  const nHtml = (mHtml[1].match(/(\d+)/) || [])[1];
  const nUi = (mUi[1].match(/(\d+)/) || [])[1];
  eq('两个构建标记的序号一致', nHtml, nUi);
}
ok('README 里的构建标记与代码一致（或不再写死具体版本号）',
  !/mdz-webrtc-web-1\b/.test(readText('README-DEV.md')));

// 面向人的文档里也写了构建号，最容易忘同步 —— 一起守住。
// README.md 是仓库首页入口（给测试者与访客），测试者须知.md 是给参与测试的朋友。
for (const doc of ['README.md', '测试者须知.md']) {
  ok(doc + ' 存在', fs.existsSync(path.join(ROOT, doc)));
  if (!fs.existsSync(path.join(ROOT, doc))) continue;
  const text = readText(doc);
  ok(doc + ' 写的是当前构建标记',
    !!mHtml && text.indexOf(mHtml[1]) >= 0,
    '文档里应出现 ' + (mHtml ? mHtml[1] : '?'));
  ok(doc + ' 写的是当前面板构建标记',
    !!mUi && text.indexOf(mUi[1]) >= 0,
    '文档里应出现 ' + (mUi ? mUi[1] : '?'));
}

/* -------------------------------------- 5. 脚本引用完整性与已删模块无引用 */
section('5. index.html 的脚本引用必须全部存在，已删模块不能再被引用');

const srcs = [];
const reSrc = /<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g;
let m;
while ((m = reSrc.exec(html))) srcs.push(m[1]);
ok('解析到若干外部脚本', srcs.length > 5, srcs.length + ' 个');
const missing = srcs.filter(s => !fs.existsSync(path.join(ROOT, 'web', s)));
ok('所有 <script src> 指向的文件都存在（不会有启动 404）', missing.length === 0, missing.join(', '));

// logger.js / drop.js 曾因缺失而在每次启动 404；现在只允许出现在注释里
for (const ghost of ['logger.js', 'drop.js']) {
  const active = new RegExp('<script\\b[^>]*src="[^"]*' + ghost.replace('.', '\\.') + '"').test(html);
  ok(ghost + ' 没有被当成活跃脚本引用', !active);
  ok(ghost + ' 确实不在 web/ 里（引用它就是 404）', !fs.existsSync(path.join(ROOT, 'web', ghost)));
}

const REMOVED = ['mdz_cfg', 'mdz_diag', 'mdz_island', 'mdz_hitfix', 'mdz_players', 'mdz_storm'];
const scanDirs = ['web', 'test', 'tools', 'sp/scripts'];
const referenced = [];
function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = rel + '/' + f.name;
    if (f.isDirectory()) { walk(child); continue; }
    if (!/\.(js|html|json|ps1|ts|md)$/.test(f.name)) continue;
    const txt = fs.readFileSync(abs + '/' + f.name, 'utf8');
    for (const mod of REMOVED) {
      // 只看"真的在加载它"的写法：<script src="mdz_xxx.js"> 或 require('.../mdz_xxx.js')
      const load = new RegExp('src="[^"]*' + mod + '\\.js"|require\\([^)]*' + mod + '\\.js');
      if (load.test(txt)) referenced.push(child + ' -> ' + mod);
    }
  }
}
scanDirs.forEach(walk);
ok('已删除的 6 个补丁模块没有被任何地方加载', referenced.length === 0, referenced.join('; '));
for (const mod of REMOVED) {
  ok(mod + '.js 确实不在 web/ 里', !fs.existsSync(path.join(ROOT, 'web', mod + '.js')));
}

/* ------------------------------------------- 6. 黑边功能的关键实现不变量 */
section('6. 黑边功能的关键实现不变量');

const core = readText('web/mdz_core.js');
ok('mdz_core.js 里没有裸的 new Array(meta.t)', !/new Array\(meta\.t\)/.test(core) || /isValidChunkMeta/.test(core));
ok('ChunkReassembler 有并发组上限', /maxPending/.test(core));
ok('ChunkReassembler 有总量上限', /maxTotalBytes/.test(core));
ok('mdz_ui.js 覆盖了 window.innerWidth', /Object\.defineProperty\(window,\s*'innerWidth'/.test(ui));
ok('画布定位规则带 !important', /#c2canvasdiv\{margin-left:var\(--mdz-bar-left/.test(ui) && /!important/.test(ui));
ok('mdz_ui.js 不再直接用 window.innerWidth 做布局', !/var vw = window\.innerWidth/.test(ui));

// 黑边的核心机制只有在真浏览器跑起 c2runtime 才验得出来，所以那个工具不能丢
ok('真浏览器验证工具 tools/verify-bars.js 存在', fs.existsSync(path.join(ROOT, 'tools', 'verify-bars.js')));
const pkg = JSON.parse(readText('package.json'));
ok('package.json 里有 verify:bars 脚本',
  !!(pkg.scripts && pkg.scripts['verify:bars']),
  pkg.scripts && pkg.scripts['verify:bars']);

// 发热/帧率的测量工具：必须按**手机视口**测，桌面视口会得出高一个数量级的假象
ok('性能测量工具 tools/measure-perf.js 存在', fs.existsSync(path.join(ROOT, 'tools', 'measure-perf.js')));
ok('package.json 里有 measure:perf 脚本',
  !!(pkg.scripts && pkg.scripts['measure:perf']),
  pkg.scripts && pkg.scripts['measure:perf']);
if (fs.existsSync(path.join(ROOT, 'tools', 'measure-perf.js'))) {
  const mp = readText('tools/measure-perf.js');
  ok('measure-perf 用了手机视口模拟（setDeviceMetricsOverride）', /setDeviceMetricsOverride/.test(mp));
  ok('measure-perf 自带静态服务与浏览器启动（零依赖）',
    /createServer/.test(mp) && /requestAnimationFrame|remote-debugging-port/.test(mp));
}
ok('面板提供「性能快照」按钮', /性能快照/.test(ui) && /perfSnapshot/.test(ui));
ok('测试者须知.md 说明了怎么测性能', /性能快照/.test(readText('测试者须知.md')));

console.log('\n--------------------------------------------------');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
