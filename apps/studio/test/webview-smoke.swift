import AppKit
import WebKit

// Drives the real system WebView without Accessibility, Chrome or Apple Events.
final class Smoke: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var view: WKWebView!
    let window = NSWindow(contentRect: NSRect(x: 0,y: 0,width: 1200,height: 800), styleMask: [.titled], backing: .buffered, defer: false)
    var started = false
    let output = CommandLine.arguments[2]
    func start() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "proof")
        view = WKWebView(frame: window.contentView!.bounds, configuration: config)
        view.autoresizingMask = [.width,.height]
        window.contentView = view
        view.navigationDelegate = self
        window.orderBack(nil)
        view.load(URLRequest(url: URL(string: CommandLine.arguments[1])!))
        DispatchQueue.main.asyncAfter(deadline: .now()+85) { fputs("WKWebView test timed out\n",stderr);exit(2) }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !started else { return }
        started = true
        let test = #"""
        (async()=>{
          const wait = async fn => { for(let i=0;i<240;i++){if(fn())return;await new Promise(r=>setTimeout(r,120))}throw Error('等待界面超时 '+document.body.innerText.slice(-180)); };
          const click=q=>{const x=document.querySelector(q);if(!x)throw Error('找不到 '+q);x.click()};
          try{
            await wait(()=>document.querySelector('#new-title'));document.querySelector('#new-title').value='系统 WebView 回归';
            document.querySelector('#brief').value='一段保留同期声的本机剪辑';click('[data-act="create"]');
            await wait(()=>document.querySelector('[data-act="tab"][data-id="assets"]'));click('[data-act="tab"][data-id="assets"]');
            await wait(()=>document.querySelector('#asset-upload'));const p=(await(await fetch('/api/projects')).json())[0];
            const response=await fetch('/api/projects/'+p.id+'/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:p.revision,commands:[{op:'add',clip:{id:'caption-sample',track:'caption',text:'可编辑字幕',start:3,duration:53}}]})});
            if(!response.ok)throw Error(await response.text());
            click('#projects button');await wait(()=>document.querySelector('[data-clip="caption-sample"]'));
            const c=document.querySelector('[data-clip="caption-sample"]');c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
            await wait(()=>document.querySelector('[data-act="lock"]'));click('[data-act="lock"]');
            await wait(()=>document.querySelector('[data-clip="caption-sample"].lock'));
            click('[data-act="tab"][data-id="settings"]');await wait(()=>document.querySelector('#voice-mode'));
            document.querySelector('#set-title').value='已保存的剪辑工程';click('[data-act="settings-save"]');
            await wait(()=>document.querySelector('#current-title').textContent==='已保存的剪辑工程');
            click('[data-act="tab"][data-id="edit"]');await wait(()=>document.querySelector('.timeline'));window.webkit.messageHandlers.proof.postMessage('ok');
          }catch(e){window.webkit.messageHandlers.proof.postMessage(String(e));}
        })()
        """#
        webView.evaluateJavaScript(test, completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController,didReceive message: WKScriptMessage) {
        guard let status=message.body as? String,status=="ok" else {fputs("WKWebView: \(message.body)\n",stderr);exit(3)}
        view.takeSnapshot(with: nil) { image,error in
            guard let image=image,let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else {exit(4)}
            do{try png.write(to:URL(fileURLWithPath:self.output));print("WKWebView: create, navigate, edit, lock, settings, snapshot passed");exit(0)}catch{exit(5)}
        }
    }
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let test=Smoke()
test.start()
app.run()
