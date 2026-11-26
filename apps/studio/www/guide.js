import {guideControl} from './guide-controls.js';
import {guideTopics} from './guide-data.js';

const byId=new Map(guideTopics.map(topic=>[topic.id,topic]));
let panel=document.getElementById('guide-dialog');
if(!panel){
  // The screening room keeps its own form and player while reading the same guide.
  panel=document.createElement('dialog');panel.id='guide-dialog';panel.setAttribute('aria-labelledby','guide-title');
  panel.innerHTML='<header class="guide-head"><h1 id="guide-title">使用帮助</h1><label class="guide-search"><input id="guide-search" type="search" placeholder="搜索按钮或输入框" aria-label="搜索帮助"></label><button id="guide-close">完成</button></header><div class="guide-layout"><nav id="guide-nav" aria-label="帮助主题"></nav><article id="guide-body" tabindex="-1"></article></div>';
  document.body.append(panel);
}
const nav=panel.querySelector('#guide-nav'),body=panel.querySelector('#guide-body'),search=panel.querySelector('#guide-search');
let active='new',returnTo=null,context='new',scope=null;
const node=(tag,value)=>{const el=document.createElement(tag);if(value!=null)el.textContent=value;return el;};
const simplify=str=>str.toLocaleLowerCase().replace(/[\s·／，（）＋]/g,'');
function currentTopic(){
  if(location.pathname.startsWith('/blind'))return 'blind';
  const modal=document.querySelector('#dialog[open]');
  if(modal?.querySelector('#source-preview,#event-label'))return 'assets';
  if(modal?.querySelector('video,audio,img')&&!modal.querySelector('[data-act=install]'))return document.querySelector('.tabs .selected')?.dataset.id||'edit';
  if(modal)return 'tools';
  if(document.querySelector('#new-title'))return 'new';
  return document.querySelector('.tabs .selected')?.dataset.id||'edit';
}
function jump(id,match){
  const topic=byId.get(id)||byId.get('new');active=topic.id;search.value='';body.replaceChildren();
  for(const b of nav.querySelectorAll('button')){if(b.dataset.topic===active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  body.append(node('h2',topic.title),node('p',topic.intro));
  const figure=node('figure'),pic=node('img');figure.className='guide-figure';
  pic.src='/guide/'+topic.figure+'.jpg';pic.alt=topic.title+'操作界面';
  const zoom=node('button');zoom.className='guide-zoom';zoom.type='button';zoom.title='放大或收起界面截图';zoom.setAttribute('aria-label',zoom.title);zoom.setAttribute('aria-expanded','false');
  zoom.addEventListener('click',()=>{const expanded=figure.classList.toggle('expanded');zoom.setAttribute('aria-expanded',String(expanded));});
  zoom.append(pic);figure.append(zoom,node('figcaption',topic.caption));body.append(figure);
  let target;
  for(const [heading,rows] of topic.groups){
    const list=node('dl');list.className='guide-rows';body.append(node('h3',heading),list);
    for(const [label,description] of rows){
      const row=node('div');row.append(node('dt',label),node('dd',description));list.append(row);
      if(match===label)target=row;
    }
  }
  body.scrollTop=0;if(target){target.classList.add('guide-match');target.scrollIntoView({block:'center'});}
}
function results(){
  const q=simplify(search.value.trim());if(!q)return active==='controls'?inventoryView():jump(active);
  body.replaceChildren(node('h2','搜索结果'));let count=0;
  for(const topic of guideTopics)for(const [section,rows] of topic.groups)for(const [label,description] of rows){
    if(!simplify([topic.title,section,label,description].join(' ')).includes(q))continue;
    const b=node('button');b.type='button';b.className='guide-hit';b.append(node('strong',label),node('small',topic.title+' · '+description));
    b.addEventListener('click',()=>{jump(topic.id,label);body.focus({preventScroll:true});});body.append(b);count++;
  }
  if(!count)body.append(node('p','没有找到对应说明。试试「分享画面」「分割」或「旁白」。'));
}
for(const topic of guideTopics){const b=node('button',topic.title);b.type='button';b.dataset.topic=topic.id;b.addEventListener('click',()=>jump(topic.id));nav.append(b);}
const inventory=node('button','当前界面的控件');inventory.type='button';inventory.className='guide-inventory';nav.prepend(inventory);
function inventoryView(){
  active='controls';search.value='';body.replaceChildren(node('h2','当前界面的控件'),node('p','选「定位」可回到实际控件。置灰项目会标出目前的状态。'));
  for(const b of nav.querySelectorAll('button'))b.removeAttribute('aria-current');inventory.setAttribute('aria-current','page');
  const list=node('dl');list.className='guide-rows';body.append(list);
  const seen=new Set();
  for(const el of (scope||document).querySelectorAll('input:not([type=hidden]),textarea,select,button,summary,[role=slider],audio[controls],video[controls],a[href]')){
    if(el.closest('#guide-dialog,[hidden]')||el.closest('dialog:not([open])')||el.matches('[data-clip]')&&seen.has('timeline-clip'))continue;
    const doc=guideControl(el,el.closest('#inspect')?'inspector':context,byId);
    if(!doc.label||!doc.description)continue;
    if(el.matches('[data-clip]'))seen.add('timeline-clip');
    const key=doc.label+'|'+doc.description;if(seen.has(key))continue;seen.add(key);
    const div=node('div'),dt=node('dt',doc.label),dd=node('dd',doc.description);
    const reason=(el.disabled||el.getAttribute('aria-disabled')==='true')&&(el.dataset.disabledReason||el.title||'此状态下暂不可用');
    if(reason)dd.append(node('small',' · '+reason));
    const locate=node('button','定位');locate.className='guide-locate';locate.type='button';locate.addEventListener('click',()=>{
      returnTo=null;panel.close();if(!el.isConnected)return;
      for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
      el.scrollIntoView({block:'center'});el.focus({preventScroll:true});el.classList.add('control-highlight');setTimeout(()=>el.classList.remove('control-highlight'),1800);
    });dt.append(locate);div.append(dt,dd);list.append(div);
  }
  body.scrollTop=0;
}
inventory.onclick=inventoryView;
function openHelp(id,from,query){
  returnTo=from;context=currentTopic();scope=document.querySelector('#dialog[open]')||document;panel.showModal();jump(id==='current'?context:id);
  if(query){search.value=query;results();}
  panel.querySelector('#guide-close').focus({preventScroll:true});
}
document.addEventListener('click',e=>{const b=e.target.closest('[data-guide]');if(b&&!panel.open)openHelp(b.dataset.guide,b);});
document.addEventListener('keydown',e=>{
  if(e.key!=='F1'||e.altKey||e.metaKey||e.ctrlKey)return;
  e.preventDefault();if(panel.open){search.focus();return;}
  const c=document.activeElement,explicit=c?.closest('button,input,textarea,select');
  const label=explicit?.labels?.[0]?.firstChild?.textContent||explicit?.getAttribute('aria-label')||explicit?.textContent||'';
  openHelp(currentTopic(),c,label.trim().replace(/[（(].*/,'').slice(0,24));
});
search.addEventListener('input',results);
panel.querySelector('#guide-close').onclick=()=>panel.close();
panel.addEventListener('close',()=>{if(returnTo?.isConnected)returnTo.focus({preventScroll:true});returnTo=null;});
