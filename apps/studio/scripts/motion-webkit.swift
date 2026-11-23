import AppKit
import CoreGraphics
import CryptoKit
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
    let font: FontAsset
}
struct FontAsset: Decodable {
    let path: String
    let sha256: String
}

@MainActor final class Renderer: NSObject, WKNavigationDelegate {
    let batch: Batch
    var fontData: Data?
    let window: NSWindow
    let view: WKWebView
    var index = 0

    init(_ batch: Batch) throws {
        self.batch = batch
        // Only the pinned bytes enter WebKit. The content process never receives a path or file URL.
        let url=URL(fileURLWithPath:batch.font.path)
        let info=try url.resourceValues(forKeys:[.isRegularFileKey,.fileSizeKey])
        guard info.isRegularFile==true, let byteCount=info.fileSize, byteCount>0, byteCount<=24*1024*1024 else {
            throw NSError(domain:"VideoStudioMotionFont",code:1,userInfo:[NSLocalizedDescriptionKey:"内置字体文件无效。"])
        }
        let data=try Data(contentsOf:url,options:.mappedIfSafe)
        let hash=SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined()
        guard hash==batch.font.sha256 else {
            throw NSError(domain:"VideoStudioMotionFont",code:2,userInfo:[NSLocalizedDescriptionKey:"字体验证失败。"])
        }
        self.fontData=data
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
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loadFont(at:0) }
    func loadFont(at offset:Int) {
        guard let bytes=fontData else { fail("内置字体尚未初始化。") }
        // A 512-KiB base64 IPC message avoids embedding a 24-MB string in the HTML document.
        let end=min(offset+384*1024,bytes.count)
        let script="""
        const fontBytes=window.__studioFontBytes??=new Uint8Array(total);
        const part=atob(encoded);
        for(let i=0;i<part.length;i++)fontBytes[offset+i]=part.charCodeAt(i);
        if(!last)return true;
        const face=new FontFace('Noto Sans SC',fontBytes.buffer,{style:'normal',weight:'100 900'});
        await face.load();document.fonts.add(face);await document.fonts.ready;
        delete window.__studioFontBytes;
        if(face.status!=='loaded' || !document.fonts.has(face))throw Error('Noto Sans SC 未在 WebKit 中就绪');
        const canvas=document.createElement('canvas');canvas.width=280;canvas.height=68;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});
        const sample=(family,weight)=>{
          ctx.clearRect(0,0,280,68);ctx.font=weight+' 43px '+family;
          ctx.fillText('潮位 Aa18 月印',5,50);
          const rgba=ctx.getImageData(0,0,280,68).data;
          let h=2166136261;
          for(let i=3;i<rgba.length;i+=4)h=Math.imul(h^rgba[i],16777619);
          return (h>>>0).toString(16).padStart(8,'0');
        };
        return {family:face.family,status:face.status,weight:face.weight,
          regularRaster:sample('"Noto Sans SC"',400),boldRaster:sample('"Noto Sans SC"',900),
          systemSansRaster:sample('"PingFang SC"',400),serifRaster:sample('serif',400)};
        """
        let args:[String:Any]=["total":bytes.count,"offset":offset,"encoded":bytes[offset..<end].base64EncodedString(),"last":end==bytes.count]
        view.callAsyncJavaScript(script,arguments:args,in:nil,in:.page){result in
            switch result {
            case .failure(let error): self.fail("内置中文字体无法加载："+error.localizedDescription)
            case .success(let value):
                if end < bytes.count { self.loadFont(at:end);return }
                guard let receipt=value as? [String:Any],receipt["status"] as? String=="loaded",
                      let encoded=try? JSONSerialization.data(withJSONObject:receipt) else { self.fail("WebKit 未确认内置字体。") }
                FileHandle.standardOutput.write(encoded)
                self.fontData=nil
                self.next()
            }
        }
    }
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
        let renderer=try Renderer(JSONDecoder().decode(Batch.self,from:data))
        renderer.start()
        app.run()
    }
}
