import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Mini DAYZ 双模式零服务器 WebRTC 联机 —— Capacitor 配置
 *
 * 说明：
 *  - webDir 指向 web/（里面就是游戏本体 + 我们新增的 mdz_*.js），资源全部本地化，不依赖任何外网服务器
 *  - androidScheme 用默认的 https，WebView 的源是 https://localhost —— 属于安全上下文，
 *    WebRTC / DataChannel 可用（摄像头另见下方权限说明）
 *  - 扫码在 App 内优先走原生插件 BarcodeScanner（WebView 里的 getUserMedia 在 Android/iOS 上不可靠），
 *    所以插件列表里必须包含 @capacitor-mlkit/barcode-scanning
 */
const config: CapacitorConfig = {
  appId: 'com.mdz.webrtcmp',
  appName: 'Mini DAYZ 联机版',
  webDir: 'web',
  bundledWebRuntime: false,
  android: {
    // 已关闭：本包面向朋友间小范围互玩，不对外提供调试入口。
    // 需要看控制台时临时改回 true 重新构建，或改用 chrome://inspect 前先确认这是自用包。
    webContentsDebuggingEnabled: false,
    allowMixedContent: false,
    // 强制 WebView 允许内联媒体播放（对摄像头预览有益）
    captureInput: true
  },
  ios: {
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false
  },
  server: {
    // 保持 https://localhost，属于安全上下文；不要改成 http
    androidScheme: 'https',
    iosScheme: 'capacitor'
  },
  plugins: {
    // 原生扫码插件（@capacitor-mlkit/barcode-scanning）无需额外 JS 配置
  }
};

export default config;
