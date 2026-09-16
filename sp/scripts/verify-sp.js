/**
 * verify-sp.js -- 对已准备好的单机版 iOS 构建树做静态验收（不需要 Mac）
 *
 * 检查项：
 *   1. public/ 里有全部必需资源，且没有任何联机版脚本
 *   2. index.html 已禁用 Service Worker、无俄文、仍正确引用 c2runtime.js
 *   3. capacitor.config.json 合法、appId/webDir 正确
 *   4. Info.plist 良构、关键 key 存在、联机版权限已删除、Bundle ID 正确
 *   5. Podfile 只依赖 Capacitor（无 MLKit），且引用的本地路径真实存在
 *   6. 游戏本体是"汉化 + 无 MDZ☆START"
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SP = process.argv[2] || path.join(__dirname, '..');
const PUB = path.join(SP, 'ios', 'App', 'App', 'public');
const APP = path.join(SP, 'ios', 'App', 'App');

let fails = 0, warns = 0;
const ok   = m => console.log('  \u2713 ' + m);
const bad  = m => { fails++; console.log('  \u2717 ' + m); };
const warn = m => { warns++; console.log('  ! ' + m); };
const head = m => console.log('\n=== ' + m + ' ===');
const read = p => fs.readFileSync(p, 'utf8');
const exists = p => fs.existsSync(p);

// ---------------------------------------------------------------- 1. public/
head('1. public/ 资源');
if (!exists(PUB)) { bad('public/ 不存在'); process.exit(1); }
const need = ['index.html','data.js','c2runtime.js','jquery-3.4.1.min.js','offline.js','sw.js',
              'l_eng_ui.xml','l_eng_items.xml','l_eng_log.xml','l_eng_new.xml',
              'appmanifest.json','bunker_json','images','media'];
for (const n of need) {
  if (exists(path.join(PUB, n))) ok(n); else bad('缺少 ' + n);
}
const files = (function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, acc);
    else { acc.push(p); continue; }
  }
  return acc;
})(PUB);
const sizeMB = (files.reduce((s, f) => s + fs.statSync(f).size, 0) / 1048576).toFixed(1);
console.log(`  · ${files.length} 个文件, ${sizeMB} MB`);

// 联机版绝不能混进来
const mp = ['mdz_p2p.js','mdz_core.js','mdz_ui.js','lan_bridge.js','peerjs.min.js',
            'mp_join.js','mp_entities.js','mp_players.js','mp_worldstate.js','zoom.js'];
let leaked = mp.filter(f => exists(path.join(PUB, f)));
if (leaked.length) bad('混入了联机版脚本: ' + leaked.join(', ')); else ok('无联机版脚本残留');

// ---------------------------------------------------------------- 2. index.html
head('2. index.html');
const html = read(path.join(PUB, 'index.html'));
if (/if \(true\) return;\s*\/\* iOS \u7248/.test(html) || html.includes('iOS \u7248\uff1a\u7981\u7528 Service Worker'))
  ok('Service Worker 已禁用');
else if (html.includes('if (!navigator.serviceWorker)')) bad('Service Worker 未禁用（注册代码仍生效）');
else warn('找不到 SW 注册代码，结构可能已变');
if (/[\u0400-\u04ff]/.test(html)) bad('index.html 仍含俄文字母'); else ok('无俄文残留');
if (html.includes('c2runtime.js')) ok('仍引用 c2runtime.js'); else bad('缺 c2runtime.js 引用');
if (html.includes('jquery-3.4.1.min.js')) ok('仍引用 jquery'); else bad('缺 jquery 引用');
for (const m of mp) if (html.includes(m)) bad('index.html 仍引用联机脚本 ' + m);

// ---------------------------------------------------------------- 3. capacitor.config.json
head('3. capacitor.config.json');
const cfgPath = path.join(APP, 'capacitor.config.json');
if (!exists(cfgPath)) bad('不存在');
else {
  let cfg = null;
  try { cfg = JSON.parse(read(cfgPath)); ok('JSON 合法'); } catch (e) { bad('JSON 非法: ' + e.message); }
  if (cfg) {
    if (cfg.appId === 'com.mdz.minidayz.sp') ok('appId = ' + cfg.appId); else bad('appId 异常: ' + cfg.appId);
    if (cfg.webDir === 'public') ok('webDir = public'); else bad('webDir 异常: ' + cfg.webDir);
    if (cfg.server && cfg.server.iosScheme === 'capacitor') ok('iosScheme = capacitor'); else warn('iosScheme 未设为 capacitor');
    if (cfg.ios && cfg.ios.contentInset === 'never') ok('contentInset = never'); else warn('contentInset 未设 never');
  }
}

// ---------------------------------------------------------------- 4. Info.plist
head('4. Info.plist');
const plistPath = path.join(APP, 'Info.plist');
if (!exists(plistPath)) bad('不存在');
else {
  const t = read(plistPath);
  // well-formedness
  const stack = []; let m, wf = true;
  const re = /<(\/?)([A-Za-z_][\w.:~-]*)([^>]*?)(\/?)>/g;
  while ((m = re.exec(t))) {
    if (m[0].startsWith('<?') || m[0].startsWith('<!')) continue;
    if (m[4]) continue;
    if (m[1]) { if (stack.pop() !== m[2]) { wf = false; break; } } else stack.push(m[2]);
  }
  if (wf && stack.length === 0) ok('XML 良构'); else bad('XML 不良构');
  const has = k => t.includes('<key>' + k + '</key>');
  for (const k of ['CFBundleDisplayName','UIRequiresFullScreen','UIStatusBarHidden',
                   'UISupportedInterfaceOrientations','UISupportedInterfaceOrientations~ipad',
                   'WKWebViewConfigurationAllowsInlineMediaPlayback','ITSAppUsesNonExemptEncryption'])
    if (has(k)) ok('有 ' + k); else bad('缺 ' + k);
  for (const k of ['NSCameraUsageDescription','NSLocalNetworkUsageDescription','NSBonjourServices'])
    if (has(k)) bad('单机版不该有 ' + k); else ok('已移除 ' + k);
  const orient = (t.match(/UIInterfaceOrientation\w+/g) || []);
  if (orient.every(o => o.includes('Landscape'))) ok('仅横屏 (' + [...new Set(orient)].join(', ') + ')');
  else warn('含非横屏方向: ' + orient.join(', '));
  if (!/[\u0400-\u04ff]/.test(t)) ok('无俄文'); else bad('Info.plist 含俄文');
}

// ---------------------------------------------------------------- 5. Podfile
head('5. Podfile');
const podPath = path.join(SP, 'ios', 'App', 'Podfile');
if (!exists(podPath)) bad('不存在');
else {
  const t = read(podPath);
  if (/platform :ios, '15\.5'/.test(t.split('\n')[0])) ok("首行 platform :ios, '15.5'"); else bad('platform 不在第一行或版本不对');
  if (/mlkit/i.test(t)) bad('含 MLKit 引用'); else ok('无 MLKit 引用');
  if (/def capacitor_pods/.test(t)) ok('定义 capacitor_pods'); else bad('缺 capacitor_pods 定义');
  if (/^\s*use_frameworks!/m.test(t)) ok('use_frameworks! 存在'); else bad('缺 use_frameworks!');
  if (/assertDeploymentTarget/.test(t)) ok('post_install 校验存在'); else warn('缺 post_install');
  // 本地 pod 路径必须真实存在
  const paths = [...t.matchAll(/pod\s+'([^']+)',\s*:path\s*=>\s*'([^']+)'/g)].map(x => [x[1], x[2]]);
  const podDir = path.dirname(podPath);
  for (const [name, rel] of paths) {
    const abs = path.resolve(podDir, rel);
    if (exists(abs)) ok(`pod ${name} -> ${rel} (存在)`); else bad(`pod ${name} 路径不存在: ${abs}`);
  }
  // podspec 里的部署目标是否 <= 15.5
  const spec = path.resolve(podDir, 'node_modules/@capacitor/ios/Capacitor.podspec');
  if (exists(spec)) {
    const mm = read(spec).match(/deployment_target\s*=\s*'([\d.]+)'/);
    if (mm) {
      if (parseFloat(mm[1]) <= 15.5) ok(`Capacitor.podspec deployment_target = ${mm[1]} (<= 15.5, 兼容)`);
      else bad(`Capacitor.podspec 要求 iOS ${mm[1]} > 15.5`);
    }
  } else warn('找不到 Capacitor.podspec（未复制 node_modules？）');
}

// ---------------------------------------------------------------- 6. 游戏本体
head('6. 游戏本体');
const data = read(path.join(PUB, 'data.js'));
if (data.includes('\u2606')) bad('data.js 仍含 \u2606 (MDZ START)'); else ok('data.js 无 MDZ START');
for (const f of ['l_eng_ui.xml','l_eng_items.xml','l_eng_log.xml','l_eng_new.xml']) {
  const t = read(path.join(PUB, f));
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const need2 = f === 'l_eng_ui.xml' ? 3000 : 500;
  if (cjk >= need2) ok(`${f} 中文字符 ${cjk}`); else bad(`${f} 中文过少 (${cjk})`);
}
// XML 结构没被破坏
for (const f of ['l_eng_ui.xml','l_eng_items.xml','l_eng_log.xml','l_eng_new.xml']) {
  const t = read(path.join(PUB, f));
  const opens = (t.match(/<name>/g) || []).length, closes = (t.match(/<\/name>/g) || []).length;
  if (opens === closes) ok(`${f} <name> 配对 ${opens}`); else bad(`${f} <name> 不配对 ${opens}/${closes}`);
}
// data.js 可解析
try {
  JSON.parse(data.replace(/^\uFEFF/, ''));
  ok('data.js JSON 可解析');
} catch (e) { bad('data.js JSON 解析失败: ' + e.message); }

// ---------------------------------------------------------------- 结果
head('结果');
console.log(`  失败 ${fails} 项, 警告 ${warns} 项`);
if (fails === 0) console.log('\n  \u2705 静态验收通过 —— 可以 push 出包了');
else console.log('\n  \u274c 有失败项，先修复');
process.exit(fails === 0 ? 0 : 1);
