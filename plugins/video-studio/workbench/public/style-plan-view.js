const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={purpose:'表达目的',trigger:'触发台词 / 动作',phases:'进入 → 变化 → 退出',placement:'位置与动作避让',sound:'声音与落点',implementation:'实现方式与素材前提',fallback:'受限时的替代设计'};
export function renderShotDesign(shot){
  if(!shot.design?.length)return '';
  return `<section class="shot-style-design"><h3>这镜头如何表现</h3>${shot.design.map(d=>`<article data-design-id="${esc(d.id)}"><p><strong>${esc(d.purpose)}</strong></p><div class="shot-edit-fields">${['trigger','phases','placement','sound'].map(k=>`<label>${labels[k]}<textarea data-design-field="${k}" rows="2">${esc(d[k])}</textarea></label>`).join('')}<label>预计持续（秒）<input data-design-field="durationSeconds" type="number" min="0.01" step="0.01" value="${esc(d.durationSeconds)}"></label></div><details><summary>实现与替代设计</summary>${['purpose','implementation','fallback'].map(k=>`<label class="editor-label">${labels[k]}<textarea data-design-field="${k}" rows="2">${esc(d[k])}</textarea></label>`).join('')}<small>关联风格规则：${(d.ruleIds||[]).map(esc).join('、')}</small></details></article>`).join('')}</section>`;
}
export function readShotDesign(element,designs){
  return (designs||[]).map(d=>{
    const node=[...element.querySelectorAll('[data-design-id]')].find(n=>n.dataset.designId===d.id);
    if(!node)return d;
    const next={...d};
    for(const input of node.querySelectorAll('[data-design-field]'))next[input.dataset.designField]=input.dataset.designField==='durationSeconds'?Number(input.value):input.value;
    return next;
  });
}
export function renderStylePlan(plan){
  const s=plan.stylePlan;if(!s)return '';
  const states={planned:'本期采用',not_applicable:'本期不适用',overridden:'按你的要求调整'};
  return `<section class="plan-style-summary"><h3>本期风格与节奏</h3><p>${esc(s.contrastReview)}</p><details><summary>参考对照与逐条落实</summary>${s.referenceChecks.map(r=>`<p><strong>${esc(r.referenceId)} · ${esc(r.location)}</strong><br>${esc(r.observation)}<br>本期：${esc(r.adaptation)}</p>`).join('')}<ul>${s.rules.map(r=>`<li><strong>${esc(states[r.disposition]||r.disposition)}</strong> · ${esc(r.ruleId)}${r.shotIds.length?' · '+r.shotIds.map(esc).join('、'):''}<br>${esc(r.treatment)}</li>`).join('')}</ul></details></section>`;
}
