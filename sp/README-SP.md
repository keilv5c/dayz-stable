# Mini DAYZ 单机版 —— iOS / IPA 构建说明（SP）

> 这一套是**单机版**：游戏本体是已汉化、且已删除 `MDZ☆START` 入口的 **Mini DAYZ 2.2.6**。
> 联机版是另一套（`web/` + `ios/` + `ios-unsigned-ipa.yml`），两边互不影响。

---

## 一、这个文件夹里有什么

```
sp/
├─ web/                      ← 游戏本体（已汉化 + 无 MDZ☆START），**提交进仓库**
├─ ios/App/                  ← iOS 原生工程（Xcode 工程 + Info.plist + 极简 Podfile）
├─ scripts/
│  ├─ sync-game.ps1          ← 把仓库外的 2.2.6 同步进 sp/web
│  ├─ prepare.ps1            ← 生成完整构建树（public/ + node_modules + config）
│  ├─ transform-web.js       ← 停用 Service Worker、启动弹窗中文化
│  └─ verify-sp.js           ← 静态验收（不需要 Mac 就能查出大部分问题）
└─ README-SP.md              ← 本文件
```

对应的工作流：**`.github/workflows/ios-sp-ipa.yml`**（产出未签名 IPA）

---

## 二、先接受一个事实：IPA 只能在 macOS 上编译

Apple 的编译链、iOS SDK、`codesign` 都只有 macOS 版，**Windows 上产不出 IPA 二进制**。
所以路线是：

> **GitHub 的 macOS 机器负责编译出「未签名 IPA」→ 你在 Windows 用 Sideloadly + 自己的 Apple ID 签名安装。**

Windows 侧装包步骤（含常见报错）见 [`../tools/sideload-windows.md`](../tools/sideload-windows.md)。

---

## 三、出包步骤

### 1. 改了游戏的话，先同步进仓库

游戏本体原目录在**仓库外面**（`../Minidayz-2.2.6-main/Minidayz-2.2.6-main`），
而 GitHub Actions 只能看到仓库内容 —— 所以必须把游戏资源同步进 `sp/web/` 并提交。

```powershell
cd D:\game_hack\minidayz\Minidayz-WebRTC
npm run sp:sync          # 等价于 powershell -File sp/scripts/sync-game.ps1
```

它会顺手校验：`data.js` 里没有 `☆`（MDZ START 删干净了）、`l_eng_ui.xml` 有足量中文。
不通过就直接报错，避免把没改好的游戏打进去。

### 2. 本地先做静态验收（强烈建议）

```powershell
npm run sp:prepare       # 生成构建树
node sp\scripts\verify-sp.js
```

`verify-sp.js` 会把能提前发现的坑都查一遍：
资源是否齐、有没有混进联机脚本、SW 是否停用、`capacitor.config.json` 有没有 BOM、
`Info.plist` 是否良构且权限项正确、Podfile 引用的本地路径是否真实存在、汉化是否到位。
（这一步真抓到过问题：`Set-Content -Encoding UTF8` 给配置文件加了 BOM，Capacitor 会解析失败。）

### 3. 提交并推送

```powershell
git add sp .github/workflows/ios-sp-ipa.yml package.json .gitignore
git commit -m "单机版 iOS 构建线：汉化 2.2.6 + 无 MDZ START"
git push
```

### 4. 在 GitHub 上跑工作流

仓库页面 → **Actions** → **Build iOS IPA (SP single-player)** → **Run workflow**

> **免费 Apple ID 请务必在 `bundle_id` 输入框里填一个你独有的 ID**（例如 `com.yourname.mdzsp`），
> 默认的 `com.mdz.minidayz.sp` 可能已被占用，免费账号不能用别人的 Bundle ID。

等 10~20 分钟，从该次运行的 **Artifacts** 下载 `minidayz-sp-unsigned-ipa`。

### 5. 用 Sideloadly 装到 iPhone

连上手机 → 把 ipa 拖进去 → 填 Apple ID → Start → 手机「设置 → 通用 → VPN 与设备管理」信任证书
（iOS 16+ 还要开「设置 → 隐私与安全性 → 开发者模式」）。

---

## 四、为什么单机版比联机版好构建

| | 联机版 | 单机版（这一套） |
|---|---|---|
| Pod | 扫码插件 + ML 套件 + 相机 + 状态栏 | **只有 Capacitor 本体** |
| pod install | 要下几百 MB、几分钟 | 几秒 |
| Xcode 要求 | **必须 ≥ 16**（ML 套件 8.x 的硬要求） | 无特殊要求 |
| 资源准备 | `npx cap copy/update` | 纯文件复制 + 手写 Podfile |
| 权限 | 相机 + 本地网络 + Bonjour | **一个都不需要** |

关键取舍：**不用 Capacitor CLI**。因为 CLI 会按 `package.json` 里的插件列表重写 Podfile，
把扫码插件（连带 ML 套件）加回来。单机版没这些需求，所以 Podfile 手写死、只留 Capacitor 本体。

---

## 五、踩过的坑（都已在代码里规避）

1. **`.ps1` 必须纯 ASCII**
   Windows PowerShell 5.1 读「无 BOM 的 UTF-8」文件时按 **ANSI 代码页**解码，
   脚本里的中文会变乱码、直接导致语法错误（`Missing closing '}'`）。
   所以 `sp/scripts/*.ps1` 里没有中文，中文说明只放在本文件里。

2. **`$PSScriptRoot` 在 param 默认值里可能是空的**
   PS 5.1 求值默认值的时机很早。已改成在脚本体内解析路径（并回退到 `$MyInvocation`）。

3. **配置文件不要带 BOM**
   `Set-Content -Encoding UTF8` 会加 BOM，Capacitor 解析 `capacitor.config.json` 会直接失败。
   已改用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`，并在脚本里断言无 BOM。

4. **CI 上用 `powershell` 而不是 `pwsh`**
   `pwsh`（PowerShell 7）在 macOS runner 上不一定预装；`powershell` 一定有。
   脚本只用了 5.1 也支持的东西，两边都能跑。

5. **游戏资源必须在仓库内**
   仓库根是 `Minidayz-WebRTC/`，游戏原来在仓库外，CI 看不到。所以有 `sp/web/`。

6. **Service Worker 在 iOS 包内停用**
   网页版靠 `sw.js` 做离线缓存；在 Capacitor 的 `capacitor://` 里 SW 支持不可靠，
   而且会缓存旧资源导致「改了代码重装还是旧的」。已在 `transform-web.js` 里短路掉。

7. **`sp/web/` 体积**
   约 37 MB / 2377 个文件，会进 git。曾评估过「复用联机版 `web/` 里同名文件」来瘦身，
   但实测两版**图片资源并不一致**（例如 `akm_rifle-sheet0.png` 1814 vs 758 字节），
   不能按路径共享，于是保留独立副本。

---

## 六、本地验证清单（不需要 Mac）

- [ ] `npm run sp:sync` 通过（游戏本体校验）
- [ ] `npm run sp:prepare` 通过
- [ ] `node sp\scripts\verify-sp.js` 全绿（失败 0 / 警告 0）
- [ ] `npm run sp:web` 起本地服务，浏览器开 <http://127.0.0.1:8774/index.html>
      能看到**中文界面**、主菜单**没有 MDZ START 按钮**
- [ ] push 后 Actions 绿了，Artifacts 里有 `.ipa`

## 七、真机验收清单（装到 iPhone 之后）

- [ ] 打开就是横屏、无状态栏、画面铺满
- [ ] 界面是中文
- [ ] 主菜单**没有 MDZ START**（也不会有任何跳转）
- [ ] 能新建游戏、进地图、能打僵尸、能捡东西
- [ ] 有声音（若无声，检查是否被静音开关影响）
- [ ] 存档能正常保存/读取
