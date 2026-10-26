import AppKit
import WebKit

// Internal package smoke check. Entered before AppDelegate is initialized so it
// does not initialize the user's task store, notification scheduler or login item.
final class PackageVerifier: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var web: WKWebView!
    private var started = false

    static func run() -> Never {
        let app = NSApplication.shared, verifier = PackageVerifier()
        app.setActivationPolicy(.accessory)
        app.delegate = verifier
        app.run()
        exit(3)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) { exit(3) }
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("PaperEdge_PaperEdgeApp.bundle"),
              let bundle = Bundle(url: root), let resources = bundle.resourceURL,
              let index = bundle.url(forResource: "index", withExtension: "html"),
              let help = bundle.url(forResource: "help", withExtension: "html"),
              let helpText = try? String(contentsOf: help, encoding: .utf8),
              helpText.contains("完成任务后停止"), helpText.contains("不随日期自动移动"),
              FileManager.default.fileExists(atPath: resources.appendingPathComponent("MacResources/QieJiPaper-Regular.ttf").path),
              FileManager.default.fileExists(atPath: resources.appendingPathComponent("MacResources/ZhuqueFangsong-OFL.txt").path),
              let notices = try? String(contentsOf: resources.appendingPathComponent("vendor/THIRD_PARTY_NOTICES.txt"), encoding: .utf8),
              notices.contains("Copyright (c) Facebook, Inc. and its affiliates."),
              notices.contains("Permission is hereby granted, free of charge"),
              notices.contains("OUT OF OR IN CONNECTION WITH THE SOFTWARE")
        else { fputs("Package resources missing\n", stderr); exit(2) }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "paperEdge")
        config.userContentController.addUserScript(WKUserScript(source: """
        const memory=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v))}});
        window.__QIEJI_DISPLAY_MODE__='side';window.__QIEJI_PANEL_OPEN__=true;
        window.__QIEJI_NATIVE_WORKSPACE__={version:2,tasks:[{id:'package-check',text:'安装包合成任务',group:'today',done:false}],trash:[]};
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 430, height: 720), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "且记 · 安装包验证 · 合成数据"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        var url = URLComponents(url: index, resolvingAgainstBaseURL: false)!
        url.query = "native=1"
        web.loadFileURL(url.url!, allowingReadAccessTo: resources)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }; started = true
        web.callAsyncJavaScript("""
        for(let i=0;i<100&&typeof window.paperEdgeExportWorkspace!=='function';i++)await new Promise(r=>setTimeout(r,30));
        await document.fonts.load('16px "QieJi Paper"');await document.fonts.ready;
        const row=document.querySelector('[data-task-id="package-check"]');
        const exported=window.paperEdgeExportWorkspace();
        return {valid:!!row&&exported.format==='qieji-workspace'&&exported.tasks.length===1&&exported.tasks[0].text==='安装包合成任务',
          tasks:exported.tasks.length,fontLoaded:document.fonts.check('16px "QieJi Paper"')};
        """, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                let object = value as? [String: Any] ?? [:]
                let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
                print("Package smoke: " + String(data: data, encoding: .utf8)!)
                exit(object["valid"] as? Bool == true && object["fontLoaded"] as? Bool == true ? 0 : 1)
            case .failure(let error): fputs("Package smoke failed: \(error)\n", stderr); exit(1)
            }
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
}
