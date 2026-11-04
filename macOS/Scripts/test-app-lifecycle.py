#!/usr/bin/env python3
"""Exercise native login launch, login-item menu and real WebKit process recovery.

All task files, defaults, login service calls and notifications are isolated.
Only the WebKit process owned by the temporary test app may be terminated.
"""
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
output = Path(tempfile.mkdtemp(prefix="qieji-lifecycle-", dir="/private/tmp"))
print("Lifecycle verification:", output, flush=True)
source = (root / "Sources/PaperEdgeApp/main.swift").read_text()
source = source.replace("?? Bundle.module", "?? Bundle.main")
source = source.replace("configuration.websiteDataStore = .default()", "configuration.websiteDataStore = .nonPersistent()")
assert 'private let taskBackupStore = TaskBackupStore()' in source
source = source.replace('private let taskBackupStore = TaskBackupStore()',
    'private let taskBackupStore = TaskBackupStore(directoryURL: probeOutput.appendingPathComponent("Data"))')
source = source.replace("UserDefaults.standard", "probeDefaults")
source = source.replace("SMAppService.mainApp", "probeLoginService")
source = source.replace('Bundle.main.bundleURL.path.hasPrefix("/Applications/")', 'true')
source = source.replace("NSAppleEventManager.shared().currentAppleEvent", "probeLaunchEvent()")
source = source.replace("NSApp.activate(ignoringOtherApps: true)", "probeActivations += 1; NSApp.activate(ignoringOtherApps: true)")
source = source.replace("func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {",
    "func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {\n        probeTerminations += 1")
mutation = os.environ.get("QIEJI_LIFECYCLE_MUTATION", "")
if mutation == "startup":
    source = source.replace("let loginLaunch = Self.isLoginLaunch(probeLaunchEvent())", "let loginLaunch = false; try! probeLoginService.register()")
elif mutation == "recovery":
    source = source.replace("        probeTerminations += 1", "        probeTerminations += 1\n        return")
elif mutation:
    raise SystemExit("Unknown test mutation")
source = source.replace("import Carbon", r'''import Carbon
private let probeOutput = URL(fileURLWithPath: CommandLine.arguments[1])
private let probeCase = CommandLine.arguments[2]
private var probeActivations = 0
private var probeTerminations = 0
private var probeAlerts = 0
private let probeDefaults: UserDefaults = {
    let defaults = UserDefaults(suiteName: "local.qieji.lifecycle." + UUID().uuidString)!
    defaults.set("paper", forKey: "QieJi.displayMode")
    defaults.set(true, forKey: "QieJi.panelOpen")
    return defaults
}()
private final class ProbeLoginService {
    var status: SMAppService.Status = .notRegistered
    var registered = 0, unregistered = 0
    var fail = false
    func register() throws {
        registered += 1
        if fail { throw NSError(domain:"fixture",code:1) }
        status = .enabled
    }
    func unregister() throws {
        unregistered += 1
        if fail { throw NSError(domain:"fixture",code:2) }
        status = .notRegistered
    }
}
private final class ProbeAlert: NSAlert {
    override func runModal() -> NSApplication.ModalResponse { probeAlerts += 1; return .alertFirstButtonReturn }
}
private let probeLoginService = ProbeLoginService()
private func probeLaunchEvent() -> NSAppleEventDescriptor {
    let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass),
        eventID: AEEventID(kAEOpenApplication), targetDescriptor: nil,
        returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    if probeCase == "login" {
        event.setParam(NSAppleEventDescriptor(enumCode: OSType(keyAELaunchedAsLogInItem)), forKeyword: AEKeyword(keyAEPropData))
    }
    return event
}
''')
source = source.replace("NSAlert()", "ProbeAlert()")
probe = r'''
private extension AppDelegate {
    func finishProbe(_ details: [String: Any], valid: Bool) {
        var result = details; result["valid"] = valid; result["case"] = probeCase
        let data = try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        try! data.write(to: probeOutput.appendingPathComponent("result.json"))
        exit(valid ? 0 : 1)
    }
    func runLifecycleProbe(_ attempt: Int = 0) {
        guard interfaceReady else {
            if attempt > 100 { finishProbe(["reason":"interface not ready"], valid: false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.runLifecycleProbe(attempt + 1) }
            return
        }
        if probeCase == "manual" || probeCase == "login" {
            let login = probeCase == "login"
            let launchValid = probeLoginService.registered == 0 && (login
                ? displayMode == .side && !isPanelOpen && paperWindow == nil && panel.frame.width < 100 && probeActivations == 0
                : displayMode == .paper && isPanelOpen && paperWindow?.isVisible == true && probeActivations == 1)
            let menu = statusItem.menu!
            let loginItem = menu.items.first { $0.action == #selector(toggleLaunchAtLogin) }!
            menuWillOpen(menu)
            let initialOff = loginItem.state == .off
            toggleLaunchAtLogin()
            let enabled = probeLoginService.registered == 1 && loginItem.state == .on
            toggleLaunchAtLogin()
            let disabled = probeLoginService.unregistered == 1 && loginItem.state == .off
            probeLoginService.status = .requiresApproval
            menuWillOpen(menu)
            let approval = loginItem.state == .mixed && loginItem.title.contains("等待系统允许")
            toggleLaunchAtLogin()
            let cancelled = probeLoginService.unregistered == 2 && loginItem.state == .off
            probeLoginService.status = .enabled; menuWillOpen(menu)
            let refreshed = loginItem.state == .on
            probeLoginService.fail = true
            toggleLaunchAtLogin()
            let disableFailed = probeAlerts == 1 && loginItem.state == .on
            probeLoginService.status = .notRegistered
            toggleLaunchAtLogin()
            let enableFailed = probeAlerts == 2 && loginItem.state == .off
            probeLoginService.status = .notFound; menuWillOpen(menu)
            let unavailable = !validateMenuItem(loginItem)
            finishProbe(["launch":launchValid,"initialOff":initialOff,"enable":enabled,
                "disable":disabled,"approvalState":approval,"cancelApproval":cancelled,"systemStateRefresh":refreshed,
                "enableFailure":enableFailed,"disableFailure":disableFailed,"unavailable":unavailable],
                valid: launchValid && initialOff && enabled && disabled && approval && cancelled && refreshed && enableFailed && disableFailed && unavailable)
        }
        if probeCase == "crash-side" || probeCase == "crash-loop" { setDisplayMode(.side, open: true) }
        if probeCase == "crash-collapsed" { setDisplayMode(.side, open: false) }
        webView.callAsyncJavaScript("""
        const next=window.paperEdgeExportWorkspace();
        next.tasks.push({id:'after-launch',text:'启动后保存的新任务',group:'upcoming',done:false,html:'<b>启动后保存的新任务</b>',remindAt:'2099-01-01T08:00:00Z'});
        return window.paperEdgeApplyWorkspace(next);
        """, arguments: [:], in: nil, in: .page) { result in
            guard case .success = result else { self.finishProbe(["reason":"could not edit fixture"], valid:false); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                guard self.taskBackupStore.readWorkspace()?["tasks"] as? [[String:Any]] != nil,
                      let pid = self.webView.value(forKey: "_webProcessIdentifier") as? NSNumber,
                      pid.int32Value > 0, pid.int32Value != getpid() else {
                    self.finishProbe(["reason":"owned WebKit PID unavailable"], valid:false); return
                }
                probeActivations = 0
                if probeCase == "crash-loop" { self.recentProcessFailures = [Date(),Date()] }
                let killed = kill(pid.int32Value, SIGKILL) == 0
                guard killed else { self.finishProbe(["reason":"could not terminate owned WebKit"], valid:false); return }
                self.waitForRecovery()
            }
        }
    }
    func waitForRecovery(_ attempt: Int = 0) {
        guard probeTerminations > 0 && interfaceReady else {
            if attempt > 100 { finishProbe(["reason":"recovery did not finish","callbacks":probeTerminations], valid:false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.waitForRecovery(attempt + 1) }
            return
        }
        webView.callAsyncJavaScript("""
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const w=window.paperEdgeExportWorkspace();const row=document.querySelector('[data-task-id="after-launch"]');
        return {tasks:w.tasks.length,trash:w.trash.length,hasLatest:!!row&&row.textContent.includes('启动后保存的新任务'),
            format:w.tasks.find(t=>t.id==='after-launch').html,remindAt:w.tasks.find(t=>t.id==='after-launch').remindAt,
            mode:document.documentElement.dataset.displayMode,open:document.querySelector('.app-screen').dataset.open,
            notice:document.querySelector('.notification-notice')?.textContent||''};
        """, arguments: [:], in: nil, in: .page) { result in
            guard case .success(let value) = result, let ui = value as? [String: Any] else {
                self.finishProbe(["reason":"reloaded UI unavailable"], valid:false); return
            }
            let collapsed = probeCase == "crash-collapsed", paper = probeCase == "crash-paper"
            let valid = ui["tasks"] as? Int == 2 && ui["trash"] as? Int == 1 && ui["hasLatest"] as? Bool == true
                && ui["format"] as? String == "<b>启动后保存的新任务</b>" && ui["remindAt"] as? String == "2099-01-01T08:00:00Z"
                && ui["mode"] as? String == (paper ? "paper" : "side") && ui["open"] as? String == (collapsed ? "false" : "true")
                && probeActivations == 0 && self.pendingReminderTaskID == nil
                && (collapsed ? ui["notice"] as? String == "" : (ui["notice"] as? String ?? "").contains("已恢复最近保存的任务"))
                && (probeCase != "crash-loop" || (probeAlerts == 1 && self.recentProcessFailures.isEmpty))
            self.finishProbe(["ui":ui,"callbacks":probeTerminations,"activationsAfterCrash":probeActivations,"retryPrompt":probeAlerts], valid:valid)
        }
    }
}
'''
source = source.replace("private let application = NSApplication.shared", probe + "\nprivate let application = NSApplication.shared")
source = source.replace("application.run()", """
DispatchQueue.global().asyncAfter(deadline: .now() + 20) { exit(3) }
DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { delegate.runLifecycleProbe() }
application.run()""")
(output / "main.swift").write_text(source)
(output / "TaskReminderScheduler.swift").write_text('''import Foundation
final class TaskReminderScheduler {
 var onOpen: (() -> Void)?
 var onOpenTask: ((String) -> Void)?
 var onCompleteTask: ((String) -> Void)?
 var onSnoozeTask: ((String) -> Void)?
 var onStatus: ((String) -> Void)?
 func sync(tasks: Any?) {}
 func refresh() {}
}
''')
app = output / "LifecycleProbe.app"
contents = app / "Contents"
(contents / "MacOS").mkdir(parents=True)
resources = contents / "Resources/PaperEdge_PaperEdgeApp.bundle"
shutil.copytree(root / "Sources/PaperEdgeApp/Resources", resources)
shutil.copytree(root / "Sources/PaperEdgeApp/MacResources", resources / "MacResources")
(contents / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable":"LifecycleProbe",
    "CFBundleIdentifier":"local.qieji.lifecycle." + output.name.rsplit("-",1)[-1], "CFBundleName":"且记生命周期验证", "CFBundlePackageType":"APPL"}))
executable = contents / "MacOS/LifecycleProbe"
subprocess.run(["xcrun","swiftc","-module-cache-path","/private/tmp/qieji-lifecycle-module-cache",
    str(output / "main.swift"),str(output / "TaskReminderScheduler.swift")]
    + [str(root / "Sources/PaperEdgeApp" / name) for name in ["TaskBackupStore.swift","PackageVerifier.swift","WebPrintSession.swift","NotificationSettingsLink.swift","MenuBarIcon.swift"]]
    + ["-o",str(executable)],check=True)
cases = ["manual","login","crash-side","crash-paper","crash-collapsed","crash-loop"]
if mutation == "startup": cases = ["manual","login"]
if mutation == "recovery": cases = ["crash-side"]
valid = True
for case in cases:
    run = output / case
    (run / "Data").mkdir(parents=True)
    task = {"id":"original","text":"原有合成任务","group":"today","done":False}
    (run / "Data/workspace.json").write_text(json.dumps({"version":2,"tasks":[task],"trash":[
        {"id":"trash","task":{**task,"id":"deleted"},"index":0,"deletedAt":100}]}))
    with (run / "runtime.log").open("w") as log:
        result = subprocess.run([str(executable),str(run),case],stdout=log,stderr=log,timeout=25)
    detail = json.loads((run / "result.json").read_text()) if (run / "result.json").exists() else {}
    passed = result.returncode == 0 and detail.get("valid") is True
    print(case, "PASS" if passed else "FAIL", detail, flush=True)
    valid = valid and passed
raise SystemExit(0 if valid else 1)
