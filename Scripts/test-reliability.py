#!/usr/bin/env python3
"""Exercise the generated UI and the real native quit/save path with synthetic data."""
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
output = Path(tempfile.mkdtemp(prefix="qieji-reliability-", dir="/private/tmp"))
resources = output / "resources"
shutil.copytree(root / "Sources/PaperEdgeApp/Resources", resources)
shutil.copytree(root / "Sources/PaperEdgeApp/MacResources", resources / "MacResources")
print("Reliability verification:", output, flush=True)

compiler = ["xcrun", "swiftc", "-module-cache-path", "/private/tmp/qieji-reliability-module-cache"]
subprocess.run(compiler + ["-parse-as-library", str(root / "Scripts/verify-reliability.swift"),
                          "-o", str(output / "verify-ui")], check=True)
ui = output / "ui"
ui.mkdir()
with (ui / "runtime.log").open("w") as log:
    result = subprocess.run([str(output / "verify-ui"), str(resources), str(ui)],
                            stdout=log, stderr=log, timeout=45)
ui_result = json.loads((ui / "results.json").read_text()) if (ui / "results.json").exists() else {}
print("UI:", [(case["name"], case["valid"]) for case in ui_result.get("cases", [])], flush=True)
if result.returncode != 0 or not ui_result.get("valid"):
    raise SystemExit("UI regression failed; see " + str(ui / "runtime.log"))

for label, flags in [("ux", []), ("help", ["--help-page"])]:
    ux = output / label
    ux.mkdir()
    with (ux / "runtime.log").open("w") as log:
        ux_run = subprocess.run([str(output / "verify-ui"), str(resources), str(ux),
                                 str(root / "Scripts/ux-checks.js")] + flags,
                                stdout=log, stderr=log, timeout=65)
    ux_result = json.loads((ux / "results.json").read_text()) if (ux / "results.json").exists() else {}
    print(label, [(case["name"], case["valid"]) for case in ux_result.get("cases", [])], flush=True)
    if ux_run.returncode != 0 or not ux_result.get("valid") or not ux_result.get("cases"):
        raise SystemExit(label + " regression failed; see " + str(ux / "runtime.log"))

# Only persistence location, defaults, and OS notification scheduling are isolated.
# Window code, readiness handshake, editor flush, shouldTerminate, and file writes
# are the actual production implementation. Quit success must exit normally;
# failed disk writes must cancel termination and leave the edited text available.
native = output / "native"
native.mkdir()
source = (root / "Sources/PaperEdgeApp/main.swift").read_text()
source = source.replace("?? Bundle.module", "?? Bundle.main")
source = source.replace("configuration.websiteDataStore = .default()", "configuration.websiteDataStore = .nonPersistent()")
assert 'private let taskBackupStore = TaskBackupStore()' in source
source = source.replace('private let taskBackupStore = TaskBackupStore()',
                        'private let taskBackupStore = TaskBackupStore(directoryURL: probeOutput.appendingPathComponent("Data", isDirectory: true))')
source = source.replace("UserDefaults.standard", "probeDefaults")
source = source.replace("import WebKit", """import WebKit
private let probeOutput = URL(fileURLWithPath: CommandLine.arguments[1])
private let probeFailSave = CommandLine.arguments.contains("--fail-save")
private let probeDefaults: UserDefaults = {
    let value = UserDefaults(suiteName: "local.qieji.reliability." + UUID().uuidString)!
    value.set(false, forKey: "QieJi.panelOpen")
    return value
}()
private var probeSaveErrors = [String]()
private var probeLaunchedClosed = false
private var probeClickQueuedBeforeReady = false
""")
source = source.replace("        loadInterface()", """
        probeLaunchedClosed = !isPanelOpen && panel.frame.width < 100
        probeClickQueuedBeforeReady = !interfaceReady
        reminderScheduler.onOpenTask?("target")
        reminderScheduler.onCompleteTask?("filler-0")
        reminderScheduler.onSnoozeTask?("target")
        loadInterface()""", 1)
source = source.replace("        alert.runModal()", "        probeSaveErrors.append(message)", 1)

probe = r'''
private extension AppDelegate {
    func runReliabilityProbe(_ attempt: Int = 0) {
        guard interfaceReady else {
            if attempt > 100 { exit(5) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.runReliabilityProbe(attempt + 1) }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.webView.callAsyncJavaScript("""
            const target=document.querySelector('[data-task-id="target"]');
            const rect=target.getBoundingClientRect(),scroll=document.querySelector('.task-scroll').getBoundingClientRect();
            const focused=target.contains(document.activeElement);
            const open=document.querySelector('.app-screen').dataset.open==='true';
            const inView=rect.top>=scroll.top&&rect.bottom<=scroll.bottom;
            const saved=window.paperEdgePrepareToQuit();
            const queuedTask=saved.tasks.find(t=>t.id==='target');
            const queuedActions=saved.tasks.find(t=>t.id==='filler-0')?.done===true
              &&queuedTask.repeat==='daily'&&queuedTask.remindAt==='2020-01-01T01:00:00Z'
              &&Math.abs(new Date(queuedTask.snoozedUntil).getTime()-Date.now()-900000)<5000;
            target.querySelector('.task-copy').click();
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            document.querySelector('.task-edit').textContent='退出前未失焦的合成编辑';
            return {focused,open,inView,queuedActions};
            """, arguments: [:], in: nil, in: .page) { result in
                guard case .success(let value) = result, let result = value as? [String: Any] else { exit(6) }
                let valid = probeLaunchedClosed && probeClickQueuedBeforeReady && self.isPanelOpen
                    && result["focused"] as? Bool == true && result["open"] as? Bool == true
                    && result["inView"] as? Bool == true && result["queuedActions"] as? Bool == true
                let detail: [String: Any] = ["launchedClosed": probeLaunchedClosed,
                    "queuedBeforeReady": probeClickQueuedBeforeReady, "notification": result, "valid": valid]
                try! JSONSerialization.data(withJSONObject: detail, options: [.prettyPrinted, .sortedKeys])
                    .write(to: probeOutput.appendingPathComponent("before-quit.json"))
                guard valid else { exit(7) }
                if probeFailSave {
                    try! FileManager.default.moveItem(at: probeOutput.appendingPathComponent("Data/workspace.json"),
                        to: probeOutput.appendingPathComponent("Data/before-failure.json"))
                    try! FileManager.default.createDirectory(at: probeOutput.appendingPathComponent("Data/workspace.json"), withIntermediateDirectories: true)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                        self.webView.evaluateJavaScript("window.QieJi.taskStorage.readWorkspace ? document.querySelector('[data-task-id=target] .task-copy')?.textContent : null") { value, error in
                            let retained = error == nil && value as? String == "退出前未失焦的合成编辑"
                            let valid = !self.terminationPending && !probeSaveErrors.isEmpty && retained
                            let result: [String: Any] = ["valid": valid, "errors": probeSaveErrors, "retained": retained]
                            try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
                                .write(to: probeOutput.appendingPathComponent("cancelled-quit.json"))
                            exit(valid ? 0 : 8)
                        }
                    }
                }
                if probeFailSave { self.quitApp() }
                else { self.checkNativeDataTools() }
            }
        }
    }
    func checkNativeDataTools() {
        let exportURL = probeOutput.appendingPathComponent("exported.json")
        exportTasks(to: exportURL) { exported in
            guard exported else { exit(9) }
            self.previewImport(from: probeOutput.appendingPathComponent("import.json")) { preview in
                guard let preview, let summary = preview["summary"] as? [String: Any],
                      summary["tasks"] as? Int == 1, summary["trash"] as? Int == 1,
                      summary["conflicts"] as? Int == 1 else { exit(10) }
                self.applyImport(preview) { applied in
                    guard applied else { exit(11) }
                    let titles = self.statusItem.menu?.items.map { $0.title } ?? []
                    let menuValid = ["导出任务…", "导入任务…", "在 Finder 中显示备份"].allSatisfy { titles.contains($0) }
                    let helpValid = NSApp.helpMenu?.items.contains(where: { $0.title == "使用说明" && $0.action == #selector(self.showHelp) }) == true
                        && self.helpURL?.isFileURL == true
                        && FileManager.default.fileExists(atPath: self.helpURL?.path ?? "")
                    let result: [String: Any] = ["valid": menuValid && helpValid, "summary": summary,
                        "menuValid": menuValid, "helpMenuAndResourceValid": helpValid]
                    try! JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
                        .write(to: probeOutput.appendingPathComponent("data-tools.json"))
                    guard menuValid && helpValid else { exit(12) }
                    self.webView.callAsyncJavaScript("""
                    document.querySelector('[data-task-id="target"] .task-copy').click();
                    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
                    document.querySelector('.task-edit').textContent='退出前未失焦的合成编辑';
                    """, arguments: [:], in: nil, in: .page) { _ in self.quitApp() }
                }
            }
        }
    }
}
'''
source = source.replace("private let application = NSApplication.shared", probe + "\nprivate let application = NSApplication.shared")
source = source.replace("application.run()", """
DispatchQueue.global().asyncAfter(deadline: .now() + 20) { exit(3) }
DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { delegate.runReliabilityProbe() }
application.run()""")
(native / "main.swift").write_text(source)
(native / "TaskReminderScheduler.swift").write_text("""import Foundation
final class TaskReminderScheduler {
 var onOpen: (() -> Void)?
 var onOpenTask: ((String) -> Void)?
 var onCompleteTask: ((String) -> Void)?
 var onSnoozeTask: ((String) -> Void)?
 var onStatus: ((String) -> Void)?
 func sync(tasks: Any?) {}
 func refresh() {}
}
""")
app = native / "ReliabilityProbe.app"
contents = app / "Contents"
(contents / "MacOS").mkdir(parents=True)
shutil.copytree(resources, contents / "Resources/PaperEdge_PaperEdgeApp.bundle")
(contents / "Info.plist").write_bytes(plistlib.dumps({
    "CFBundleExecutable": "ReliabilityProbe", "CFBundleName": "ReliabilityProbe",
    "CFBundleIdentifier": "local.qieji.reliability." + output.name.rsplit("-", 1)[-1],
    "CFBundlePackageType": "APPL",
}))
executable = contents / "MacOS/ReliabilityProbe"
subprocess.run(compiler + [str(native / "main.swift"), str(native / "TaskReminderScheduler.swift"),
                           str(root / "Sources/PaperEdgeApp/TaskBackupStore.swift"),
                           str(root / "Sources/PaperEdgeApp/PackageVerifier.swift"),
                           str(root / "Sources/PaperEdgeApp/WebPrintSession.swift"),
                           str(root / "Sources/PaperEdgeApp/NotificationSettingsLink.swift"),
                           str(root / "Sources/PaperEdgeApp/MenuBarIcon.swift"),
                           "-o", str(executable)], check=True)
for fail in [False, True]:
    run = native / ("disk-failure" if fail else "normal-quit")
    (run / "Data").mkdir(parents=True)
    workspace = {"version": 2, "trash": [], "tasks": [
        {"id": "filler-" + str(i), "text": "合成占位任务 " + str(i), "group": "today", "done": False}
        for i in range(28)] + [{"id": "target", "text": "通知目标任务", "group": "upcoming", "done": False,
            "repeat": "daily", "remindAt": "2020-01-01T01:00:00Z"}]}
    # Failure fixture uses tasks.json migration, reserving workspace.json as an
    # unwritable directory only immediately before the actual quit request.
    (run / "Data" / ("tasks.json" if fail else "workspace.json")).write_text(
        json.dumps(workspace["tasks"] if fail else workspace, ensure_ascii=False))
    (run / "import.json").write_text(json.dumps({"version": 2, "tasks": [
        {"id": "target", "text": "旧冲突内容", "group": "today", "done": False},
        {"id": "native-new", "text": "原生导入合成任务", "group": "upcoming", "done": False}],
        "trash": [{"id": "native-trash", "task": {"id": "native-deleted", "text": "原生导入回收记录", "group": "today", "done": False}, "index": 0, "deletedAt": 100}]}))
    with (run / "runtime.log").open("w") as log:
        result = subprocess.run([str(executable), str(run)] + (["--fail-save"] if fail else []),
                                stdout=log, stderr=log, timeout=25)
    before = json.loads((run / "before-quit.json").read_text()) if (run / "before-quit.json").exists() else {}
    if fail:
        detail = json.loads((run / "cancelled-quit.json").read_text()) if (run / "cancelled-quit.json").exists() else {}
        valid = detail.get("valid") is True
    else:
        saved = json.loads((run / "Data/workspace.json").read_text())
        valid = next(task for task in saved["tasks"] if task["id"] == "target")["text"] == "退出前未失焦的合成编辑"
        exported = json.loads((run / "exported.json").read_text())
        checkpoints = list((run / "Data/Backups").glob("*.json"))
        checkpoint = json.loads(checkpoints[0].read_text()) if len(checkpoints) == 1 else {}
        data_tools = json.loads((run / "data-tools.json").read_text())
        valid = valid and exported["format"] == "qieji-workspace" and len(exported["tasks"]) == 29 \
            and len(saved["tasks"]) == 30 and len(saved["trash"]) == 1 and len(checkpoint.get("tasks", [])) == 29 \
            and data_tools.get("valid") is True
    print(run.name, {"exit": result.returncode, "notification": before, "saved_or_cancelled": valid}, flush=True)
    if result.returncode != 0 or not before.get("valid") or not valid:
        raise SystemExit("Native regression failed; see " + str(run / "runtime.log"))
print("PASS: isolated UI, cold notification handoff, quit persistence, and failed-save cancellation.")
