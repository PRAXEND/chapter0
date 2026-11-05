export function revisionMarkup(project,view,draft,busy,esc){
  const waiting=!!(view.questions?.length||view.proposal||view.issues?.length);
  return `<div class="section-heading"><h2>修订与补充反馈</h2><span>${busy?'任务执行中，可先保存反馈':waiting?'有待处理建议':'按需补充'}</span></div>
    ${view.submitted?`<details><summary>本轮已确认的修改要求</summary><p>${esc(view.submitted)}</p></details>`:''}
    ${view.proposal?`<div class="job-question"><strong>${esc(view.proposal.summary)}</strong>${(view.proposal.changes||[]).map(s=>`<p>${esc(s)}</p>`).join('')}</div>`:''}
    ${(view.questions||[]).map(q=>`<p class="job-question">${esc(q)}</p>`).join('')}
    ${view.issues?.length?`<details><summary>查看本轮 ${view.issues.length} 项验收问题</summary>${view.issues.map(i=>`<p><strong>${esc(i.check)}</strong>：${esc(i.text)}</p>`).join('')}</details>`:''}
    <label class="editor-label" for="revision-feedback">本轮修改要求（AI 建议可直接确认，也可编辑）</label>
    <textarea id="revision-feedback" rows="5" maxlength="12000" placeholder="说明希望替换的素材、画面或文案，以及需要保留的内容。">${esc(draft)}</textarea>
    <div class="inline-field"><button class="button secondary" data-feedback-suggestion ${!view.suggested?'disabled':''}>填入 AI 建议</button><button class="button secondary" data-feedback-save>保存反馈</button></div>
    <div class="inline-field"><button class="button primary" data-revision-confirm ${busy||!draft.trim()?'disabled':''}>${view.proposal||view.questions?.length?'批准替换 / 修订并继续制作':'确认反馈并继续制作'}</button><button class="button secondary" data-revision-stop>停止制作，保留现有文件</button></div>
    <p class="helper-text">保存反馈不启动 AI。确认继续将记录本轮要求，沿用当前工程更新方案并局部修订；验收未通过会再次暂停，不自动追加制作费用。${busy?'当前任务结束或停止后才能确认继续。':''}</p>
    ${project.provisionalDeliveries?.length?'<button class="text-button" data-show-provisional>查看并下载完整临时交付 →</button>':''}`;
}

export function provisionalMarkup(d,esc){
  const archive=d.files.find(f=>f.role==='archive');
  return `<div class="section-heading"><h2>临时交付 · 尚未通过验收</h2><span class="delivery-badge">${d.complete?'交付文件齐全':'交付文件有缺项'}</span></div>
    <p class="demo-notice">这是实际候选视频，供查看和下载；保留验收问题，不标记为合格成片。你可以在上方确认修订后继续，也可以停止制作。</p>
    ${d.videoId?`<video class="final-video" controls preload="metadata" src="/api/files/${esc(d.videoId)}"></video>`:''}
    ${d.captionsEnabled?'<p>视频内字幕：'+esc(d.captionsStatus||'以本次验收报告为准')+' · 独立 SRT：'+(d.files.some(f=>f.role==='subtitles')?'已附上':'缺少')+'</p>':''}
    ${d.missing?.length?`<p class="error-banner">${d.missing.map(esc).join('；')}</p>`:''}
    ${archive?`<a class="button primary" href="/api/files/${esc(archive.id)}?download=1" download>下载完整临时交付 ZIP</a>`:''}
    <div class="output-summary"><span>临时交付位置</span><code>${esc(d.directory)}</code><button class="button secondary" id="open-output" data-directory="${esc(d.directory)}">打开文件夹</button></div>
    <div class="file-list">${d.files.filter(f=>f.role!=='archive').map(f=>`<a class="file-row" href="/api/files/${esc(f.id)}?download=1" download><strong>${esc(f.name)}</strong><span>下载 ↓</span></a>`).join('')}</div>`;
}
