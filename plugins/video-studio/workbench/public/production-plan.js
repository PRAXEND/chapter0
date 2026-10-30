// Shared by the web server and review UI. These rules do not inspect style IDs.
const string={type:'string'},nullableNumber={type:['number','null']};
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const sourceUseSchema=object({id:string,sourceId:string,inSeconds:nullableNumber,outSeconds:nullableNumber,actionGroup:string,role:{type:'string',enum:['primary','supplemental']},purpose:string,compatibility:string});
export const placementSchema=object({composition:string,contentBottom:nullableNumber,captionBottom:nullableNumber});
export const productionPlanSchema=object({version:{type:'integer',enum:[1]},materialReview:string,layout:object({mode:{type:'string',enum:['portrait-safe','unchanged']},bottomInset:{type:'number'}})});
export function productionLayout(settings){
  const portrait=settings.height>settings.width,inset=settings.portrait_bottom_inset??.18;
  if(!Number.isFinite(inset)||inset<0||inset>.4)throw new Error('竖版底部留量需要在 0–40% 之间。');
  return {mode:portrait?'portrait-safe':'unchanged',bottomInset:portrait?inset:0};
}
const text=v=>typeof v==='string'&&!!v.trim();
export function validateProductionPlan(plan,settings,sources,required=true){
  if(!plan||typeof plan!=='object')throw new Error('制作方案必须是对象。');
  const policy=plan.productionPlan;
  if(policy==null&&!required)return;
  const expected=productionLayout(settings);
  if(!policy||policy.version!==1||policy.layout?.mode!==expected.mode||policy.layout.bottomInset!==expected.bottomInset||!text(policy.materialReview))throw new Error('请补充通用素材检查和与实际画幅一致的布局方案。');
  const byId=new Map(sources.map(s=>[s.id,s])),seen=new Set(),previous=[];
  if(!Array.isArray(plan.shots)||!plan.shots.length)throw new Error('制作方案需要实际分镜。');
  const shotIds=new Set();
  for(const shot of plan.shots){
    if(!shot||!text(shot.id)||shotIds.has(shot.id))throw new Error('分镜编号无效或重复。');shotIds.add(shot.id);
    if(!Array.isArray(shot.sourceIds)||shot.sourceIds.some(id=>!byId.has(id)))throw new Error('分镜引用了不存在的素材。');
    if(!Array.isArray(shot.sourceUses)||shot.sourceUses.some(u=>!u||typeof u!=='object'))throw new Error('请记录每镜的素材区间与用途。');
    const visualIds=new Set(shot.sourceIds.filter(id=>['video','image'].includes(byId.get(id)?.kind)));
    if(visualIds.size!==new Set(shot.sourceUses.map(u=>u.sourceId)).size||shot.sourceUses.some(u=>!visualIds.has(u.sourceId)))throw new Error('画面来源与片段使用记录不一致。');
    for(const use of shot.sourceUses){
      if(!text(use.id)||seen.has(use.id))throw new Error('素材使用编号需要全片唯一。');seen.add(use.id);
      const source=byId.get(use.sourceId);
      if(!['primary','supplemental'].includes(use.role)||!text(use.purpose)||!text(use.compatibility))throw new Error('请填写素材用途和与旁白的相容性。');
      if(source.kind==='image'){
        if(use.inSeconds!==null||use.outSeconds!==null)throw new Error('静态图片不填写视频源区间。');
        continue;
      }
      if(![use.inSeconds,use.outSeconds,source.duration].every(Number.isFinite)||use.inSeconds<0||use.outSeconds<=use.inSeconds||use.outSeconds>source.duration+.001||!text(use.actionGroup))throw new Error('视频片段需有动作组且位于已探测的素材时长内。');
      const start=source.source_start_seconds??source.start??0;
      if(!Number.isFinite(start)||start<0)throw new Error('原片偏移需要有效的非负秒数。');
      for(const [old,other] of previous){
        const same=use.sourceId===old.sourceId||!!source.sha256&&source.sha256===other.sha256||!!(source.local_path||source.localPath)&&(source.local_path||source.localPath)===(other.local_path||other.localPath);
        const sameUrl=!!source.url&&source.url===other.url;
        const offset=!same&&sameUrl?start:0,otherOffset=!same&&sameUrl?(other.source_start_seconds??other.start??0):0;
        const overlap=(same||sameUrl)&&Math.min(use.outSeconds+offset,old.outSeconds+otherOffset)-Math.max(use.inSeconds+offset,old.inSeconds+otherOffset)>.001;
        if((overlap||use.actionGroup===old.actionGroup)&&!text(settings.replay_authorization))throw new Error('重复动作或重叠源片段，请更换素材。');
      }
      previous.push([use,source]);
    }
    if(!shot.layout||!text(shot.layout.composition))throw new Error('请记录构图与动作保护方式。');
    for(const key of ['contentBottom','captionBottom']){
      const value=shot.layout[key],needed=expected.mode==='portrait-safe'&&(key==='contentBottom'||settings.captions);
      if(value==null&&!needed)continue;
      if(!Number.isFinite(value)||value<0||value>1||expected.mode==='portrait-safe'&&value>1-expected.bottomInset+1e-9)throw new Error('字幕或关键画面进入竖版底部避让区。');
    }
  }
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderProductionPlan(plan){
  const p=plan.productionPlan;if(!p)return '<p class="helper-text">历史方案保留原制作记录；重新生成时采用通用素材与布局检查。</p>';
  const safe=p.layout.mode==='portrait-safe';
  return `<section class="production-plan-summary"><h3>素材与构图安排</h3><label>素材连续性检查<textarea data-production-review rows="2">${esc(p.materialReview)}</textarea></label>${safe?`<svg class="portrait-guide" viewBox="0 0 108 192" role="img" aria-label="竖版底部避让区示意，仅供审阅"><rect class="portrait-guide-content" width="108" height="192"/><rect class="portrait-guide-bottom" width="108" y="${(1-p.layout.bottomInset)*192}" height="${p.layout.bottomInset*192}"/><text x="54" y="70" text-anchor="middle">关键画面与字幕</text></svg><p>底部 ${Math.round(p.layout.bottomInset*100)}% 避让</p><p>主体、动作和字幕同步向上安排；背景可铺满。辅助线不进入成片。</p>`:'<p>当前画幅保持原构图，不应用竖版上移。</p>'}</section>`;
}
export function renderSourceUses(shot,sources){
  if(!shot.sourceUses)return '';
  return `<section class="shot-source-uses"><h3>素材片段与构图</h3>${shot.sourceUses.map(u=>`<article data-use-id="${esc(u.id)}"><button type="button" class="text-button" data-remove-use="${esc(u.id)}">移除此片段</button><div class="shot-edit-fields"><label>画面来源<select data-use-field="sourceId">${sources.filter(s=>shot.sourceIds.includes(s.id)&&['image','video'].includes(s.kind)).map(s=>`<option value="${esc(s.id)}" ${u.sourceId===s.id?'selected':''}>${esc(s.title)}</option>`).join('')}</select></label><label>用途<select data-use-field="role"><option value="primary" ${u.role==='primary'?'selected':''}>主内容</option><option value="supplemental" ${u.role==='supplemental'?'selected':''}>相关补充</option></select></label>${['inSeconds','outSeconds'].map((k,i)=>`<label>${i?'源片段结束':'源片段开始'}（本地素材秒数，图片留空）<input data-use-field="${k}" type="number" min="0" step="0.001" value="${esc(u[k])}"></label>`).join('')}<label>动作组（同一段回放使用相同名称）<input data-use-field="actionGroup" value="${esc(u.actionGroup)}"></label>${['purpose','compatibility'].map((k,i)=>`<label>${i?'与旁白、前后镜头的衔接':'本镜画面用途'}<textarea data-use-field="${k}" rows="2">${esc(u[k])}</textarea></label>`).join('')}</div></article>`).join('')}<button type="button" class="text-button" data-add-use>添加素材片段</button><div class="shot-edit-fields"><label>构图与完整动作保护<textarea data-layout-field="composition" rows="2">${esc(shot.layout?.composition)}</textarea></label>${['contentBottom','captionBottom'].map((k,i)=>`<label>${i?'字幕':'关键画面'}下缘（画高比例 0–1）<input data-layout-field="${k}" type="number" min="0" max="1" step="0.01" value="${esc(shot.layout?.[k])}"></label>`).join('')}</div></section>`;
}
export function readSourceUses(element,shot){
  if(!shot.sourceUses)return {};
  const sourceUses=shot.sourceUses.map(u=>{const node=[...element.querySelectorAll('[data-use-id]')].find(n=>n.dataset.useId===u.id),next={...u};if(node)for(const input of node.querySelectorAll('[data-use-field]')){const k=input.dataset.useField;next[k]=['inSeconds','outSeconds'].includes(k)?input.value.trim()===''?null:Number(input.value):input.value;}return next;});
  const layout={...shot.layout};for(const input of element.querySelectorAll('[data-layout-field]')){const k=input.dataset.layoutField;layout[k]=k==='composition'?input.value:input.value.trim()===''?null:Number(input.value);}
  return {sourceUses,layout};
}
