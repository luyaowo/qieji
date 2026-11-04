import AppKit
import WebKit

// The real generated interface, with in-memory synthetic tasks and no notifications.
final class ReliabilityVerification: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    let resources = URL(fileURLWithPath: CommandLine.arguments[1])
    let output = URL(fileURLWithPath: CommandLine.arguments[2])
    var started = false

    func applicationDidFinishLaunching(_ note: Notification) {
        DispatchQueue.global().asyncAfter(deadline: .now() + 60) { exit(3) }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "paperEdge")
        config.userContentController.addUserScript(WKUserScript(source: """
        const memory=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,String(v))}});
        window.__QIEJI_DISPLAY_MODE__='side';
        window.__QIEJI_NATIVE_WORKSPACE__={version:2,trash:[],tasks:[
          {id:'long',text:'https://example.com/'+ 'abcdefghij'.repeat(24),group:'today',done:false},
          {id:'delete',text:'删除后检查撤销位置',group:'today',done:false},
          ...Array.from({length:24},(_,i)=>({id:'filler-'+i,text:'合成任务 '+i,group:'tomorrow',done:false})),
          {id:'missed',text:'已错过的合成提醒',group:'today',done:false,remindAt:'2020-01-01T08:00:00Z'},
          {id:'target',text:'通知应定位到这条任务',group:'upcoming',done:false,remindAt:'2099-01-01T08:00:00Z'}
        ]};
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 430, height: 720), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "且记 · 可靠性回归 · 隔离任务"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let page = CommandLine.arguments.contains("--help-page") ? "help.html" : "index.html"
        var url = URLComponents(url: resources.appendingPathComponent(page), resolvingAgainstBaseURL: false)!
        url.query = "native=1"
        web.loadFileURL(url.url!, allowingReadAccessTo: resources)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }; started = true
        let customChecks = CommandLine.arguments.count > 3
            ? try! String(contentsOfFile: CommandLine.arguments[3], encoding: .utf8) : nil
        web.callAsyncJavaScript(customChecks ?? """
        const wait=ms=>new Promise(r=>setTimeout(r,ms));
        const focusNative=()=>new Promise(resolve=>{
          window.addEventListener('qieji-window-focused',resolve,{once:true});
          window.webkit.messageHandlers.paperEdge.postMessage({type:'focus'});
        });
        const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        for(let i=0;i<100&&typeof window.paperEdgeSetOpen!=='function';i++)await wait(30);
        await document.fonts.ready; await frame();
        const cases=[];
        const check=(name,valid,detail={})=>cases.push({name,valid:!!valid,...detail});
        for(const mode of ['side','paper']) {
          window.webkit.messageHandlers.paperEdge.postMessage({type:'resize',width:mode==='side'?430:680});
          window.paperEdgeSetMode(mode);window.paperEdgeSetOpen(true);await frame();await wait(280);
          const copy=document.querySelector('[data-task-id="long"] .task-copy');
          check(mode+'-long-text-wraps',copy.scrollWidth<=copy.clientWidth+1,{scrollWidth:copy.scrollWidth,clientWidth:copy.clientWidth});
          const actionRow=document.querySelector('[data-task-id="long"]'),rowActions=actionRow.querySelector('.row-actions');
          await focusNative();copy.focus();await wait(200);
          check(mode+'-copy-focus-shows-reminder-hides-delete',Number(getComputedStyle(rowActions).opacity)>0.99
            &&(actionRow.matches(':hover')||Number(getComputedStyle(actionRow.querySelector('.row-action.delete')).opacity)<0.01),
            {actionsOpacity:getComputedStyle(rowActions).opacity,deleteOpacity:getComputedStyle(actionRow.querySelector('.row-action.delete')).opacity,hover:actionRow.matches(':hover'),pageFocus:document.hasFocus()});
          actionRow.querySelector('.row-action.delete').focus();await wait(200);
          check(mode+'-delete-focus-shows-delete',Number(getComputedStyle(rowActions).opacity)>0.99);
          copy.focus();await frame();
          copy.click();await frame();
          document.querySelector('.task-reminder-toggle').click();await frame();
          check(mode+'-repeat-options-without-reminder',document.querySelectorAll('.task-reminder-repeat button').length===4);
          const input=document.querySelector('input[type="datetime-local"]');input.focus();
          input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await frame();
          check(mode+'-escape-reminder-only',document.querySelector('.app-screen').dataset.open==='true'&&!!document.querySelector('.task-edit')&&!document.querySelector('.task-reminder-options'));
          document.querySelector('.task-edit')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
          window.paperEdgeSetOpen(true);await frame();
          if(mode==='side'){
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true}));
            document.querySelector('[data-task-id="delete"] .row-action.delete').click();
            await wait(50);
            check('side-delete-restores-keyboard-focus',document.activeElement===document.querySelector('.task-input'));
          }
          await frame();await wait(300);
          const toast=document.querySelector('.undo-toast[role="status"]'),composer=document.querySelector('.composer');
          const t=toast?.getBoundingClientRect(),c=composer.getBoundingClientRect();
          check(mode+'-toast-above-composer',t&&t.bottom<=c.top,{toastBottom:t?.bottom,composerTop:c.top});
          await new Promise(resolve=>{
            window.addEventListener('qieji-snapshot-done',resolve,{once:true});
            window.webkit.messageHandlers.paperEdge.postMessage({type:'snapshot',name:mode});
          });
        }
        document.querySelector('.undo-toast[role="status"] button')?.click();await frame();
        window.paperEdgeSetMode('side');await frame();
        check('missed-strip-visible',!!document.querySelector('.missed-notice'));
        check('missed-strip-count',(document.querySelector('.missed-notice')?.textContent||'').includes('1 条提醒'));
        document.querySelector('.missed-summary')?.click();await frame();
        check('missed-row-shown',!!document.querySelector('.missed-row'));
        const missedActions=[...document.querySelectorAll('.missed-action')].map(b=>b.textContent.trim());
        check('missed-actions',missedActions.includes('15 分钟后')&&missedActions.includes('完成'),{missedActions});
        document.querySelector('.missed-summary')?.click();await frame();
        document.querySelector('[data-task-id="target"] .task-copy')?.click();await frame();
        document.querySelector('.task-reminder-toggle')?.click();await frame();
        const repeatButtons=[...document.querySelectorAll('.task-reminder-repeat button')].map(b=>b.textContent.trim());
        check('repeat-options',['不重复','每天','工作日','每周'].every(v=>repeatButtons.includes(v)),{repeatButtons});
        document.querySelector('.task-edit')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await frame();
        const todayIds=()=>[...document.querySelectorAll('[data-group="today"] .task-row')].map(row=>row.dataset.taskId);
        const beforeKeyboard=todayIds(),longCopy=document.querySelector('[data-task-id="long"] .task-copy');
        longCopy.focus();
        longCopy.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}));
        await frame();await wait(80);
        const expectedKeyboard=[...beforeKeyboard];
        const longIndex=expectedKeyboard.indexOf('long');
        [expectedKeyboard[longIndex],expectedKeyboard[longIndex+1]]=[expectedKeyboard[longIndex+1],expectedKeyboard[longIndex]];
        check('keyboard-reorder-and-focus',todayIds().join(',')===expectedKeyboard.join(',')
          &&document.activeElement?.closest('[data-task-id]')?.dataset.taskId==='long');
        document.querySelector('[data-task-id="long"] .task-copy').click();await frame();
        document.querySelector('.task-edit').textContent='退出前没有失焦的编辑内容';
        const saved=window.paperEdgePrepareToQuit?.();
        check('quit-flushes-active-editor',saved?.tasks?.find(t=>t.id==='long')?.text==='退出前没有失焦的编辑内容');
        document.querySelector('.task-edit')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await frame();
        document.querySelector('.recovery-button').click();await frame();
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true}));await wait(250);
        check('command-k-closes-recovery',!document.querySelector('.recovery-panel')&&document.activeElement===document.querySelector('.task-input'));
        const emit=status=>window.dispatchEvent(new CustomEvent('qieji-notification-status',{detail:{status}}));
        emit('denied');await frame();check('permission-denied-shown',!!document.querySelector('.notification-notice'));
        check('permission-denied-marker',!!document.querySelector('.task-reminder-warning'));
        window.paperEdgeSetOpen(false);await frame();window.paperEdgeSetOpen(true);await frame();
        emit('denied');await frame();check('duplicate-permission-status-stays-quiet',!document.querySelector('.notification-notice'));
        emit('authorized');await frame();check('permission-authorized-clears-marker',!document.querySelector('.task-reminder-warning'));
        emit('denied');await frame();check('permission-change-shown-again',!!document.querySelector('.notification-notice'));
        check('permission-denied-marker-returns',!!document.querySelector('.task-reminder-warning'));
        emit('limit');await frame();check('reminder-limit-visible',document.querySelector('.notification-notice')?.textContent.includes('60'));
        window.paperEdgeSetOpen(false);await frame();
        window.paperEdgeOpenTask?.('target');await frame();await wait(450);
        const target=document.querySelector('[data-task-id="target"]'),r=target.getBoundingClientRect(),s=document.querySelector('.task-scroll').getBoundingClientRect();
        check('notification-opens-and-focuses-task',document.querySelector('.app-screen').dataset.open==='true'&&target.contains(document.activeElement)&&r.top>=s.top&&r.bottom<=s.bottom,{taskTop:r.top,taskBottom:r.bottom,scrollTop:s.top,scrollBottom:s.bottom});
        const exported=window.paperEdgeExportWorkspace();
        check('export-has-version-and-workspace',exported.format==='qieji-workspace'&&exported.version===2&&exported.tasks.length>0&&Array.isArray(exported.trash));
        const preview=window.paperEdgePreviewImport({version:2,tasks:[
          {id:'target',text:'冲突旧版本',group:'today',done:false},
          {id:'import-new',text:'新导入任务',group:'upcoming',done:false,html:'<strong>新导入任务</strong>',remindAt:'2030-01-01T08:00:00Z'}],
          trash:[{id:'import-trash',task:{id:'import-deleted',text:'导入的回收任务',group:'today',done:false},index:0,deletedAt:100}]});
        check('import-preview-does-not-mutate',preview.summary.tasks===1&&preview.summary.trash===1&&preview.summary.conflicts===1&&!document.querySelector('[data-task-id="import-new"]'));
        window.paperEdgeApplyWorkspace(preview.workspace);await frame();
        check('import-applies-and-keeps-current-version',document.querySelector('[data-task-id="import-new"]')?.textContent.includes('新导入任务')&&document.querySelector('[data-task-id="target"]')?.textContent.includes('通知应定位到这条任务'));
        document.querySelector('.recovery-button').click();await frame();
        document.querySelector('[aria-label="永久删除任务：导入的回收任务"]').click();await frame();
        check('permanent-delete-needs-confirmation',!!document.querySelector('.recovery-confirm')&&window.paperEdgePrepareToQuit().trash.length===1);
        [...document.querySelectorAll('.recovery-confirm button')].find(b=>b.textContent==='取消').click();await frame();
        check('permanent-delete-cancel-keeps-record',!document.querySelector('.recovery-confirm')&&window.paperEdgePrepareToQuit().trash.length===1);
        document.querySelector('[aria-label="永久删除任务：导入的回收任务"]').click();await frame();
        [...document.querySelectorAll('.recovery-confirm button')].find(b=>b.textContent==='确认永久删除').click();await frame();
        check('permanent-delete-only-clears-trash',window.paperEdgePrepareToQuit().trash.length===0&&!!document.querySelector('[data-task-id="import-new"]'));
        document.querySelector('.recovery-heading-actions button').click();await frame();
        for(const id of ['filler-0','filler-1']){document.querySelector(`[data-task-id="${id}"] .row-action.delete`).click();await frame();}
        document.querySelector('.recovery-button').click();await frame();
        const clear=()=>[...document.querySelectorAll('.recovery-heading-actions button')].find(b=>b.textContent==='清空已删除').click();
        clear();await frame();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await frame();
        check('escape-cancels-purge-before-closing-recovery',!document.querySelector('.recovery-confirm')&&!!document.querySelector('.recovery-panel')&&window.paperEdgePrepareToQuit().trash.length===2);
        for(const mode of ['side','paper']){
          window.webkit.messageHandlers.paperEdge.postMessage({type:'resize',width:mode==='side'?430:680});window.paperEdgeSetMode(mode);await frame();
          clear();await frame();
          const panel=document.querySelector('.recovery-panel').getBoundingClientRect();
          const fits=[...document.querySelectorAll('.recovery-heading button,.recovery-confirm button,.recovery-entry-actions button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=panel.left&&r.right<=panel.right});
          check(mode+'-recovery-actions-fit',fits);
          await new Promise(resolve=>{window.addEventListener('qieji-snapshot-done',resolve,{once:true});window.webkit.messageHandlers.paperEdge.postMessage({type:'snapshot',name:'recovery-'+mode});});
          [...document.querySelectorAll('.recovery-confirm button')].find(b=>b.textContent==='取消').click();await frame();
        }
        clear();await frame();[...document.querySelectorAll('.recovery-confirm button')].find(b=>b.textContent==='确认永久删除').click();await frame();
        check('clear-trash-confirmed',window.paperEdgePrepareToQuit().trash.length===0&&!document.querySelector('.undo-toast[role="status"]'));
        const thousand=Array.from({length:1000},(_,i)=>({id:'r'+i,task:{id:'t'+i,text:'合成回收记录',group:'today',done:false},index:0,deletedAt:100}));
        window.paperEdgeApplyWorkspace({version:2,tasks:[],trash:thousand});await frame();
        check('trash-capacity-warns-without-deleting',!!document.querySelector('.recovery-capacity')&&window.paperEdgePrepareToQuit().trash.length===1000);
        window.paperEdgeApplyWorkspace({version:2,sampleNoticePending:true,trash:[],tasks:[{id:'sample-1',text:'完成今天最重要的一件事',group:'today',done:false,createdAt:1}]});
        document.querySelector('.recovery-heading-actions button').click();window.paperEdgeSetMode('side');
        window.webkit.messageHandlers.paperEdge.postMessage({type:'resize',width:430});await frame();
        check('first-launch-explains-samples',!!document.querySelector('.sample-notice'));
        await new Promise(resolve=>{window.addEventListener('qieji-snapshot-done',resolve,{once:true});window.webkit.messageHandlers.paperEdge.postMessage({type:'snapshot',name:'samples-side'});});
        [...document.querySelectorAll('.sample-notice button')].find(b=>b.textContent==='清除示例').click();await frame();
        check('sample-clear-choice-is-persisted',!document.querySelector('.sample-notice')&&window.paperEdgePrepareToQuit().tasks.length===0);
        // Release regressions: real WebKit parsing, native button activation and reminder UI.
        const fixture=(extra={})=>({id:'release',text:'abcdef',group:'today',done:false,...extra});
        window.__unsafeImportExecuted=false;
        const unsafe='<strong>safe</strong><img src="data:image/png;base64,AA==" onerror="window.__unsafeImportExecuted=true">';
        const malicious=window.paperEdgePreviewImport({version:2,tasks:[fixture({html:unsafe})],trash:[]});
        window.paperEdgeApplyWorkspace(malicious.workspace);await wait(150);await frame();
        check('import-html-never-executes',!window.__unsafeImportExecuted);
        check('import-safe-format-preserved',document.querySelector('[data-task-id="release"] strong')?.textContent==='safe');
        window.paperEdgeApplyWorkspace({version:2,tasks:[fixture()],trash:[]});await frame();
        document.querySelector('[data-task-id="release"] .task-copy').click();await frame();
        const selectText=async()=>{
          const editor=document.querySelector('.task-edit');editor.focus();
          const range=document.createRange();range.selectNodeContents(editor);
          const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));await frame();
        };
        await selectText();document.querySelector('.task-edit').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));await frame();
        check('tab-enters-format-toolbar',document.activeElement===document.querySelector('.format-button')&&!!document.querySelector('.format-toolbar'));
        for(const tone of ['sand','sage','sky']){
          await selectText();const button=document.querySelector('.format-swatch.'+tone);
          button.focus();await frame();button.click();await frame();
          check('keyboard-highlight-'+tone,document.querySelector('.task-edit')?.querySelector('mark')?.dataset.tone===tone
            ||QieJi.richText.sanitizeRichText(document.querySelector('.task-edit').innerHTML).includes('data-tone="'+tone+'"'));
          check('format-restores-editor-focus-'+tone,document.activeElement===document.querySelector('.task-edit'));
        }
        document.querySelector('.task-edit').innerHTML='<strong><mark data-tone="sand">abcdef</mark></strong>';
        await selectText();const clearFormat=document.querySelector('[aria-label="清除格式"]');clearFormat.focus();
        await frame();clearFormat.click();await frame();
        check('keyboard-clear-format',document.querySelector('.task-edit').innerHTML==='abcdef');
        await selectText();const boldFormat=document.querySelector('[aria-label="加粗"]');boldFormat.focus();await frame();
        boldFormat.click();await frame();
        check('keyboard-bold',QieJi.richText.sanitizeRichText(document.querySelector('.task-edit').innerHTML)==='<strong>abcdef</strong>');
        await selectText();const mouseBold=document.querySelector('[aria-label="加粗"]');
        mouseBold.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));mouseBold.click();await frame();
        check('mouse-bold-activates-once',QieJi.richText.sanitizeRichText(document.querySelector('.task-edit').innerHTML)==='abcdef');
        window.paperEdgePrepareToQuit();await frame();
        window.paperEdgeApplyWorkspace({version:2,tasks:[fixture({remindAt:'2020-01-01T01:00:00Z',repeat:'daily'})],trash:[]});await frame();
        emit('denied');await frame();
        check('past-anchor-repeat-keeps-permission-warning',!!document.querySelector('.task-reminder-warning'));
        check('repeat-label-shows-next-time',document.querySelector('.task-reminder-meta')?.textContent.includes('下次'));
        const anchor=window.paperEdgePrepareToQuit().tasks[0].remindAt;
        window.paperEdgeSnoozeTask('release');await frame();
        const snoozed=window.paperEdgePrepareToQuit().tasks[0];
        check('repeat-snooze-preserves-rule',snoozed.repeat==='daily'&&snoozed.remindAt===anchor
          &&Math.abs(new Date(snoozed.snoozedUntil).getTime()-Date.now()-900000)<1000);
        document.querySelector('.task-copy').click();await frame();document.querySelector('.task-reminder-toggle').click();await frame();
        check('repeat-input-has-no-start-date',!!document.querySelector('input[type="time"]')&&!document.querySelector('input[type="datetime-local"]'));
        check('repeat-panel-shows-next-time',document.querySelector('.task-reminder-next')?.textContent.includes('下次'));
        await new Promise(resolve=>{window.addEventListener('qieji-snapshot-done',resolve,{once:true});window.webkit.messageHandlers.paperEdge.postMessage({type:'snapshot',name:'repeat-next-time'});});
        [...document.querySelectorAll('.task-reminder-repeat button')].find(b=>b.textContent==='每周').click();await frame();
        check('weekly-has-weekday-choice',document.querySelectorAll('.task-reminder-custom select option').length===7);
        [...document.querySelectorAll('.task-reminder-repeat button')].find(b=>b.textContent==='不重复').click();await frame();
        const onceInputValue=document.querySelector('input[type="datetime-local"]').value;
        document.querySelector('.task-reminder-save').click();await frame();
        const onceTask=window.paperEdgePrepareToQuit().tasks[0];await frame();
        // Snapshot commits the editor; reopen it to verify persisted one-shot input.
        document.querySelector('.task-copy').click();await frame();document.querySelector('.task-reminder-toggle').click();await frame();
        check('repeat-to-once-keeps-next-date',!onceTask.repeat&&new Date(onceTask.remindAt)>new Date()
          &&onceInputValue===QieJi.reminderTime.toLocalInputValue(new Date(onceTask.remindAt))
          &&document.querySelector('input[type="datetime-local"]').value===onceInputValue);
        [...document.querySelectorAll('.task-reminder-presets button')].find(b=>b.textContent==='取消提醒').click();await frame();
        const canceled=window.paperEdgePrepareToQuit().tasks[0];
        check('cancel-clears-repeat-and-snooze',!canceled.remindAt&&!canceled.repeat&&!canceled.snoozedUntil);
        return {cases,valid:cases.every(c=>c.valid)};
        """, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                let object = value as? [String: Any] ?? [:]
                let data = try! JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
                try! data.write(to: self.output.appendingPathComponent("results.json"))
                print(String(data: data, encoding: .utf8)!)
                exit(object["valid"] as? Bool == true ? 0 : 1)
            case .failure(let error): fputs("\(error)\n", stderr); exit(4)
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "focus" {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            window.makeFirstResponder(web)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                self.web.evaluateJavaScript("window.dispatchEvent(new Event('qieji-window-focused'))")
            }
        }
        if body["type"] as? String == "resize", let width = body["width"] as? Double {
            window.setContentSize(NSSize(width: width, height: body["height"] as? Double ?? 720))
        }
        if body["type"] as? String == "snapshot", let name = body["name"] as? String {
            web.takeSnapshot(with: nil) { image, _ in
                if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: self.output.appendingPathComponent(name + ".png"))
                }
                self.web.evaluateJavaScript("window.dispatchEvent(new Event('qieji-snapshot-done'))")
            }
        }
    }
}

@main struct ReliabilityVerificationMain {
    static func main() {
        let app = NSApplication.shared, delegate = ReliabilityVerification()
        app.setActivationPolicy(.accessory); app.delegate = delegate; app.run()
    }
}
