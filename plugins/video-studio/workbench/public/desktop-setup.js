const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function desktopSetupMarkup(config,busy=false){
  if(config?.mode==='cli')return '<p class="helper-text">当前使用兼容 CLI 执行模式。桌面电脑控制仅在桌面会话模式可用。</p>';
  return `<details ${config?.configured?'':'open'}><summary>桌面执行会话 · ${config?.configured?esc(config.title):'首次使用请先配置'}</summary>
  <p>制作会在你选择的 Codex 桌面会话中执行。此配置在本机保存，后续可以复用。</p>
  <ol><li>在这台电脑的 Codex 桌面端新建专用会话，命名为“Video Studio 制作”。</li><li>把该会话权限设为<strong>完全访问</strong>，发送一条简短消息，等待回复完成。</li><li>确保该会话已启用 Video Studio、ChatCut 和电脑控制；在需要的浏览器中登录 ChatCut。系统及浏览器授权需在电脑上完成。</li><li>点击下方“读取桌面会话”，选择刚才的会话并保存。制作期间保持 Codex 桌面端和此会话可用，不在其中提交其他工作。</li></ol>
  <p class="helper-text">完全访问设置不会代替操作系统或网站授权，首次使用仍可能出现它们的确认。这里只读取本机状态；点击一键生成才派发制作任务。独立验收保留单独的 CLI 会话。</p>
  <div class="desktop-setup-actions"><button class="button secondary" data-desktop-load ${busy?'disabled':''}>读取桌面会话</button><label class="editor-label">制作会话<select id="desktop-session-select" ${busy?'disabled':''}>${config?.threadId?`<option value="${esc(config.threadId)}">${esc(config.title)}</option>`:'<option value="">先读取本机会话</option>'}</select></label><button class="button primary" data-desktop-save ${busy?'disabled':''}>检查权限并保存</button></div><p id="desktop-setup-status" class="helper-text" role="status">${config?.configured?'已保存。开始制作前会重新核对权限与占用状态。':'未配置时不会启动视频制作。'}</p></details>`;
}
export function bindDesktopSetup(element,{api,updated,error}){
  element.addEventListener('click',async e=>{
    const load=e.target.closest('[data-desktop-load]'),save=e.target.closest('[data-desktop-save]');if(!load&&!save)return;
    const button=load||save,status=element.querySelector('#desktop-setup-status');button.disabled=true;
    try{if(load){status.textContent='正在读取本机桌面会话，不会调用模型…';const {sessions}=await api('/api/desktop/sessions');const select=element.querySelector('select'),selected=select.value;select.innerHTML='<option value="">选择专用制作会话</option>'+sessions.map(s=>`<option value="${esc(s.id)}">${esc(s.title)} · ${esc(s.id.slice(-6))}</option>`).join('');if(sessions.some(s=>s.id===selected))select.value=selected;status.textContent=sessions.length?'选择会话后点击“检查权限并保存”。':'未找到桌面会话，请先完成上方第 1、2 步。';}
      else{status.textContent='正在核对会话权限…';const value=await api('/api/desktop/configure',{threadId:element.querySelector('select').value,acknowledged:true});updated(value.desktop);}
    }catch(e){status.textContent=e.message;error(e.message);}finally{button.disabled=false;}
  });
}
