export function renderPlanningDraft(draft,escape){
  if(!draft?.script)return '';
  return `<section class="planning-draft"><h3>已保存的文案草稿</h3><p class="helper-text">分镜与动效方案尚在完善。草稿会保留，完整方案校验通过后可编辑并确认。</p><strong>${escape(draft.title)}</strong><p>${escape(draft.summary)}</p><textarea class="script-editor" readonly aria-label="已保存的文案草稿">${escape(draft.script)}</textarea>${draft.gaps?.length?`<p class="source-caveats">待补输入：${draft.gaps.map(escape).join('；')}</p>`:''}${draft.limitations?.length?`<p class="helper-text">已知限制：${draft.limitations.map(escape).join('；')}</p>`:''}</section>`;
}
