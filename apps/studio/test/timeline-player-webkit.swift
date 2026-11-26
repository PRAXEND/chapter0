import AppKit
import WebKit

// Local integration probe. The caller supplies an isolated Studio URL and a JS test body.
// Only the browser owned by this process can receive the click.
final class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    let window=NSWindow(contentRect:NSRect(x:0,y:0,width:800,height:540),styleMask:[.titled],backing:.buffered,defer:false)
    let config=WKWebViewConfiguration()
    var page:WKWebView!
    var started=false
    func start(){
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self,name:"transport")
        page=WKWebView(frame:window.contentView!.bounds,configuration:config)
        page.navigationDelegate=self
        window.contentView=page
        window.makeKeyAndOrderFront(nil)
        page.load(URLRequest(url:URL(string:CommandLine.arguments[1])!))
    }
    func webView(_ view:WKWebView,didFinish navigation:WKNavigation!){
        guard !started else{return};started=true
        do {
            let body=try String(contentsOfFile:CommandLine.arguments[2],encoding:.utf8)
            page.callAsyncJavaScript(body,arguments:[:],in:nil,in:.page) { result in
                if case .failure(let error)=result{fputs("\(error)\n",stderr);exit(3)}
            }
        } catch{fputs("\(error)\n",stderr);exit(3)}
    }
    func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage){
        guard let m=message.body as? [String:Any] else{return}
        if m["click"] != nil {
            let p=NSPoint(x:50,y:window.contentView!.bounds.height-35)
            let now=ProcessInfo.processInfo.systemUptime
            for type:NSEvent.EventType in [.leftMouseDown,.leftMouseUp] {
                if let e=NSEvent.mouseEvent(with:type,location:p,modifierFlags:[],timestamp:now,windowNumber:window.windowNumber,context:nil,eventNumber:1,clickCount:1,pressure:1){window.sendEvent(e)}
            }
        } else {
            if let data=try? JSONSerialization.data(withJSONObject:m),let line=String(data:data,encoding:.utf8){print(line)}
            exit(m["error"] == nil ? 0 : 4)
        }
    }
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let probe=Probe();probe.start()
DispatchQueue.main.asyncAfter(deadline:.now()+100){fputs("WKWebView transport timeout\n",stderr);exit(5)}
app.run()
