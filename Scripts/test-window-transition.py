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
        if event == "canvasPrepared" && target {
            probeResults.append(["case": "opening-viewport-hidden",
                "valid": (webView.layer?.opacity ?? 1) == 0])
            // The small path must stay at its previous screen position when
            // its transparent hosting window expands before the animation.
            if paperLayer.path!.boundingBoxOfPath.width < PanelLayout.closedWidth + 1 {
                samplePaper("opening-paper-handoff")
            }
        }
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
                self.checkTabPosition(0)
            }
        }
    }
    func checkTabPosition(_ index: Int) {
        tabCenterFraction = [CGFloat(0.2), 0.5, 0.8][index]
        // Place the collapsed tab first, just as dragging it does. Changing
        // the fraction on an already-open canvas would create a false offset.
        setDisplayMode(.side, open: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.probeToggle(open: true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.85) {
            self.probeToggle(open: false)
            for delay in [0.10, 0.18] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    self.sampleTab("close-\(index)-\(delay)", expected: "hidden")
                }
            }
            for delay in [0.04, 0.08, 0.12, 0.20, 0.24, 0.28, 0.34, 0.44, 0.55] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    self.samplePaper("closing-paper-\(index)-\(delay)")
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
                self.sampleTab("closed-\(index)", expected: "aligned")
                self.webView.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                       let png = bitmap.representation(using: .png, properties: [:]) {
                        try? png.write(to: probeOutput.appendingPathComponent("closed-\(index).png"))
                    }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                self.probeToggle(open: true)
                for delay in [0.03, 0.08, 0.18] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                        self.sampleTab("opening-\(index)-\(delay)", expected: "hidden")
                        self.sampleOpenContent("opening-content-\(index)-\(delay)", visible: false)
                    }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) {
                self.sampleOpenContent("opened-content-\(index)", visible: true)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.45) {
                if index < 2 { self.checkTabPosition(index + 1) }
                else { self.checkInterruptedTabMotion() }
            }
        }
    }
    func probeToggle(open: Bool) {
        webView.evaluateJavaScript("window.paperEdgeSetOpen(\(open ? "true" : "false"))")
        setPanel(open: open, animated: true)
    }
    func samplePaper(_ name: String) {
        guard let layer = paperLayer.presentation() ?? paperLayer,
              let path = layer.path else { return }
        let parent = containerView.layer?.presentation() ?? containerView.layer
        let localRect = layer.convert(path.boundingBoxOfPath, to: parent)
        let actual = localRect.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
        let closedFrame = frameForPanel(open: false)
        let expected = surfaceFrame(in: closedFrame).offsetBy(dx: closedFrame.minX, dy: closedFrame.minY)
        let compact = panel.frame.width <= closedFrame.width + 1
        let error = max(abs(actual.minX - expected.minX), abs(actual.minY - expected.minY),
                        abs(actual.width - expected.width), abs(actual.height - expected.height))
        let geometryAnimations = (paperLayer.animationKeys() ?? []).filter { ["position", "bounds"].contains($0) }
        let small = abs(actual.width - expected.width) < 1 && abs(actual.height - expected.height) < 1
        probeResults.append(["case": name, "compact": compact, "error": error,
            "actual": NSStringFromRect(actual), "expected": NSStringFromRect(expected),
            "panelFrame": NSStringFromRect(panel.frame), "requestedOpenFrame": NSStringFromRect(frameForPanel(open: true)),
            "layerFrame": NSStringFromRect(layer.frame), "layerBounds": NSStringFromRect(layer.bounds),
            "animations": paperLayer.animationKeys() ?? [],
            "valid": (!small || error < 1) && (!compact || geometryAnimations.isEmpty)])
    }
    func sampleTab(_ name: String, expected: String) {
        let targetCenter = frameForPanel(open: false).midY
        let webTop = panel.frame.minY + webView.frame.maxY
        let nativeOpacity = webView.layer?.presentation()?.opacity ?? webView.layer?.opacity ?? 1
        webView.evaluateJavaScript("""
        (() => {
          const tab = document.querySelector('.edge-tab'), rect = tab.getBoundingClientRect(), css = getComputedStyle(tab);
          return {center: rect.top + rect.height / 2, opacity: Number(css.opacity),
            visibility: css.visibility, viewport: innerHeight};
        })()
        """) { value, error in
            let dom = value as? [String: Any] ?? [:]
            let hidden = nativeOpacity < 0.01 || dom["visibility"] as? String == "hidden" || (dom["opacity"] as? Double ?? 1) < 0.01
            let center = webTop - (dom["center"] as? Double ?? 0)
            let aligned = !hidden && abs(center - targetCenter) < 1
                && (dom["opacity"] as? Double ?? 0) > 0.99
            probeResults.append(["case": name, "dom": dom, "nativeOpacity": nativeOpacity, "targetCenter": targetCenter,
                "tabCenter": center, "valid": error == nil && (expected == "hidden" ? hidden : aligned)])
        }
    }
    func sampleOpenContent(_ name: String, visible: Bool) {
        let opacity = webView.layer?.presentation()?.opacity ?? webView.layer?.opacity ?? 1
        let frame = webView.frame
        let expectedFrame = surfaceFrame(open: true)
        webView.evaluateJavaScript("""
        (() => { const p=document.querySelector('.side-panel'), r=p.getBoundingClientRect(), c=getComputedStyle(p);
          return {opacity: Number(c.opacity), top: r.top, viewport: innerHeight}; })()
        """) { value, error in
            let dom = value as? [String: Any] ?? [:]
            let cssOpacity = dom["opacity"] as? Double ?? 1
            let ready = opacity > 0.99 && cssOpacity > 0.99
                && abs(frame.minY - expectedFrame.minY) < 1
                && abs(frame.height - expectedFrame.height) < 1
                && abs(dom["top"] as? Double ?? 999) < 1
            probeResults.append(["case": name, "nativeOpacity": opacity, "dom": dom,
                "valid": error == nil && (visible ? ready : opacity * Float(cssOpacity) < 0.01)])
        }
    }
    func checkInterruptedTabMotion() {
        probeToggle(open: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) { self.probeToggle(open: true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { self.probeToggle(open: false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { self.sampleTab("rapid-toggle-hidden", expected: "hidden") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.65) { self.sampleTab("rapid-toggle-final", expected: "aligned") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.85) {
            // Covers the same immediate path used for reduced motion and recovery.
            self.setDisplayMode(.side, open: false)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.15) { self.sampleTab("immediate-closed", expected: "aligned") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
            let valid = probeResults.allSatisfy { $0["valid"] as? Bool == true }
            let data = try! JSONSerialization.data(withJSONObject: probeResults, options: [.prettyPrinted, .sortedKeys])
            try! data.write(to: probeOutput.appendingPathComponent("results.json"))
            print(String(data: data, encoding: .utf8)!)
            exit(valid ? 0 : 1)
        }
    }
}
'''
source = source.replace('private let application = NSApplication.shared', probe + '\nprivate let application = NSApplication.shared')
source = source.replace('application.run()', 'DispatchQueue.global().asyncAfter(deadline: .now() + 30) { exit(3) }\napplication.run()')
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
result = subprocess.run([str(executable)], timeout=35)
raise SystemExit(result.returncode)
