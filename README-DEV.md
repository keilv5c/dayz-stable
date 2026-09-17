# Mini DAYZ 双模式零服务器 WebRTC 联机 —— 开发说明（DEV）

> 本目录是**副本**，原版目录 `D:\game_hack\minidayz\Minidayz-Multiplayer-main\Minidayz-Multiplayer-main` 一个字节都没有改。
> 校验方法见文末"原版未被改动的证明"。
>
> **当前形态**：只保留联机三件套 `mdz_core.js` / `mdz_p2p.js` / `mdz_ui.js`。
> 历史上曾有 6 个补丁模块 —— `mdz_cfg`（配置中枢）、`mdz_diag`（诊断）、`mdz_island`（跨岛止损）、
> `mdz_hitfix`（命中修复）、`mdz_players`（角色自保）、`mdz_storm`（风暴刹车）——
> **经确认不再需要，已连同它们的测试套件一并删除**，代码里也不再引用（`test/mdz_invariants.test.js` 会守住这一点）。
>
> **定位与已知问题**：本包面向**朋友间小范围互玩**（PvE），不追求公开发布。
> 因为删掉了上面那些补丁模块，第四节历史坑 #9 / #10 描述的现象在本快照里**仍然是存在的**，
> 属于已知限制，不要在联机时做跨岛 / 依赖客机命中的玩法。
> 黑边（挖孔屏适配）与联机相关的能力见第三节与第五节。
>
> 👉 **给测试者看的那份**在 **`测试者须知.md`**（怎么装、怎么连、哪些是已知问题、出问题怎么反馈）。
> 本文件是开发向的。

---

## 一、这套东西是什么

把原来"PeerJS + 中心信令服务器"的联机方式，换成**零服务器的 WebRTC 直连**，并且提供两种握手方式：

| 模式 | 场景 | 握手方式 | ICE |
|---|---|---|---|
| **模式A** `qr` | 面对面、同一 Wi-Fi | 二维码（压缩+base64） | **不配 STUN**，只用 host 候选 |
| **模式B** `text` | 异地、跨网络 | 手动复制粘贴 SDP 文本 | 国内 STUN（miwifi / bilibili / hitv） |

底层统一走 `RTCDataChannel`，全程没有音视频轨道。

### 关键设计决策（都是反查原代码后定的，不是拍脑袋）

1. **不重写 `lan_bridge.js`，而是提供 `window.Peer` 垫片。**
   `lan_bridge.js` 本质是"传输适配层"：它 `new Peer(...)`，然后把手里的 conn 通过
   `setSender()/setConn()` 注入给 `MPNet / MPJoin / MPWorldState / MPEntities / MPPlayers / MPInteractions`。
   它需要的接口只有：

   ```
   Peer : on('open'|'connection') / connect(id) / destroy()
   conn : send(obj) / open / on('open'|'data'|'close'|'error') / close() / bufferSize
   ```

   我们提供 `window.Peer` 顶替 PeerJS，于是 `lan_bridge.js` 和 7 个 `mp_*.js` **一行都不用改**。

2. **`conn.bufferSize` 是隐藏契约。** `mp_join.js` 里用
   `if (typeof conn.bufferSize === "number") return conn.bufferSize;` 做世界快照分块的**背压**。
   垫片把它映射到 `dataChannel.bufferedAmount`，否则游戏会一次性猛灌所有 12000 字节分片。

3. **主通道必须可靠有序。** 游戏自己按 12000 字节分块传世界快照（`mpj_begin/chunk/end` + `fingerprint` 校验），
   全文搜索 `retry` / `nak` **命中 0** —— 丢一片就整份世界数据损坏且无法恢复。
   所以：
   - `mdz_game_sync`：`ordered:true` 可靠有序 —— 默认通道，几乎所有消息走这里
   - `mdz_fast`：`ordered:false, maxRetransmits:0` —— **只**走 `player_state` / `player_visual`（丢一包下一包就覆盖）
   - 回退开关：控制台 `MDZP2P.setFastLane(false)` 可关掉副通道，全部走主通道

4. **模式A 不按内网 IP 过滤候选。** 现代 Chrome/WebView 在页面没有摄像头权限时会做
   **mDNS 混淆**（候选地址是 `<uuid>.local` 而不是 `192.168.x.x`）。按 IP 过滤会把候选全过滤光，
   直接导致模式A 失效。所以：mDNS 候选**也算可用**；只有在"没有任何候选"时才报错并引导切模式B。
   可选增强：`requestCameraForUnobfuscation()`（面板里点「扫对方回码」前会申请一次摄像头权限）能拿到真实内网 IP。

5. **STUN 用的是实测可用的**。2026-09 本机 UDP 实测：`stun.qq.com` **已超时失效**（需求文档里写的是它），
   可用的是 `stun.miwifi.com` / `stun.chat.bilibili.com` / `stun.hitv.com`。

6. **握手串体积实测**（决定二维码密度，见 `npm run test:core` 输出）：
   模式A 约 **512–526 字符**，模式B 约 **600–707 字符**，都远低于单张二维码上限 2953 字节 → 二维码很好扫。

---

## 二、目录结构

```
Minidayz-WebRTC/
├─ web/                         ← 游戏本体副本 + 新增代码（Capacitor 的 webDir）
│  ├─ index.html                ← 只改了两处：去掉 peerjs.min.js、加入新脚本
│  ├─ lan_bridge.js             ← 与原版逐字节一致（未改动）
│  ├─ mp_*.js / c2runtime.js …  ← 与原版逐字节一致（未改动）
│  ├─ mdz_core.js               ← 新增：纯逻辑（SDP 打包/裁剪、候选分析、分块、分流）可 Node 单测
│  ├─ mdz_p2p.js                ← 新增：WebRTC 传输层 + window.Peer 垫片 + 双通道
│  ├─ mdz_ui.js                 ← 新增：双模式面板（二维码 / 摄像头 / SDP 文本框）
│  ├─ mdz_selftest.html         ← 新增：单机自测页（不需要第二台设备）
│  └─ vendor/{pako,qrcode,html5-qrcode}.min.js   ← 本地化依赖，不依赖 CDN
├─ test/                        ← 三层测试（见第五节）
├─ tools/make-vendor.js         ← 重新生成 vendor/（npm run vendor）
├─ android/                     ← Capacitor 生成的 Android 工程（已配好相机权限）
├─ capacitor.config.ts
└─ _original_manifest.csv       ← 原版目录的 SHA256 清单（留证）
```

---

## 三、跑网页版（开发/调试）

```bat
cd /d D:\game_hack\minidayz\Minidayz-WebRTC
npm run web
```
然后浏览器打开：

- 游戏：<http://localhost:8765/index.html>
- **自测页（推荐先跑这个）**：<http://localhost:8765/mdz_selftest.html>

### ⚠️ 看不到联机面板 / 找不到扫码入口？（踩过两次的坑）

游戏的 `sw.js` 是**离线缓存 Service Worker**，它会把 `index.html` 一起缓存。
如果你之前用旧页面打开过这个地址，之后刷新拿到的还是**旧 index.html**——
表现就是：游戏能玩、原版面板（Room ID / HOST / JOIN）在，但**右上角没有我们的联机面板**。

判断方法：按 F12 看控制台，**没有 `[MDZ] build mdz-webrtc-web-… 已加载` 就是缓存住了**
（具体版本号见 `web/index.html` 里的 `MDZ_BUILD`，面板标题栏上也会显示同一个号）。

三种解法（任选）：

1. 加个查询参数强制走网络：`http://localhost:8765/index.html?v=2`
2. DevTools → **Application → Service Workers → Unregister** → 再 Ctrl+Shift+R（最彻底）
3. 用无痕窗口打开

现在 `index.html` 里已经加了**自动注销旧 Service Worker + 禁用注册**的代码，
清一次之后就不会再被缓存坑到了（想恢复离线单机，把 `index.html` 末尾那段删掉即可）。

### 扫码入口在哪？

**不在游戏里，也没有游戏内图标**——入口就是我们注入的联机面板（固定在**右上角**）：

- 房主：面板上点「① 房主：创建房间」→ 面板里出现**房间二维码**
- 客机：面板上点「① 客机：加入房间」→ 面板里出现**摄像头预览框**去扫房主的码
- 点完之后才会出现二维码 / 摄像头区域，没点之前是隐藏的

游戏自带的那个原版面板（Room ID / HOST / JOIN / DISCONNECT）也**能用**：
点它的 HOST/JOIN，我们的面板会自动展开并接手（已适配并测过，见测试第 8 节）。

> 网页端注意：`http://localhost` 属于安全上下文，所以**网页也能用模式A 扫码**（会按需加载 html5-qrcode）。
> 但如果用 `http://192.168.x.x` 打开，浏览器会禁用摄像头 → 面板会自动切到模式B。

自测页在**同一个页面**里开两个 RTCPeerConnection，跑完整握手 + 双通道 + 收发 + 大消息分块，
不需要第二台设备就能确认传输层是否正常（会打印 PASS/FAIL 列表）。

### 画面被挖孔 / 灵动岛挡住？调「画面黑边」

游戏是 Construct 2 的 **crop（裁切铺满）** 模式（`data.js` 里 `fullscreen_mode = 1`），
画面会顶到屏幕左右两端，所以挖孔 / 灵动岛正好压住边缘的游戏 UI。

面板底部有 **「画面黑边（避开挖孔 / 灵动岛，高度不变）」**：

- 「左」「右」各一条滑杆 + 数字框，范围 0–400px，**拖动即时生效**
- 快捷按钮：`对称 40` / `对称 80` / `重置黑边`
- 设置存在 `localStorage`（`mdz.ui.bars.v1`），下次打开还在
- **只收左右，高度一点都不动**（不是等比缩放）

实现方式（改动都在 `web/mdz_ui.js`，没碰游戏本体）：

1. 接管 `window.innerWidth` 的 getter，返回 `真实宽度 - 左黑边 - 右黑边`。
   `c2runtime` **每帧**都在比对 `window.innerWidth` 与 `lastWindowWidth`，一旦不等就自己调
   `setSize()` —— 所以只要改这个值，运行时就会按新视口重新缩放布局，旋转屏幕也会自动跟上。
2. `#c2canvasdiv` 的 `margin-left` 是 `setSize()` 写的内联样式（crop 模式下恒为 0），
   用一条带 `!important` 的样式表规则盖掉它，把画布推到左黑边之后。
3. 页面背景本来就是纯黑（`html,body{background:#000}`），没被画布盖住的两条边天然就是黑边。

> 保护：单边最多 400px，且无论怎么设都**至少给游戏留 240px 宽**，不会把画面压没。
> 页面自身的其它视口计算（面板拖动边界、二维码浮层尺寸、桌面判定）一律走"真实宽度"
> （`MDZUI.viewport()`），不会被黑边影响。
> 万一某些内核不允许覆盖 `innerWidth`，功能会整体失效并在日志里说明原因 ——
> 只是没有黑边，不影响游戏与联机。
>
> 调试入口：`MDZUI.setBars(左, 右)` / `MDZUI.resetBars()` / `MDZUI.getBars()` / `MDZUI.viewport()`。

### 手机发热 / 掉帧？调「画面清晰度」

> ⚠️ **先纠正一个曾经写错的结论**：早先这里贴过一张「1x=60.2fps / 1.5x=35.4fps / 3x=12.0fps」的表，
> 那是在**桌面全屏视口（2314px 宽）**下测的 —— 桌面视口的画布像素数比手机高一个数量级，
> 拿来代表手机是错的。下面这张才是**按手机视口**测的（`npm run measure:perf` 可复现）。

画布像素数 = `CSS 视口尺寸 × 渲染倍率²`。手机 CSS 视口只有 ~800x390，所以：

| 机型（横屏） | 未封顶 | 高 2x | 中 1.5x（默认） | 低 1x |
|---|---|---|---|---|
| iPhone 15 Pro（852x393 CSS @3x） | 2556x1179 · **301 万像素** · 55.6 fps | 1704x786 · 134 万 · 60.1 | 1278x590 · 75 万 · 60.0 | 852x393 · 33 万 · 60.0 |
| 中端安卓（800x360 CSS @3x） | 2400x1080 · **259 万像素** · 58.9 fps | 1600x720 · 115 万 · 60.1 | 1200x540 · 65 万 · 60.0 | 800x360 · 29 万 · 60.2 |
| 1080p 安卓（960x432 CSS @2.5x） | 2400x1080 · 259 万 · 60.0 | 1920x864 · 166 万 · 60.0 | 1440x648 · 93 万 · 60.1 | 960x432 · 41 万 · 60.1 |

**怎么读这张表**（很重要，别读错）：

1. 无头环境是 **SwiftShader 软件渲染**，绝对帧率**低于**真机 GPU，所以「未封顶 55~59fps」
   不代表真机也是这个数 —— 真机可能更好，也可能因为 GPU 更弱/已降频而更差。
2. 真正可信、且与设备无关的是 **画布像素数**：默认 3x 下每帧要填 259~301 万像素，
   60fps 就是 **1.5~1.8 亿像素/秒**的持续填充。这才是**发热的第一驱动**：
   同样的游戏逻辑，像素数降到 1.5x 是 1/4、降到 1x 是 1/9。
3. 帧耗时那一列（p50 约 2ms、p95 约 3ms）是 **JS 侧 tick 耗时**，不含 GPU 合成与显示，
   所以它一直很宽松 —— 说明**瓶颈在渲染管线，不在游戏逻辑**。

所以「画面清晰度」三档的作用是**按比例削掉 GPU 填充量**：

| 档位 | 封顶倍率 | 相对 3x 的像素数 | 适用 |
|---|---|---|---|
| 高（最清晰） | 2.0x | 约 1/2.2 | 旗舰机、想要最锐利的文字 |
| **中（均衡，默认）** | 1.5x | **约 1/4** | 绝大多数手机 |
| 低（最省电） | 1.0x | **约 1/9** | 发热/掉帧明显、或长时间联机 |

设置存 `localStorage`（`mdz.ui.render.v1`）。桌面端 dpr 本来就是 1，三档等效，不受影响。

实现要点（`web/mdz_ui.js` 的 `applyRenderLevel`）：

- 只改 `runtime.devicePixelRatio`（= `min(真实 dpr, 档位上限)`）再 `setSize()` 重排。
- **`isRetina` 必须保持 `true`**：它同时决定 C2 要不要给 canvas 写 CSS 尺寸，
  置 false 会让画布按位图尺寸显示、直接溢出屏幕（实测踩过）。
- 为什么不做「限帧」：C2 的主循环在 IIFE 里就把 `requestAnimationFrame` 抓成了局部变量，
  外部改不动；要限帧只能改 `index.html` 的加载顺序去劫持 rAF，收益不明确、风险更大，故不做。

### 衡量优化效果：帧率 / 发热的指标与测法

**一、应用内指标（点联机面板的「性能快照」按钮，或 `MDZUI.perfSnapshot(3)`）**

| 指标 | 含义 | 目标 |
|---|---|---|
| `fps` | 3 秒内实际帧数/秒 | ≥ 55 视为达标；< 40 需要降档 |
| `frameMsP50` | 每帧 tick 耗时中位数 | 应远小于 16.7ms |
| `frameMsP95` | 95 分位耗时 —— **比平均值有意义**，卡顿是长尾 | < 8ms |
| `longFrames` | tick 超过 50ms 的帧数（肉眼可见地卡一下） | 0 |
| `megapixels` | 画布像素数（万） | 发热的第一驱动，是主要调节量 |
| `renderScale` / `deviceDpr` | 实际渲染倍率 / 设备原生 dpr | 两者之差就是省下的量 |
| `renderer` | WebGL 还是 Canvas2D | Canvas2D 说明没吃到 GPU，发热会明显更差 |

命令行的等价物：`npm run measure:perf`（按手机视口模拟，逐档出表），
`npm run measure:perf -- --css 800x360 --dpr 3 --seconds 10` 可自定机型。

**二、设备侧指标（应用内读不到，必须从系统侧取）**

Android（USB 调试后）：

```bash
adb shell dumpsys thermalservice | grep -i "Temperature\|status"   # 各温区温度与节流状态
adb shell cat /sys/class/thermal/thermal_zone*/temp                # 原始温度（毫摄氏度）
adb shell dumpsys battery | grep -i "temperature\|level"           # 电池温度(0.1℃) 与电量
adb shell dumpsys gfxinfo <包名>                                    # 掉帧/卡顿统计
```

iOS：Xcode → Instruments 的 **Thermal State** 与 **Energy Log**；
代码侧可用 `ProcessInfo.processInfo.thermalState`（需原生侧加，当前没做）。

**三、判定标准（建议）**

- **帧率**：连续玩 5 分钟，`fps` 的 1% low（最差的那 1% 帧）≥ 50 —— 只看平均会被好帧掩盖。
- **温度**：Android 电池温度 **≤ 40℃** 为舒适区；40~43℃ 会开始降频；> 43℃ 必须降档。
  测法：开一局玩 10 分钟，每 30 秒记一次，看**稳态值**而不是起始值。
- **降频**：`thermalservice` 的 status 出现 `THROTTLING_*` 说明已经在降频 —— 此时 fps 会掉。
- **电量**：10 分钟耗电 ≤ 8%（约 0.8%/分钟）算正常；超过说明填充量或轮询太猛。
- **对照实验**：同一台机器、同一局场景，只改「画面清晰度」档位，比较 `megapixels` 与
  稳态温度 —— 像素数降 4 倍（3x→1.5x）应能看到温度明显下台阶。

**四、已知的其它耗电源（不在「清晰度」控制范围内）**

游戏自身的多人在线同步循环会**持续轮询**，即使没连上也在跑（实测注册情况）：

| 来源 | 间隔 | 频率 |
|---|---|---|
| `mp_interactions.js` | 50ms ×2 | 20Hz ×2 |
| `mp_entities.js` | 100ms | 10Hz |
| `mp_worldstate.js` | 250ms | 4Hz |
| `mp_players.js` | 500ms ×2 | 2Hz ×2 |

这些都在原版 `mp_*.js` 里（**与原版逐字节一致，未改动**），
单次开销很小（总帧耗时 p50 仅约 2ms），但**是持续的背景负载**，长时间联机会累积成热量。
想再压只能改游戏本体，属于超出「不改游戏」边界的操作，暂不做。

### 主菜单上两个遗留入口已被移除

游戏主菜单左右两侧原本各有一个入口：

| 位置 | 文字 | 点击后 |
|---|---|---|
| 左 | `MDZ☆START` / `MDZ◇START` | 跳 `t.me/likefreefun` |
| 右 | `MINI DayZ 2` | 跳 `store.bistudio.com` 的商店页 |

现在它们**在视觉上完全消失、点击也不再跳转**，且**没有改动游戏本体**（`web/` 仍与原版逐字节一致）。

做法（`web/mdz_ui.js` 的 `hideLegacyEntries` / `blockLegacyLinks`）：

1. **隐藏**：Menu 布局 `menu_elements` 层上，按文本匹配 `t415`/`t1056` 的实例并置为 invisible；
   再把它**位置重合、尺寸相近**的实例一起隐藏 —— 入口除了文字还有一块底色板，
   而那块板是**另一种类型**的对象（按文本、按同类实例都匹配不到，实测确认）。
   尺寸护栏（6 倍面积差）用来排除覆盖全屏的背景对象，否则会把整个菜单干掉。
2. **拦跳转**：这里有个坑 —— C2 的 `Browser.GoToURL` 用的是 **`window.location = url`**，
   而 `location` 是 unforgeable 的、JS 覆盖不了它的 setter。所以只能在
   **动作函数的原型**（`Object.getPrototypeOf(cr.plugins_.Browser.prototype.acts)`）上包一层；
   `GoToURLWindow` 走 `window.open`，两条都拦。只拦这两个域名，其它外链照常放行。
   > 只包实例（`acts.GoToURL = ...`）是不够的 —— 运行时仍可能拿到原型上的原函数。
3. 菜单会滚动、文字会在 ☆/◇ 之间变，所以用一个 1 秒的轻量巡检兜底，只在 Menu 布局上跑。

> 验证：`npm run verify:bars` 会检查这两个入口的实例是否 invisible、
> 直接调用 `GoToURL` 是否被拦、以及点原位置是否还会跳走。

### 两台设备实测联机

**先用两个浏览器在本机做一次冒烟测试**（不需要第二台设备，能验证 90% 的链路）：
Chrome 开一个窗口当房主，Edge 开一个窗口当客机（**必须是两个不同浏览器**，同一浏览器的两个标签页会共用存档，容易互相干扰），
走「异地文本 SDP」流程粘贴一次即可。

真正的双设备：

1. 两台设备都打开游戏页面（局域网可用 `http://本机IP:8765/index.html`；异地需要把 8765 暴露出去，或用 App）
2. 双方在同一 Wi-Fi：选 **面对面扫码联机**
   - 房主点「① 房主：创建房间」→ 屏幕出现房间二维码
   - 客机点「① 客机：加入房间」→ 扫码 → 出现回码
   - 房主点「② 房主：扫对方回码」→ 扫客机的回码 → 自动连上
   - **如果二维码里只有 mDNS 候选**（面板会提示），或扫完连不上：房主点「②b 只拿到 mDNS：授权摄像头后重出码」，
     授权一次摄像头权限后重新出码，这时 Offer 里会带真实内网 IP（`192.168.x.x`），局域网直连更稳，再让客机扫一次
3. 异地：选 **异地文本 SDP 联机** → 房主「创建房间」把 Offer 复制发微信 → 客机粘贴后点「生成 Answer」→ 把 Answer 发回 → 房主粘贴后点「③ 确认 Answer 建立连接」

连接成功后，游戏原本的玩家/物品同步会自动开始（`lan_bridge.js` 收到 `connection` 事件后接管）。

---

## 四、Capacitor / 打包 APK

依赖与 Android 工程**已经生成好了**（`android/` 目录），相机权限也已写入 `AndroidManifest.xml`。
本机目前**没有 Android SDK / Android Studio，只有 JDK 1.8**（Capacitor 8 需要 JDK 17+），所以没有执行构建。

要出 APK，需要先装 Android Studio（自带 JDK 17 + SDK），然后：

```bat
npm run sync                 :: cap sync android（把 web/ 同步进 Android 工程）
npx cap open android         :: 用 Android Studio 打开，Build APK
```

iOS（需要 macOS）：`npx cap add ios` 之后，在 `ios/App/App/Info.plist` 里加：

```xml
<key>NSCameraUsageDescription</key>
<string>用于扫描房间二维码以建立局域网联机</string>
```

Android 已加好的权限（`android/app/src/main/AndroidManifest.xml`）：
`INTERNET`、`ACCESS_NETWORK_STATE`、`CAMERA`，以及 `uses-feature camera required=false`（无摄像头设备也能装，自动退化到模式B）。

**App 内扫码走原生插件** `@capacitor-mlkit/barcode-scanning`（已在依赖里，`npx cap add android` 时已被识别），
不用 WebView 的 `getUserMedia` —— 后者在 Android/iOS WebView 里不可靠
（参考 [html5-qrcode#544](https://github.com/mebjas/html5-qrcode/issues/544)、[capacitor#6759](https://github.com/ionic-team/capacitor/issues/6759)）。
网页端才用 html5-qrcode 兜底。

---

## 五、测试（`npm test`，13 个套件 + 工作流 shell 块，当前全绿）

> 下表**不写死通过数**（每次加断言都要回来改，已经踩过一次）。要具体数字直接跑 `npm test`。

| 套件 | 跑什么 |
|---|---|
| `test/mdz_core.test.js` | SDP 打包/解包（含换行/截断/校验和损坏）、裁剪失败降级、候选分类（mDNS/内网/CGNAT/link-local）、代理对安全切片、分块乱序重组、消息分流、握手串体积实测 |
| `test/mdz_rtc.test.js` | 用 `node-datachannel` 跑**同一份** `mdz_p2p.js`：模式A/模式B 真实握手、双向收发、副通道、60000 字符分块、`bufferSize`、**完全照抄 lan_bridge.js 调用顺序驱动垫片**、漏调 `clientBegin` 的容错、模式切换状态隔离 |
| `test/mdz_handshake.test.js` | 握手状态机：重复回码 / 陈旧回码 / 文本模式完整 SDP |
| `test/mdz_fix_audit.test.js` | 真机故障修复点审计：闩锁、1080p、变焦、权限、扫码投票门槛、构建标记自洽 |
| `test/mdz_ui.test.js` | 两个 jsdom"设备"按 index.html 顺序加载脚本，模拟 lan_bridge 的 `startHost/joinGame`，用 UI 按钮走完文本 SDP 全流程，验证游戏包双向互通；外加**走游戏原面板 HOST/JOIN 入口**也能拉起我们的面板 |
| `test/mdz_selftest.test.js` | **测自测页本身**：把 `mdz_selftest.html` 装进 jsdom、点"运行自测"、读页面上的 PASS/FAIL，确保页面自己跑得通 |
| `test/mdz_page.test.js` | **按 index.html 的真实脚本顺序**做页面集成检查：所有 script 都能加载、`window.Peer` 被垫片接管、构建标记存在且与面板一致、联机面板真的出现在页面上、SW 已被禁用、**可点击性审计（pointer-events 继承）**、收起→再打开、**mDNS 兜底按钮真的会申请摄像头** |
| `test/mdz_scan.test.js` | **App 内扫码三级链路**：WebView 内嵌扫码 → 原生 `startScan`（捆绑模型）→ 才切文本模式；并验证"原生报 GMS 模块缺失时不会再掉进模式B" |
| `test/mdz_chunk_guard.test.js` | **分块重组的资源上限**：信封形状校验、并发组数上限、单组/总量字节上限、超时清扫、同 id 换分块方案视为伪造（防对端撑爆内存） |
| `test/mdz_bars.test.js` | **自定义左右黑边**：接管 `window.innerWidth`、画布定位规则带 `!important`、单边上限与"至少留 240px 画面"的保护、持久化、损坏配置不崩、页面其它视口计算仍走真实宽度 |
| `test/mdz_invariants.test.js` | **工程不变量**：`tools/*.ps1` 必须 UTF-8 with BOM、`sp/scripts/*.ps1` 必须纯 ASCII、`.gitattributes` 覆盖字节敏感路径、调试开关为 false、构建标记同版本、`<script src>` 无 404、已删的 6 个补丁模块不再被引用 |
| `test/tool_mobileprovision.test.js` | 证书体检工具：Bundle ID / 类型 / 有效期 / UDID |
| `test/ios_config.test.js` | iOS 工程配置：部署目标 ≥15.5、权限项、共享 scheme、Podfile 不被 `cap sync` 改坏 |

单独跑：`npm run test:core` / `test:rtc` / `test:ui`；其余直接 `node test/<套件>.test.js`；看握手细节：`set MDZ_VERBOSE=1 && node test/mdz_rtc.test.js`。

> 历史坑（都已修，且都有回归测试守着）：
> 1. `mdz_selftest.html` 曾漏掉 `MDZP2P.clientBegin()` 就直接 `clientAcceptHost()`，浏览器里点"运行自测"会报 `当前没有等待握手的客机会话`。现在 API 层会自动补建客机会话，页面也改成标准顺序。
> 2. 游戏 `sw.js` 会把 `index.html` 缓存住，导致改完代码刷新还是旧页面（没有联机面板）。现在 `index.html` 末尾会自动注销旧 SW 并禁止注册，控制台也会打印构建标记便于分辨。
> 3. **`pointer-events` 是继承属性**：面板容器为了不挡住游戏画布设了 `pointer-events:none`，挂在它下面的"☰ 联机面板"小按钮如果自己不写 `pointer-events:auto`，就会**点不动**（收起后再也打不开）。因为 jsdom 的 `.click()` 不检查 CSS 命中测试，所以专门加了"沿祖先链审计 pointer-events"的检查来守住这类问题。

**尚未验证的部分（必须真机/真浏览器做）**：
1. 两台真实设备之间的 P2P 打洞（本机测试是同机 loopback）
2. 二维码用真实摄像头扫（自测页可以生成真二维码，用手机相机扫一下即可）
3. Capacitor App 内原生扫码插件
4. 异地（跨 NAT）模式B 的成功率 —— 没有 TURN，对称 NAT 下会失败

### 黑边功能：已在真实 Chrome 里端到端验证过

上面这 4 条与黑边无关。黑边功能**不需要真机就能验证到底**，因为它的关键机制
（覆盖 `window.innerWidth` → c2runtime 自己调 `setSize()` → 画布 div 被推到左黑边之后）
只有在真实浏览器里跑起 c2runtime 才看得见。所以有一个可重复执行的工具：

```bash
npm run verify:bars                 # 自带静态服务 + 启动无头 Chrome + 跑完自动清理
npm run verify:bars -- --headful    # 想看画面时用
npm run verify:bars -- --hold 60    # 验证完再多观察 60 秒
npm run verify:bars -- --chrome "C:\path\to\chrome.exe"
```

`tools/verify-bars.js` **零 npm 依赖**（用 Node 22 自带的 `http` 与 `WebSocket` 直连 CDP，
不需要装 playwright / agent-browser 那几百 MB 的浏览器）。
找不到浏览器时它会以退出码 2 跳过，不会误报失败。

实测结果：

| 检查项 | 实测结果 |
|---|---|
| 运行时真的起来了（jsdom 做不到） | ✅ `fullscreen_mode = 1`（crop），与 `data.js` 里读出的值一致 |
| 基线（无黑边） | 画布 div 宽 = `innerWidth`，`margin-left: 0px` |
| 设 左60 / 右40 后 | `innerWidth` 收窄 100；**运行时自己也认了**（`rtWidth`/`lastWindowWidth` 同步）；画布位图跟着变；`margin-left: 60px` |
| 高度是否被改动 | ❌ 没动：`innerHeight` 与 `rtHeight` 都不变 |
| 页面自身布局是否被带偏 | ❌ 没偏：`documentElement.clientWidth` 与 `MDZUI.viewport()` 仍是真实值 |
| 极端值保护 | 9999/9999 → 夹到 400/400 且留 ≥240px，运行时没崩 |
| 重置 | `innerWidth`/`margin-left`/画布宽度全部复原 |
| 持久化 | 重载页面后自动按已保存值收窄 |
| **会不会被运行时抢回去** | ✅ 连续采样 15 秒 / 上千帧，`margin-left` 稳定不变 —— 这条 `!important` 规则是关键，已验证 |
| 有没有引入运行时报错 | 无未捕获异常、无 `console.error` |
| **是否影响加载/性能** | 对照实验：不开黑边 tick 增量 1472，开黑边 1483（差 1%）；两组都从 `Loading` 走到 `Menu` |

结论：**黑边不影响游戏运行**，可以在真机上放心用。真机只需要确认一件事 ——
你机型的挖孔位置对应调多宽合适（这个只能肉眼判断）。

> 截图对比（`.workbuddy-ai/verify/`）：不开黑边时游戏顶到左右两端（左上角的 `MDZ☆START` 按钮、
> 左边缘图标列、顶部 `MDZ v1.2` 正好落在挖孔会盖住的位置）；设 160/160 后这些内容全部内收、画面正常居中。

---

## 六、已知限制 / 后续可做

1. **没有 TURN**：异地联机在对称 NAT 下会打洞失败。要稳定就自建 coturn，然后在 `mdz_p2p.js` 的 `CFG.STUN_TEXT` 旁边加 `turn:` 配置。
2. **单侧扫码依赖摄像头权限**：模式A 房主侧若只有 mDNS 候选且连不上，可让房主也允许一次摄像头权限（面板会申请）拿真实内网 IP。
3. **服务端零依赖**：原来的 `mdz-server/node` 信令服务器**在这套方案里完全不需要**了，可以不启动。
4. `web/peerjs.min.js` 文件仍在目录里，但 `index.html` 已不再加载它。**不要删**：它是原版清单
   （`_original_manifest.csv`）里的文件，删掉就破坏了"游戏本体逐字节未改"这条不变量。
   同理 `web/cordova.js` / `cordova_plugins.js` / `plugins/**` 也保留原样，Capacitor 打包时会自动排除一部分，不影响功能。
5. `capacitor.config.ts` 会触发一条 `MODULE_TYPELESS_PACKAGE_JSON` 警告，属正常现象（加 `"type":"module"` 会破坏 CommonJS 测试脚本，故不加）。
6. **删掉补丁模块带来的已知现象**（本包面向朋友间小范围互玩，这些不打算修）：
   - 客机（非房主）打怪可能不结算伤害（原 `mdz_hitfix` 负责的领域）
   - 跨岛时可能出现世界快照重推，导致客机拿到房主的角色/背包（原 `mdz_island` 负责的领域）
   - 长时间高交互可能发热偏高（原 `mdz_storm` 负责的领域）
   → 规避方式：别在联机时跨岛；客机以探索/协作玩法为主。
7. **安全边界**：二维码 / SDP 就是准入凭证，没有口令，也没有 PvP 开关（原版的"PvP 关闭"是服务端行为，
   零服务器方案下没有代码在保证它）。**只和信得过的人联机**。
   分块重组器已经加了并发组数 / 单组字节 / 总量字节三重上限与超时清扫
   （`mdz_core.js` 的 `CHUNK_LIMITS`），但不要因此把它当成"能随便连陌生人"的东西。

### 黑边功能的边界

- 只做左右，**不做上下**（需求就是避让挖孔/灵动岛，高度不变）。
- 依赖能覆盖 `window.innerWidth`：Chromium / WKWebView 都支持；万一某个内核不允许，
  功能会整体失效并写日志（不影响游戏与联机），面板上的设置区会被隐藏。
- 只对**联机版 App**（`web/` + `android/` + `ios/`）生效。`sp/` 单机版是另一套 web 与入口，
  没有 `mdz_ui.js`，目前不含这个功能。

---

## 七、已完成：Android APK 构建（2026-09-10）

### 产物

| 项 | 值 |
|---|---|
| APK | `dist/Minidayz-WebRTC-debug.apk`（同时保留在 `android/app/build/outputs/apk/debug/app-debug.apk`） |
| 大小 | **50.0 MB**（52,440,621 字节） |
| SHA256 | `E05AD5A048E39FBE15BD8F1B8A798674E33661CE23B006A986CB4D6D51CCC196` |
| 构建标记 | `mdz-webrtc-web-7-lite` / `mdz-ui-7-lite`（含自定义左右黑边 + 分块资源上限） |
| 包名 / 标签 | `com.mdz.webrtcmp` / 「Mini DAYZ 联机版」 |
| minSdk / targetSdk | 24 / 36（compileSdk 36） |
| 屏幕方向 | `android:screenOrientation="sensorLandscape"`（横屏锁定）+ 主题 `windowFullscreen` + `viewport-fit=cover` |
| 插件 | barcode-scanning 8.2.1 / camera 8.2.4 / status-bar 8.0.3 |
| WebView 调试 | **已关闭**（`webContentsDebuggingEnabled: false`，`test/mdz_invariants.test.js` 守着） |
| 签名 | Android Debug 证书（可正常安装，不能上架） |
| 构建耗时 | 首次 12m17s；本次增量 6m37s（187 tasks，含 3 个 Capacitor 插件子工程） |

> 本次构建环境：worktree 内 `npm ci` → `npx cap sync android` → 直接用工具链跑 `./gradlew assembleDebug`
> （JDK 21 + Android SDK 36 在 `D:\game_hack\minidayz\tools`）。
> 注：`tools/build-apk.ps1` 内部依赖 `cmd /c`，在受限的 PowerShell 会话里可能跑不起来，
> 直接用 gradlew 更省事（见本节末尾的等价命令）。

### App 内扫码的三级链路（真机 bug 修复）

真机上点「客机：加入房间」时曾直接掉进模式B，日志显示：

```
原生扫码失败/被拒绝：The Google Barcode Scanner Module is not available.
You must install it first using the installGoogleBarcodeScannerModule method.
```

原因：`@capacitor-mlkit/barcode-scanning` 提供**两套**接口 ——

| 接口 | 底层 | 是否需要 Google Play 服务 |
|---|---|---|
| `scan()` | Google Code Scanner (`play-services-code-scanner`) | **需要**，首次要下载模块；国内无 GMS 的手机必然失败 |
| `startScan()` + `barcodesScanned` | 捆绑 MLKit 模型 (`com.google.mlkit:barcode-scanning`) + CameraX | **不需要**，完全离线 |

我当时用的是 `scan()`，所以踩坑。现在的链路是：

1. **WebView 内嵌扫码**（html5-qrcode，优先使用平台的 BarcodeDetector）—— 离线、无 GMS 依赖、预览就在面板里（Capacitor 的 `BridgeWebChromeClient.onPermissionRequest` 会为 `VIDEO_CAPTURE` 申请并授予 CAMERA 权限，所以 WebView 摄像头可用）
2. **原生 `startScan()`**（捆绑模型）—— WebView 方案失败时启用；原生预览画在 WebView 后面，所以会临时把游戏画面/面板隐藏、背景设为透明
3. **文本模式** —— 前两条都失败才切，并且**把失败原因留在状态行上**（之前 `switchMode` 会把原因覆盖掉，用户看不到为什么掉进模式B）

> 历史坑 #4：`scan()` 需要 GMS 模块、`startScan()` 不需要；不要再改回 `scan()`。
> 历史坑 #5：切换模式会重写状态行，自动降级时必须**在 switchMode 之后**再写一次原因。

### 真机"二维码放框里完全没反应"的排查与修复

症状是**既不快也不慢、一帧都不回调**，这排除了"二维码太密识别慢"，指向回调压根没被调用。两个已知成因都已修：

1. **`useBarCodeDetectorIfSupported` 静默失败**：安卓 WebView 里 `window.BarcodeDetector` 存在，但底层 MLKit 模块缺失时 `detect()` 永远不返回结果，html5-qrcode 会**一帧都不回调**。
   → 现在该开关**默认关闭**（`state.useBarcodeDetector = false`），走 ZXing；要试可手动打开。
2. **选到了前置摄像头**：约束只写软性 `facingMode:'environment'` 时，部分安卓 WebView 会选前摄——用户对着屏幕永远扫不到。
   → 现在先 `enumerateDevices()` 按标签挑 `back/rear/后置`，再依次降级
   `deviceId(exact)` → `facingMode(exact environment)` → `facingMode(environment)` → 任意摄像头，并把**选中的摄像头标签和取景分辨率打进日志**。

配套改进：

- **App 内改为优先原生 `startScan`**（MLKit 捆绑模型对密集二维码识别率远高于 ZXing），WebView 作为备选；顺序可用「换个扫码方式」按钮手动对调。
- **8 秒看门狗**：未识别时给出可操作提示，并区分两种情形 ——
  `摄像头没有输出画面（可能选到了前置摄像头或被占用）` vs `已分析 N 帧仍未识别（让二维码更大更清晰）`。
  这直接区分了"没画面"和"解码不出来"，是上次无法判断的关键信息。
- **二维码画大**：显示房间二维码时面板临时加宽，画布按窗口宽度取 `280–600px`（原来固定 300px），
  取景框从 78% 提到 85%。密集 QR 的模块像素越大越好扫。
- 每 60 帧打一条 `已分析 N 帧仍未识别` 日志，方便远程定位。

### 二维码显示方式（小屏适配）+ 面板可拖动

- **二维码改成全屏居中浮层**（不再塞进侧边面板）。原因：横屏手机的面板只有 `~92vh ≈ 400px` 高，
  塞进面板里的二维码会被裁掉，对端摄像头看到的是半个码（用户报过"二维码太大超出屏幕"）。
  现在浮层尺寸按 `min(视口宽, 视口高)` 算；**屏幕高度 < 620px 时进入极简模式**：
  标题/提示/说明全部隐藏，只留右上角一个「收起」按钮，把整屏高度让给二维码。
  实测 800×400 的横屏手机上二维码可显示到约 374px（89 个模块 → 每格约 4.2px）。
- **纠错等级 M → L**：同样内容模块数 101×101 → **89×89**（用真实 qrcode 库实测），每格像素更大，小屏更友好。
- **候选瘦身** `Core.trimCandidates(sdp, 2)`：同一台机器的多个 host 候选是等价备选，每行却要占约 110 字符，
  模式A 每类只留优先级最高的 2 个（模式B 留 3 个），实测手串 629 → 603 字符。瘦身后若候选为空则自动回退。
- **联机面板可拖动/悬浮**：拖标题栏或收起后的「☰ 联机面板」小按钮即可移动，位置存 `localStorage`，
  下次打开还在原处；底部「重置面板位置」一键回到右上角。这样面板挡住游戏角落按钮（例如取消键）时能拖开。
  拖动超过 6px 才算拖动，未拖动仍然是普通点击；拖动结束后会屏蔽一次 click，避免误触发展开/收起。

### 电脑（网页端）扫不上手机屏幕上的二维码

日志能看出关键区别：`已分析 720 帧，仍未识别到二维码` = **摄像头有画面、解码器在跑，但解不出来**。
电脑上失败的原因有三个，都已处理：

1. **分辨率太低**：html5-qrcode 默认拿到的 stream 可能只有 640×480，89×89 的二维码摊到上面每格不到 2px，
   ZXing-JS 必然失败。现在约束里明确要求 `width/height: {ideal: 1920×1080}`，并会打印实际
   `取景分辨率：1920x1080`（低于 640 宽会直接提示改用文本）。
2. **`qrbox` 把画面裁掉了**：之前设了 `qrbox`，只扫中间一块；二维码稍偏一点就永远扫不到。现在**不设 qrbox**，全画面扫描。
3. **Windows 版 Chrome 没有 `BarcodeDetector`**（只有 Android/ChromeOS/macOS 有），只能退回 ZXing-JS，对密集码偏弱。
   现在桌面浏览器**能用 BarcodeDetector 就自动启用**（App 的 WebView 里仍强制关闭，因为那里它会静默失败）。
   html5-qrcode 加载不上时另有按需加载与降级。

**兜底（最可靠，已内置）**：握手串本来就是一段文本，二维码只是载体，**两种模式都显示文本握手区**，
二维码浮层里也加了「复制握手串（对方扫不上时用文本）」按钮。所以电脑和手机联机的推荐流程是：

- 电脑当房主出大二维码 → **手机扫码**（这条稳）→ 手机生成 Answer 后点「复制握手串」→ 用微信/QQ 发回电脑 →
  电脑粘到 Answer 框点「③ 确认 Answer 建立连接」。**只需传一次文本**。
- 或者两边都用文本模式：电脑复制 Offer → 发手机 → 手机生成 Answer → 发回电脑 → 完成。

### 本机装的工具链（解压式，不污染系统）

```
<workspace>\tools\jdk21\            Temurin JDK 21.0.12.1（Capacitor 8 要求 Java 21）
<workspace>\tools\android-sdk\      cmdline-tools + platform-tools + platforms;android-36 + build-tools;36.0.0
<workspace>\tools\env.ps1           环境变量脚本（build-apk.ps1 会 dot-source）
```

两个脚本（都在 `Minidayz-WebRTC\tools\`，**必须保持 UTF-8 with BOM**，否则 PowerShell 5.1 会按 ANSI 读、中文乱码）：

```powershell
powershell -File tools\setup-android-toolchain.ps1   # 一次性：下载并安装 JDK21 + Android SDK
powershell -File tools\build-apk.ps1                 # 每次改完代码：cap sync + 构建 + 校验产物
powershell -File tools\build-apk.ps1 -Variant Release # 出 release（未签名，需自己配 keystore）
```

**工具链不在项目目录里时的等价命令**（本次构建就是这么跑的）：
`build-apk.ps1` 会去 `<项目上级>\tools\env.ps1` 找 JDK/SDK；如果工具链在别处，
要么加 `-ToolchainRoot <含 env.ps1 的目录>`，要么绕开脚本直接跑 gradlew
（注意：脚本内部用 `cmd /c` 包原生命令，某些受限的 PowerShell 会话里没有 `cmd`，这时只能走下面这条路）：

```bash
cd android
export JAVA_HOME="<工具链>/jdk21/jdk-21.0.12.1+1"
export ANDROID_HOME="<工具链>/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"
"$JAVA_HOME/bin/java" -version          # 确认是 21
./gradlew assembleDebug --no-daemon --console=plain
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

前置（只需在改完 `web/` 之后跑一次）：`npm ci` → `npx cap sync android`。

### 产物校验结果（脚本自动做）

- `uses-permission`: INTERNET / ACCESS_NETWORK_STATE / **CAMERA**
- `uses-feature-not-required: android.hardware.camera` → 没有摄像头的设备也能装（会自动退化到模式B）
- APK 内 `assets/public/`：**1940 个文件 / 29.0 MB**，`media/` 489 个、`images/` 1368 个
- `assets/public/index.html` 内含构建标记（形如 `mdz-webrtc-web-7-lite`，以 `web/index.html` 的 `MDZ_BUILD` 为准）→ 确认打进去的是新代码，不是被缓存的旧页面
- `mdz_core.js` / `mdz_p2p.js` / `mdz_ui.js` / `lan_bridge.js` / `vendor/*` 全部在包内

> **一个容易误判的坑**：用 .NET `ZipFile` 或 `tar` 对比文件名时，会发现 51 个西里尔名字（`перс1.png`、`город.png`…）
> 显示成乱码（`胁械褉褏1.png`）并据此报"缺失"。实际是 zip 条目没设 UTF-8 标志、.NET 按系统 ANSI(GBK) 解码名字所致，
> **存储的字节就是 UTF-8**——已用字节级搜索确认：APK 内存在 `D0 BF D0 B5 D1 80 D1 81 31 2E 70 6E 67`（"перс1"）且紧跟 `89 50 4E 47`（PNG 头）。
> 真正没进包的只有 `cordova.js` / `cordova_plugins.js` / `plugins/**`（Cordova 遗留文件，Capacitor 有意排除，
> `index.html` 也没有引用），不影响游戏与联机。

### 装到手机上

```bat
:: 方式1：adb（手机开 USB 调试）
adb install -r "D:\game_hack\minidayz\Minidayz-WebRTC\dist\Minidayz-WebRTC-debug.apk"

:: 方式2：把 APK 拷到手机（微信/QQ/数据线），点击安装
::   首次运行会请求相机权限 —— 扫码联机需要它
```

### 在手机上联机测试

1. 两台手机都装这个 APK（或用「一台手机 + 一台电脑浏览器」）
2. 同一 Wi-Fi（或一台开热点）
3. A 机：右上角面板 → 「① 房主：创建房间」→ 出现房间二维码
4. B 机：右上角面板 → 「① 客机：加入房间」→ 用原生扫码扫 A 的二维码 → 出现回码
5. A 机：「② 房主：扫对方回码」→ 扫 B 的回码 → 双方状态变「已连接」，游戏同步开始
6. 若连不上：先看面板提示，若是 mDNS 提示就点「②b 授权摄像头后重出码」，让 B 重扫一次

异地联机用「异地文本 SDP」模式（复制粘贴文本，微信/QQ 发送）。

---

## 八、iOS / IPA

**`.ipa` 只能在 macOS + Xcode 上编译签名**（Apple 工具链只有 macOS 版），Windows 上无法产出二进制。
所以**在 Windows 上"重新生成 IPA"这件事本身不成立** —— 能做的只有：把代码准备好 → 推到 GitHub → 让 Actions 的
macOS 机器产出未签名 IPA → 回 Windows 用 Sideloadly 签名安装。完整步骤见 **`tools/build-ios.md`**：

| 项 | 位置 | 说明 |
|---|---|---|
| iOS 工程 | `ios/App/App.xcodeproj` | 用 **CocoaPods** 生成（扫码插件只有 podspec，SPM 会跳过它） |
| 依赖清单 | `ios/App/Podfile` | 含 Capacitor / MlkitBarcodeScanning / Camera / StatusBar，**`platform :ios, '15.5'`**（不能是 15.0，见下） |
| 权限与显示 | `ios/App/App/Info.plist` | 相机、**本地网络**、Bonjour、横屏锁定、全屏 |
| 云构建 | `.github/workflows/ios-unsigned-ipa.yml` | GitHub 的 macOS 机器产出未签名 IPA（`workflow_dispatch` 手动触发） |

**iOS 侧不需要为本次改动做任何额外配置**：黑边功能与分块上限都在 `web/mdz_ui.js` / `web/mdz_core.js` 里，
与 Android 共用同一份代码；工作流会在 CI 里自己跑 `npm ci` + `cap sync ios` 把最新的 `web/` 拷进工程。
只要 `web/` 里是新的构建标记（`mdz-webrtc-web-7-lite` / `mdz-ui-7-lite`），产出的 IPA 就带上了这些改动。

> iOS 上 `window.innerWidth` 的覆盖同样有效（WKWebView 支持在实例上定义同名属性遮蔽原型上的 getter），
> 所以黑边在 iPhone 上一样能用；挖孔/灵动岛被遮时把对应一侧调宽即可。

三条路线：

```bat
:: 有 Mac
npm run sync:ios      :: cap sync ios（顺带 pod install）
npm run open:ios      :: 打开 Xcode，选真机 Run
:: 出 IPA：xcodebuild archive + -exportArchive（详见 tools/build-ios.md）
```

- **没有 Mac**：推到 GitHub → Actions 跑 `Build iOS IPA (unsigned)`（10~20 分钟）→ 下载未签名 IPA →
  在 **Windows** 上用 [Sideloadly](https://sideloadly.io/) + 自己的 Apple ID 签名安装
  （免费账号 7 天有效、最多 3 个 App；付费账号 1 年）
- **要上架 / TestFlight**：Codemagic、Ionic Appflow 等云构建，配 Apple 开发者账号后可自动签名

iOS 上与安卓不同的坑（已处理，务必注意）：

1. **`NSLocalNetworkUsageDescription` 必须有** —— iOS 14+ 做局域网直连会弹「允许访问本地网络」，
   没这个键连弹框都不会出现，WebRTC 直接连不上。
2. 必须在**真机**上测：模拟器没有摄像头，扫码测不了，WebRTC 也不可靠。
3. 免费 Apple ID 的 Bundle ID 必须全局唯一，`com.mdz.webtcmp` 可能被占用，改一个自己的。
4. iOS 侧的扫码同样走**原生 MLKit `startScan`**（CocoaPods 集成），逻辑与安卓共用一套 `mdz_ui.js`。

### 历史坑 #6：iOS 部署目标必须是 15.5，不能是 Capacitor 默认的 15.0

CI 上 `cap sync ios` 那一步 **2 秒就红**、而且日志里**没有任何 pod 下载记录**，原因就在这里：

- 扫码插件 `CapacitorMlkitBarcodeScanning.podspec` 依赖 `GoogleMLKit/BarcodeScanning ~> 8.0.0`
- 而 CocoaPods Specs 里 **整条 MLKit 链都写着 `platform :ios, '15.5'`**
  （实测查过：GoogleMLKit 8.0.0/9.0.0、MLKitBarcodeScanning 6.0.0/7.0.0、MLKitCommon 12.0.0/13.0.0 全是 15.5）
- Capacitor 模板给的 Podfile 是 `platform :ios, '15.0'` → CocoaPods 在**解析阶段**就找不到可用版本 →
  `pod install` 立刻失败（连下载都没开始，所以只要 2 秒）

修法（已改）：

| 文件 | 改成 |
|---|---|
| `ios/App/Podfile` | `platform :ios, '15.5'`（**必须放文件第一行**，见下面警告） |
| `ios/App/App.xcodeproj/project.pbxproj` | `IPHONEOS_DEPLOYMENT_TARGET = 15.5;`（4 处） |

> ⚠️ **纠正一个曾经写错、并因此连红三次 CI 的结论**：
> `cap sync` / `cap update` **会**重写 Podfile。Capacitor CLI 的 `updatePodfile()` 用正则
> `/(def capacitor_pods)[\s\S]+?(\nend)/` 定位要重写的代码块 —— 起点就是那串触发字符本身。
> 当时这份 Podfile 的注释里恰好写了"CLI 只定点替换 `def capacitor_pods` 块和 require_relative"，
> 匹配起点于是前移到注释处，把注释后半句、`platform :ios,'15.5'`、`use_frameworks!`、`install!`
> 和真正的定义行**一起删掉**；`target 'App'` 里调用的 `capacitor_pods` 就成了未定义方法：
>
> ```
> [!] Invalid `Podfile` file: undefined method `capacitor_pods'
> ```
>
> 它 1 秒内失败、且没有任何 pod 下载日志，所以表面上还是"2 秒红"，极难定位。
> 现在：platform 行放在文件第一行（正则永远吃不到它）+ 注释里不写那串字符 +
> `tools/check-podfile.js` 静态体检并用 CLI 真实正则"重放"一遍 +
> `test/ios_config.test.js` 第 4 节回归测试（含"埋雷必须被检出"的反向自检）。
> 工作流里 `cap sync/update` 之后也各加了一步「校验 Podfile 没被改坏」。
>
> `test/ios_config.test.js` 另外守住：Podfile 平台 ≥ 15.5、pbxproj 四处目标一致且与 Podfile 相同、
> 并会根据扫码插件的 `GoogleMLKit` 依赖主版本反推最低系统要求做交叉校验。

---

### 历史坑 #7：MLKit 8.x 要求 **Xcode ≥ 16**，而 `macos-14` 默认只有 15.4

Podfile 修好之后，CI 的失败点从第 10 步推进到了第 14 步 `xcodebuild archive`（23 秒失败），
根因是官方镜像的默认工具链太旧：

- 扫码插件依赖 `GoogleMLKit/BarcodeScanning ~> 8.0.0`；ML Kit 官方发布说明 2025-03-25 那一版
  （GoogleMLKit **8.0.0** / MLKitBarcodeScanning 7.0.0 / MLKitCommon 13.0.0）明确写着：
  > **On iOS, raised the minimum supported version of Xcode to 16.0.0.**
- GitHub 的 `macos-14` 镜像**默认 Xcode 是 15.4**（16.1 / 16.2 装在镜像里，但没被 `xcode-select` 选中）
- 于是 `pod install` 一切正常（只下载预编译 xcframework），**一到编译期就失败** ——
  因为 MLKit 8 的二进制是用 Xcode 16 的 Swift 编译的，报错往往很隐晦

修法（已改，两个工作流都加了）：

```yaml
- name: 选择 Xcode（MLKit 8.x 要求 >= 16）
  run: |
    LATEST=$(ls -d /Applications/Xcode*.app | sort -V | tail -n 1)
    sudo xcode-select -s "$LATEST/Contents/Developer"
    XV=$(xcodebuild -version | head -n 1 | awk '{print $2}')
    [ "${XV%%.*}" -lt 16 ] && { echo "::error::Xcode $XV 太旧"; exit 1; }
```

> 另外：CI 的作业日志接口需要写权限（匿名读是 403），排查时改从 **check-run annotations**
> 入手（公开仓库可匿名读）。所以 Archive 步骤会把 `error:` 开头的行用 `::error::` 抛出来，
> 这样即使拿不到日志也能看到报错原文。

---

### 历史坑 #8：iOS 扫不上码 / `Called in wrong state: stable` / 异地一直卡在"等待直连"

2026-09-10 真机复现（iOS 房主 + 安卓客机）：

| 现象 | 真因 | 修法 |
|---|---|---|
| **安卓能扫、iOS 回扫怎么都扫不上，偶尔突然又扫上了** | 原生扫码插件要求**同一个码被连续识别满 10 帧**才回调（iOS `BarcodeScanner.swift` 与安卓 `BarcodeScanner.java` 都是 `votes >= 10`）。iOS 的 `startScan` 默认只有 **1280x720**，89x89 模块的密集码在整幅画面里每模块仅 ~2px，MLKit 只能**间歇**识别 → 投票涨得极慢 | ① `startScan` 传 `resolution: 2`（1080p）② iOS 再补数字变焦 1.8x，8 秒没扫上自动推到 3x ③ `tools/patch-mlkit-votes.js` 把投票门槛 10 → **3**（已挂 `postinstall`，npm ci 后自动生效；误读由握手串自带的 FNV 校验兜住） |
| 安卓日志：`Failed to set remote answer sdp: Called in wrong state: stable`，客机一直进不去 | 原生扫码回调**连发多次**（事件到达 JS 的顺序不保证），同一张回码被应用两次；第二次 `setRemoteDescription(answer)` 时 PC 已是 `stable`，必然抛错 —— 而第一次其实已经成功了 | ① UI 侧 `scanHandled` 单次闩锁 ② 传输层 `acceptAnswer` 幂等（`_remoteAnswerApplied`）：重复回码静默忽略；真正过期（房间重建过）才报可操作的错 ③ 通道已开时直接忽略回码 |
| 出码后对方解析不了地址 / 一直"等待直连" | 房主的 Offer 是**在授权摄像头之前**生成的，浏览器/WebView 此时会做 mDNS 混淆，候选全是 `xxxx.local`，对方根本解析不了 | 模式A 点「创建房间」时**先申请摄像头权限**（`unobfuscated: true`），拿到真实内网 IP 再出码 |
| 异地文本模式双方握手串都贴好了还是连不上 | 文本模式**本来没有长度限制，却仍在裁剪 SDP + 把候选瘦身到 3 个/类**，等于白丢"唯一能打通的那条" | 文本模式原样打包完整 SDP；STUN 列表补 Google/Cloudflare；没有 srflx 候选时直接在状态栏说清"异地必失败" |
| 扫描时看不到取景画面 | 扫描时没收起自己的**全屏二维码浮层**（`rgba(6,8,10,.96)`），而 iOS/安卓的原生预览都插在 WebView **下面** | 开扫前 `hideQr()`；`enterNativeScanVisual` 改成把所有 HTML 都藏掉（`body *:not(#mdz-scan-tip)`）+ 画取景框；网页扫码改用**全屏浮层**取景（不再用面板里 180px 的小窗） |

连带新增：`diagnose()` 一句话诊断（握手后 20 秒没连上就直接打在面板上）、
`test/mdz_handshake.test.js`（26 项，用行为一致的假 RTCPeerConnection）与
`test/mdz_fix_audit.test.js`（25 项，逐条钉住上面的修法）。
构建号当时升到 `mdz-webrtc-web-2` / `mdz-ui-2`（历史值）—— 手机上打开面板要能看到当前构建号，否则装的是旧包。
当前构建号以 `web/index.html` 的 `MDZ_BUILD` 与 `web/mdz_ui.js` 的 `BUILD` 为准，两处必须同版本
（`test/mdz_invariants.test.js` 会守住这条，`test/mdz_page.test.js` 还会检查面板标题上真的显示了它）。

> ⚠️ 这些修复都在 **web 资源**里，而 Capacitor 是把 web 资源打进安装包的：
> 改完必须**重新构建 + 重装**（安卓 `tools/build-apk.ps1`，iOS 跑 CI 再重签），
> 光刷新页面或重启 App 是拿不到新代码的。

### 历史坑 #9：跨岛**不能**用"重推整张世界快照"来同步（会把房主的角色/背包带给客机）

**我踩的坑（务必别再犯）**：第一版跨岛同步是"房主换岛 → `MPJoin.sendSnapshot()` 重推世界 → 客机加载"。
真机结果：**客机拿到了房主的装备，而且卸不下来**。

原因（读 `c2runtime.js` 确认）：

```js
Runtime.prototype.saveToJSONString = function () {
  …
  typeobj["instances"].push(this.saveInstanceToJSON(type.instances[j]));   // 含 ivs：实例变量
  o["types"][type.sid] = typeobj;
  for (…) layout = this.layouts_by_index[i]; o["layouts"][layout.sid] = layout.saveToJSON();
```

C2 的存档 = **运行布局里所有实例 + 每个实例的实例变量** —— 两个玩家的角色、背包都是同一张
`Map` 布局里的实例，所以"重推世界"就等于把房主那一局的所有东西塞给客机。
MOD 本来有保护（载入前存"你自己的角色检查点"、载入后恢复），但协调器在指纹一直对不上时
会**重推最多 4 次**：第 2 次抓到的检查点已经是"上一次载入后"的状态，于是恢复出来的就是房主的角色。
而"卸不下来"是**归属**问题：那批物品在房主的授权账本里不属于客机，
任何移除都被判未授权（`inventory_replacement_not_authorized` / `remoteOwnsItem`）→ 回滚。

**曾经的做法（路线1，已随 `mdz_island.js` 一并删除）**：那个模块只做**检测**（两端比对 `MDZ.fingerprint()` 的 `mapHash`），
一旦判定跨岛就 **广播再见 + 断开联机 + 明确提示重连**：

> 跨岛了：联机已断开。请和房主到同一个岛后重新连接 —— 房主点「①创建房间」，客机点「①加入房间」

⚠️ **本快照已经没有这层保护了**（6 个补丁模块按需求删除）。所以在当前版本里跨岛
就是历史坑 #9 描述的现象本身：**客机可能拿到房主的角色/背包且卸不下来**。
规避方式只有一个 —— 联机时别跨岛；真要跨岛就断开重连，并接受存档被污染的风险。
下面这条设计结论仍然成立，留给以后想真正解决它的人：

重新加入走的是**正规加入流程**，客机自己的角色/装备会被正确恢复（这是加入流程本来就设计好的）。

> 想做到"无缝跟岛"（不重连）只有一条正路：让客机**本地**用同一个种子重新生成世界
> （`MDZ.setSeed` + 各岛确定性种子），完全不传世界快照。前提是先攻下"如何触发本地换岛" ——
> 现在已确认 `generate_array_locations` 等生成入口**不在任何具名函数里**（data.js 的 24 个具名函数都不是），
> 所以要么找到木筏交互的触发点，要么伪造 `CurrentLevel` 全局变量 + 重放生成流程。

---

### 历史坑 #10：客机打不到怪，但怪能打到客机（伤害权威不对称）

机制（`mp_entities.js`）：客机本地判定"子弹×僵尸"相交后，发 `mp_entity_hit` **请房主裁决**；
房主 `_x6f` 有 8 道校验，任一不过就 `hitsRejected++`、不扣血也不回包：

| 校验 | 阈值 |
|---|---|
| 弹种白名单 | 29 种（`t243 t244 t466 t940 …t881`），不在表里直接拒 |
| 实体状态 | 必须存在、活着、`phase !== 'dead'`、有血量变量 |
| 同一颗子弹 | 1 秒内不能重复命中 |
| 频率 | 1 秒最多 60 次命中 |
| 命中点位置 | 必须在**房主侧僵尸位置 120px 内** |
| 客机位置 | `player_state` **超过 3000ms** 没到房主 → **全拒** |
| 距离 | 僵尸必须在**房主所知的客机位置 2000px 内** |

而"怪打客机"走另一条路：房主算好直接下发 `{type:'damage', source:'zombie'}`，**没有任何客户端校验**
→ 所以永远生效。这就是那个不对称的根源（近战更彻底：近战不产生子弹实例，连 `mp_entity_hit` 都发不出去）。

**现在的做法**（已随 `mdz_hitfix.js` 删除）：那个模块是外挂式的，不改 `mp_*.js`：

1. 缓存房主同步过来的实体权威坐标（`mp_entity_add/state/death/reconcile` 都带 x/y）；
2. 客机发 `mp_entity_hit` 时把 x/y **校正成房主侧坐标** → 120px 校验必然通过；
3. 房主收到命中时，若它记的客机位置已过期，就用我们缓存的最近位置喂一次
   `MPEntities.observe({type:'player_state',…})` → 绕开 3000ms 全拒；
4. **逐条打印判定结果**（`✅ 已结算` / `❌ 被房主拒绝` / `房主宣布死亡…` / `你被僵尸打了…`），
   下次复现点「复制日志」就能一眼看出是哪一条挂了。

⚠️ **本快照没有这层修复**。表现为：**客机（非房主）打怪可能不结算伤害**（近战更彻底）。
规避方式：客机以探索/协作玩法为主，或让房主来打。
面板上的「复制日志」仍然可用 —— 排查时把完整日志发出来就能看出是哪一条校验挂了。

---

## 九、原版未被改动的证明

清单 `_original_manifest.csv` 是**相对路径 + SHA256**，所以可以直接拿来校验 `web/` 副本
（不需要原版目录；早期文档里的脚本指向本机的原版路径，别人跑不了）：

```bash
# 在项目根目录执行：逐个比对 web/ 与清单
# 清单里的子目录用反斜杠（plugins\xxx\yyy.js），所以统一换成 / 再拼路径，跨平台都能跑
python - <<'PY'
import csv, hashlib, os
man = {r['rel']: r['Hash'] for r in csv.DictReader(open('_original_manifest.csv', encoding='utf-8-sig'))}
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest().upper()
diff = []
for rel, want in man.items():
    p = os.path.join('web', rel.replace('\\', '/'))
    if not os.path.exists(p) or sha(p) != want:
        diff.append(rel)
print('清单条目', len(man), '| 不一致', len(diff))
for r in diff: print('  差异:', r)
PY
```

**当前实测结果：清单 1964 项里 1963 项与 `web/` 完全一致，唯一差异是 `index.html`**（有意修改：
去掉 `peerjs.min.js`、加入 `mdz_*` 与新脚本）。也就是说「游戏本体逐字节未改」这条承诺是成立的、可机器验证的。

> 注意：清单用**反斜杠**做子目录分隔（`plugins\xxx\yyy.js`），在 Linux/macOS 上比对时要把 `\` 换成 `/`。
> 另外这条校验目前是**手动**跑的。要把它变成 CI 不变量，就在 `test/` 下加一个套件读清单比对
> `web/`（排除 `index.html`、`mdz_*.js`、`vendor/`、`mdz_selftest.html` 这些新增/改动文件）。
> 有了它，"这是 MOD 的 bug 还是资源被改了"这类扯皮可以直接排除。
