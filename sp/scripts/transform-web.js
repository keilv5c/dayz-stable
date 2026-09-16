/**
 * transform-web.js —— 把网页版游戏资源改成"适合塞进 iOS App"的形态
 *
 * 只做两件小事，都是**纯 ASCII 替换**（避开 PowerShell 处理 UTF-8 的坑）：
 *
 *   1. 关掉 Service Worker 注册
 *      网页版靠 sw.js 做离线缓存。在 Capacitor 的 WKWebView 里：
 *        · capacitor:// 属于非标准 scheme，SW 支持不可靠（可能直接抛错）
 *        · 资源已经在安装包里了，离线缓存毫无意义
 *        · 更糟的是它会缓存旧版本资源，改完代码重装还看到旧的
 *      所以直接把 navigator.serviceWorker.register("sw.js") 这一步短路掉。
 *
 *   2. 启动弹窗改成中文
 *      原版是俄语（"Спасибо всем игрокам..."）。这行只在 file:// 协议下弹，
 *      App 里其实不会出现，但留着俄语不体面，顺手换掉。
 *      （中文文案与联机版的 index.html 保持一致。）
 *
 * 用法：node sp/scripts/transform-web.js <public 目录>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const pub = process.argv[2];
if (!pub) {
  console.error('用法: node transform-web.js <public 目录>');
  process.exit(1);
}
const indexHtml = path.join(pub, 'index.html');
if (!fs.existsSync(indexHtml)) {
  console.error('找不到 ' + indexHtml);
  process.exit(1);
}

let html = fs.readFileSync(indexHtml, 'utf8');
const before = html.length;
const changes = [];

// ---- 1. 短路 Service Worker 注册 -------------------------------------------
// 原代码：
//   if (!navigator.serviceWorker)
//       return;		// no SW support, ignore call
const swNeedle = 'if (!navigator.serviceWorker)';
if (html.includes(swNeedle)) {
  html = html.replace(
    swNeedle,
    'if (true) return;   /* iOS 版：禁用 Service Worker（资源已内置，且 WebView 缓存旧版本会更麻烦） */\n\t\t\tif (!navigator.serviceWorker)'
  );
  changes.push('已禁用 Service Worker 注册');
} else if (html.includes('iOS 版：禁用 Service Worker')) {
  changes.push('Service Worker 已是禁用状态（跳过）');
} else {
  console.warn('  [WARN] 没找到 SW 注册的判断语句，index.html 结构可能变了');
}

// ---- 2. 启动弹窗换中文 ------------------------------------------------------
// 该字符串只在 file:// 下触发，App 内不会出现，但保持体面
const ruStart = html.indexOf('alert("');
if (ruStart !== -1) {
  const ruEnd = html.indexOf('");', ruStart);
  if (ruEnd !== -1) {
    const oldAlert = html.slice(ruStart, ruEnd + 3);
    if (/[\u0400-\u04ff]/.test(oldAlert)) {
      const zh = 'alert("感谢所有喜爱 MiniDayz 的玩家 ♡♡♡            欢迎来到 MiniDayz！");';
      html = html.slice(0, ruStart) + zh + html.slice(ruEnd + 3);
      changes.push('启动弹窗改为中文');
    }
  }
}

// ---- 写出 ------------------------------------------------------------------
fs.writeFileSync(indexHtml, html, 'utf8');

console.log('=== transform-web 结果 ===');
console.log('  目标 : ' + indexHtml);
console.log('  大小 : ' + before + ' -> ' + html.length + ' 字符');
if (changes.length) changes.forEach(c => console.log('  ✓ ' + c));
else console.log('  （无需改动）');

// 自检
const out = fs.readFileSync(indexHtml, 'utf8');
const swDisabled = /if \(true\) return;\s*\/\* iOS 版/.test(out);
console.log('  自检 SW 已禁用 : ' + swDisabled);
console.log('  自检 无俄文字母: ' + !/[\u0400-\u04ff]/.test(out));
console.log('  自检 仍引用 c2runtime.js : ' + out.includes('c2runtime.js'));
