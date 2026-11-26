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
            const style=document.querySelector('#new-style');
            if([...style.options].map(o=>o.value).sort().join(',')!=='henry-hot-news@8,henry-technical-explainer@8')throw Error('新建工程的风格目录偏离两套 v8');
            style.value='henry-technical-explainer@8';style.dispatchEvent(new Event('change',{bubbles:true}));
            const brief=document.querySelector('#brief');brief.value='一段保留同期声的本机剪辑';brief.dispatchEvent(new Event('input',{bubbles:true}));
            click('[data-guide="new"]');await wait(()=>document.querySelector('#guide-dialog').open);
            const versions=['new','edit','inspector','advanced','assets','style','settings','deliver','tools','blind'];
            for(const topic of versions){click('#guide-nav [data-topic="'+topic+'"]');await wait(()=>document.querySelector('#guide-body img')?.naturalWidth>0);}
            const search=document.querySelector('#guide-search');search.value='吸附';search.dispatchEvent(new Event('input',{bubbles:true}));click('.guide-hit');
            await wait(()=>document.querySelector('.guide-match'));
            click('.guide-inventory');await wait(()=>document.querySelector('.guide-locate'));
            const target=[...document.querySelectorAll('#guide-body dt')].find(row=>row.firstChild.textContent.includes('最短片长'));
            if(!target)throw Error('当前控件列表缺少最短片长');
            target.querySelector('.guide-locate').click();
            await wait(()=>!document.querySelector('#guide-dialog').open&&document.activeElement.id==='new-min'&&document.querySelector('#new-min').closest('details').open);
            if(brief.value!=='一段保留同期声的本机剪辑')throw Error('查看帮助后制作要求发生变化');
            click('[data-act="create"]');
            await wait(()=>document.querySelector('[data-act="tab"][data-id="assets"]'));click('[data-act="tab"][data-id="assets"]');
            await wait(()=>document.querySelector('#asset-upload'));const p=(await(await fetch('/api/projects')).json())[0];
            const response=await fetch('/api/projects/'+p.id+'/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:p.revision,commands:[{op:'add',clip:{id:'caption-sample',track:'caption',text:'可编辑字幕',start:3,duration:53}}]})});
            if(!response.ok)throw Error(await response.text());
            click('#projects button');await wait(()=>document.querySelector('[data-clip="caption-sample"]'));
            const c=document.querySelector('[data-clip="caption-sample"]');c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
            await wait(()=>document.querySelector('[data-act="lock"]'));click('[data-act="lock"]');
            await wait(()=>document.querySelector('[data-clip="caption-sample"].lock'));
            document.querySelector('#new-component').value='staggered-explanation';
            click('[data-act="add-component"]');await wait(()=>document.querySelector('#motion-b'));
            document.querySelector('#motion-b').value='第二句在这里出现';
            const cue=document.querySelector('#cue-1');cue.value='27';cue.dispatchEvent(new Event('input',{bubbles:true}));
            if(document.querySelector('#cue-read-1').value!=='27 帧')throw Error('落点读数未更新');
            click('[data-act="save-preview-cue"]');
            await wait(()=>document.querySelector('#motion-b')?.value==='第二句在这里出现'&&document.querySelector('.timeline-header')?.innerText.includes('v5'));
            const saved=await (await fetch('/api/projects/'+p.id)).json(),layer=saved.timeline.clips.find(c=>c.motion);
            if(layer.motion.props.b!=='第二句在这里出现'||layer.motion.cueFrames[1]!==27)throw Error('组件未写入工程');
            await wait(()=>document.querySelector('#dialog[open] video')?.readyState>=1);
            if(!document.querySelector('#dialog-title').textContent.includes('v5'))throw Error('落点预览版本不符');
            click('#dismiss');
            click('[data-act="tab"][data-id="settings"]');await wait(()=>document.querySelector('#voice-mode'));
            document.querySelector('#set-title').value='已保存的剪辑工程';click('[data-act="settings-save"]');
            await wait(()=>document.querySelector('#current-title').textContent==='已保存的剪辑工程');
            click('[data-act="tab"][data-id="edit"]');await wait(()=>document.querySelector('.timeline'));
            const project=async()=>(await fetch('/api/projects/'+p.id)).json();
            const before=await project();
            const created=await fetch('/api/projects/'+p.id+'/edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:before.revision,commands:[
              {op:'add',clip:{id:'drag-me',track:'caption',text:'拖动样本',start:150,duration:40}},
              {op:'add',clip:{id:'snap-stop',track:'caption',text:'吸附切点',start:230,duration:20}}]})});
            if(!created.ok)throw Error(await created.text());
            click('#projects button');await wait(()=>document.querySelector('[data-clip="drag-me"]'));
            const sample=()=>document.querySelector('[data-clip="drag-me"]');
            const getClip=async()=>(await project()).timeline.clips.find(c=>c.id==='drag-me');
            const gesture=async(node,x,y,to,check)=>{
              const fire=(target,type,at)=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,buttons:type==='pointerup'?0:1,pointerId:8,clientX:at,clientY:y}));
              fire(node,'pointerdown',x);fire(node,'pointermove',to);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
              if(check)await check();fire(node,'pointerup',to);
            };
            const ruler=document.querySelector('.tl-ruler'),edge=ruler.getBoundingClientRect(),scale=parseFloat(sample().style.width)/40;
            await gesture(ruler,edge.left+60*scale,edge.top+5,edge.left+170*scale);
            await wait(()=>document.querySelector('.tl-time').value==='00:00:05:20');
            const rect=sample().getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
            await gesture(sample(),x,y,x+39*scale,async()=>{
              if(Math.abs(parseFloat(sample().style.left)-190*scale)>1||document.querySelector('.tl-guide').hidden)throw Error('拖动时没有实时吸附');
              if((await getClip()).start!==150)throw Error('拖动过程中意外写入工程');
            });
            await wait(()=>document.querySelector('.timeline-header small')?.textContent==='v'+(before.revision+2));
            if((await getClip()).start!==190)throw Error('片尾未对齐下一片段');
            click('[data-tl="snap"]');
            const handle=sample().querySelector('[data-edge="start"]'),box=handle.getBoundingClientRect();
            await gesture(handle,box.left+2,box.top+8,box.left+2+5*scale);
            await wait(()=>document.querySelector('.timeline-header small')?.textContent==='v'+(before.revision+3));
            const trim=await getClip();if(trim.start!==195||trim.duration!==35)throw Error('左侧修剪没有保持出点');
            await wait(()=>!document.querySelector('[data-tl="undo"]').disabled);click('[data-tl="undo"]');
            await wait(()=>document.querySelector('.timeline-header small')?.textContent==='v'+(before.revision+4));if((await getClip()).duration!==40)throw Error('撤销失败');
            await wait(()=>!document.querySelector('[data-tl="redo"]').disabled);click('[data-tl="redo"]');
            await wait(()=>document.querySelector('.timeline-header small')?.textContent==='v'+(before.revision+5));if((await getClip()).duration!==35)throw Error('重做失败');
            const tc=document.querySelector('.tl-time');tc.focus();tc.value='210';tc.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
            await wait(()=>document.querySelector('.tl-time').value==='00:00:07:00');
            click('[data-tl="split"]');await wait(()=>document.querySelector('.timeline-header small')?.textContent==='v'+(before.revision+6));
            if((await getClip()).duration!==15)throw Error('分割未使用全片播放头');
            window.webkit.messageHandlers.proof.postMessage('ok');
          }catch(e){window.webkit.messageHandlers.proof.postMessage(String(e));}
        })()
        """#
        webView.evaluateJavaScript(test, completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController,didReceive message: WKScriptMessage) {
        guard let status=message.body as? String,status=="ok" else {fputs("WKWebView: \(message.body)\n",stderr);exit(3)}
        view.takeSnapshot(with: nil) { image,error in
            guard let image=image,let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else {exit(4)}
            do{try png.write(to:URL(fileURLWithPath:self.output));print("WKWebView: create, edit, lock, JSX, snap drag, trim, undo/redo, timecode and split passed");exit(0)}catch{exit(5)}
        }
    }
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let test=Smoke()
test.start()
app.run()
