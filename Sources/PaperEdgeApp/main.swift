import AppKit
import ServiceManagement
import WebKit
import UniformTypeIdentifiers
import Carbon

private extension NSColor {
    static let paperEdgeBackground = NSColor(
        srgbRed: 245 / 255,
        green: 244 / 255,
        blue: 237 / 255,
        alpha: 1
    )
}

private enum PanelLayout {
    static let openWidth: CGFloat = 430
    static let openHeight: CGFloat = 720
    static let closedWidth: CGFloat = 54
    static let closedHeight: CGFloat = 190
    static let screenInset: CGFloat = 12
    static let tabPositionKey = "QieJi.tabCenterFraction"
}

private enum DisplayMode: String {
    case side, paper
    static let defaultsKey = "QieJi.displayMode"
}

private enum PanelChrome {
    static let openCornerRadius: CGFloat = 26
    static let closedCornerRadius: CGFloat = 18
    // The blurred shadow needs transparent space on the left, top and bottom.
    static let shadowInset: CGFloat = 36
}

private enum PanelMotion {
    static let openDuration: TimeInterval = 0.28
    static let closeDuration: TimeInterval = 0.22
    static let closeCurve = CAMediaTimingFunction(controlPoints: 0.16, 1.0, 0.3, 1.0)
    static let openSpringResponse: CGFloat = 0.26
    static let openSpringDampingRatio: CGFloat = 0.94
}

private final class PaperPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

private final class InteractiveWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSWindowDelegate, NSMenuDelegate, NSMenuItemValidation, WKNavigationDelegate {
    // Keep maxBackupRecords in sync with taskStorage.MAX_IMPORT_RECORDS.
    private static let maxBackupRecords = 20000
    private static let maxBackupBytes = 20 * 1024 * 1024
    private var panel: PaperPanel!
    private var containerView: NSView!
    private var paperLayer: CAShapeLayer!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var paperWindow: NSWindow?
    private var displayMode = DisplayMode(rawValue: UserDefaults.standard.string(forKey: DisplayMode.defaultsKey) ?? "") ?? .side
    private let taskBackupStore = TaskBackupStore()
    private let reminderScheduler = TaskReminderScheduler()
    private let printSession = WebPrintSession()
    private var isPanelOpen = UserDefaults.standard.object(forKey: "QieJi.panelOpen") as? Bool ?? true
    private var interfaceReady = false
    private var pendingReminderTaskID: String?
    private var pendingTaskCommands: [String] = []
    private var terminationPending = false
    private var terminationGeneration = 0
    private var terminationTimeout: DispatchWorkItem?
    private var loginMenuItems: [NSMenuItem] = []
    private var interfaceRecoveryPending = false
    private var recentProcessFailures: [Date] = []
    private var interfaceLoadFailures = 0
    private var loadErrorVisible = false
    private var motionGeneration = 0
    private var tabCenterFraction: CGFloat = 0.5
    private var tabDragStart: (screenY: CGFloat, centerY: CGFloat)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let loginLaunch = Self.isLoginLaunch(NSAppleEventManager.shared().currentAppleEvent)
        if loginLaunch {
            displayMode = .side
            isPanelOpen = false
        }
        if let savedPosition = UserDefaults.standard.object(forKey: PanelLayout.tabPositionKey) as? Double {
            tabCenterFraction = min(max(CGFloat(savedPosition), 0), 1)
        }
        reminderScheduler.onOpenTask = { [weak self] taskID in
            self?.pendingReminderTaskID = taskID
            self?.openPendingReminder()
        }
        reminderScheduler.onCompleteTask = { [weak self] taskID in
            self?.sendTaskCommand("paperEdgeCompleteTask", taskID: taskID)
        }
        reminderScheduler.onSnoozeTask = { [weak self] taskID in
            self?.sendTaskCommand("paperEdgeSnoozeTask", taskID: taskID)
        }
        reminderScheduler.onStatus = { [weak self] status in
            self?.webView?.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('qieji-notification-status', {detail: {status: '\(status)'}}))",
                completionHandler: nil
            )
        }
        configureApplicationMenu()
        configureStatusItem()
        configurePanel()
        configureWebView()
        if displayMode == .side { applyPanelStateImmediately(open: isPanelOpen) }
        configureLifecycleObservers()
        loadInterface()

        if displayMode == .paper {
            showPaperWindow()
        } else {
            panel.orderFrontRegardless()
        }
        if !loginLaunch { NSApp.activate(ignoringOtherApps: true) }
    }

    private static func isLoginLaunch(_ event: NSAppleEventDescriptor?) -> Bool {
        event?.eventClass == kCoreEventClass && event?.eventID == kAEOpenApplication
            && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationPending else { return .terminateLater }
        // Before the interface is ready there is no editable session to flush.
        guard interfaceReady else { return .terminateNow }
        terminationPending = true
        terminationGeneration += 1
        let generation = terminationGeneration
        terminationTimeout?.cancel()
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.terminationPending, self.terminationGeneration == generation else { return }
            self.terminationPending = false
            self.terminationGeneration += 1
            self.terminationTimeout = nil
            self.showSaveError("保存任务超时，已取消退出。请稍后重试。")
            sender.reply(toApplicationShouldTerminate: false)
        }
        terminationTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: timeout)
        // Flush React's active editor before taking the final workspace snapshot.
        webView.callAsyncJavaScript("return window.paperEdgePrepareToQuit();", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { sender.reply(toApplicationShouldTerminate: false); return }
            self.terminationTimeout?.cancel()
            self.terminationTimeout = nil
            guard self.terminationPending, self.terminationGeneration == generation else { return }
            let saved: Bool
            switch result {
            case .success(let workspace): saved = self.taskBackupStore.saveWorkspace(workspace)
            case .failure: saved = false
            }
            self.terminationPending = false
            if !saved { self.showSaveError("任务没有成功保存，已保留应用。请稍后重试。") }
            sender.reply(toApplicationShouldTerminate: saved)
        }
        return .terminateLater
    }

    private func showSaveError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "且记未能保存任务"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    private func openPendingReminder() {
        guard interfaceReady, let taskID = pendingReminderTaskID else { return }
        pendingReminderTaskID = nil
        guard let data = try? JSONSerialization.data(withJSONObject: [taskID]),
              let argument = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.paperEdgeOpenTask?.(\(argument)[0]);")
        setPanel(open: true, animated: true)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func sendTaskCommand(_ name: String, taskID: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [taskID]),
              let argument = String(data: data, encoding: .utf8) else { return }
        let script = "window.\(name)?.(\(argument)[0]);"
        if interfaceReady {
            webView.evaluateJavaScript(script)
        } else {
            pendingTaskCommands.append(script)
        }
    }

    private func flushPendingTaskCommands() {
        guard interfaceReady, !pendingTaskCommands.isEmpty else { return }
        let scripts = pendingTaskCommands
        pendingTaskCommands.removeAll()
        scripts.forEach { webView.evaluateJavaScript($0) }
    }

    func applicationWillTerminate(_ notification: Notification) {
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        reminderScheduler.refresh()
    }

    private func showFileError(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    private func showNotice(_ message: String) {
        webView.callAsyncJavaScript("window.paperEdgeShowNotice(message);", arguments: ["message": message], in: nil, in: .page) { _ in }
    }

    @objc private func chooseTaskExport() {
        guard interfaceReady else { return }
        let panel = NSSavePanel()
        panel.title = "导出且记任务"
        panel.allowedContentTypes = [.json]
        let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd"
        panel.nameFieldStringValue = "且记任务-\(formatter.string(from: Date())).json"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        exportTasks(to: url)
    }

    private static func backupRecordCount(_ value: Any) -> Int {
        guard let workspace = value as? [String: Any] else { return 0 }
        let tasks = (workspace["tasks"] as? [Any])?.count ?? 0
        let trash = (workspace["trash"] as? [Any])?.count ?? 0
        return tasks + trash
    }

    private func exportTasks(to url: URL, completion: ((Bool) -> Void)? = nil) {
        webView.callAsyncJavaScript("return window.paperEdgeExportWorkspace();", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { completion?(false); return }
            do {
                let value = try result.get()
                let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: url, options: .atomic)
                let records = Self.backupRecordCount(value)
                let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
                let bytes = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
                let tooLarge = records > Self.maxBackupRecords || bytes > Int64(Self.maxBackupBytes)
                self.showNotice(tooLarge
                    ? "已导出。文件超过导入上限（\(Self.maxBackupRecords) 条 / 20 MB），重新导入可能受限，请先清理已删除记录。"
                    : "任务与已删除记录已导出")
                completion?(true)
            } catch {
                self.showFileError("无法导出任务", error.localizedDescription)
                completion?(false)
            }
        }
    }

    @objc private func importTasks() {
        guard interfaceReady else { return }
        let panel = NSOpenPanel()
        panel.title = "导入且记任务备份"
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        previewImport(from: url) { [weak self] preview in
            guard let self, let preview, let summary = preview["summary"] as? [String: Any] else { return }
            let tasks = summary["tasks"] as? Int ?? 0, trash = summary["trash"] as? Int ?? 0
            let conflicts = summary["conflicts"] as? Int ?? 0
            guard tasks + trash > 0 else { self.showNotice("没有新增记录，已保留当前任务"); return }
            let alert = NSAlert()
            alert.messageText = "导入这些任务？"
            alert.informativeText = "新增 \(tasks) 条任务、\(trash) 条已删除记录，跳过 \(conflicts) 条重复或冲突记录。\n\n当前版本会保留，导入前会自动备份。未来提醒将按现有通知权限安排。"
            alert.addButton(withTitle: "导入")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            self.applyImport(preview)
        }
    }

    private func previewImport(from url: URL, completion: @escaping ([String: Any]?) -> Void) {
        do {
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= Self.maxBackupBytes else {
                showFileError("无法导入任务", "备份文件超过 20 MB，请先拆分后再导入。")
                completion(nil); return
            }
            let data = try Data(contentsOf: url)
            let payload = try JSONSerialization.jsonObject(with: data)
            let records = Self.backupRecordCount(payload)
            guard records <= Self.maxBackupRecords else {
                showFileError("无法导入任务", "备份包含 \(records) 条记录，超过 \(Self.maxBackupRecords) 条上限。请先清理已删除记录或分拆备份。")
                completion(nil); return
            }
            webView.callAsyncJavaScript("return window.paperEdgePreviewImport(payload);", arguments: ["payload": payload], in: nil, in: .page) { [weak self] result in
                do {
                    guard let preview = try result.get() as? [String: Any] else { throw TaskBackupStore.StoreError.invalidWorkspace }
                    completion(preview)
                } catch {
                    self?.showFileError("无法导入任务", "文件不是有效的且记备份，或包含不支持的数据。")
                    completion(nil)
                }
            }
        } catch {
            showFileError("无法读取任务备份", error.localizedDescription)
            completion(nil)
        }
    }

    private func applyImport(_ preview: [String: Any], completion: ((Bool) -> Void)? = nil) {
        guard let before = preview["before"] as? [String: Any], let workspace = preview["workspace"] as? [String: Any],
              let summary = preview["summary"] as? [String: Any] else { completion?(false); return }
        do {
            let backup = try taskBackupStore.checkpoint(before)
            guard taskBackupStore.saveWorkspace(workspace) else { throw TaskBackupStore.StoreError.invalidWorkspace }
            webView.callAsyncJavaScript("return window.paperEdgeApplyWorkspace(workspace);", arguments: ["workspace": workspace], in: nil, in: .page) { [weak self] result in
                guard let self else { completion?(false); return }
                if case .success(let value) = result, value as? Bool == true {
                    self.reminderScheduler.sync(tasks: workspace["tasks"])
                    self.showNotice("已导入 \(summary["tasks"] as? Int ?? 0) 条任务、\(summary["trash"] as? Int ?? 0) 条已删除记录")
                    completion?(true)
                } else {
                    let rolledBack = self.taskBackupStore.saveWorkspace(before)
                    self.showFileError("导入未完成", rolledBack ? "界面更新失败，已恢复导入前的数据。" : "界面更新失败，导入前备份保存在：\(backup.path)")
                    completion?(false)
                }
            }
        } catch {
            showFileError("导入已取消", "未能保存导入前备份或写入任务，当前清单没有更改。\n\(error.localizedDescription)")
            completion?(false)
        }
    }

    @objc private func showBackups() {
        do {
            try FileManager.default.createDirectory(at: taskBackupStore.backupDirectoryURL, withIntermediateDirectories: true)
            NSWorkspace.shared.open(taskBackupStore.backupDirectoryURL)
        } catch { showFileError("无法打开备份位置", error.localizedDescription) }
    }

    @objc private func showAbout() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "未打包"
        NSApp.orderFrontStandardAboutPanel(options: [.applicationName: "且记", .applicationVersion: "\(version)（构建 \(build)）"])
        NSApp.activate(ignoringOtherApps: true)
    }

    private func addDataMenuItems(to menu: NSMenu) {
        for (title, action) in [("导出任务…", #selector(chooseTaskExport)), ("导入任务…", #selector(importTasks)), ("在 Finder 中显示备份", #selector(showBackups))] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self; menu.addItem(item)
        }
    }

    private func configureApplicationMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: "且记")
        let aboutItem = NSMenuItem(title: "关于且记", action: #selector(showAbout), keyEquivalent: "")
        aboutItem.target = self
        appMenu.addItem(aboutItem)
        appMenu.addItem(.separator())
        addLoginMenuItem(to: appMenu)
        appMenu.addItem(.separator())
        let quitItem = NSMenuItem(
            title: "退出且记",
            action: #selector(quitApp),
            keyEquivalent: "q"
        )
        quitItem.target = self
        appMenu.addItem(quitItem)
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let fileMenuItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        addDataMenuItems(to: fileMenu)
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")

        func addEditItem(
            title: String,
            action: Selector,
            keyEquivalent: String,
            modifiers: NSEvent.ModifierFlags = [.command]
        ) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
            item.keyEquivalentModifierMask = modifiers
            editMenu.addItem(item)
        }

        addEditItem(title: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        addEditItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        addEditItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        addEditItem(title: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        addEditItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(.separator())
        addEditItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        for (title, action, key) in [
            ("完整窗口", #selector(showPaperMode), "1"),
            ("侧边任务单", #selector(showSideMode), "2"),
            ("打印任务纸…", #selector(printFromMenu), "p")
        ] {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.target = self
            viewMenu.addItem(item)
        }
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)
        let helpMenuItem = NSMenuItem()
        let helpMenu = NSMenu(title: "帮助")
        let helpItem = NSMenuItem(title: "使用说明", action: #selector(showHelp), keyEquivalent: "")
        helpItem.target = self
        helpMenu.addItem(helpItem)
        helpMenuItem.submenu = helpMenu
        mainMenu.addItem(helpMenuItem)
        NSApp.helpMenu = helpMenu
        NSApp.mainMenu = mainMenu
    }

    private var interfaceBundle: Bundle {
        let packaged = Bundle.main.resourceURL
            .map { $0.appendingPathComponent("PaperEdge_PaperEdgeApp.bundle") }
            .flatMap(Bundle.init(url:))
        return packaged ?? Bundle.module
    }

    private var helpURL: URL? {
        interfaceBundle.url(forResource: "help", withExtension: "html")
    }

    @objc private func showHelp() {
        guard let url = helpURL, NSWorkspace.shared.open(url) else {
            let alert = NSAlert()
            alert.messageText = "没有打开使用说明"
            alert.informativeText = "请确认应用资源完整，然后重新打开且记。"
            alert.runModal()
            return
        }
    }

    private func configureStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = MenuBarIcon.make()

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "显示 / 收起", action: #selector(togglePanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "完整窗口", action: #selector(showPaperMode), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "侧边任务单", action: #selector(showSideMode), keyEquivalent: ""))
        menu.addItem(.separator())
        addDataMenuItems(to: menu)
        menu.addItem(.separator())
        addLoginMenuItem(to: menu)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "关于且记", action: #selector(showAbout), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "退出且记", action: #selector(quitApp), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        statusItem.menu = menu
    }

    private var canManageLoginItem: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
            && Bundle.main.bundleURL.path.hasPrefix("/Applications/")
    }

    private func addLoginMenuItem(to menu: NSMenu) {
        let item = NSMenuItem(title: "开机启动", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        item.target = self
        menu.addItem(item)
        menu.delegate = self
        loginMenuItems.append(item)
        updateLoginMenuItems()
    }

    func menuWillOpen(_ menu: NSMenu) { updateLoginMenuItems() }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(toggleLaunchAtLogin) {
            return canManageLoginItem && SMAppService.mainApp.status != .notFound
        }
        return true
    }

    private func updateLoginMenuItems() {
        let status = SMAppService.mainApp.status
        for item in loginMenuItems {
            item.title = status == .requiresApproval ? "开机启动（等待系统允许）" : "开机启动"
            item.state = status == .enabled ? .on : (status == .requiresApproval ? .mixed : .off)
            item.isEnabled = canManageLoginItem && status != .notFound
            if !canManageLoginItem {
                item.toolTip = "安装到“应用程序”后可设置开机启动"
            } else if status == .notFound {
                item.toolTip = "系统尚未登记此应用；请确认且记位于“应用程序”，并使用签名后的版本"
            } else if status == .requiresApproval {
                item.toolTip = "已在系统设置中申请，等待允许"
            } else {
                item.toolTip = nil
            }
        }
    }

    @objc private func toggleLaunchAtLogin() {
        guard canManageLoginItem else { return }
        do {
            let service = SMAppService.mainApp
            switch service.status {
            case .enabled, .requiresApproval: try service.unregister()
            case .notRegistered:
                try service.register()
                if service.status == .requiresApproval {
                    let alert = NSAlert()
                    alert.messageText = "请在系统设置中允许开机启动"
                    alert.informativeText = "且记已申请在登录时启动，需要你在系统设置中允许。"
                    alert.addButton(withTitle: "打开系统设置")
                    alert.addButton(withTitle: "稍后")
                    if alert.runModal() == .alertFirstButtonReturn { SMAppService.openSystemSettingsLoginItems() }
                }
            default: showFileError("无法设置开机启动", "系统未找到这份应用，请确认且记已安装到“应用程序”。")
            }
        } catch {
            showFileError("无法设置开机启动", error.localizedDescription)
        }
        updateLoginMenuItems()
    }

    private func configureLifecycleObservers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(schedulePanelRecovery),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(schedulePanelRecovery),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
    }

    private func configurePanel() {
        let frame = frameForPanel(open: true)
        panel = PaperPanel(
            contentRect: frame,
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        panel.title = "且记"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovable = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.animationBehavior = .none
    }

    private func configureWebView() {
        let controller = WKUserContentController()
        controller.add(self, name: "paperEdge")
        refreshBootstrapScripts(in: controller)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()

        let initialBounds = NSRect(origin: .zero, size: panel.frame.size)
        containerView = NSView(frame: initialBounds)
        containerView.autoresizingMask = [.width, .height]
        containerView.wantsLayer = true
        containerView.layer?.backgroundColor = NSColor.clear.cgColor

        paperLayer = CAShapeLayer()
        paperLayer.frame = initialBounds
        paperLayer.fillColor = NSColor.paperEdgeBackground.cgColor
        paperLayer.shadowColor = NSColor.black.cgColor
        paperLayer.shadowOpacity = 0.16
        paperLayer.shadowRadius = 10
        paperLayer.shadowOffset = CGSize(width: -4, height: 0)
        paperLayer.path = paperPath(
            in: surfaceFrame(open: true),
            radius: PanelChrome.openCornerRadius,
            trailingRadius: PanelChrome.openCornerRadius
        )
        paperLayer.shadowPath = paperLayer.path
        containerView.layer?.addSublayer(paperLayer)

        webView = InteractiveWebView(frame: surfaceFrame(open: true), configuration: configuration)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.wantsLayer = true
        webView.layer?.cornerRadius = PanelChrome.openCornerRadius
        webView.layer?.cornerCurve = .continuous
        webView.layer?.masksToBounds = true
        containerView.addSubview(webView)
        panel.contentView = containerView
    }

    private func refreshBootstrapScripts(in controller: WKUserContentController) {
        controller.removeAllUserScripts()
        controller.addUserScript(taskBackupStore.bootstrapUserScript())
        controller.addUserScript(WKUserScript(
            source: "window.__QIEJI_DISPLAY_MODE__ = '\(displayMode.rawValue)'; window.__QIEJI_PANEL_OPEN__ = \(isPanelOpen ? "true" : "false");",
            injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView else { return }
        interfaceReady = false
        interfaceRecoveryPending = true
        if terminationPending {
            terminationPending = false
            terminationGeneration += 1
            terminationTimeout?.cancel()
            terminationTimeout = nil
            NSApp.reply(toApplicationShouldTerminate: false)
        }
        let now = Date()
        recentProcessFailures = recentProcessFailures.filter { now.timeIntervalSince($0) < 30 }
        recentProcessFailures.append(now)
        if recentProcessFailures.count > 2 {
            let alert = NSAlert()
            alert.messageText = "且记界面暂时无法恢复"
            alert.informativeText = "已保存的任务仍在本机。可重试加载；尚未提交的编辑可能未保留。"
            alert.addButton(withTitle: "重新加载")
            alert.addButton(withTitle: "退出且记")
            if alert.runModal() != .alertFirstButtonReturn { NSApp.terminate(nil); return }
            recentProcessFailures.removeAll()
        }
        // A reload re-runs document-start scripts: inject the latest saved
        // workspace and current window state, never the original launch snapshot.
        refreshBootstrapScripts(in: webView.configuration.userContentController)
        loadInterface()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleInterfaceLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleInterfaceLoadFailure(error)
    }

    private func handleInterfaceLoadFailure(_ error: Error) {
        guard webView === self.webView, !terminationPending, !loadErrorVisible else { return }
        loadErrorVisible = true
        defer { loadErrorVisible = false }
        interfaceReady = false
        interfaceLoadFailures += 1
        let repeated = interfaceLoadFailures >= 3
        let alert = NSAlert()
        alert.messageText = repeated ? "且记界面多次加载失败" : "且记界面没有加载成功"
        alert.informativeText = repeated
            ? "已保存的任务仍在本机。可以退出后重新打开；如果仍失败，请重新安装应用。"
            : "\(error.localizedDescription)\n\n已保存的任务仍在本机。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "重新加载")
        alert.addButton(withTitle: "退出且记")
        if alert.runModal() == .alertFirstButtonReturn {
            loadInterface()
        } else {
            NSApp.terminate(nil)
        }
    }

    private func loadInterface() {
        guard
            let resourceRoot = interfaceBundle.resourceURL,
            let fileURL = interfaceBundle.url(
                forResource: "index",
                withExtension: "html"
            )
        else {
            showLoadError()
            return
        }

        var components = URLComponents(url: fileURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "native", value: "1")]
        webView.loadFileURL(components?.url ?? fileURL, allowingReadAccessTo: resourceRoot)
    }

    private func showLoadError() {
        let alert = NSAlert()
        alert.messageText = "没有找到且记界面"
        alert.informativeText = "请重新构建工程后再试一次。"
        alert.alertStyle = .warning
        alert.runModal()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard
            message.name == "paperEdge",
            let body = message.body as? [String: Any],
            let type = body["type"] as? String
        else { return }

        switch type {
        case "ready":
            interfaceReady = true
            interfaceLoadFailures = 0
            // Replay native window state in case a menu command arrived before the page mounted.
            webView.evaluateJavaScript("window.paperEdgeSetMode?.('\(displayMode.rawValue)'); window.paperEdgeSetOpen?.(\(isPanelOpen ? "true" : "false"));")
            if displayMode == .side { revealPanelContent(open: isPanelOpen) }
            openPendingReminder()
            flushPendingTaskCommands()
            if interfaceRecoveryPending {
                interfaceRecoveryPending = false
                webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('qieji-notification-status', {detail:{status:'interfaceRecovered'}}))")
            }
        case "panel":
            guard let open = body["open"] as? Bool else { return }
            setPanel(open: open, animated: true)
        case "print":
            printTasks()
        case "openNotificationSettings":
            if !NotificationSettingsLink.open() {
                webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('qieji-notification-status', {detail: {status: 'settingsUnavailable'}}))")
            }
        case "displayMode":
            guard let raw = body["mode"] as? String, let mode = DisplayMode(rawValue: raw) else { return }
            setDisplayMode(mode, open: body["open"] as? Bool ?? true)
        case "workspace":
            if taskBackupStore.saveWorkspace(body["workspace"]) {
                if let workspace = body["workspace"] as? [String: Any] {
                    reminderScheduler.sync(tasks: workspace["tasks"])
                }
            } else {
                webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('qieji-notification-status', {detail: {status: 'saveFailed'}}))")
            }
        case "tabDrag":
            guard
                let phase = body["phase"] as? String,
                let screenY = body["screenY"] as? Double
            else { return }
            handleTabDrag(phase: phase, screenY: CGFloat(screenY))
        default:
            break
        }
    }

    private func handleTabDrag(phase: String, screenY: CGFloat) {
        guard !isPanelOpen else { return }
        switch phase {
        case "start":
            guard panel.frame.width <= frameForPanel(open: false).width + 1 else { return }
            tabDragStart = (screenY: screenY, centerY: panel.frame.midY)
        case "move", "end":
            guard let start = tabDragStart else { return }
            let visible = (NSScreen.screens.first ?? NSScreen.main)?.visibleFrame
                ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let desiredCenter = start.centerY + start.screenY - screenY
            let surfaceHeight = surfaceFrame(in: panel.frame).height
            let minimum = visible.minY + PanelLayout.screenInset + surfaceHeight / 2
            let maximum = visible.maxY - PanelLayout.screenInset - surfaceHeight / 2
            let center = min(max(desiredCenter, minimum), maximum)
            tabCenterFraction = (center - visible.minY) / visible.height
            panel.setFrame(frameForPanel(open: false), display: true)
            if phase == "end" {
                UserDefaults.standard.set(Double(tabCenterFraction), forKey: PanelLayout.tabPositionKey)
                tabDragStart = nil
            }
        case "cancel":
            tabDragStart = nil
        default:
            break
        }
    }

    private func setPanel(open: Bool, animated: Bool) {
        tabDragStart = nil
        let stateChanged = isPanelOpen != open
        isPanelOpen = open
        UserDefaults.standard.set(open, forKey: "QieJi.panelOpen")
        if displayMode == .paper {
            if open { paperWindow?.makeKeyAndOrderFront(nil) } else { paperWindow?.orderOut(nil) }
            return
        }
        // A mode change is echoed by the web view's persisted panel state.
        // Do not recreate the open canvas when that target is already applied.
        guard stateChanged else { return }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let shouldAnimate = animated && !reduceMotion

        if shouldAnimate {
            animatePaperSurface(open: open)
        } else {
            applyPanelStateImmediately(open: open)
        }

        panel.orderFrontRegardless()
    }

    private func showPaperWindow() {
        motionGeneration += 1
        paperLayer.removeAllAnimations()
        if paperWindow == nil {
            let visible = (panel.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let size = NSSize(width: min(680, visible.width - 48), height: min(860, visible.height - 48))
            let window = NSWindow(
                contentRect: NSRect(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2, width: size.width, height: size.height),
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
            )
            window.title = "且记 · 任务纸"
            window.minSize = NSSize(width: 520, height: 540)
            window.backgroundColor = .paperEdgeBackground
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.setFrameAutosaveName("QieJiCompleteWindow")
            paperWindow = window
        }
        guard let window = paperWindow, let content = window.contentView else { return }
        webView.removeFromSuperview()
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        webView.layer?.cornerRadius = 0
        setWebContentOpacity(1)
        content.addSubview(webView)
        panel.orderOut(nil)
        window.makeKeyAndOrderFront(nil)
    }

    private func setDisplayMode(_ mode: DisplayMode, open: Bool = true) {
        displayMode = mode
        isPanelOpen = open
        UserDefaults.standard.set(open, forKey: "QieJi.panelOpen")
        UserDefaults.standard.set(mode.rawValue, forKey: DisplayMode.defaultsKey)
        if mode == .paper {
            showPaperWindow()
        } else {
            paperWindow?.orderOut(nil)
            webView.removeFromSuperview()
            webView.autoresizingMask = []
            containerView.addSubview(webView)
            applyPanelStateImmediately(open: open)
            panel.orderFrontRegardless()
        }
        webView.evaluateJavaScript("window.paperEdgeSetMode?.('\(mode.rawValue)'); window.paperEdgeSetOpen?.(\(open ? "true" : "false"));")
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === paperWindow {
            setDisplayMode(.side, open: false)
            return false
        }
        return true
    }

    @objc private func showPaperMode() { setDisplayMode(.paper) }
    @objc private func showSideMode() { setDisplayMode(.side) }
    @objc private func printFromMenu() { printTasks() }

    private func animatePaperSurface(open: Bool) {
        motionGeneration += 1
        let generation = motionGeneration
        // Hide the composited WebKit content before changing its viewport.
        // CSS alone cannot hide the previous rendered frame during a resize.
        setWebContentOpacity(0)
        let expandedFromCollapsedWindow = prepareOpenCanvas()

        let targetFrame = surfaceFrame(open: open)
        let targetRadius = open ? PanelChrome.openCornerRadius : PanelChrome.closedCornerRadius
        let targetTrailingRadius = open ? PanelChrome.openCornerRadius : 0
        let targetPath = paperPath(
            in: targetFrame,
            radius: targetRadius,
            trailingRadius: targetTrailingRadius
        )
        let sourcePath = expandedFromCollapsedWindow && open
            ? paperPath(
                in: surfaceFrame(open: false),
                radius: PanelChrome.closedCornerRadius,
                trailingRadius: 0
            )
            : (paperLayer.presentation()?.path ?? paperLayer.path)
        paperLayer.removeAllAnimations()

        let pathAnimation: CAAnimation
        if open {
            pathAnimation = openingPathAnimation(
                from: sourcePath,
                to: targetFrame,
                radius: targetRadius,
                trailingRadius: targetTrailingRadius
            )
        } else {
            let close = CABasicAnimation(keyPath: "path")
            close.duration = PanelMotion.closeDuration
            close.timingFunction = PanelMotion.closeCurve
            close.fromValue = sourcePath
            close.toValue = targetPath
            pathAnimation = close
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        CATransaction.setCompletionBlock { [weak self] in
            guard let self, generation == self.motionGeneration else { return }
            if open {
                self.finishOpenState()
            } else {
                self.finishClosedState()
            }
        }
        paperLayer.path = targetPath
        paperLayer.shadowPath = targetPath
        paperLayer.add(pathAnimation, forKey: "paperEdge.path")
        if let shadowAnimation = pathAnimation.copy() as? CAPropertyAnimation {
            shadowAnimation.keyPath = "shadowPath"
            paperLayer.add(shadowAnimation, forKey: "paperEdge.shadowPath")
        }
        CATransaction.commit()
    }

    private func openingPathAnimation(
        from sourcePath: CGPath?,
        to targetFrame: NSRect,
        radius targetRadius: CGFloat,
        trailingRadius targetTrailingRadius: CGFloat
    ) -> CAKeyframeAnimation {
        let sourceFrame = sourcePath?.boundingBoxOfPath ?? surfaceFrame(open: false)
        let widthRange = PanelLayout.openWidth - PanelLayout.closedWidth
        let sourceProgress = widthRange > 0
            ? (sourceFrame.width - PanelLayout.closedWidth) / widthRange
            : 0
        let clampedSourceProgress = min(max(sourceProgress, 0), 1)
        let sourceRadius = PanelChrome.closedCornerRadius
            + (PanelChrome.openCornerRadius - PanelChrome.closedCornerRadius) * clampedSourceProgress
        let sourceTrailingRadius = PanelChrome.openCornerRadius * clampedSourceProgress
        let sampleCount = 60

        let animation = CAKeyframeAnimation(keyPath: "path")
        animation.duration = PanelMotion.openDuration
        animation.calculationMode = .linear
        animation.values = (0...sampleCount).map { index in
            let elapsed = PanelMotion.openDuration * Double(index) / Double(sampleCount)
            let progress = springProgress(at: elapsed)
            let frame = NSRect(
                x: sourceFrame.minX + (targetFrame.minX - sourceFrame.minX) * progress,
                y: sourceFrame.minY + (targetFrame.minY - sourceFrame.minY) * progress,
                width: sourceFrame.width + (targetFrame.width - sourceFrame.width) * progress,
                height: sourceFrame.height + (targetFrame.height - sourceFrame.height) * progress
            )
            let radius = sourceRadius + (targetRadius - sourceRadius) * progress
            let trailingRadius = sourceTrailingRadius
                + (targetTrailingRadius - sourceTrailingRadius) * progress
            return paperPath(
                in: frame,
                radius: radius,
                trailingRadius: trailingRadius
            )
        }
        animation.keyTimes = (0...sampleCount).map {
            NSNumber(value: Double($0) / Double(sampleCount))
        }
        return animation
    }

    private func springProgress(at elapsed: TimeInterval) -> CGFloat {
        let response = Double(PanelMotion.openSpringResponse)
        let dampingRatio = Double(PanelMotion.openSpringDampingRatio)
        let angularFrequency = (2 * Double.pi) / response
        let dampedScale = sqrt(max(1 - dampingRatio * dampingRatio, 0.0001))
        let dampedFrequency = angularFrequency * dampedScale
        let envelope = exp(-dampingRatio * angularFrequency * elapsed)
        let oscillation = cos(dampedFrequency * elapsed)
            + (dampingRatio / dampedScale) * sin(dampedFrequency * elapsed)
        return CGFloat(min(max(1 - envelope * oscillation, 0), 1))
    }

    @discardableResult
    private func prepareOpenCanvas() -> Bool {
        let openFrame = frameForPanel(open: true)
        let wasCollapsed = panel.frame.width < openFrame.width - 1
        if wasCollapsed {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            panel.setFrame(openFrame, display: false)
            containerView.frame = NSRect(origin: .zero, size: openFrame.size)
            paperLayer.frame = NSRect(origin: .zero, size: openFrame.size)
            paperLayer.path = paperPath(
                in: surfaceFrame(open: false),
                radius: PanelChrome.closedCornerRadius,
                trailingRadius: 0
            )
            paperLayer.shadowPath = paperLayer.path
            webView.layer?.cornerRadius = PanelChrome.openCornerRadius
            CATransaction.commit()
        }
        webView.frame = surfaceFrame(open: true)
        panel.displayIfNeeded()
        return wasCollapsed
    }

    private func finishOpenState() {
        let openFrame = frameForPanel(open: true)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        paperLayer.frame = NSRect(origin: .zero, size: openFrame.size)
        paperLayer.path = paperPath(
            in: surfaceFrame(open: true),
            radius: PanelChrome.openCornerRadius,
            trailingRadius: PanelChrome.openCornerRadius
        )
        paperLayer.shadowPath = paperLayer.path
        webView.layer?.cornerRadius = PanelChrome.openCornerRadius
        webView.frame = surfaceFrame(open: true)
        CATransaction.commit()
        revealPanelContent(open: true)
    }

    private func finishClosedState() {
        let closedFrame = frameForPanel(open: false)
        let closedSurface = surfaceFrame(in: closedFrame)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        panel.setFrame(closedFrame, display: false)
        containerView.frame = NSRect(origin: .zero, size: closedFrame.size)
        paperLayer.frame = NSRect(origin: .zero, size: closedFrame.size)
        paperLayer.path = paperPath(
            in: closedSurface,
            radius: PanelChrome.closedCornerRadius,
            trailingRadius: 0
        )
        paperLayer.shadowPath = paperLayer.path
        webView.layer?.cornerRadius = PanelChrome.closedCornerRadius
        webView.frame = closedSurface
        CATransaction.commit()
        panel.displayIfNeeded()
        revealPanelContent(open: false)
    }

    private func setWebContentOpacity(_ opacity: Float) {
        webView.layer?.removeAnimation(forKey: "paperEdge.contentOpacity")
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        webView.layer?.opacity = opacity
        CATransaction.commit()
    }

    private func revealPanelContent(open: Bool) {
        guard paperLayer.animation(forKey: "paperEdge.path") == nil else { return }
        let generation = motionGeneration
        // Both the label and the task list must use the final viewport before
        // native compositing makes either visible. Ignore interrupted motions.
        webView.callAsyncJavaScript(
            "await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true;",
            arguments: [:], in: nil, in: .page
        ) { [weak self] result in
            guard case .success = result, let self, generation == self.motionGeneration,
                  self.displayMode == .side, self.isPanelOpen == open,
                  self.webView.frame == self.surfaceFrame(in: self.frameForPanel(open: open)),
                  self.paperLayer.animation(forKey: "paperEdge.path") == nil else { return }
            let fromOpacity = self.webView.layer?.presentation()?.opacity ?? self.webView.layer?.opacity ?? 0
            self.setWebContentOpacity(1)
            if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = fromOpacity
                fade.toValue = Float(1)
                fade.duration = 0.12
                self.webView.layer?.add(fade, forKey: "paperEdge.contentOpacity")
            }
        }
    }

    private func applyPanelStateImmediately(open: Bool) {
        motionGeneration += 1
        setWebContentOpacity(0)
        paperLayer.removeAllAnimations()
        if open {
            prepareOpenCanvas()
            finishOpenState()
        } else {
            finishClosedState()
        }
    }

    private func paperPath(
        in rect: NSRect,
        radius: CGFloat,
        trailingRadius: CGFloat
    ) -> CGPath {
        let r = min(radius, rect.width / 2, rect.height / 2)
        let trailingR = min(trailingRadius, rect.width / 2, rect.height / 2)
        let path = CGMutablePath()
        path.move(to: CGPoint(x: rect.maxX - trailingR, y: rect.minY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.minY + trailingR),
            control: CGPoint(x: rect.maxX, y: rect.minY)
        )
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - trailingR))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - trailingR, y: rect.maxY),
            control: CGPoint(x: rect.maxX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - r),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + r, y: rect.minY),
            control: CGPoint(x: rect.minX, y: rect.minY)
        )
        path.closeSubpath()
        return path
    }

    private func surfaceFrame(in canvas: NSRect) -> NSRect {
        NSRect(
            x: PanelChrome.shadowInset,
            y: PanelChrome.shadowInset,
            width: canvas.width - PanelChrome.shadowInset,
            height: canvas.height - PanelChrome.shadowInset * 2
        )
    }

    private func surfaceFrame(open: Bool) -> NSRect {
        let canvas = frameForPanel(open: true)
        if open {
            return surfaceFrame(in: canvas)
        }
        let closed = frameForPanel(open: false)
        return surfaceFrame(in: closed).offsetBy(
            dx: closed.minX - canvas.minX,
            dy: closed.minY - canvas.minY
        )
    }

    private func frameForPanel(open: Bool) -> NSRect {
        let screen = NSScreen.screens.first ?? NSScreen.main
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        let width = (open ? PanelLayout.openWidth : PanelLayout.closedWidth)
            + PanelChrome.shadowInset
        let preferredHeight = open ? PanelLayout.openHeight : PanelLayout.closedHeight
        let surfaceHeight = min(preferredHeight, visible.height - PanelLayout.screenInset * 2)
        let height = surfaceHeight + PanelChrome.shadowInset * 2

        let preferredCenterY = visible.minY + visible.height * tabCenterFraction
        let minimumY = visible.minY + PanelLayout.screenInset
        let maximumY = visible.maxY - PanelLayout.screenInset - surfaceHeight

        let requested = NSRect(
            x: visible.maxX - width,
            y: min(max(preferredCenterY - surfaceHeight / 2, minimumY), maximumY)
                - PanelChrome.shadowInset,
            width: width,
            height: height
        )
        // AppKit may move the transparent shadow margin below the menu bar.
        // Paths and canvas handoffs must use the same constrained screen frame
        // that setFrame will actually apply, otherwise the paper jumps at rest.
        return panel?.constrainFrameRect(requested, to: screen) ?? requested
    }

    private func printTasks() {
        guard let window = webView.window else { return }
        let printInfo = NSPrintInfo.shared.copy() as! NSPrintInfo
        printInfo.paperSize = NSSize(width: 595, height: 842)
        printInfo.orientation = .portrait
        printSession.run(webView.printOperation(with: printInfo), for: window)
    }

    @objc private func schedulePanelRecovery() {
        NSObject.cancelPreviousPerformRequests(
            withTarget: self,
            selector: #selector(restorePanelPosition),
            object: nil
        )
        perform(#selector(restorePanelPosition), with: nil, afterDelay: 0.35)
    }

    @objc private func restorePanelPosition() {
        guard panel != nil else { return }
        if displayMode == .paper {
            if let window = paperWindow {
                window.setFrame(window.constrainFrameRect(window.frame, to: window.screen), display: true)
            }
            return
        }
        applyPanelStateImmediately(open: isPanelOpen)
        panel.orderFrontRegardless()
    }

    @objc private func togglePanel() {
        let nextState = !isPanelOpen
        let script = "window.paperEdgeSetOpen && window.paperEdgeSetOpen(\(nextState ? "true" : "false"));"
        webView.evaluateJavaScript(script)
        setPanel(open: nextState, animated: true)
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

if CommandLine.arguments.contains("--verify-package") { PackageVerifier.run() }

private let application = NSApplication.shared
private let delegate = AppDelegate()
application.delegate = delegate
application.run()
