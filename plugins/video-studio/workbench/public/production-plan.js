// Shared by the web server and review UI. These rules do not inspect style IDs.
const string={type:'string'},nullableNumber={type:['number','null']};
const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
export const sourceUseSchema=object({id:string,sourceId:string,inSeconds:nullableNumber,outSeconds:nullableNumber,actionGroup:string,role:{type:'string',enum:['primary','supplemental']},purpose:string,compatibility:string});
const boxSchema=object(Object.fromEntries(['left','top','right','bottom'].map(k=>[k,{type:'number'}])));
const nullable=schema=>({anyOf:[{type:'null'},schema]});
const captionStyleSchema=object({fontFamily:string,fontSize:{type:'number'},fontWeight:{type:'integer'},lineHeight:{type:'number'},color:string,align:string,verticalAlign:string});
export const placementSchema=object({composition:string,mediaBox:nullable(boxSchema),captionBox:nullable(boxSchema),fit:nullable(string),titleText:nullable(string),titleBox:nullable(boxSchema),captionStyle:nullable(captionStyleSchema),emphasisBoxes:{type:'array',items:object({bounds:boxSchema,footageBounds:boxSchema})}});
const centeredSchema=object({mode:{type:'string',enum:['portrait-centered']},version:{type:'integer',enum:[2]},background:string,titleBox:boxSchema,mediaBox:boxSchema,captionBox:boxSchema,fit:string,captionStyle:captionStyleSchema});
export const productionPlanSchema=object({version:{type:'integer',enum:[1]},materialReview:string,coverTitle:nullable(string),layout:{anyOf:[centeredSchema,object({mode:{type:'string',enum:['unchanged']}})]}});
export const layoutPolicy='customer-portrait-v2';
// Only retain historical fingerprints for non-portrait projects. This never
// reinstates an inset or changes their composition.
export const projectLayoutPolicy=p=>p.ratio==='9:16'?layoutPolicy:(p.layoutPolicy||layoutPolicy);
export const legacyLandscape=p=>!p.layoutPolicy&&p.ratio!=='9:16';
export function productionLayout(settings){
  if(!Number.isFinite(settings.width)||!Number.isFinite(settings.height)||!(settings.height>settings.width&&settings.width>0))return {mode:'unchanged'};
  return {mode:'portrait-centered',version:2,background:'#000000',
    titleBox:{left:.05,top:.04,right:.95,bottom:.28},mediaBox:{left:0,top:.32,right:1,bottom:.68},
    captionBox:{left:.05,top:.72,right:.95,bottom:.88},fit:'contain',
    captionStyle:{fontFamily:'sans-serif',fontSize:settings.width*.05,fontWeight:600,lineHeight:1.25,color:'#FFFFFF',align:'center',verticalAlign:'top'}};
}
const text=v=>typeof v==='string'&&!!v.trim();
const same=(a,b)=>a===b||!!a&&!!b&&typeof a==='object'&&typeof b==='object'&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));
const box=b=>!!b&&typeof b==='object'&&Object.keys(b).length===4&&['left','top','right','bottom'].every(k=>Number.isFinite(b[k]))&&b.left>=0&&b.left<b.right&&b.right<=1&&b.top>=0&&b.top<b.bottom&&b.bottom<=1;
const inside=(a,b)=>box(a)&&box(b)&&a.left>=b.left-1e-9&&a.top>=b.top-1e-9&&a.right<=b.right+1e-9&&a.bottom<=b.bottom+1e-9;
export function validatePlacement(placement,settings,coverTitle){
  if(!placement||!text(placement.composition))throw new Error('请记录镜头构图与动作保护方式。');
  const expected=productionLayout(settings);if(expected.mode==='unchanged')return;
  if(!same(placement.mediaBox,expected.mediaBox)||!same(placement.captionBox,settings.captions?expected.captionBox:null))throw new Error('素材区必须居中，字幕区必须固定在素材下方；全片使用相同布局。');
  if(placement.fit!=='contain')throw new Error('素材须等比完整适配。');
  if(!same(placement.titleBox,expected.titleBox))throw new Error('顶部标题框必须固定在素材上方。');
  const lines=typeof placement.titleText==='string'?placement.titleText.replace(/\r\n/g,'\n').split('\n'):[];
  if(!text(coverTitle)||/[\r\n]/.test(coverTitle)||lines.length<1||lines.length>2||lines.some(line=>!text(line)||line.includes('\r'))||lines.join('').trim()!==coverTitle.trim())throw new Error('顶部标题须由 Agent 生成，与 productionPlan.coverTitle 完全一致；仅允许一至两行换行。');
  if(!same(placement.captionStyle,settings.captions?expected.captionStyle:null))throw new Error('普通字幕的字体、字号、白色、对齐和位置必须统一。');
  if(!Array.isArray(placement.emphasisBoxes))throw new Error('请记录花字动画包围盒；没有花字时使用空列表。');
  for(const e of placement.emphasisBoxes)if(!e||!inside(e.footageBounds,expected.mediaBox)||!inside(e.bounds,e.footageBounds))throw new Error('花字完整动画必须位于对应的实际素材画面内，不能进入黑底留白区。');
}
export function validateProductionPlan(plan,settings,sources,required=true){
  if(!plan||typeof plan!=='object')throw new Error('制作方案必须是对象。');
  const policy=plan.productionPlan;
  if(policy==null&&!required)return;
  const expected=productionLayout(settings);
  const compatibleLandscape=expected.mode==='unchanged'&&same(policy?.layout,{mode:'unchanged',bottomInset:0});
  if(!policy||policy.version!==1||!same(policy.layout,expected)&&!compatibleLandscape||!text(policy.materialReview))throw new Error('请补充通用素材检查和与实际画幅一致的布局方案；旧竖版方案需重新生成。');
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
    validatePlacement(shot.layout,settings,policy.coverTitle);
  }
}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderProductionPlan(plan){
  const p=plan.productionPlan;if(!p)return '<p class="helper-text">历史方案保留原制作记录；重新生成时采用通用素材与布局检查。</p>';
  const centered=p.layout.mode==='portrait-centered'&&p.layout.version===2;
  const titleLines=String(plan.shots?.[0]?.layout?.titleText||p.coverTitle||'待生成封面同款标题').replace(/\r\n/g,'\n').split('\n').slice(0,2);
  const diagram=centered?`<svg class="portrait-guide" viewBox="0 0 108 192" role="img" aria-label="客户竖版布局示意，仅供审阅，标注不进入成片"><rect class="portrait-guide-canvas" width="108" height="192"/><rect class="portrait-guide-title" x="5.4" y="7.68" width="97.2" height="46.08"/><rect class="portrait-guide-media" x="0" y="61.44" width="108" height="69.12"/><rect class="portrait-guide-caption" x="5.4" y="138.24" width="97.2" height="30.72"/><text x="54" y="28" text-anchor="middle">${titleLines.map((line,i)=>`<tspan x="54" dy="${i?9:0}">${esc(line)}</tspan>`).join('')}</text><text x="54" y="94" text-anchor="middle">素材居中 · 花字在画内</text><text x="54" y="155" text-anchor="middle">固定普通字幕</text></svg><p>黑底三分区；素材按原比例完整显示，字幕位置和样式固定。顶部标题由 Agent 生成，与两张封面标题文字一致，可按版式换行。</p>`:p.layout.mode==='unchanged'?'<p>横版或方形沿用本期构图。</p>':'<p>历史竖版方案仅供查看；继续制作前需按客户排版重新生成。</p>';
  return `<section class="production-plan-summary"><h3>素材与构图安排</h3><label>素材连续性检查<textarea data-production-review rows="2">${esc(p.materialReview)}</textarea></label>${diagram}</section>`;
}
export function renderSourceUses(shot,sources){
  if(!shot.sourceUses)return '';
  return `<section class="shot-source-uses"><h3>素材片段与构图</h3>${shot.sourceUses.map(u=>`<article data-use-id="${esc(u.id)}"><button type="button" class="text-button" data-remove-use="${esc(u.id)}">移除此片段</button><div class="shot-edit-fields"><label>画面来源<select data-use-field="sourceId">${sources.filter(s=>shot.sourceIds.includes(s.id)&&['image','video'].includes(s.kind)).map(s=>`<option value="${esc(s.id)}" ${u.sourceId===s.id?'selected':''}>${esc(s.title)}</option>`).join('')}</select></label><label>用途<select data-use-field="role"><option value="primary" ${u.role==='primary'?'selected':''}>主内容</option><option value="supplemental" ${u.role==='supplemental'?'selected':''}>相关补充</option></select></label>${['inSeconds','outSeconds'].map((k,i)=>`<label>${i?'源片段结束':'源片段开始'}（本地素材秒数，图片留空）<input data-use-field="${k}" type="number" min="0" step="0.001" value="${esc(u[k])}"></label>`).join('')}<label>动作组（同一段回放使用相同名称）<input data-use-field="actionGroup" value="${esc(u.actionGroup)}"></label>${['purpose','compatibility'].map((k,i)=>`<label>${i?'与旁白、前后镜头的衔接':'本镜画面用途'}<textarea data-use-field="${k}" rows="2">${esc(u[k])}</textarea></label>`).join('')}</div></article>`).join('')}<button type="button" class="text-button" data-add-use>添加素材片段</button><div class="shot-edit-fields"><label>构图与完整动作保护<textarea data-layout-field="composition" rows="2">${esc(shot.layout?.composition)}</textarea></label>${shot.layout?.mediaBox?'<p class="helper-text">素材展示框固定居中，普通字幕固定在下方；花字位置以对应素材及完整动画范围核验。</p>':''}</div></section>`;
}
export function readSourceUses(element,shot){
  if(!shot.sourceUses)return {};
  const sourceUses=shot.sourceUses.map(u=>{const node=[...element.querySelectorAll('[data-use-id]')].find(n=>n.dataset.useId===u.id),next={...u};if(node)for(const input of node.querySelectorAll('[data-use-field]')){const k=input.dataset.useField;next[k]=['inSeconds','outSeconds'].includes(k)?input.value.trim()===''?null:Number(input.value):input.value;}return next;});
  const layout={...shot.layout};for(const input of element.querySelectorAll('[data-layout-field]')){const k=input.dataset.layoutField;layout[k]=k==='composition'?input.value:input.value.trim()===''?null:Number(input.value);}
  return {sourceUses,layout};
}
