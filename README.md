# Mini DAYZ 联机版（非官方粉丝作品）

把 Mini DAYZ 改造成**两个人可以直接联机**的版本：零服务器（不需要中心信令服务器）、
支持面对面扫码或异地文本握手，并封装成 Android / iOS App。

> **非官方、非商业的粉丝作品。** 与 Bohemia Interactive 无任何关系。
> 本仓库包含游戏资源副本，仅供小范围朋友间测试，请勿用于商业用途。
> 当前定位是 **PvE 小范围互玩**，不是公开发布版本。

当前版本：**`mdz-webrtc-web-6-lite`**（App 内面板标题栏显示 `mdz-ui-6-lite`，对不上就是旧包）

---

## 我该看哪份文档

| 你是谁 | 看这个 |
|---|---|
| **想装来玩 / 参与测试** | 👉 [`测试者须知.md`](测试者须知.md) —— 怎么装、怎么连、已知问题、出问题怎么反馈 |
| **要改代码 / 重新构建** | 👉 [`README-DEV.md`](README-DEV.md) —— 架构、双模式原理、测试、打包、踩过的坑 |

---

## 拿安装包

### iOS（未签名 IPA）

只能由 macOS 编译，所以走 GitHub Actions：

1. 打开 [Build iOS IPA (unsigned)](https://github.com/keilv5c/dayz-stable/actions/workflows/ios-unsigned-ipa.yml)
2. 最新一次成功运行（绿色 ✅）页面底部 **Artifacts** → 下载 `minidayz-unsigned-ipa`
3. 解压得到 `.ipa`，用 [Sideloadly](https://sideloadly.io/) + 自己的 Apple ID 签名安装

> ⚠️ 下载 artifact **需要登录 GitHub**。
> ⚠️ 免费 Apple ID 签的包**只有 7 天有效**、最多 3 个 App，到期要重签。
> Bundle ID 被占用时，重新运行工作流并在 `bundle_id` 输入框填一个你自己独有的（如 `com.yourname.mdzmp`）。

### Android（APK）

APK **不入库**（`.gitignore` 排除了 `dist/`），需要本地构建：

```bash
npm ci
npx cap sync android
# 然后用 JDK 21 + Android SDK 跑：
cd android && ./gradlew assembleDebug --no-daemon
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

一键脚本：`powershell -File tools\build-apk.ps1`（详见 `README-DEV.md` 第七节）。

### 电脑（浏览器）

`npm run web` 后访问 `http://localhost:8765/index.html`。
局域网给别的设备用 `http://本机IP:8765/index.html`，但**非 localhost 的 http 会被浏览器禁用摄像头**，
扫码模式就用不了（面板会自动切到文本模式）。要用扫码请上 HTTPS。

---

## 快速了解它怎么工作

原来的联机方式依赖 PeerJS + 中心信令服务器。这里换成了两端直连：

- **不重写游戏代码**：提供 `window.Peer` 垫片顶替 PeerJS，`lan_bridge.js` 与 7 个 `mp_*.js`
  与原版**逐字节一致**（`_original_manifest.csv` 是 SHA256 留证，实测 1964 项里只有 `index.html` 有差异）。
- **两种握手**：
  - 模式A `qr`：同一 Wi-Fi，压缩握手串画成二维码，不配 STUN
  - 模式B `text`：异地，手动复制粘贴 SDP 文本，走国内 STUN
- **双通道**：`mdz_game_sync` 可靠有序（世界快照 `mpj_*` 分块依赖它）+
  `mdz_fast` 无序不重传（只走 `player_state` / `player_visual`）。

细节见 [`README-DEV.md`](README-DEV.md)。

---

## 已知限制（都是已知的，不用报）

1. **没有 TURN**：异地联机在对称 NAT 下必然失败。要稳需自建 coturn。
2. **客机打怪可能不结算伤害**（近战尤其明显）—— 历史补丁模块已按需求移除。
3. **跨岛会出问题**：客机可能拿到房主的角色/背包且卸不下来。**联机时不要跨岛。**
4. 长时间高频率交互手机会偏热。
5. 没有房间列表（零服务器的代价），必须线下交换二维码/文本。
6. 二维码/SDP 就是准入凭证，**没有密码**，只和信得过的人联机。

---

## 测试

```bash
npm test              # 13 个套件（含工程不变量检查）
npm run verify:bars   # 画面黑边功能的真浏览器验证（需要本机有 Chrome）
```

`npm test` 全绿是改动的最低门槛；动了黑边相关代码还必须跑 `verify:bars`
（黑边的核心机制只有在真实浏览器里跑起 c2runtime 才验得出来，jsdom 做不到）。
