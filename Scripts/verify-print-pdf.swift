import AppKit
import PDFKit
import WebKit

// Compile alongside Sources/PaperEdgeApp/WebPrintSession.swift. Synthetic data only.
final class PrintPDFVerification: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    let arguments = CommandLine.arguments
    let session = WebPrintSession()
    var web: WKWebView!
    var window: NSWindow!
    var tasks: [[String: Any]] = []
    var started = false
    var attempt = 1
    var results: [[String: Any]] = []
    var reminderStateBefore = ""
    var screenRemindersBefore = false
    var fixture: String { value("--case") ?? "basic" }
    var output: URL { URL(fileURLWithPath: value("--output")!) }
    var pdfURL: URL { output.appendingPathComponent("\(fixture)-\(attempt).pdf") }
    func value(_ flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A process-wide deadline also stops the synchronous negative control.
        let deadline: Double = arguments.contains("--dialog") ? 300 : 40
        DispatchQueue.global().asyncAfter(deadline: .now() + deadline) { exit(3) }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        if fixture != "basic" {
            tasks = makeTasks()
            let workspace: [String: Any] = ["version": 2, "tasks": tasks, "trash": []]
            let data = try! JSONSerialization.data(withJSONObject: workspace)
            let json = String(data: data, encoding: .utf8)!
            let bootstrap = """
            const memory = new Map();
            Object.defineProperty(window, 'localStorage', {value: {
              getItem:k=>memory.get(k)??null, setItem:(k,v)=>memory.set(k,String(v)),
              removeItem:k=>memory.delete(k), clear:()=>memory.clear()
            }});
            window.__QIEJI_NATIVE_WORKSPACE__ = \(json);
            window.__QIEJI_DISPLAY_MODE__ = '\(fixture == "side" ? "side" : "paper")';
            """
            configuration.userContentController.addUserScript(WKUserScript(
                source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
        }
        let width = fixture == "side" ? 430 : 680
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: 720), configuration: configuration)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "且记 PDF 验证 · \(fixture) · 合成任务"
        window.contentView = web
        window.orderFront(nil)
        if arguments.contains("--dialog") { NSApp.activate(ignoringOtherApps: true) }
        if fixture == "basic" {
            web.loadHTMLString("<!doctype html><html><body><h1>Print baseline</h1><p>Task one 123456</p><p>Task two</p></body></html>", baseURL: nil)
        } else {
            let root = URL(fileURLWithPath: value("--resources")!, isDirectory: true)
            var url = URLComponents(url: root.appendingPathComponent("index.html"), resolvingAgainstBaseURL: false)!
            url.query = "native=1"
            web.loadFileURL(url.url!, allowingReadAccessTo: root)
        }
    }

    func makeTasks() -> [[String: Any]] {
        if fixture == "empty" { return [] }
        let count = fixture == "many" ? 120 : 6
        var list: [[String: Any]] = (1...count).map { index in
            ["id": "synthetic-\(index)", "text": "打印验证任务\(index)：检查纸面内容与分页", "group": ["today", "tomorrow", "upcoming"][(index - 1) % 3], "done": false, "createdAt": index]
        }
        list[0]["text"] = "打印验证任务1：正文中的提醒二字保留"
        list[0]["html"] = "<b>打印验证任务1：</b>正文中的提醒二字保留"
        list[0]["remindAt"] = "2020-01-01T02:00:00.000Z"
        for (index, rule) in [(1, "daily"), (2, "weekdays"), (3, "weekly")] {
            list[index]["remindAt"] = "2099-01-05T09:00:00.000Z"
            list[index]["repeat"] = rule
        }
        list[3]["snoozedUntil"] = "2099-01-06T09:15:00.000Z"
        list[4]["remindAt"] = "2099-01-05T10:30:00.000Z"
        list.append(["id": "synthetic-done", "text": "已完成样例不应打印", "group": "today", "done": true, "createdAt": 999])
        return list
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }
        started = true
        web.callAsyncJavaScript("""
        if (document.documentElement.classList.contains('native-shell')) {
          await document.fonts.load('16px "QieJi Zhuque"');
          await document.fonts.load('16px "QieJi Paper"');
        }
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__printReminderState = () => JSON.stringify((window.paperEdgePrepareToQuit?.().tasks || [])
          .map(t => [t.id, t.done, t.remindAt ?? null, t.repeat ?? null, t.snoozedUntil ?? null]));
        const reminderState = window.__printReminderState();
        // beforeprint still uses screen styles in WebKit. Observe the actual print media transition.
        window.__printVisibilitySamples = [];
        const printMedia = matchMedia('print');
        printMedia.addEventListener('change', () => {
          if (!printMedia.matches) return;
          const selectors = ['.task-reminder-meta', '.task-reminder-warning', '.task-reminder-controls',
            '.format-toolbar', '.row-actions', '.composer', '.task-row.is-done'];
          const elements = selectors.flatMap(selector => [...document.querySelectorAll(selector)]);
          window.__printVisibilitySamples.push({
            hidden: elements.every(element => getComputedStyle(element).display === 'none'),
            warningCount: document.querySelectorAll('.task-reminder-warning').length,
            visible: elements.filter(element => getComputedStyle(element).display !== 'none')
              .map(element => element.className)
          });
        });
        window.dispatchEvent(new CustomEvent('qieji-notification-status', {detail: {status: 'denied'}}));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const visible = selector => {
          const items = [...document.querySelectorAll(selector)];
          return items.length > 0 && items.every(e => getComputedStyle(e).display !== 'none');
        };
        const screenReminders = '\(fixture)' === 'basic' || '\(fixture)' === 'empty'
          || visible('.task-reminder-meta') && visible('.task-reminder-warning');
        if ('\(fixture)' === 'editing') {
          document.querySelector('.task-copy').click();
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const editor=document.querySelector('.task-edit'),range=document.createRange();
          range.selectNodeContents(editor);const selection=window.getSelection();
          selection.removeAllRanges();selection.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        }
        return {rows: document.querySelectorAll('.task-row').length, toolbar:!!document.querySelector('.format-toolbar'),
          reminderState, screenReminders};
        """, arguments: [:], in: nil, in: .page) { result in
            guard case .success(let value) = result,
                  let ready = value as? [String: Any],
                  self.fixture == "basic" || ready["rows"] as? Int == self.tasks.count,
                  self.fixture != "editing" || ready["toolbar"] as? Bool == true,
                  ready["screenReminders"] as? Bool == true
            else { fputs("Fixture not ready\n", stderr); exit(4) }
            self.reminderStateBefore = ready["reminderState"] as? String ?? ""
            self.screenRemindersBefore = ready["screenReminders"] as? Bool == true
            self.printPage()
        }
    }

    func printPage() {
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.paperSize = NSSize(width: 595, height: 842)
        info.orientation = .portrait
        let dialog = arguments.contains("--dialog")
        if !dialog {
            info.jobDisposition = .save
            info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = pdfURL
        }
        if arguments.contains("--legacy-sync") {
            info.dictionary()[NSPrintInfo.AttributeKey.allPages] = false
            info.dictionary()[NSPrintInfo.AttributeKey.firstPage] = 1
            info.dictionary()[NSPrintInfo.AttributeKey.lastPage] = 1
        }
        let operation = web.printOperation(with: info)
        operation.showsPrintPanel = dialog
        operation.showsProgressPanel = dialog
        if arguments.contains("--legacy-sync") {
            finish(operation.run())
        } else {
            guard session.run(operation, for: window, completion: { self.finish($0) }) else { exit(5) }
        }
    }

    func finish(_ success: Bool) {
        let document = PDFDocument(url: pdfURL)
        let text = document?.string ?? ""
        // Quartz may map CJK glyphs to equivalent Kangxi radicals in ToUnicode.
        func normalize(_ text: String) -> String {
            text.precomposedStringWithCompatibilityMapping
                .replacingOccurrences(of: "\\s", with: "", options: .regularExpression)
        }
        let normalized = normalize(text)
        let expected = fixture == "basic" ? ["Printbaseline", "Taskone123456", "Tasktwo"] : tasks.filter { $0["done"] as? Bool == false }.map { $0["text"] as! String }
        let missing = expected.filter { !normalized.contains(normalize($0)) }
        let pages = document?.pageCount ?? 0
        let allPagesHaveText = pages > 0 && (0..<pages).allSatisfy { !(document?.page(at: $0)?.string ?? "").isEmpty }
        let a4 = pages > 0 && (0..<pages).allSatisfy {
            let bounds = document!.page(at: $0)!.bounds(for: .mediaBox)
            return abs(bounds.width - 595) < 1 && abs(bounds.height - 842) < 1
        }
        let uncutTasks = fixture == "basic" || expected.allSatisfy { task in
            let selections = document?.findString(task, withOptions: []) ?? []
            return selections.count == 1 && selections.allSatisfy { selection in
                guard selection.pages.count == 1, let page = selection.pages.first else { return false }
                let bounds = selection.bounds(for: page)
                let paper = page.bounds(for: .mediaBox)
                return bounds.minY >= 48 && bounds.maxY <= paper.height - 40
            }
        }
        let reminderMetadataAbsent = !normalized.contains("提醒·")
        let valid = success && missing.isEmpty && allPagesHaveText && a4 && uncutTasks && reminderMetadataAbsent
            && !text.contains("已完成样例不应打印")
            && (fixture != "editing" || !text.contains("清") && !text.contains("B"))
            && (fixture != "many" || pages > 1 && pages < 20)
            && (fixture == "basic" || ["且记", "今天", "最近", "长远"].allSatisfy { normalized.contains($0) })
        web.callAsyncJavaScript("""
        // Flush an active editor first, then wait for observable screen recovery.
        const reminderState = window.__printReminderState();
        const snapshot = () => {
          const styles = selector => [...document.querySelectorAll(selector)]
            .map(element => ({display: getComputedStyle(element).display,
              visibility: getComputedStyle(element).visibility}));
          const meta = styles('.task-reminder-meta'), warning = styles('.task-reminder-warning');
          const visible = items => items.length > 0 && items.every(style =>
            style.display !== 'none' && style.visibility === 'visible');
          const printing = matchMedia('print').matches;
          const noReminders = '\(fixture)' === 'basic' || '\(fixture)' === 'empty';
          return {printing, meta, warning, ready: !printing && (noReminders || visible(meta) && visible(warning))};
        };
        const deadline = performance.now() + 2000;
        let state, stable = 0;
        do {
          state = snapshot();
          stable = state.ready ? stable + 1 : 0;
          if (stable >= 2) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (performance.now() < deadline);
        const samples = window.__printVisibilitySamples;
        window.__printVisibilitySamples = [];
        return {reminderState, screenReminders: stable >= 2, screenState: state, printSamples: samples,
          printStylesHidden: samples.length > 0 && samples.every(sample => sample.hidden)
            && ('\(fixture)' === 'basic' || '\(fixture)' === 'empty' || samples.some(sample => sample.warningCount > 0))};
        """, arguments: [:], in: nil, in: .page) { result in
            guard case .success(let value) = result, let after = value as? [String: Any] else { exit(4) }
            let reminderDataUnchanged = after["reminderState"] as? String == self.reminderStateBefore
            let screenRemindersAfter = after["screenReminders"] as? Bool == true
            let printStylesHidden = after["printStylesHidden"] as? Bool == true
            let finalValid = valid && reminderDataUnchanged && screenRemindersAfter && printStylesHidden
            self.record(valid: finalValid, success: success, pages: pages, text: text, missing: missing,
                        allPagesHaveText: allPagesHaveText, a4: a4, uncutTasks: uncutTasks,
                        reminderMetadataAbsent: reminderMetadataAbsent, reminderDataUnchanged: reminderDataUnchanged,
                        screenRemindersAfter: screenRemindersAfter, visibility: after)
        }
    }

    func record(valid: Bool, success: Bool, pages: Int, text: String, missing: [String], allPagesHaveText: Bool,
                a4: Bool, uncutTasks: Bool, reminderMetadataAbsent: Bool, reminderDataUnchanged: Bool,
                screenRemindersAfter: Bool, visibility: [String: Any]) {
        results.append(["file": pdfURL.path, "valid": valid, "success": success, "pages": pages,
                        "characters": text.count, "missing": missing, "allPagesHaveText": allPagesHaveText,
                        "a4": a4, "uncutTasks": uncutTasks, "reminderMetadataAbsent": reminderMetadataAbsent,
                        "reminderDataUnchanged": reminderDataUnchanged, "screenRemindersBefore": screenRemindersBefore,
                        "screenRemindersAfter": screenRemindersAfter,
                        "printStylesHidden": visibility["printStylesHidden"] ?? false,
                        "printSamples": visibility["printSamples"] ?? [],
                        "screenState": visibility["screenState"] ?? [:]])
        if valid && attempt == 1 && arguments.contains("--repeat") {
            attempt += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.printPage() }
            return
        }
        let data = try! JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys])
        try! data.write(to: output.appendingPathComponent("\(fixture)-result.json"))
        print(String(data: data, encoding: .utf8)!)
        exit(valid ? 0 : 1)
    }
}

@main struct PrintPDFVerificationMain {
    static func main() {
        let application = NSApplication.shared
        let delegate = PrintPDFVerification()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}
