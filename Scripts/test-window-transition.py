#!/usr/bin/env python3
"""Run the actual native window code with isolated data and transition probes."""
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
output = Path(tempfile.mkdtemp(prefix="qieji-window-transition-", dir="/private/tmp"))
app = output / "TransitionProbe.app"
contents = app / "Contents"
executable = contents / "MacOS/TransitionProbe"
executable.parent.mkdir(parents=True)
resources = contents / "Resources/PaperEdge_PaperEdgeApp.bundle"
shutil.copytree(root / "Sources/PaperEdgeApp/Resources", resources)
shutil.copytree(root / "Sources/PaperEdgeApp/MacResources", resources / "MacResources")
(contents / "Info.plist").write_bytes(plistlib.dumps({
    "CFBundleExecutable": "TransitionProbe", "CFBundleName": "TransitionProbe",
    "CFBundleIdentifier": "local.qieji.transition." + output.name.rsplit("-", 1)[-1],
    "CFBundlePackageType": "APPL",
}))

source = (root / "Sources/PaperEdgeApp/main.swift").read_text()
# Test substitutions isolate persistence/services; window methods remain production code.
source = source.replace("?? Bundle.module", "?? Bundle.main")
source = source.replace("configuration.websiteDataStore = .default()", "configuration.websiteDataStore = .nonPersistent()")
assert 'private let taskBackupStore = TaskBackupStore()' in source
source = source.replace('private let taskBackupStore = TaskBackupStore()',
                        'private let taskBackupStore = TaskBackupStore(directoryURL: probeOutput.appendingPathComponent("Data", isDirectory: true))')
source = source.replace('UserDefaults.standard', 'probeDefaults')
source = source.replace('import WebKit', '''import WebKit
private let probeOutput = URL(fileURLWithPath: PROBE_OUTPUT)
private let probeDefaults = UserDefaults(suiteName: "local.qieji.transition." + UUID().uuidString)!
private var probeEvents: [[String: Any]] = []
private var probeResults: [[String: Any]] = []
private let probeStart = ProcessInfo.processInfo.systemUptime
'''.replace('PROBE_OUTPUT', json.dumps(str(output))))
source = source.replace('private func setPanel(open: Bool, animated: Bool) {',
                        'private func setPanel(open: Bool, animated: Bool) {\n        traceWindow("panelMessage", target: open)')
source = source.replace('private func setDisplayMode(_ mode: DisplayMode, open: Bool = true) {',
                        'private func setDisplayMode(_ mode: DisplayMode, open: Bool = true) {\n        traceWindow("mode-" + mode.rawValue, target: open)')
source = source.replace('private func animatePaperSurface(open: Bool) {',
                        'private func animatePaperSurface(open: Bool) {\n        traceWindow("animation", target: open)')
source = source.replace('        panel.displayIfNeeded()\n        return wasCollapsed',
                        '        panel.displayIfNeeded()\n        traceWindow("canvasPrepared", target: isPanelOpen)\n        return wasCollapsed')
source = source.replace('private func finishClosedState() {',
                        'private func finishClosedState() {\n        traceWindow("finishClosed", target: false)')
startup_end = '        if !loginLaunch { NSApp.activate(ignoringOtherApps: true) }'
assert startup_end in source
source = source.replace(startup_end,
                        startup_end + '\n        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.runProbeRound(0) }', 1)

probe = r'''
private extension AppDelegate {
    func traceWindow(_ event: String, target: Bool) {
        probeEvents.append(["event": event, "target": target, "openBefore": isPanelOpen,
            "width": panel?.frame.width ?? 0, "height": panel?.frame.height ?? 0,
            "time": ProcessInfo.processInfo.systemUptime - probeStart])
    }
    func runProbeRound(_ round: Int) {
        setDisplayMode(.paper)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
            probeEvents = []
            if round == 1 {
                self.paperWindow?.performClose(nil)
            } else {
                self.webView.evaluateJavaScript("document.querySelector('[aria-label=\"收起到侧边\"]').click()")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) {
                let redundantAnimations = probeEvents.filter { ($0["event"] as? String) == "animation" }
                let name = round == 1 ? "window-close" : "toolbar-collapse-\(round)"
                probeResults.append(["case": name, "events": probeEvents,
                    "width": self.panel.frame.width,
                    "valid": self.displayMode == .side && !self.isPanelOpen
                        && abs(self.panel.frame.width - (PanelLayout.closedWidth + PanelChrome.shadowInset)) < 0.1
                        && redundantAnimations.isEmpty])
                if round < 2 { self.runProbeRound(round + 1) }
                else { self.checkFocus() }
            }
        }
    }
    func checkFocus() {
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(webView)
        NSApp.activate(ignoringOtherApps: true)
        webView.evaluateJavaScript("""
        (() => {
          const root=document.documentElement, tab=document.querySelector('.edge-tab'), count=tab.querySelector('.edge-tab-count');
          tab.focus(); root.dataset.inputMethod='pointer';
          const pointer={focused:document.activeElement===tab, outline:getComputedStyle(tab).outlineWidth};
          root.dataset.inputMethod='keyboard';
          const keyboard={focused:document.activeElement===tab, documentFocused:document.hasFocus(), cssFocus:tab.matches(':focus'), outline:getComputedStyle(count).outlineWidth, style:getComputedStyle(count).outlineStyle};
          root.dataset.inputMethod='pointer';
          return {pointer,keyboard};
        })()
        """) { value, error in
            let result = value as? [String: Any] ?? [:]
            let pointer = result["pointer"] as? [String: Any] ?? [:]
            let keyboard = result["keyboard"] as? [String: Any] ?? [:]
            probeResults.append(["case": "pointer-focus", "result": result,
                "keyboardVerified": keyboard["documentFocused"] as? Bool == true
                    && keyboard["outline"] as? String == "2px"
                    && keyboard["style"] as? String == "solid",
                "valid": error == nil && pointer["focused"] as? Bool == true
                    && pointer["outline"] as? String == "0px"])
            self.webView.takeSnapshot(with: nil) { image, _ in
                if let tiff = image?.tiffRepresentation,
                   let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: probeOutput.appendingPathComponent("pointer-tab.png"))
                }
                self.checkNormalToggle()
            }
        }
    }
    func checkNormalToggle() {
        probeEvents = []
        webView.evaluateJavaScript("document.querySelector('.edge-tab').click()")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
            let open = self.isPanelOpen && self.panel.frame.width > 400
            self.webView.evaluateJavaScript("document.querySelector('[aria-label=\"收起到侧边\"]').click()")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
                probeResults.append(["case": "normal-side-toggle", "events": probeEvents,
                    "valid": open && !self.isPanelOpen && self.panel.frame.width < 100])
                let valid = probeResults.allSatisfy { $0["valid"] as? Bool == true }
                let data = try! JSONSerialization.data(withJSONObject: probeResults, options: [.prettyPrinted, .sortedKeys])
                try! data.write(to: probeOutput.appendingPathComponent("results.json"))
                print(String(data: data, encoding: .utf8)!)
                exit(valid ? 0 : 1)
            }
        }
    }
}
'''
source = source.replace('private let application = NSApplication.shared', probe + '\nprivate let application = NSApplication.shared')
source = source.replace('application.run()', 'DispatchQueue.global().asyncAfter(deadline: .now() + 20) { exit(3) }\napplication.run()')
(output / "main.swift").write_text(source)
# The test app never schedules notifications or reads application reminder state.
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
print("Window transition verification:", output, flush=True)
subprocess.run(["xcrun", "swiftc", "-module-cache-path", "/private/tmp/qieji-transition-module-cache",
                str(output / "main.swift"), str(output / "TaskReminderScheduler.swift"),
                str(root / "Sources/PaperEdgeApp/TaskBackupStore.swift"),
                str(root / "Sources/PaperEdgeApp/PackageVerifier.swift"),
                str(root / "Sources/PaperEdgeApp/WebPrintSession.swift"),
                str(root / "Sources/PaperEdgeApp/NotificationSettingsLink.swift"),
                str(root / "Sources/PaperEdgeApp/MenuBarIcon.swift"), "-o", str(executable)], check=True)
result = subprocess.run([str(executable)], timeout=25)
raise SystemExit(result.returncode)
