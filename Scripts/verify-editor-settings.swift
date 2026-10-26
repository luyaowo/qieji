import AppKit
import WebKit

// Compile with NotificationSettingsLink.swift. All task data is synthetic/in-memory.
final class EditorSettingsVerification: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var results: [String: Any] = [:]
    let output = URL(fileURLWithPath: CommandLine.arguments[1])
    let resources = URL(fileURLWithPath: CommandLine.arguments[2])
    var started = false
    func applicationDidFinishLaunching(_ note: Notification) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 30) { exit(3) }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "paperEdge")
        config.userContentController.addUserScript(WKUserScript(source: """
        const memory=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k)}});
        window.__QIEJI_DISPLAY_MODE__='side';
        window.__QIEJI_NATIVE_WORKSPACE__={version:2,trash:[],tasks:[
          {id:'one',text:'检查编辑文字是否居中',group:'today',done:false,createdAt:1},
          {id:'two',text:'核对数量 123456 Abgpy',group:'today',done:false,createdAt:2},
          {id:'long',text:'检查一条自然换行的较长任务，核对编辑前后的复选框位置、首行文字基线与多行编辑框的高度是否保持一致',group:'today',done:false,createdAt:3}
        ]};
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 430, height: 720), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "且记 · 编辑与通知验证 · 合成数据"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        var url = URLComponents(url: resources.appendingPathComponent("index.html"), resolvingAgainstBaseURL: false)!
        url.query = "native=1"
        web.loadFileURL(url.url!, allowingReadAccessTo: resources)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }; started = true
        if CommandLine.arguments.contains("--collapse-only") {
            verifyCollapsedNotices()
            return
        }
        runJS("""
        await document.fonts.load('16px "QieJi Paper"');await document.fonts.ready;
        const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        await frame();
        window.verificationFrame=frame;
        window.measureEditors=async function(mode){
          const out=[];
          for(const id of ['one','two','long']){
            const row=document.querySelector(`[data-task-id="${id}"]`),copy=row.querySelector('.task-copy'),check=row.querySelector('.task-check');
            const copyTop=copy.getBoundingClientRect().top,checkTop=check.getBoundingClientRect().top;
            copy.click();await frame();
            const editor=row.querySelector('.task-edit'),r=editor.getBoundingClientRect(),s=getComputedStyle(editor),range=document.createRange();range.selectNodeContents(editor);
            const text=range.getBoundingClientRect(),height=Number.parseFloat(s.lineHeight);
            const item={mode,id,height:r.height,lineHeight:height,minHeight:s.minHeight,background:s.backgroundColor,checkboxShift:check.getBoundingClientRect().top-checkTop,textTopShift:r.top-copyTop,centerBias:text.top+text.height/2-r.top-r.height/2};
            item.valid=Math.abs(item.checkboxShift)<.1&&Math.abs(item.textTopShift)<.1&&Math.abs(item.centerBias)<1&&(id==='long'?r.height>=height*2:Math.abs(r.height-height)<.1);
            out.push(item);
            if(id==='one')window.webkit.messageHandlers.paperEdge.postMessage({type:'snapshot',name:`editor-${mode}`});
            await frame();editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await frame();
          }
          return out;
        };
        return await window.measureEditors('side');
        """) { value in
            self.results["side"] = value
            self.window.setContentSize(NSSize(width: 680, height: 820))
            self.runJS("window.paperEdgeSetMode('paper');await window.verificationFrame();return await window.measureEditors('paper');") { value in
                self.results["paper"] = value
                self.verifyNotices()
            }
        }
    }

    func verifyCollapsedNotices() {
        runJS("""
        const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const wait=ms=>new Promise(r=>setTimeout(r,ms));
        const emit=status=>window.dispatchEvent(new CustomEvent('qieji-notification-status',{detail:{status}}));
        const notify=body=>window.webkit.messageHandlers.paperEdge.postMessage(body);
        const visible=selector=>Array.from(document.querySelectorAll(selector)).some(e=>{
          const r=e.getBoundingClientRect(),s=getComputedStyle(e);
          return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0&&r.width>0&&r.height>0;
        });
        await document.fonts.ready;
        for(let i=0;i<100&&typeof window.paperEdgeSetMode!=='function';i++)await wait(50);
        if(typeof window.paperEdgeSetMode!=='function')throw new Error('React native bridge did not initialize');
        const cases=[];
        for(const mode of ['side','paper']){
          notify({type:'resizeTest',width:mode==='paper'?680:430,height:720});
          window.paperEdgeSetMode(mode);window.paperEdgeSetOpen(true);await frame();
          emit('denied');await frame();
          const shownBeforeCollapse=visible('.notification-notice');
          document.querySelector('.notification-settings-link')?.focus();
          document.querySelector('[aria-label="收起到侧边"]').click();await frame();
          notify({type:'resizeTest',width:54,height:380});await frame();await wait(300);
          const hiddenAfterCollapse=!visible('.undo-toast');
          notify({type:'snapshot',name:`collapsed-${mode}`});await frame();
          const lateStatuses=[];
          for(const status of ['denied','failed','settingsUnavailable']){
            emit(status);await frame();lateStatuses.push(!visible('.undo-toast'));
          }
          notify({type:'resizeTest',width:430,height:720});
          window.paperEdgeSetOpen(true);await frame();
          const noStaleNoticeOnReopen=!visible('.notification-notice');
          emit('failed');await frame();const freshNoticeVisible=visible('.notification-notice');
          // Native callback path (Escape / native menu), separate from toolbar click.
          window.paperEdgeSetOpen(false);await frame();
          const hiddenAfterNativeCollapse=!visible('.undo-toast');
          window.paperEdgeSetOpen(true);await frame();
          const clearedAfterNativeCollapse=!visible('.notification-notice');
          const item={mode,shownBeforeCollapse,hiddenAfterCollapse,lateStatuses,noStaleNoticeOnReopen,
            freshNoticeVisible,hiddenAfterNativeCollapse,clearedAfterNativeCollapse};
          item.valid=shownBeforeCollapse&&hiddenAfterCollapse&&lateStatuses.every(Boolean)&&noStaleNoticeOnReopen&&freshNoticeVisible&&hiddenAfterNativeCollapse&&clearedAfterNativeCollapse;
          cases.push(item);
          emit('authorized');await frame();
        }
        // Undo is hidden while collapsed, but stays usable within its original deadline.
        document.querySelector('[data-task-id="one"] .row-action.delete').click();await frame();
        const undoShown=visible('.undo-toast[role="status"]');
        window.paperEdgeSetOpen(false);await frame();const undoHidden=!visible('.undo-toast[role="status"]');
        window.paperEdgeSetOpen(true);await frame();const undoReshown=visible('.undo-toast[role="status"]');
        document.querySelector('.undo-toast[role="status"] button')?.click();await frame();
        const undoRestores=!!document.querySelector('[data-task-id="one"]');
        document.querySelector('[data-task-id="two"] .row-action.delete').click();await frame();
        window.paperEdgeSetOpen(false);await frame();await wait(4400);
        window.paperEdgeSetOpen(true);await frame();
        const undoExpired=!visible('.undo-toast[role="status"]');
        const undo={undoShown,undoHidden,undoReshown,undoRestores,undoExpired};
        undo.valid=Object.values(undo).every(Boolean);
        return {cases,undo,valid:cases.every(c=>c.valid)&&undo.valid};
        """) { value in
            let result = value as? [String:Any] ?? [:]
            try! JSONSerialization.data(withJSONObject:result, options:[.prettyPrinted,.sortedKeys]).write(to:self.output.appendingPathComponent("results.json"))
            let valid = result["valid"] as? Bool == true
            print("Collapse verification output: \(self.output.path); valid=\(valid)")
            exit(valid ? 0 : 1)
        }
    }

    func verifyNotices() {
        runJS("""
        const emit=status=>window.dispatchEvent(new CustomEvent('qieji-notification-status',{detail:{status}}));
        const frame=window.verificationFrame;emit('denied');await frame();
        const notice=document.querySelector('.notification-notice'),button=notice?.querySelector('[aria-label="打开且记通知设置"]');
        const r=notice?.getBoundingClientRect(),b=button?.getBoundingClientRect();
        const denied={button:!!button,text:notice?.innerText,fits:!!r&&!!b&&b.right<=r.right&&r.left>=0&&r.right<=innerWidth};
        window.webkit.messageHandlers.paperEdge.postMessage({type:'snapshot',name:'notification-paper'});await frame();
        emit('failed');await frame();const failed={button:!!document.querySelector('.notification-settings-link'),visible:!!document.querySelector('.notification-notice')};
        emit('authorized');await frame();const cleared=!document.querySelector('.notification-notice');
        emit('settingsUnavailable');await frame();const unavailable=!!document.querySelector('.notification-notice')&&!document.querySelector('.notification-settings-link');
        emit('denied');await frame();
        return {denied,failed,cleared,unavailable,valid:denied.button&&denied.fits&&failed.visible&&!failed.button&&cleared&&unavailable};
        """) { value in
            self.results["notices"] = value
            self.window.setContentSize(NSSize(width: 430, height: 720))
            self.runJS("""
            window.paperEdgeSetMode('side');await window.verificationFrame();
            const button=document.querySelector('.notification-settings-link');
            button.focus();await new Promise(r=>setTimeout(r,5200));
            const visible=!!document.querySelector('.notification-settings-link');
            window.webkit.messageHandlers.paperEdge.postMessage({type:'snapshot',name:'notification-side'});
            return {focusedNoticeSurvivesTimeout:visible};
            """) { value in
                self.results["focusTimer"] = value
                self.runJS("document.querySelector('.notification-settings-link').click();return true;") { _ in }
            }
        }
    }

    func runJS(_ script: String, done: @escaping (Any) -> Void) {
        web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): done(value)
            case .failure(let error): fputs("\(error)\n", stderr); exit(4)
            }
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body=message.body as? [String: Any],let type=body["type"] as? String else { return }
        if type == "resizeTest", let width=body["width"] as? Double, let height=body["height"] as? Double {
            window.setContentSize(NSSize(width: width, height: height))
        }
        if type == "snapshot", let name=body["name"] as? String {
            web.takeSnapshot(with: nil) { image, _ in
                if let tiff=image?.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) {
                    try? png.write(to:self.output.appendingPathComponent(name+".png"))
                }
            }
        }
        if type == "openNotificationSettings" {
            let url = NotificationSettingsLink.url(for: "com.luyaowo.qieji")
            let opened = NotificationSettingsLink.open(for: "com.luyaowo.qieji")
            results["settingsLink"] = ["url": url?.absoluteString ?? "", "opened": opened,
                "rejectsEmptyIdentifier": NotificationSettingsLink.url(for: nil) == nil]
            let editors = (results["side"] as? [[String: Any]] ?? []) + (results["paper"] as? [[String: Any]] ?? [])
            let valid = editors.count == 6 && editors.allSatisfy { $0["valid"] as? Bool == true }
                && (results["notices"] as? [String:Any])?["valid"] as? Bool == true
                && (results["focusTimer"] as? [String:Any])?["focusedNoticeSurvivesTimeout"] as? Bool == true && opened
            results["valid"] = valid
            try! JSONSerialization.data(withJSONObject:results, options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("results.json"))
            print("Verification output: \(output.path); valid=\(valid)")
            exit(valid ? 0 : 1)
        }
    }
}

@main struct EditorSettingsVerificationMain {
    static func main() {
        let app=NSApplication.shared,delegate=EditorSettingsVerification()
        app.setActivationPolicy(.accessory);app.delegate=delegate;app.run()
    }
}
