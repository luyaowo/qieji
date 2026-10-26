# 且记 · 架构与开发说明

[返回 README](../README.md)

## 架构

且记使用 Swift + AppKit 承载原生窗口，在 WKWebView 中运行本地 React 界面。前端通过消息桥接调用原生能力，界面、字体和 React 运行资源均随应用打包。

```text
React 清单界面（WKWebView）
          ↕ 消息桥接
Swift / AppKit 原生应用
  ├─ 菜单栏、侧边窗口与完整窗口
  ├─ TaskBackupStore：JSON 工作区与备份
  ├─ TaskReminderScheduler：系统通知排期
  └─ WebPrintSession：原生打印与 PDF
```

**窗口复用**：侧边与完整窗口复用同一个 WebView，切换形态时保留清单和编辑状态；Swift 管理窗口位置、开合、菜单栏及应用生命周期。

**数据保存**：React 管理任务与回收站状态，网页本地存储与原生 JSON 工作区共同保存数据，启动时按有效性和更新时间选择副本。原生存储保留上一版，导入前创建备份；退出时提交当前文字编辑，保存失败则取消退出。

**提醒与打印**：提醒设置保存后交给原生通知调度；打印复用清单内容，通过打印样式控制纸面布局和隐藏元素，再由原生打印流程输出。A4 比例只用于打印，完整窗口尺寸可调整。

屏幕使用独立命名的 QieJi Paper 适配字体，统一字体度量，保留朱雀仿宋的字形与字符宽度；字号、行高和间距集中在样式变量中。打印继续使用原字体。

## 开发

### 构建与打包

需要 Apple 芯片 Mac、macOS 14 及以上、支持 Swift 6 的命令行工具、Node.js 18 及以上和 Python 3.9 及以上。前端构建所用 Babel 已随项目保存，无需安装 npm 依赖。

在项目根目录生成前端并编译：

```bash
node Scripts/build-frontend.cjs
swift build -c release --arch arm64
```

生成可运行的本地 `.app`、ZIP，再将已验证的 ZIP 封装为 DMG：

```bash
python3 Scripts/package-mac.py
python3 Scripts/package-dmg.py
```

请通过 Git 克隆仓库后打包，并在已登录的 Mac 图形桌面运行；检查和包内校验会打开临时窗口。直接下载的源码 ZIP 不含 Git 仓库，打包脚本会提前提示并停止。

脚本读取 `Packaging/Info.plist`，执行检查、Release 构建、本地 ad-hoc 签名和包内启动校验，然后写入 `dist/`，同时生成来源元数据与 SHA-256。它不会自动安装；同版本产物已存在时会停止，不覆盖。

DMG 内包含`且记.app`与指向 `/Applications` 的拖拽入口。DMG 脚本核对来源 ZIP、版本及源码哈希，验证磁盘映像和包内签名，再把应用复制到临时目录，核对复制前后的内容与签名，并使用合成任务验证启动。产物保存在 `dist/`，附带校验文件和验证记录；不会安装或覆盖已有交付文件。

开发副本与已安装版本共用同一个任务目录，在日常账户运行可能读写现有任务；应在隔离数据环境中验证，避免同时运行普通版和开发副本。

### 修改与检查

日常界面修改以 `Frontend/` 为入口，`Sources/PaperEdgeApp/Resources/scripts/` 与 `styles/` 是生成结果。

```bash
# 检查前端源码与生成资源是否一致
node Scripts/build-frontend.cjs --check

# 运行自动化检查，需要已登录的 Mac 图形桌面
python3 Scripts/check.py
```

检查使用示例数据，覆盖前端同步、JavaScript、原生存储与排期、界面与退出保存、窗口切换、生命周期、打印检查脚本和 PDF 输出。运行时会创建临时应用或窗口。

字体已随仓库提供。只有重新生成屏幕适配字体时才需要 `fontTools`，并运行 `Scripts/prepare-mac-font.py`；普通前端构建不执行这个步骤。

| 目录 | 内容 |
| --- | --- |
| `Frontend/` | 本地 React 界面的源码和样式 |
| `Sources/PaperEdgeApp/` | Swift 原生窗口、存储、通知、打印及运行资源 |
| `Scripts/`、`Tests/` | 生成、检查、打包脚本与原生检查 |
| `Packaging/` | 版本信息、图标和随包说明 |
| `docs/` | README 使用的截图与演示资源 |

## 安装与验证边界

打包生成本地 ad-hoc 签名的测试包，尚未完成 Developer ID 签名和 Apple 公证。构建、检查和包内启动校验通过，不代表已经验证下载后的首次安装或所有系统环境。当前提醒限制及其他边界见[使用说明](../Packaging/使用说明.md#边界)。
