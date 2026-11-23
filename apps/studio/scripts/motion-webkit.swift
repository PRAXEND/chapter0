import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import WebKit

struct State: Decodable {
    let key: String
    let html: String
    let width: Int
    let height: Int
}
struct Batch: Decodable {
    let directory: String
    let states: [State]
}

@MainActor final class Renderer: NSObject, WKNavigationDelegate {
    let batch: Batch
    let window: NSWindow
    let view: WKWebView
    var index = 0

    init(_ batch: Batch) {
        self.batch = batch
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        self.view = WKWebView(frame: NSRect(x:0, y:0, width:1, height:1), configuration:config)
        self.window = NSWindow(contentRect:view.frame, styleMask:.borderless, backing:.buffered, defer:false)
        super.init()
    }
    func start() {
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.contentView = view
        window.setFrameOrigin(NSPoint(x:-12000, y:-12000))
        window.orderBack(nil)
        view.setValue(false, forKey:"drawsBackground")
        view.underPageBackgroundColor = .clear
        view.navigationDelegate = self
        let shell = """
        <!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
        <style>*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden;font-family:'PingFang SC',sans-serif}
        #scene{position:absolute;left:0;top:0;overflow:hidden}</style><div id="scene"></div>
        """
        view.loadHTMLString(shell, baseURL:nil)
    }
    func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data((message+"\n").utf8))
        exit(1)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { next() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("动效 WebKit 进程中断。") }
    func next() {
        guard index < batch.states.count else { exit(0) }
        let state=batch.states[index]
        guard state.key.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,
              (1...4096).contains(state.width), (1...4096).contains(state.height) else { fail("动效帧参数无效。") }
        let size=NSSize(width:state.width,height:state.height)
        window.setContentSize(size)
        view.frame=NSRect(origin:.zero,size:size)
        let script="""
        const root=document.getElementById('scene');
        root.style.width=width+'px';root.style.height=height+'px';root.innerHTML=markup;
        root.getBoundingClientRect();await document.fonts.ready;return true;
        """
        view.callAsyncJavaScript(script, arguments:["width":state.width,"height":state.height,"markup":state.html],
            in:nil,in:.page) { result in
            if case .failure(let error) = result { self.fail(error.localizedDescription) }
            let options=WKSnapshotConfiguration()
            options.rect=CGRect(origin:.zero,size:size)
            options.snapshotWidth=NSNumber(value:state.width)
            options.afterScreenUpdates=true
            self.view.takeSnapshot(with:options) { image,error in
                guard let image=image, error==nil else { self.fail(error?.localizedDescription ?? "无法合成动效帧。") }
                var rect=CGRect(origin:.zero,size:size)
                guard let raw=image.cgImage(forProposedRect:&rect,context:nil,hints:nil),
                    let context=CGContext(data:nil,width:state.width,height:state.height,bitsPerComponent:8,bytesPerRow:0,
                        space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { self.fail("无法建立透明动效画布。") }
                context.interpolationQuality = .high
                context.draw(raw,in:CGRect(origin:.zero,size:size))
                let file=URL(fileURLWithPath:self.batch.directory).appendingPathComponent(state.key+".png")
                guard let rendered=context.makeImage(),let target=CGImageDestinationCreateWithURL(file as CFURL,UTType.png.identifier as CFString,1,nil) else { self.fail("无法写入动效帧。") }
                CGImageDestinationAddImage(target,rendered,nil)
                guard CGImageDestinationFinalize(target) else { self.fail("透明动效帧写入不完整。") }
                self.index+=1
                DispatchQueue.main.async { self.next() }
            }
        }
    }
}

@main struct Main {
    @MainActor static func main() throws {
        let app=NSApplication.shared
        app.setActivationPolicy(.accessory)
        guard CommandLine.arguments.count==2 else { exit(2) }
        let data=try Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))
        let renderer=Renderer(try JSONDecoder().decode(Batch.self,from:data))
        renderer.start()
        app.run()
    }
}
