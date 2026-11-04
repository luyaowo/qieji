# 且记 macOS

Mac 版独立工程，使用 Swift + AppKit 与 WKWebView 中的 React 界面。源码、资源、检查与打包脚本均在本目录维护；Windows 工程位于旁边的 `Windows/`，两边没有共享构建步骤。

[项目介绍与下载](../README.md) · [架构与开发说明](../docs/development.md) · [使用说明](Packaging/使用说明.md) · [第三方许可](THIRD_PARTY_NOTICES.md)

## 构建

需要 Apple 芯片 Mac、macOS 14 及以上、支持 Swift 6 的命令行工具、Node.js 18 及以上和 Python 3.9 及以上。通过 Git 克隆仓库后，在本目录执行：

```bash
node Scripts/build-frontend.cjs
swift build -c release --arch arm64
```

前端生成资源位于 `Sources/PaperEdgeApp/Resources/`。详细检查与 ZIP、DMG 打包命令见架构与开发说明，构建产物位于本目录的 `dist/`，不进入源码仓库。

开发应用与已安装版本可能使用同一个任务目录，日常账户不要同时运行两者。自动化检查使用隔离环境与合成任务。
