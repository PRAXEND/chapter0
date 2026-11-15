export function revisionMarkup(project,view,draft,busy,esc){
  const waiting=!!(view.questions?.length||view.proposal||view.issues?.length);
  return `<div class="section-heading"><h2>修订与补充反馈</h2><span>${busy?'任务执行中，可先保存反馈':waiting?'有待处理建议':'按需补充'}</span></div>
    ${view.technicalBlocker?`<div class="job-question"><strong>${view.technicalBlocker.action==='delivery'?'保存交付受阻':view.technicalBlocker.action==='review'?'验收准备受阻':'任务准备受阻'}</strong><p>${esc(view.technicalBlocker.message)}</p><p>${view.technicalBlocker.action==='delivery'?'已有验收结论会在继续时重新核对；文件和证据仍有效时，只重试保存交付。':'本次属于技术阻塞，没有新增质量修改建议。处理上面的原因后点击继续，会先核对已有任务和文件。'}原工程和方案会保留，无需在意见栏填写“重新制作”。</p></div>`:''}
    ${view.packageError?`<div class="job-question"><strong>临时交付尚未保存</strong><p>${esc(view.packageError.message)}</p><p>原候选和已有验收结果已保存。重试只整理本地文件，不启动制作或验收。</p><button class="button secondary" data-provisional-retry ${busy?'disabled':''}>重试保存临时交付</button></div>`:''}
    ${view.registrationPending?'<div class="job-question"><strong>已有制作结果等待登记</strong><p>点击继续会先核对并恢复本地登记，再进行独立验收；不会重新制作视频，无需在意见栏填写修改要求。</p></div>':''}
    ${view.evidencePending?`<div class="job-question"><strong>补齐原件后继续验收原试片</strong><p>${esc(view.evidencePending.summary)}</p>${view.evidencePending.questions.map(q=>`<p>${esc(q)}</p>`).join('')}<p>补交文件无需确认创意修订。补齐后点击原制作流程的“继续”，会保留原方案批准和已导出视频。</p></div>`:''}
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
