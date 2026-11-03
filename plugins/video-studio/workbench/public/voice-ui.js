export const consentText='我确认拥有该音色或已获得克隆授权，并承诺不将其用于冒充他人、欺诈或其他违法用途。';
export const defaultPreview='这是你的克隆音色，希望你喜欢这个效果。';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function currentVoiceRequest(project){
  const job=project.jobs.find(j=>j.action==='produce'),r=job?.voiceRequest;
  return project.narration&&job?.status==='needs_input'&&r&&!r.answeredAt&&r.planHash===project.approval?.planHash&&r.inputHash===project.approval?.inputHash?r:null;
}
export function renderVoiceRequest(r,busy=false){
  if(!r)return '';
  const disabled=busy?'disabled':'';
  const button=(action,text,key='')=>`<button type="button" class="button secondary" data-voice-action="${action}" data-voice-key="${esc(key)}" ${disabled}>${text}</button>`;
  let content='';
  if(r.kind==='clone_choice')content=`<h3>需要克隆自己的声音吗？</h3><p>你还没有可用的克隆音色。可以上传一段录音，也可以试听并选择官方音色。</p><div class="voice-actions">${button('clone','克隆我的音色')}${button('official','选择官方音色')}</div>`;
  if(r.kind==='voice_choice')content=`<h3>试听并选择配音音色</h3><div class="voice-candidates">${r.candidates.map(c=>`<article class="voice-candidate"><h4>${esc(c.name)}</h4><p>${esc(c.summary)}</p><audio controls preload="none" src="${esc(c.sampleUrl)}" aria-label="试听 ${esc(c.name)}"></audio>${button('select','使用这个音色',c.key)}</article>`).join('')}</div><div class="voice-actions">${button('clone','克隆我的音色')}</div>`;
  if(r.kind==='clone_recording')content=`<h3>上传一段录音，克隆你的音色</h3><p>建议 30–60 秒清晰独白，无配乐与杂音；支持 10 秒至 3 分钟，最大 25 MB。提交后录音将发送至 ChatCut 创建音色，源录音会保留供后续服务迁移。</p><form id="voice-recording-form"><label class="editor-label">音色名称<input name="voiceName" required maxlength="80" placeholder="例如：我的旁白"></label><label class="editor-label">录音文件<input name="recording" type="file" accept=".aac,.flac,.m4a,.mp3,.ogg,.wav,.webm" required></label><label class="editor-label">试听文本（最多 100 字）<textarea name="previewText" rows="2">${defaultPreview}</textarea></label><label class="voice-consent"><input name="voiceConsent" type="checkbox" required> ${consentText}</label><button type="submit" class="button primary" ${disabled}>提交录音并继续</button></form><div class="voice-actions">${button('official','暂不克隆，选择官方音色')}</div>`;
  return `<section class="voice-request" aria-label="配音音色设置">${r.message?`<p>${esc(r.message)}</p>`:''}${content}</section>`;
}
